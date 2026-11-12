import type { CodeLibraryRoot } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";

const MAX_SUBDIRECTORIES = 64;
const SKIPPED_SUBDIRECTORIES = new Set(["node_modules", "site-packages", "__pycache__"]);
// Every file read here is named by a workspace; a real one is a few kilobytes.
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

const PyrightConfig = Schema.Struct({
  venvPath: Schema.optional(Schema.String),
  venv: Schema.optional(Schema.String),
});
const decodePyrightConfig = Schema.decodeUnknownOption(Schema.fromJsonString(PyrightConfig));

export interface PythonEnvironmentLocation {
  readonly source: "root" | "main-checkout" | "setting" | "none";
  /** The virtualenv directory (or the path the user set), absolute. Absent when `source` is "none". */
  readonly environment?: string;
  /** For the status chip: the interpreter the environment names and its version. Never executed. */
  readonly interpreter?: { readonly path: string; readonly version?: string };
  /** site-packages and the stdlib directory, absolute, existing directories only. */
  readonly libraryRoots: ReadonlyArray<CodeLibraryRoot>;
  /** Set when the user's path for this root does not exist; `source` is then "none". */
  readonly problem?: "setting_path_missing";
}

export class PythonEnvironment extends Context.Service<
  PythonEnvironment,
  {
    /** Never fails and never runs anything: the environment is found by reading files. */
    readonly locate: (root: string) => Effect.Effect<PythonEnvironmentLocation>;
  }
>()("t3/codeIntel/PythonEnvironment") {}

/** `key = value` lines, keys lowercased, as CPython's `site` module reads the file. */
const readPyvenvConfig = (source: string): ReadonlyMap<string, string> => {
  const values = new Map<string, string>();
  for (const line of source.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      values.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
  }
  return values;
};

/**
 * String values of a TOML file, keyed by `table.key`. Reads table headers and one-line string
 * values only, which covers the settings looked up here; inline tables and arrays are skipped.
 */
const readTomlStrings = (source: string): ReadonlyMap<string, string> => {
  const values = new Map<string, string>();
  let table: string | undefined = "";
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("[[")) {
      table = undefined;
      continue;
    }
    const header = /^\[([^[\]]+)\]\s*(?:#.*)?$/u.exec(line);
    if (header?.[1] !== undefined) {
      table = header[1]
        .split(".")
        .map((part) => part.trim().replace(/^(["'])(.*)\1$/u, "$2"))
        .join(".");
      continue;
    }
    const pair = /^([\w.-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/u.exec(line);
    if (table === undefined || pair?.[1] === undefined) continue;
    const value = pair[2] === undefined ? pair[3] : pair[2].replace(/\\(["\\])/gu, "$1");
    if (value !== undefined) values.set(table === "" ? pair[1] : `${table}.${pair[1]}`, value);
  }
  return values;
};

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const home = yield* HostProcess.HomeDirectory;

  // The helpers below are untraced: each runs inside the `PythonEnvironment.locate` span.

  const isFile = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );

  const isDirectory = (directory: string) =>
    fileSystem.stat(directory).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const readSmallFile = Effect.fnUntraced(function* (file: string) {
    const info = yield* fileSystem.stat(file).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return undefined;
    if (Number(info.value.size) > MAX_CONFIG_FILE_BYTES) return undefined;
    return yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => undefined));
  });

  /** The virtualenv a path names: the directory itself, or the one whose `bin` holds the interpreter. */
  const virtualenvAt = Effect.fnUntraced(function* (candidate: string) {
    if (yield* isFile(path.join(candidate, "pyvenv.cfg"))) return candidate;
    const binDirectory = path.dirname(candidate);
    const environment = path.dirname(binDirectory);
    const namesInterpreter =
      path.basename(binDirectory) === "bin" && path.basename(candidate).startsWith("python");
    if (namesInterpreter && (yield* isFile(path.join(environment, "pyvenv.cfg")))) {
      return environment;
    }
    return undefined;
  });

  const configuredCandidates = Effect.fnUntraced(function* (directory: string) {
    const candidates: Array<string> = [];
    const pyright = Option.getOrUndefined(
      decodePyrightConfig((yield* readSmallFile(path.join(directory, "pyrightconfig.json"))) ?? ""),
    );
    if (pyright?.venvPath !== undefined && pyright.venv !== undefined) {
      candidates.push(path.resolve(directory, pyright.venvPath, pyright.venv));
    }
    const pyproject = readTomlStrings(
      (yield* readSmallFile(path.join(directory, "pyproject.toml"))) ?? "",
    );
    const venvPath = pyproject.get("tool.pyright.venvPath");
    const venv = pyproject.get("tool.pyright.venv");
    if (venvPath !== undefined && venv !== undefined) {
      candidates.push(path.resolve(directory, venvPath, venv));
    }
    const tyPython = pyproject.get("tool.ty.environment.python");
    if (tyPython !== undefined) candidates.push(path.resolve(directory, tyPython));
    return candidates;
  });

  const firstVirtualenv = Effect.fnUntraced(function* (candidates: ReadonlyArray<string>) {
    for (const candidate of candidates) {
      const environment = yield* virtualenvAt(candidate);
      if (environment !== undefined) return environment;
    }
    return undefined;
  });

  const subdirectories = Effect.fnUntraced(function* (root: string) {
    const entries = yield* fileSystem
      .readDirectoryEntries(root)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<FileSystem.DirectoryEntry> => []));
    return entries
      .filter(
        (entry) =>
          entry.type === "Directory" &&
          !entry.name.startsWith(".") &&
          !SKIPPED_SUBDIRECTORIES.has(entry.name),
      )
      .map((entry) => path.join(root, entry.name))
      .sort()
      .slice(0, MAX_SUBDIRECTORIES);
  });

  /**
   * A monorepo keeps its Python in a subdirectory, so the root's children are looked at too. A
   * virtualenv a config file names outranks one found by its directory name: a root can hold a
   * stray `.venv` beside the `backend/pyrightconfig.json` that names the real one.
   */
  const findVirtualenv = Effect.fnUntraced(function* (root: string) {
    const directories = [root, ...(yield* subdirectories(root))];
    for (const directory of directories) {
      const configured = yield* firstVirtualenv(yield* configuredCandidates(directory));
      if (configured !== undefined) return configured;
    }
    return yield* firstVirtualenv(
      directories.flatMap((directory) => [
        path.join(directory, ".venv"),
        path.join(directory, "venv"),
      ]),
    );
  });

  /**
   * Where `root` sits in the main checkout when it is inside a linked git worktree. Reads `.git`
   * and `commondir` instead of running git, which would read the repository's own config.
   */
  const mainCheckoutPlace = Effect.fnUntraced(function* (root: string) {
    let directory = root;
    for (;;) {
      const gitEntry = path.join(directory, ".git");
      const info = yield* fileSystem.stat(gitEntry).pipe(Effect.option);
      if (Option.isSome(info)) {
        if (info.value.type !== "File") return undefined;
        const gitPointer = /^gitdir:\s*(.+)/u.exec((yield* readSmallFile(gitEntry)) ?? "")?.[1];
        if (gitPointer === undefined) return undefined;
        const gitDirectory = path.resolve(directory, gitPointer.trim());
        const commonPointer = (yield* readSmallFile(path.join(gitDirectory, "commondir")))?.trim();
        if (!commonPointer) return undefined;
        const commonDirectory = path.resolve(gitDirectory, commonPointer);
        // A bare repository has no main checkout to borrow a virtualenv from.
        if (path.basename(commonDirectory) !== ".git") return undefined;
        return path.join(path.dirname(commonDirectory), path.relative(directory, root));
      }
      const parent = path.dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  });

  const describeVirtualenv = Effect.fnUntraced(function* (environment: string) {
    const config = readPyvenvConfig(
      (yield* readSmallFile(path.join(environment, "pyvenv.cfg"))) ?? "",
    );
    const version = /^\d+\.\d+(?:\.\d+)?/u.exec(
      config.get("version") ?? config.get("version_info") ?? "",
    )?.[0];
    const home = config.get("home");
    const libraryRoots: Array<CodeLibraryRoot> = [];
    if (version !== undefined) {
      const majorMinor = version.split(".").slice(0, 2).join(".");
      const sitePackages = path.join(environment, "lib", `python${majorMinor}`, "site-packages");
      if (yield* isDirectory(sitePackages)) {
        libraryRoots.push({
          path: sitePackages,
          label: `Python ${majorMinor} site-packages`,
          kind: "site-packages",
        });
      }
      // `home` is the base interpreter's `bin`; its stdlib sits beside it.
      const stdlib =
        home === undefined
          ? undefined
          : path.resolve(environment, home, "..", "lib", `python${majorMinor}`);
      if (stdlib !== undefined && (yield* isDirectory(stdlib))) {
        libraryRoots.push({
          path: stdlib,
          label: `Python ${majorMinor} standard library`,
          kind: "stdlib",
        });
      }
    }
    return {
      environment,
      interpreter: {
        path: path.join(environment, "bin", "python"),
        ...(version === undefined ? {} : { version }),
      },
      libraryRoots,
    };
  });

  const locateFromSetting = Effect.fnUntraced(function* (root: string, setting: string) {
    const configured = path.resolve(root, expandHomePath(setting, home));
    const exists = yield* fileSystem.exists(configured).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return {
        source: "none",
        problem: "setting_path_missing",
        libraryRoots: [],
      } satisfies PythonEnvironmentLocation;
    }
    const environment = yield* virtualenvAt(configured);
    if (environment === undefined) {
      return {
        source: "setting",
        environment: configured,
        libraryRoots: [],
      } satisfies PythonEnvironmentLocation;
    }
    return {
      source: "setting",
      ...(yield* describeVirtualenv(environment)),
    } satisfies PythonEnvironmentLocation;
  });

  // Clients key the setting by the workspace path they opened, which may be a symlink to `root`.
  const settingFor = Effect.fnUntraced(function* (root: string) {
    const environments = yield* settings.getSettings.pipe(
      Effect.map(({ codeIntel }) => codeIntel.pythonEnvironments),
      Effect.orElseSucceed((): Readonly<Record<string, string>> => ({})),
    );
    if (Object.hasOwn(environments, root) && environments[root]) return environments[root];
    for (const [workspace, setting] of Object.entries(environments)) {
      if (!setting || workspace === root) continue;
      const resolved = yield* fileSystem
        .realPath(workspace)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (resolved === root) return setting;
    }
    return undefined;
  });

  const locate: PythonEnvironment["Service"]["locate"] = Effect.fn("PythonEnvironment.locate")(
    function* (root) {
      const setting = yield* settingFor(root);
      if (setting) return yield* locateFromSetting(root, setting);

      const ownEnvironment = yield* findVirtualenv(root);
      if (ownEnvironment !== undefined) {
        return { source: "root", ...(yield* describeVirtualenv(ownEnvironment)) };
      }

      // A worktree shares its code with the main checkout but not its virtualenv.
      const mainPlace = yield* mainCheckoutPlace(root);
      const mainEnvironment =
        mainPlace === undefined ? undefined : yield* findVirtualenv(mainPlace);
      if (mainEnvironment !== undefined) {
        return { source: "main-checkout", ...(yield* describeVirtualenv(mainEnvironment)) };
      }

      return { source: "none", libraryRoots: [] };
    },
  );

  return PythonEnvironment.of({ locate });
});

export const layer = Layer.effect(PythonEnvironment, make);
