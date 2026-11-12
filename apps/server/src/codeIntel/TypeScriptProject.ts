// @effect-diagnostics nodeBuiltinImport:off -- one listing tells folders from files without a stat each.
import * as NodeFSP from "node:fs/promises";

import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import { IGNORED_DIRECTORIES } from "./WorkspaceWatcher.ts";

// Every project of a large monorepo (t3code's 41) took tsc 3.2 GB, past its 3 GiB soft limit.
const MAX_SEED_PROJECTS = 4;
const MAX_REFERENCE_HOPS = 2;
const MAX_LISTED_DIRECTORIES = 256;
const MAX_NODE_MODULES_ROOTS = 32;
/** Projects and packages sit in the root or up to two folders down: `apps/web`, `packages/ui`. */
const PROJECT_DEPTH = 2;
const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"] as const;
const TYPESCRIPT_SOURCE = /\.(?:[cm]?ts|tsx)$/;
const ANY_SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const GLOB = /[*?[{]/;

const ProjectConfig = fromLenientJson(
  Schema.Struct({
    files: Schema.optional(Schema.Array(Schema.String)),
    include: Schema.optional(Schema.Array(Schema.String)),
    references: Schema.optional(Schema.Array(Schema.Struct({ path: Schema.String }))),
  }),
);
const decodeProjectConfig = Schema.decodeUnknownOption(ProjectConfig);

interface Listing {
  readonly directories: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
}

const EMPTY_LISTING: Listing = { directories: [], files: [] };

const isSource = (name: string, source: RegExp) => source.test(name) && !/\.d\.[cm]?ts$/.test(name);

/**
 * tsc loads a project only when one of its files opens, and a workspace-wide question sees
 * loaded projects alone. This finds which files to open and where packages resolve from, by
 * listing folders and reading project files through the workspace's read rule. Nothing runs.
 */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;

  // Links are neither: a folder link could lead anywhere, and files are opened by their real path.
  const list = (directory: string) =>
    Effect.promise(() =>
      NodeFSP.readdir(directory, { withFileTypes: true }).then(
        (entries): Listing => {
          const sorted = entries.toSorted((left, right) => left.name.localeCompare(right.name));
          return {
            directories: sorted.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
            files: sorted.filter((entry) => entry.isFile()).map((entry) => entry.name),
          };
        },
        () => EMPTY_LISTING,
      ),
    );

  const searchable = (name: string) => !name.startsWith(".") && !IGNORED_DIRECTORIES.has(name);

  /** Breadth first from `start`, `depth` folders down at most; `visit` answers whether to stop. */
  const walk = Effect.fnUntraced(function* (
    start: string,
    depth: number,
    visit: (directory: string, listing: Listing) => boolean,
  ) {
    let level = [start];
    let listed = 0;
    for (let current = 0; current <= depth && level.length > 0; current++) {
      const next: Array<string> = [];
      for (const directory of level) {
        if (listed++ >= MAX_LISTED_DIRECTORIES) return;
        const listing = yield* list(directory);
        if (visit(directory, listing)) return;
        for (const name of listing.directories) {
          if (searchable(name)) next.push(path.join(directory, name));
        }
      }
      level = next;
    }
  });

  const firstSourceUnder = Effect.fnUntraced(function* (directory: string, source: RegExp) {
    let found: string | undefined;
    yield* walk(directory, Number.POSITIVE_INFINITY, (current, listing) => {
      const name = listing.files.find((file) => isSource(file, source));
      if (name !== undefined) found = path.join(current, name);
      return found !== undefined;
    });
    return found;
  });

  const isFile = (file: string) =>
    Effect.promise(() =>
      NodeFSP.lstat(file).then(
        (stat) => stat.isFile(),
        () => false,
      ),
    );

  /** The file an `include` entry starts from: its folders before the first wildcard. */
  const fromPattern = Effect.fnUntraced(function* (
    root: string,
    directory: string,
    pattern: string,
    source: RegExp,
  ) {
    const segments = pattern.split("/");
    const wildcard = segments.findIndex((segment) => GLOB.test(segment));
    const start = path.resolve(
      directory,
      ...segments.slice(0, wildcard < 0 ? undefined : wildcard),
    );
    if (!KnownWorkspaces.isWithinRoot(path, start, root)) return undefined;
    if (wildcard < 0 && isSource(start, source) && (yield* isFile(start))) return start;
    return yield* firstSourceUnder(start, source);
  });

  const readConfig = (root: string, configPath: string) =>
    workspaceFileSystem.readFile({ cwd: root, relativePath: configPath }).pipe(
      Effect.map((file) =>
        file.exists === false || file.truncated ? undefined : decodeProjectConfig(file.contents),
      ),
      Effect.orElseSucceed(() => undefined),
    );

  /** A file of the project `configPath` names, or of a project it references. */
  const projectFile = Effect.fnUntraced(function* (
    root: string,
    configPath: string,
    hops: number,
  ): Effect.fn.Return<string | undefined> {
    const read = yield* readConfig(root, configPath);
    if (read === undefined || read._tag === "None") return undefined;
    const config = read.value;
    const directory = path.dirname(configPath);
    const source = path.basename(configPath) === "jsconfig.json" ? ANY_SOURCE : TYPESCRIPT_SOURCE;
    for (const file of config.files ?? []) {
      const candidate = path.resolve(directory, file);
      if (
        KnownWorkspaces.isWithinRoot(path, candidate, root) &&
        isSource(candidate, source) &&
        (yield* isFile(candidate))
      ) {
        return candidate;
      }
    }
    // tsc's own default: every file under the project, unless `files` names them.
    for (const pattern of config.include ?? (config.files === undefined ? ["**/*"] : [])) {
      const found = yield* fromPattern(root, directory, pattern, source);
      if (found !== undefined) return found;
    }
    // A solution lists no files of its own; opening one of a referenced project loads it.
    if (hops >= MAX_REFERENCE_HOPS) return undefined;
    for (const reference of config.references ?? []) {
      const target = path.resolve(directory, reference.path);
      const referenced = target.endsWith(".json") ? target : path.join(target, "tsconfig.json");
      const found = yield* projectFile(root, referenced, hops + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  });

  /** The root's own project, or the shallowest projects below a root that has none. */
  const seedFiles = Effect.fn("TypeScriptProject.seedFiles")(function* (root: string) {
    const rootListing = yield* list(root);
    for (const name of CONFIG_NAMES) {
      if (!rootListing.files.includes(name)) continue;
      const file = yield* projectFile(root, path.join(root, name), 0);
      if (file !== undefined) return [file];
    }
    const configs: Array<string> = [];
    yield* walk(root, PROJECT_DEPTH, (directory, listing) => {
      if (directory === root) return false;
      const name = CONFIG_NAMES.find((candidate) => listing.files.includes(candidate));
      if (name !== undefined) configs.push(path.join(directory, name));
      return configs.length >= MAX_SEED_PROJECTS;
    });
    const files = yield* Effect.forEach(configs, (config) => projectFile(root, config, 0));
    return [...new Set(files.filter((file) => file !== undefined))];
  });

  /** `node_modules` folders of the root and of packages up to two folders down, root first. */
  const nodeModulesRoots = Effect.fn("TypeScriptProject.nodeModulesRoots")(function* (
    root: string,
  ) {
    const roots: Array<string> = [];
    yield* walk(root, PROJECT_DEPTH, (directory, listing) => {
      if (listing.directories.includes("node_modules")) {
        roots.push(path.join(directory, "node_modules"));
      }
      return roots.length >= MAX_NODE_MODULES_ROOTS;
    });
    return roots;
  });

  return { seedFiles, nodeModulesRoots };
});
