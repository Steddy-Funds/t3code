// @effect-diagnostics nodeBuiltinImport:off -- one listing tells folders from files without a stat each.
import * as NodeFSP from "node:fs/promises";

import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
    extends: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
    files: Schema.optional(Schema.Array(Schema.String)),
    include: Schema.optional(Schema.Array(Schema.String)),
    references: Schema.optional(Schema.Array(Schema.Struct({ path: Schema.String }))),
  }),
);
type ProjectConfig = typeof ProjectConfig.Type;
const decodeProjectConfig = Schema.decodeUnknownOption(ProjectConfig);

const Dependencies = Schema.optional(Schema.Record(Schema.String, Schema.Unknown));
const PackageManifest = fromLenientJson(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    exports: Schema.optional(Schema.Unknown),
    main: Schema.optional(Schema.Unknown),
    module: Schema.optional(Schema.Unknown),
    types: Schema.optional(Schema.Unknown),
    typings: Schema.optional(Schema.Unknown),
    dependencies: Dependencies,
    devDependencies: Dependencies,
    peerDependencies: Dependencies,
  }),
);
type PackageManifest = typeof PackageManifest.Type;
const decodePackageManifest = Schema.decodeUnknownOption(PackageManifest);

interface Listing {
  readonly directories: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
}

const EMPTY_LISTING: Listing = { directories: [], files: [] };

/** Folder listings one search has left. */
interface Budget {
  listings: number;
}

const newBudget = (): Budget => ({ listings: MAX_LISTED_DIRECTORIES });

/** `files` and `include` as tsc reads them, relative to `directory`. */
interface Sources {
  readonly directory: string;
  readonly files: ReadonlyArray<string>;
  readonly include: ReadonlyArray<string>;
}

interface Candidate {
  readonly config: string;
  readonly name: string | undefined;
  /** The workspace packages it imports, whose files tsc loads with its own. */
  readonly loads: ReadonlyArray<string>;
}

const DECLARATION = /\.d\.[cm]?ts$/;

const ownSources = (directory: string, config: ProjectConfig): Sources | undefined =>
  config.files === undefined && config.include === undefined
    ? undefined
    : { directory, files: config.files ?? [], include: config.include ?? [] };

// No entry point: an app, which no dependent imports, so only opening it loads it.
const isImportable = (manifest: PackageManifest) =>
  [manifest.exports, manifest.main, manifest.module, manifest.types, manifest.typings].some(
    (entry) => entry !== undefined,
  );

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
    budget: Budget,
    visit: (directory: string, listing: Listing) => boolean,
  ) {
    let level = [start];
    for (let current = 0; current <= depth && level.length > 0; current++) {
      const next: Array<string> = [];
      for (const directory of level) {
        if (budget.listings <= 0) return;
        budget.listings -= 1;
        const listing = yield* list(directory);
        if (visit(directory, listing)) return;
        for (const name of listing.directories) {
          if (searchable(name)) next.push(path.join(directory, name));
        }
      }
      level = next;
    }
  });

  /**
   * The first implementation file under `directory`, else its first declaration file: an ambient
   * one may be in no project.
   */
  const firstSourceUnder = Effect.fnUntraced(function* (
    directory: string,
    source: RegExp,
    budget: Budget,
  ) {
    let found: string | undefined;
    let declaration: string | undefined;
    yield* walk(directory, Number.POSITIVE_INFINITY, budget, (current, listing) => {
      const sources = listing.files.filter((file) => source.test(file));
      const name = sources.find((file) => !DECLARATION.test(file));
      if (name !== undefined) found = path.join(current, name);
      const first = sources[0];
      if (declaration === undefined && first !== undefined) declaration = path.join(current, first);
      return found !== undefined;
    });
    return found ?? declaration;
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
    budget: Budget,
  ) {
    const segments = pattern.split("/");
    const wildcard = segments.findIndex((segment) => GLOB.test(segment));
    const start = path.resolve(
      directory,
      ...segments.slice(0, wildcard < 0 ? undefined : wildcard),
    );
    if (!KnownWorkspaces.isWithinRoot(path, start, root)) return undefined;
    if (wildcard < 0 && source.test(start) && (yield* isFile(start))) return start;
    return yield* firstSourceUnder(start, source, budget);
  });

  const readJson = <A>(
    root: string,
    file: string,
    decode: (contents: string) => Option.Option<A>,
  ): Effect.Effect<A | undefined> =>
    // Relative, so the read rule refuses a file outside the root, through a link too.
    workspaceFileSystem.readFile({ cwd: root, relativePath: path.relative(root, file) }).pipe(
      Effect.map((read) =>
        read.exists === false || read.truncated
          ? undefined
          : Option.getOrUndefined(decode(read.contents)),
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const readConfig = (root: string, configPath: string) =>
    readJson(root, configPath, decodeProjectConfig);

  const referencesOf = (configPath: string, config: ProjectConfig) =>
    (config.references ?? []).map((reference) => {
      const target = path.resolve(path.dirname(configPath), reference.path);
      return target.endsWith(".json") ? target : path.join(target, "tsconfig.json");
    });

  /** A project without `files` or `include` takes its base's, relative to the base, else all. */
  const sourcesOf = Effect.fnUntraced(function* (
    root: string,
    configPath: string,
    config: ProjectConfig,
  ) {
    const directory = path.dirname(configPath);
    const own = ownSources(directory, config);
    if (own !== undefined) return own;
    const bases = typeof config.extends === "string" ? [config.extends] : (config.extends ?? []);
    // The last base wins; a package's base (`@tsconfig/node22`) names no project files.
    for (const base of bases.toReversed().filter((entry) => entry.startsWith("."))) {
      const basePath = path.resolve(directory, base.endsWith(".json") ? base : `${base}.json`);
      const baseConfig = yield* readConfig(root, basePath);
      const inherited =
        baseConfig === undefined ? undefined : ownSources(path.dirname(basePath), baseConfig);
      if (inherited !== undefined) return inherited;
    }
    return { directory, files: [], include: ["**/*"] } satisfies Sources;
  });

  /** A file of the project itself, without its references. */
  const ownFile = Effect.fnUntraced(function* (
    root: string,
    configPath: string,
    config: ProjectConfig,
    budget: Budget,
  ) {
    const sources = yield* sourcesOf(root, configPath, config);
    const source = path.basename(configPath) === "jsconfig.json" ? ANY_SOURCE : TYPESCRIPT_SOURCE;
    for (const file of sources.files) {
      const candidate = path.resolve(sources.directory, file);
      if (
        KnownWorkspaces.isWithinRoot(path, candidate, root) &&
        source.test(candidate) &&
        (yield* isFile(candidate))
      ) {
        return candidate;
      }
    }
    for (const pattern of sources.include) {
      const found = yield* fromPattern(root, sources.directory, pattern, source, budget);
      if (found !== undefined) return found;
    }
    return undefined;
  });

  /** A file of the project `configPath` names, or of a project it references. */
  const projectFile = Effect.fnUntraced(function* (
    root: string,
    configPath: string,
    hops: number,
    budget: Budget,
  ): Effect.fn.Return<string | undefined> {
    const config = yield* readConfig(root, configPath);
    if (config === undefined) return undefined;
    const own = yield* ownFile(root, configPath, config, budget);
    if (own !== undefined || hops >= MAX_REFERENCE_HOPS) return own;
    // A solution lists no files of its own; opening one of a referenced project loads it.
    for (const reference of referencesOf(configPath, config)) {
      const found = yield* projectFile(root, reference, hops + 1, budget);
      if (found !== undefined) return found;
    }
    return undefined;
  });

  /**
   * A project loads the workspace packages it imports with its own files. So the projects that
   * import the most go first, and one a chosen project already loads waits for a slot left over:
   * an import may resolve to built output, which loads none of the package's sources.
   */
  const pickProjects = Effect.fnUntraced(function* (
    root: string,
    configs: ReadonlyArray<string>,
    budget: Budget,
  ) {
    const manifests = yield* Effect.forEach(configs, (config) =>
      readJson(root, path.join(path.dirname(config), "package.json"), decodePackageManifest),
    );
    const importable = new Set(
      manifests.flatMap((manifest) =>
        manifest?.name !== undefined && isImportable(manifest) ? [manifest.name] : [],
      ),
    );
    const candidates = configs.map((config, index): Candidate => {
      const manifest = manifests[index];
      const dependencies = [
        manifest?.dependencies,
        manifest?.devDependencies,
        manifest?.peerDependencies,
      ].flatMap((map) => Object.keys(map ?? {}));
      return {
        config,
        name: manifest?.name,
        loads: [...new Set(dependencies)].filter(
          (name) => name !== manifest?.name && importable.has(name),
        ),
      };
    });
    const loaded = new Set<string>();
    const deferred: Array<Candidate> = [];
    const files: Array<string> = [];
    const open = Effect.fnUntraced(function* (candidate: Candidate) {
      const file = yield* projectFile(root, candidate.config, 0, budget);
      if (file === undefined || files.includes(file)) return;
      files.push(file);
      if (candidate.name !== undefined) loaded.add(candidate.name);
      for (const name of candidate.loads) loaded.add(name);
    });
    for (const candidate of candidates.toSorted(
      (left, right) => right.loads.length - left.loads.length,
    )) {
      if (files.length >= MAX_SEED_PROJECTS) break;
      if (candidate.name !== undefined && loaded.has(candidate.name)) deferred.push(candidate);
      else yield* open(candidate);
    }
    for (const candidate of deferred) {
      if (files.length >= MAX_SEED_PROJECTS) break;
      yield* open(candidate);
    }
    return files;
  });

  /**
   * The root's own project; else the projects its solution references, or those up to two
   * folders below it, as many as `pickProjects` chooses.
   */
  const seedFiles = Effect.fn("TypeScriptProject.seedFiles")(function* (root: string) {
    const budget = newBudget();
    const rootListing = yield* list(root);
    for (const name of CONFIG_NAMES) {
      if (!rootListing.files.includes(name)) continue;
      const configPath = path.join(root, name);
      const config = yield* readConfig(root, configPath);
      if (config === undefined) continue;
      const own = yield* ownFile(root, configPath, config, budget);
      if (own !== undefined) return [own];
      const references = referencesOf(configPath, config);
      if (references.length > 0) return yield* pickProjects(root, references, budget);
    }
    const configs: Array<string> = [];
    yield* walk(root, PROJECT_DEPTH, newBudget(), (directory, listing) => {
      const name = CONFIG_NAMES.find((candidate) => listing.files.includes(candidate));
      if (directory !== root && name !== undefined) configs.push(path.join(directory, name));
      return false;
    });
    return yield* pickProjects(root, configs, budget);
  });

  /** `node_modules` folders of the root and of packages up to two folders down, root first. */
  const nodeModulesRoots = Effect.fn("TypeScriptProject.nodeModulesRoots")(function* (
    root: string,
  ) {
    const roots: Array<string> = [];
    yield* walk(root, PROJECT_DEPTH, newBudget(), (directory, listing) => {
      if (listing.directories.includes("node_modules")) {
        roots.push(path.join(directory, "node_modules"));
      }
      return roots.length >= MAX_NODE_MODULES_ROOTS;
    });
    return roots;
  });

  return { seedFiles, nodeModulesRoots };
});
