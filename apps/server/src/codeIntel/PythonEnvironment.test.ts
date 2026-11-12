// @effect-diagnostics nodeBuiltinImport:off -- the tests lay out workspaces, worktrees and fake interpreters on a scratch disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerSettingsError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";

import * as ServerSettings from "../serverSettings.ts";
import * as PythonEnvironment from "./PythonEnvironment.ts";
import { makeWorkspace, writeFiles } from "./testing/harness.ts";

const WORLD = "@WORLD@";

interface World {
  readonly dir: string;
  readonly at: (...parts: ReadonlyArray<string>) => string;
  readonly write: (
    files: Readonly<Record<string, string>>,
  ) => Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path>;
  /** Locates the environment of `root` (a path inside the world, "" for the world itself). */
  readonly locate: (
    root?: string,
    settings?: Readonly<Record<string, string>>,
  ) => Effect.Effect<PythonEnvironment.PythonEnvironmentLocation, ServerSettingsError>;
}

const fill = (dir: string, files: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name, text.replaceAll(WORLD, dir)]),
  );

/** A scratch directory holding `files`; `@WORLD@` in a file's text stands for the directory. */
const inWorld = <A, E>(
  files: Readonly<Record<string, string>>,
  use: (world: World) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  options: {
    readonly environment?: (dir: string) => NodeJS.ProcessEnv;
    readonly homeName?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const dir = yield* makeWorkspace({});
    yield* writeFiles(dir, fill(dir, files));
    const layer = (pythonEnvironments: Readonly<Record<string, string>>) =>
      PythonEnvironment.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.ServerSettingsService.layerTest({ codeIntel: { pythonEnvironments } }),
            Layer.succeed(
              HostProcess.HomeDirectory,
              NodePath.join(dir, options.homeName ?? "home"),
            ),
            Layer.succeed(HostProcess.Environment, options.environment?.(dir) ?? {}),
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
    const world: World = {
      dir,
      at: (...parts) => NodePath.join(dir, ...parts),
      write: (more) => writeFiles(dir, fill(dir, more)),
      locate: (root = "", settings = {}) =>
        Effect.flatMap(PythonEnvironment.PythonEnvironment, (python) =>
          python.locate(NodePath.join(dir, root)),
        ).pipe(Effect.provide(layer(settings))),
    };
    return yield* use(world);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const NONE = { source: "none", libraryRoots: [] } as const;

/** A virtualenv at `prefix`, whose base interpreter lives in `base/`. */
const venv = (
  prefix: string,
  options: { readonly cfg?: string; readonly site?: boolean } = {},
): Record<string, string> => ({
  [`${prefix}/pyvenv.cfg`]:
    options.cfg ??
    `home = ${WORLD}/base/bin\ninclude-system-site-packages = false\nversion = 3.12.1\n`,
  ...(options.site === false ? {} : { [`${prefix}/lib/python3.12/site-packages/.keep`]: "" }),
});

const BASE: Record<string, string> = { "base/lib/python3.12/os.py": "" };

const executable = (file: string, text: string) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, text, { mode: 0o755 });
  NodeFS.chmodSync(file, 0o755);
};

describe("PythonEnvironment", () => {
  describe("a virtualenv by its directory name", () => {
    it.effect("finds a root .venv and describes it from pyvenv.cfg", () =>
      inWorld({ ...BASE, ...venv(".venv") }, (world) =>
        Effect.gen(function* () {
          const location = yield* world.locate();

          expect(location).toEqual({
            source: "root",
            environment: world.at(".venv"),
            interpreter: { path: world.at(".venv", "bin", "python"), version: "3.12.1" },
            libraryRoots: [
              {
                path: world.at(".venv", "lib", "python3.12", "site-packages"),
                label: expect.any(String),
                kind: "site-packages",
              },
              {
                path: world.at("base", "lib", "python3.12"),
                label: expect.any(String),
                kind: "stdlib",
              },
            ],
          });
        }),
      ),
    );

    it.effect("finds venv when there is no .venv, and prefers .venv when there are both", () =>
      inWorld({ ...BASE, ...venv("venv") }, (world) =>
        Effect.gen(function* () {
          expect(yield* world.locate()).toMatchObject({
            source: "root",
            environment: world.at("venv"),
          });
          yield* world.write(venv(".venv"));
          expect(yield* world.locate()).toMatchObject({ environment: world.at(".venv") });
        }),
      ),
    );

    it.effect("counts a candidate only when it holds a pyvenv.cfg", () =>
      inWorld(
        {
          ".venv/bin/python": "",
          ".venv/lib/python3.12/site-packages/.keep": "",
          "venv/pyvenv.cfg/inside": "a directory named pyvenv.cfg",
          "env/pyvenv.cfg": "version = 3.12.1\n",
        },
        (world) =>
          Effect.gen(function* () {
            expect(yield* world.locate()).toEqual(NONE);
            yield* world.write(venv(".venv"));
            expect(yield* world.locate()).toMatchObject({ source: "root" });
          }),
      ),
    );

    it.effect.each([
      { name: "version", cfg: "home = @WORLD@/base/bin\nversion = 3.12.1\n", version: "3.12.1" },
      {
        name: "version_info",
        cfg: "home = @WORLD@/base/bin\nversion_info = 3.12.1.final.0\n",
        version: "3.12.1",
      },
      {
        name: "a two-part version",
        cfg: "home = @WORLD@/base/bin\nversion = 3.12\n",
        version: "3.12",
      },
      {
        name: "a capitalised key and CRLF lines",
        cfg: "home = @WORLD@/base/bin\r\nVersion = 3.12.1\r\n",
        version: "3.12.1",
      },
      {
        name: "no spaces around =",
        cfg: "home=@WORLD@/base/bin\nversion=3.12.1\n",
        version: "3.12.1",
      },
    ])("reads the version from $name", (row) =>
      inWorld({ ...BASE, ...venv(".venv", { cfg: row.cfg }) }, (world) =>
        Effect.gen(function* () {
          const location = yield* world.locate();

          expect(location.interpreter?.version).toBe(row.version);
          expect(location.libraryRoots.map((root) => root.kind)).toEqual([
            "site-packages",
            "stdlib",
          ]);
        }),
      ),
    );

    it.effect("has no version, and so no library roots, when pyvenv.cfg names none", () =>
      inWorld({ ...BASE, ...venv(".venv", { cfg: "home = @WORLD@/base/bin\n" }) }, (world) =>
        Effect.gen(function* () {
          const location = yield* world.locate();

          expect(location).toMatchObject({ source: "root", environment: world.at(".venv") });
          expect(location.interpreter).toEqual({ path: world.at(".venv", "bin", "python") });
          expect(location.libraryRoots).toEqual([]);
        }),
      ),
    );

    it.effect("lists only the library directories that exist", () =>
      inWorld({ ...venv(".venv", { site: false }), ...BASE }, (world) =>
        Effect.gen(function* () {
          expect((yield* world.locate()).libraryRoots).toEqual([
            {
              path: world.at("base", "lib", "python3.12"),
              label: expect.any(String),
              kind: "stdlib",
            },
          ]);

          yield* world.write(venv(".venv"));
          NodeFS.rmSync(world.at("base"), { recursive: true });
          expect((yield* world.locate()).libraryRoots).toEqual([
            {
              path: world.at(".venv", "lib", "python3.12", "site-packages"),
              label: expect.any(String),
              kind: "site-packages",
            },
          ]);

          yield* world.write(venv(".venv", { cfg: "version = 3.12.1\n" }));
          expect((yield* world.locate()).libraryRoots.map((root) => root.kind)).toEqual([
            "site-packages",
          ]);
        }),
      ),
    );

    it.effect("looks for the library directories of the version the file names, not another", () =>
      inWorld(
        {
          ...BASE,
          ...venv(".venv", { site: false, cfg: "home = @WORLD@/base/bin\nversion = 3.11.4\n" }),
          ".venv/lib/python3.12/site-packages/.keep": "",
        },
        (world) =>
          Effect.gen(function* () {
            expect((yield* world.locate()).libraryRoots).toEqual([]);
          }),
      ),
    );
  });

  describe("a virtualenv a config names", () => {
    it.effect("takes pyrightconfig.json venvPath and venv over a stray root .venv", () =>
      inWorld(
        {
          ...BASE,
          ...venv(".venv"),
          ...venv("envs/real"),
          "pyrightconfig.json": JSON.stringify({ venvPath: "envs", venv: "real" }),
        },
        (world) =>
          Effect.gen(function* () {
            expect(yield* world.locate()).toMatchObject({
              source: "root",
              environment: world.at("envs", "real"),
            });
          }),
      ),
    );

    it.effect("finds the config in an immediate subdirectory, beside a stray root .venv", () =>
      inWorld(
        {
          ...BASE,
          ...venv(".venv"),
          ...venv("backend/.venv"),
          "backend/pyrightconfig.json": JSON.stringify({ venvPath: ".", venv: ".venv" }),
          "backend/app.py": "",
        },
        (world) =>
          Effect.gen(function* () {
            expect(yield* world.locate()).toMatchObject({
              environment: world.at("backend", ".venv"),
            });
          }),
      ),
    );

    it.effect(
      "falls through to a bare .venv when the configured one has no pyvenv.cfg or is half set",
      () =>
        inWorld(
          {
            ...BASE,
            ...venv(".venv"),
            "pyrightconfig.json": JSON.stringify({ venvPath: "envs", venv: "gone" }),
          },
          (world) =>
            Effect.gen(function* () {
              expect(yield* world.locate()).toMatchObject({ environment: world.at(".venv") });
              yield* world.write({ "pyrightconfig.json": JSON.stringify({ venv: "gone" }) });
              expect(yield* world.locate()).toMatchObject({ environment: world.at(".venv") });
            }),
        ),
    );

    it.effect.each([
      {
        name: "pyproject.toml [tool.pyright] venvPath and venv",
        toml: "[tool.pyright]\nvenvPath = \"envs\"   # where they live\nvenv = 'py'\n",
        venv: "envs/py",
      },
      {
        name: "pyproject.toml [tool.ty.environment] python, a virtualenv directory",
        toml: '[project]\nname = "x"\n\n[tool.ty.environment]\npython = ".venv-ty"\n',
        venv: ".venv-ty",
      },
      {
        name: "pyproject.toml [tool.ty.environment] python, the interpreter inside it",
        toml: '[tool.ty.environment]\npython = ".venv-ty/bin/python"\n',
        venv: ".venv-ty",
      },
      {
        name: "a quoted table header",
        toml: '[tool."pyright"]\nvenvPath = "."\nvenv = ".venv-ty"\n',
        venv: ".venv-ty",
      },
    ])("reads $name", (row) =>
      inWorld(
        {
          ...BASE,
          ...venv(".venv"),
          ...venv(row.venv),
          ...(row.venv === ".venv-ty" ? { ".venv-ty/bin/python": "" } : {}),
          "pyproject.toml": row.toml,
        },
        (world) =>
          Effect.gen(function* () {
            expect(yield* world.locate()).toMatchObject({
              source: "root",
              environment: world.at(row.venv),
            });
          }),
      ),
    );

    it.effect.each([
      {
        name: "a venv key in another table",
        toml: '[tool.other]\nvenvPath = "."\nvenv = ".other"\n',
      },
      { name: "an array of tables", toml: '[[tool.pyright]]\nvenvPath = "."\nvenv = ".other"\n' },
      {
        name: "an inline table",
        toml: 'tool = { pyright = { venvPath = ".", venv = ".other" } }\n',
      },
      {
        name: "a commented-out table",
        toml: '# [tool.pyright]\n# venvPath = "."\n# venv = ".other"\n',
      },
      {
        name: "a table closed before the keys",
        toml: '[tool.pyright]\n[tool.other]\nvenvPath = "."\nvenv = ".other"\n',
      },
    ])("ignores $name", (row) =>
      inWorld(
        { ...BASE, ...venv(".venv"), ...venv(".other"), "pyproject.toml": row.toml },
        (world) =>
          Effect.gen(function* () {
            expect(yield* world.locate()).toMatchObject({ environment: world.at(".venv") });
          }),
      ),
    );

    it.effect(
      "tries pyrightconfig.json, then [tool.pyright], then [tool.ty.environment] in one directory",
      () =>
        inWorld(
          {
            ...BASE,
            ...venv("a"),
            ...venv("b"),
            ...venv("c"),
            "pyrightconfig.json": JSON.stringify({ venvPath: ".", venv: "a" }),
            "pyproject.toml":
              '[tool.pyright]\nvenvPath = "."\nvenv = "b"\n[tool.ty.environment]\npython = "c"\n',
          },
          (world) =>
            Effect.gen(function* () {
              expect(yield* world.locate()).toMatchObject({ environment: world.at("a") });
              NodeFS.rmSync(world.at("pyrightconfig.json"));
              expect(yield* world.locate()).toMatchObject({ environment: world.at("b") });
              NodeFS.rmSync(world.at("b"), { recursive: true });
              expect(yield* world.locate()).toMatchObject({ environment: world.at("c") });
            }),
        ),
    );

    it.effect(
      "prefers a config in the root over one in a subdirectory, and either over a bare venv",
      () =>
        inWorld(
          {
            ...BASE,
            ...venv(".venv"),
            ...venv("sub/own"),
            ...venv("top"),
            "sub/pyrightconfig.json": JSON.stringify({ venvPath: ".", venv: "own" }),
          },
          (world) =>
            Effect.gen(function* () {
              expect(yield* world.locate()).toMatchObject({ environment: world.at("sub", "own") });
              yield* world.write({
                "pyrightconfig.json": JSON.stringify({ venvPath: ".", venv: "top" }),
              });
              expect(yield* world.locate()).toMatchObject({ environment: world.at("top") });
            }),
        ),
    );
  });

  describe("subdirectories", () => {
    it.effect("looks in the root first, then in immediate subdirectories in name order", () =>
      inWorld({ ...BASE, ...venv("b/.venv"), ...venv("a/.venv") }, (world) =>
        Effect.gen(function* () {
          expect(yield* world.locate()).toMatchObject({ environment: world.at("a", ".venv") });
          yield* world.write(venv(".venv"));
          expect(yield* world.locate()).toMatchObject({ environment: world.at(".venv") });
        }),
      ),
    );

    it.effect(
      "skips dot-directories, node_modules, site-packages, __pycache__ and anything deeper",
      () => {
        const skipped = [".hidden", "node_modules", "site-packages", "__pycache__", "a/deeper"];
        return inWorld(
          Object.fromEntries(
            skipped.flatMap((name) => [
              ...Object.entries(venv(`${name}/.venv`)),
              ...Object.entries(venv(`${name}/venv`)),
              [
                `${name}/pyrightconfig.json`,
                JSON.stringify({ venvPath: ".", venv: ".venv" }),
              ] as const,
            ]),
          ),
          (world) =>
            Effect.gen(function* () {
              expect(yield* world.locate()).toEqual(NONE);
              yield* world.write({ ...BASE, ...venv("z/.venv") });
              expect(yield* world.locate()).toMatchObject({ environment: world.at("z", ".venv") });
            }),
        );
      },
    );

    it.effect("looks at no more than 64 subdirectories", () => {
      const names = Array.from({ length: 66 }, (_, index) => `d${String(index).padStart(2, "0")}`);
      const files = Object.fromEntries(names.map((name) => [`${name}/app.py`, ""]));
      return inWorld(
        {
          ...files,
          ...venv("d64/.venv"),
          "d65/pyrightconfig.json": JSON.stringify({ venvPath: ".", venv: ".venv" }),
          ...venv("d65/.venv"),
        },
        (world) =>
          Effect.gen(function* () {
            expect(yield* world.locate()).toEqual(NONE);
            // No `base` directory here: it would sort ahead of d00 and push d63 out of the 64.
            yield* world.write(venv("d63/.venv"));
            expect(yield* world.locate()).toMatchObject({ environment: world.at("d63", ".venv") });
          }),
      );
    });
  });

  describe("a linked git worktree", () => {
    const main = {
      ...BASE,
      "main/.git/HEAD": "ref: refs/heads/main\n",
      "main/.git/worktrees/wt/commondir": "../..\n",
      "main/backend/pyrightconfig.json": JSON.stringify({ venvPath: ".", venv: ".venv" }),
      ...venv("main/backend/.venv"),
      "wt/.git": "gitdir: @WORLD@/main/.git/worktrees/wt\n",
      "wt/backend/app.py": "",
      "wt/backend/deeper/more/app.py": "",
    };

    it.effect("borrows the main checkout's virtualenv at the same relative place", () =>
      inWorld(main, (world) =>
        Effect.gen(function* () {
          const expected = {
            source: "main-checkout",
            environment: world.at("main", "backend", ".venv"),
            interpreter: {
              path: world.at("main", "backend", ".venv", "bin", "python"),
              version: "3.12.1",
            },
          };
          expect(yield* world.locate("wt")).toMatchObject(expected);
          expect(yield* world.locate("wt/backend")).toMatchObject(expected);
          expect(yield* world.locate("wt/backend/deeper/more")).toEqual(NONE);
        }),
      ),
    );

    it.effect(
      "reads a gitdir written as a relative path, and a commondir written as an absolute one",
      () =>
        inWorld(main, (world) =>
          Effect.gen(function* () {
            yield* world.write({ "wt/.git": "gitdir: ../main/.git/worktrees/wt\n" });
            expect(yield* world.locate("wt")).toMatchObject({ source: "main-checkout" });

            yield* world.write({
              "main/.git/worktrees/wt/commondir": `${world.at("main", ".git")}\n`,
            });
            expect(yield* world.locate("wt")).toMatchObject({ source: "main-checkout" });
          }),
        ),
    );

    it.effect("keeps a virtualenv of its own ahead of the main checkout's", () =>
      inWorld({ ...main, ...venv("wt/.venv") }, (world) =>
        Effect.gen(function* () {
          expect(yield* world.locate("wt")).toMatchObject({
            source: "root",
            environment: world.at("wt", ".venv"),
          });
        }),
      ),
    );

    it.effect(
      "finds the worktree's .git from a root inside it, and applies the rule at that place only",
      () =>
        inWorld(
          { ...main, ...venv("main/.venv"), "main/other/app.py": "", "wt/other/app.py": "" },
          (world) =>
            Effect.gen(function* () {
              // `main/backend` is where the root maps; the main checkout's root .venv is not there.
              expect(yield* world.locate("wt/other")).toEqual(NONE);
              expect(yield* world.locate("wt/backend")).toMatchObject({ source: "main-checkout" });
            }),
        ),
    );

    it.effect("gives none when the main checkout has no virtualenv", () =>
      inWorld(
        {
          ...BASE,
          "main/.git/worktrees/wt/commondir": "../..\n",
          "wt/.git": "gitdir: @WORLD@/main/.git/worktrees/wt\n",
        },
        (world) =>
          Effect.gen(function* () {
            expect(yield* world.locate("wt")).toEqual(NONE);
          }),
      ),
    );

    it.effect("gives none for the main checkout itself, whose .git is a directory", () =>
      inWorld({ "main/.git/HEAD": "", "main/app.py": "", ...venv("elsewhere/.venv") }, (world) =>
        Effect.gen(function* () {
          expect(yield* world.locate("main")).toEqual(NONE);
        }),
      ),
    );

    it.effect("gives none for a worktree of a bare repository", () =>
      inWorld(
        {
          ...BASE,
          // A decoy where a careless reading would look: the parent of the common directory.
          ...venv(".venv"),
          "proj.git/HEAD": "",
          "proj.git/worktrees/wt/commondir": "../..\n",
          "wt/.git": "gitdir: @WORLD@/proj.git/worktrees/wt\n",
        },
        (world) =>
          Effect.gen(function* () {
            expect(yield* world.locate("wt")).toEqual(NONE);
          }),
      ),
    );

    it.effect("gives none for a submodule, which has no commondir", () =>
      inWorld(
        {
          ...BASE,
          ...venv("super/.venv"),
          "super/.git/modules/sub/HEAD": "",
          "super/sub/.git": "gitdir: ../.git/modules/sub\n",
          "super/sub/app.py": "",
        },
        (world) =>
          Effect.gen(function* () {
            expect(yield* world.locate("super/sub")).toEqual(NONE);
          }),
      ),
    );

    it.effect.each([
      { name: "a .git file with no gitdir line", git: "not a pointer\n" },
      { name: "a gitdir that does not exist", git: "gitdir: /nonexistent/place\n" },
      { name: "an empty .git file", git: "" },
    ])("gives none for $name", (row) =>
      inWorld({ ...main, "wt/.git": row.git }, (world) =>
        Effect.gen(function* () {
          expect(yield* world.locate("wt")).toEqual(NONE);
        }),
      ),
    );

    it.effect("stops at the nearest .git: a directory there ends the search", () =>
      inWorld({ ...main, "wt/inner/.git/HEAD": "", "wt/inner/app.py": "" }, (world) =>
        Effect.gen(function* () {
          expect(yield* world.locate("wt/inner")).toEqual(NONE);
        }),
      ),
    );
  });

  describe("the user's pythonEnvironments", () => {
    it.effect(
      "takes a virtualenv directory, describes it, and wins over what the workspace names",
      () =>
        inWorld(
          {
            ...BASE,
            ...venv(".venv"),
            ...venv("custom/env", { cfg: "home = @WORLD@/base/bin\nversion = 3.12.1\n" }),
            "pyrightconfig.json": JSON.stringify({ venvPath: ".", venv: ".venv" }),
          },
          (world) =>
            Effect.gen(function* () {
              const location = yield* world.locate("", { [world.dir]: world.at("custom", "env") });

              expect(location).toMatchObject({
                source: "setting",
                environment: world.at("custom", "env"),
                interpreter: {
                  path: world.at("custom", "env", "bin", "python"),
                  version: "3.12.1",
                },
              });
              expect(location.libraryRoots.map((root) => root.kind)).toEqual([
                "site-packages",
                "stdlib",
              ]);
              expect(location.problem).toBeUndefined();
            }),
        ),
    );

    it.effect("takes an interpreter inside a virtualenv as that virtualenv", () =>
      inWorld({ ...BASE, ...venv("custom/env"), "custom/env/bin/python3.12": "" }, (world) =>
        Effect.gen(function* () {
          for (const name of ["python3.12", "python"]) {
            yield* world.write({ [`custom/env/bin/${name}`]: "" });
            expect(
              yield* world.locate("", { [world.dir]: world.at("custom", "env", "bin", name) }),
            ).toMatchObject({ source: "setting", environment: world.at("custom", "env") });
          }
        }),
      ),
    );

    it.effect("passes any other existing path through as given", () =>
      inWorld({ "somewhere/lib.py": "" }, (world) =>
        Effect.gen(function* () {
          expect(yield* world.locate("", { [world.dir]: world.at("somewhere") })).toEqual({
            source: "setting",
            environment: world.at("somewhere"),
            libraryRoots: [],
          });
        }),
      ),
    );

    it.effect(
      "says setting_path_missing for a path that does not exist, and never falls through",
      () =>
        inWorld({ ...BASE, ...venv(".venv") }, (world) =>
          Effect.gen(function* () {
            expect(yield* world.locate("", { [world.dir]: world.at("gone") })).toEqual({
              source: "none",
              problem: "setting_path_missing",
              libraryRoots: [],
            });
            expect(yield* world.locate()).toMatchObject({ source: "root" });
          }),
        ),
    );

    it.effect("treats an empty path as unset, and ignores a setting for another root", () =>
      inWorld({ ...BASE, ...venv(".venv"), "other/app.py": "" }, (world) =>
        Effect.gen(function* () {
          expect(yield* world.locate("", { [world.dir]: "" })).toMatchObject({ source: "root" });
          expect(yield* world.locate("", { [world.at("other")]: world.at("gone") })).toMatchObject({
            source: "root",
          });
        }),
      ),
    );

    it.effect("expands a leading ~ against the home directory", () =>
      inWorld({ ...BASE, ...venv("home/envs/mine") }, (world) =>
        Effect.gen(function* () {
          expect(yield* world.locate("", { [world.dir]: "~/envs/mine" })).toMatchObject({
            source: "setting",
            environment: world.at("home", "envs", "mine"),
          });
        }),
      ),
    );
  });

  describe("never failing, never running anything", () => {
    it.effect("gives none for a root that does not exist, or is a file", () =>
      inWorld({ afile: "text" }, (world) =>
        Effect.gen(function* () {
          expect(yield* world.locate("missing")).toEqual(NONE);
          expect(yield* world.locate("afile")).toEqual(NONE);
        }),
      ),
    );

    it.effect("ignores config files that are broken, the wrong shape, or directories", () =>
      inWorld(
        {
          ...BASE,
          ...venv(".venv"),
          "a/pyrightconfig.json": "{ not json",
          "b/pyrightconfig.json": "[]",
          "c/pyrightconfig.json": JSON.stringify({ venvPath: 3, venv: [".venv"] }),
          "d/pyrightconfig.json/inside": "a directory",
          "e/pyproject.toml": '[tool.pyright\nvenv = "x\n\u0000\u0001',
          "f/pyproject.toml/inside": "a directory",
          "g/pyrightconfig.json": '{ // comments are allowed by pyright\n "venv": ".venv" }',
        },
        (world) =>
          Effect.gen(function* () {
            expect(yield* world.locate()).toMatchObject({
              source: "root",
              environment: world.at(".venv"),
            });
          }),
      ),
    );

    it.effect(
      "skips a config over 1 MB, and takes a pyvenv.cfg over 1 MB as a virtualenv with no details",
      () =>
        inWorld(
          {
            ...BASE,
            ...venv(".venv"),
            ...venv("real"),
            "pyproject.toml": `[tool.pyright]\nvenvPath = "."\nvenv = "real"\n# ${"x".repeat(1024 * 1024)}\n`,
          },
          (world) =>
            Effect.gen(function* () {
              expect(yield* world.locate()).toMatchObject({ environment: world.at(".venv") });

              yield* world.write({
                ".venv/pyvenv.cfg": `home = ${world.at("base", "bin")}\nversion = 3.12.1\n# ${"x".repeat(1024 * 1024)}\n`,
              });
              const location = yield* world.locate();
              expect(location).toMatchObject({ source: "root", environment: world.at(".venv") });
              expect(location.interpreter?.version).toBeUndefined();
              expect(location.libraryRoots).toEqual([]);
            }),
        ),
    );

    it.effect(
      "treats a dangling symlink, or a file, where a virtualenv should be as no virtualenv",
      () =>
        inWorld({ venv: "a file", ".git": "" }, (world) =>
          Effect.gen(function* () {
            NodeFS.symlinkSync(world.at("nowhere"), world.at(".venv"));
            NodeFS.symlinkSync(world.at("nowhere"), world.at("pyrightconfig.json"));
            expect(yield* world.locate()).toEqual(NONE);
          }),
        ),
    );

    it.effect("never executes an interpreter, a ty or a git, whatever the workspace holds", () =>
      inWorld(
        {
          ...BASE,
          ...venv("main/.venv"),
          "main/.git/worktrees/wt/commondir": "../..\n",
          "wt/.git": "gitdir: @WORLD@/main/.git/worktrees/wt\n",
        },
        (world) =>
          Effect.gen(function* () {
            const marker = (name: string) => world.at(`${name}.ran`);
            const script = (name: string) => `#!/bin/sh\ntouch ${marker(name)}\n`;
            for (const venvName of ["main/.venv", "wt/.venv"]) {
              for (const binary of ["python", "python3", "python3.12", "ty"]) {
                executable(
                  world.at(venvName, "bin", binary),
                  script(`${venvName.replace("/", "-")}-${binary}`),
                );
              }
            }
            executable(world.at("pathbin", "git"), script("git"));
            executable(world.at("pathbin", "python"), script("path-python"));

            yield* world.locate("wt");
            yield* world.locate("main");
            yield* world.locate("", { [world.dir]: world.at("main", ".venv", "bin", "python") });
            yield* world.locate("wt", {
              [world.at("wt")]: world.at("wt", ".venv", "bin", "python3.12"),
            });

            expect(NodeFS.readdirSync(world.dir).filter((name) => name.endsWith(".ran"))).toEqual(
              [],
            );
          }),
        { environment: (dir) => ({ PATH: `${NodePath.join(dir, "pathbin")}:/usr/bin:/bin` }) },
      ),
    );

    it.effect("does not write anything", () =>
      inWorld({ ...BASE, ...venv(".venv") }, (world) =>
        Effect.gen(function* () {
          const before = NodeFS.readdirSync(world.dir, { recursive: true }).sort();
          yield* world.locate();
          yield* world.locate("", { [world.dir]: world.at("gone") });
          expect(NodeFS.readdirSync(world.dir, { recursive: true }).sort()).toEqual(before);
        }),
      ),
    );
  });
});
