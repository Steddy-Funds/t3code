// @effect-diagnostics nodeBuiltinImport:off -- the tests put executables and symlinks on a scratch disk and watch it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerSettings as ServerSettingsValue } from "@t3tools/contracts";
import type { DeepPartial } from "@t3tools/shared/Struct";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HttpClientError from "effect/http/HttpClientError";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as LanguageServerBinaries from "./LanguageServerBinaries.ts";
import { forkRequest, makeWorkspace } from "./testing/harness.ts";
import { gzip, sha256Hex, tar, tarGz, type TarMember } from "./testing/tarball.ts";

type TyRelease = NonNullable<LanguageServerBinaries.LanguageServerBinariesOptions["tyRelease"]>;
type Respond = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<Response, HttpClientError.HttpClientError>;

const TARGET = "x86_64-unknown-linux-gnu";
const MEMBER_DIR = `ty-${TARGET}`;
const TY_BYTES = "#!/bin/sh\necho ty\n";
const ASSET_URL = `https://github.com/astral-sh/ty/releases/download/0.0.94/ty-${TARGET}.tar.gz`;

/** An asset whose pinned size and sha256 describe `archive`, as the table's rows describe the real one. */
const releaseFor = (archive: Uint8Array): TyRelease => ({
  target: TARGET,
  sha256: sha256Hex(archive),
  bytes: archive.length,
});

const tyArchive = (content = TY_BYTES) => tarGz([{ name: `${MEMBER_DIR}/ty`, content }]);

const body = (bytes: Uint8Array) => bytes as unknown as ConstructorParameters<typeof Response>[0];
const serve =
  (bytes: Uint8Array): Respond =>
  () =>
    Effect.succeed(new Response(body(bytes)));
const status =
  (code: number): Respond =>
  () =>
    Effect.succeed(new Response("not here", { status: code }));
const transportFailure: Respond = (request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request,
        description: "private-host.example refused the connection",
        cause: new Error("private cause details"),
      }),
    }),
  );
const connectionReset: Respond = () =>
  Effect.succeed(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.error(new Error("connection reset"));
        },
      }),
    ),
  );

interface RigOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly libc?: "gnu" | "musl";
  /** Left out, the module's own table row for the platform is used. */
  readonly tyRelease?: TyRelease;
  readonly serverPaths?: Readonly<Record<string, string>>;
  /** Known workspace roots, as real paths. */
  readonly projects?: ReadonlyArray<string>;
  readonly home?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly workingDirectory?: string;
  /** The installed `typescript` package's own lookup, instead of the stand-in. */
  readonly realTypeScript?: boolean;
  readonly respond?: Respond;
}

const rigLayer = (rig: Rig, options: RigOptions) => {
  const http = HttpClient.make((request) =>
    Effect.suspend(() => {
      rig.requests.push(request.url);
      return rig.respond(request).pipe(
        Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      );
    }),
  );
  const settings: DeepPartial<ServerSettingsValue> = {
    codeIntel: { serverPaths: { ...options.serverPaths } },
  };
  const dependencies = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, http),
    ServerSettings.ServerSettingsService.layerTest(settings),
    Layer.succeed(HostProcess.Platform, options.platform ?? "linux"),
    Layer.succeed(HostProcess.Architecture, options.arch ?? "x64"),
    Layer.succeed(HostProcess.LinuxLibc, options.libc ?? "gnu"),
    Layer.succeed(HostProcess.HomeDirectory, options.home ?? "/nonexistent-home"),
    Layer.succeed(HostProcess.Environment, options.environment ?? {}),
    Layer.succeed(HostProcess.WorkingDirectory, options.workingDirectory ?? NodeProcess.cwd()),
    ServerConfig.ServerConfig.layerTest(NodeProcess.cwd(), { prefix: "t3-code-intel-binaries-" }),
    NodeCrypto.layer,
    Layer.mock(KnownWorkspaces.KnownWorkspaces)({
      contains: (realPath) =>
        Effect.succeed(
          (options.projects ?? []).some(
            (root) => realPath === root || realPath.startsWith(root + NodePath.sep),
          ),
        ),
    }),
  );
  return Layer.effect(
    LanguageServerBinaries.LanguageServerBinaries,
    LanguageServerBinaries.make({
      ...(options.tyRelease === undefined ? {} : { tyRelease: options.tyRelease }),
      ...(options.realTypeScript === true
        ? {}
        : {
            locateTypeScript: () => {
              if (rig.typescript === undefined) throw new Error("no platform package");
              return rig.typescript;
            },
          }),
    }),
  ).pipe(Layer.provideMerge(dependencies), Layer.provideMerge(NodeServices.layer));
};

interface Rig {
  readonly requests: Array<string>;
  respond: Respond;
  typescript: { readonly command: string; readonly version: string } | undefined;
}

/** The module under test on a scratch state directory, with no way to reach the network. */
const inRig = <A, E>(
  options: RigOptions,
  use: (rig: Rig & Services) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.suspend(() => {
    const rig: Rig = {
      requests: [],
      respond: options.respond ?? status(404),
      typescript: { command: "/opt/tsc/tsc", version: "7.0.2" },
    };
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      return yield* use(
        Object.assign(rig, {
          binaries: yield* LanguageServerBinaries.LanguageServerBinaries,
          settings: yield* ServerSettings.ServerSettingsService,
          stateDir: config.stateDir,
          tyDirectory: path.join(config.stateDir, "language-servers", "ty", "0.0.94"),
          tyPath: path.join(config.stateDir, "language-servers", "ty", "0.0.94", "ty"),
        }),
      );
    }).pipe(Effect.provide(rigLayer(rig, options)), Effect.scoped);
  });

interface Services {
  readonly binaries: LanguageServerBinaries.LanguageServerBinaries["Service"];
  readonly settings: ServerSettings.ServerSettingsService["Service"];
  readonly stateDir: string;
  readonly tyDirectory: string;
  readonly tyPath: string;
}

const inScratch = <A, E>(use: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.flatMap(makeWorkspace({}), use).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** Returns once the call has begun waiting on the install, which it does without yielding the fiber. */
const startInstall = Effect.fnUntraced(function* (
  binaries: LanguageServerBinaries.LanguageServerBinaries["Service"],
) {
  const started = yield* Deferred.make<void>();
  const call = yield* forkRequest(
    Deferred.succeed(started, undefined).pipe(Effect.andThen(binaries.install("python"))),
  );
  yield* Deferred.await(started);
  return call;
});

const listing = (directory: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.readDirectory(directory, { recursive: true }),
  ).pipe(Effect.map((entries) => [...entries].sort()));

const putExecutable = (file: string, contents = TY_BYTES) =>
  Effect.sync(() => {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, contents, { mode: 0o755 });
    NodeFS.chmodSync(file, 0o755);
  });

const installFailure = <A>(effect: Effect.Effect<A, LanguageServerBinaries.LanguageServerInstallError>) =>
  effect.pipe(Effect.flip);

describe("LanguageServerBinaries", () => {
  describe("resolve", () => {
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty", "ruby", ""]) {
      it.effect(`says ${JSON.stringify(id)} is an unknown language that cannot be installed`, () =>
        inRig({ serverPaths: { [id]: "/bin/sh" } }, ({ binaries }) =>
          Effect.gen(function* () {
            expect(yield* binaries.resolve(id)).toMatchObject({
              _tag: "Unavailable",
              languageId: id,
              reason: "unknown_language",
              installable: false,
            });
          }),
        ),
      );
    }

    it.effect("reports a missing ty as installable, and sees it appear and disappear with no restart", () =>
      inRig({}, ({ binaries, tyPath, tyDirectory }) =>
        Effect.gen(function* () {
          const missing = yield* binaries.resolve("python");
          expect(missing).toMatchObject({
            _tag: "Unavailable",
            languageId: "python",
            name: "ty",
            reason: "not_installed",
            installable: true,
          });
          expect(missing._tag === "Unavailable" ? missing.message : "").toContain("0.0.94");

          yield* putExecutable(tyPath);
          expect(yield* binaries.resolve("python")).toEqual({
            _tag: "LaunchSpec",
            languageId: "python",
            name: "ty",
            version: "0.0.94",
            command: tyPath,
            args: ["server"],
            source: "managed",
          });

          NodeFS.rmSync(tyDirectory, { recursive: true });
          expect(yield* binaries.resolve("python")).toMatchObject({
            _tag: "Unavailable",
            reason: "not_installed",
          });
        }),
      ),
    );

    it.effect("does not take a file that is not executable, or a directory, for the managed binary", () =>
      inRig({}, ({ binaries, tyPath }) =>
        Effect.gen(function* () {
          yield* putExecutable(tyPath);
          NodeFS.chmodSync(tyPath, 0o644);
          expect(yield* binaries.resolve("python")).toMatchObject({ reason: "not_installed" });

          NodeFS.rmSync(tyPath);
          NodeFS.mkdirSync(tyPath);
          NodeFS.chmodSync(tyPath, 0o755);
          expect(yield* binaries.resolve("python")).toMatchObject({ reason: "not_installed" });
        }),
      ),
    );

    for (const row of [
      { platform: "linux", arch: "x64", libc: "gnu", reason: "not_installed", installable: true },
      { platform: "linux", arch: "arm64", libc: "gnu", reason: "not_installed", installable: true },
      { platform: "darwin", arch: "arm64", libc: "gnu", reason: "not_installed", installable: true },
      { platform: "darwin", arch: "x64", libc: "gnu", reason: "not_installed", installable: true },
      { platform: "linux", arch: "x64", libc: "musl", reason: "unsupported_platform", installable: false },
      { platform: "linux", arch: "arm64", libc: "musl", reason: "unsupported_platform", installable: false },
      { platform: "win32", arch: "x64", libc: "gnu", reason: "unsupported_platform", installable: false },
      { platform: "linux", arch: "ia32", libc: "gnu", reason: "unsupported_platform", installable: false },
      { platform: "freebsd", arch: "x64", libc: "gnu", reason: "unsupported_platform", installable: false },
    ] as const) {
      it.effect(`resolves ty on ${row.platform}-${row.arch}${row.platform === "linux" ? `-${row.libc}` : ""} as ${row.reason}`, () =>
        inRig(row, ({ binaries }) =>
          Effect.gen(function* () {
            expect(yield* binaries.resolve("python")).toMatchObject({
              _tag: "Unavailable",
              reason: row.reason,
              installable: row.installable,
            });
          }),
        ),
      );
    }

    describe("the user's serverPaths", () => {
      it.effect("uses an existing file as given, with the default args and no version", () =>
        inScratch((dir) => Effect.gen(function* () {
          const ty = NodePath.join(dir, "my-ty");
          const tsc = NodePath.join(dir, "my-tsc");
          yield* putExecutable(ty);
          yield* putExecutable(tsc);
          yield* inRig({ serverPaths: { python: ty, typescript: tsc } }, ({ binaries }) =>
            Effect.gen(function* () {
              expect(yield* binaries.resolve("python")).toEqual({
                _tag: "LaunchSpec",
                languageId: "python",
                name: "ty",
                version: undefined,
                command: ty,
                args: ["server"],
                source: "setting",
              });
              expect(yield* binaries.resolve("typescript")).toEqual({
                _tag: "LaunchSpec",
                languageId: "typescript",
                name: "TypeScript",
                version: undefined,
                command: tsc,
                args: ["--lsp", "--stdio"],
                source: "setting",
              });
            }),
          );
        })),
      );

      it.effect("wins over the managed binary, and never falls through when its file is gone", () =>
        inScratch((dir) => Effect.gen(function* () {
          const ty = NodePath.join(dir, "my-ty");
          yield* putExecutable(ty);
          yield* inRig({ serverPaths: { python: ty } }, ({ binaries, tyPath }) =>
            Effect.gen(function* () {
              yield* putExecutable(tyPath);
              expect(yield* binaries.resolve("python")).toMatchObject({ source: "setting" });

              NodeFS.rmSync(ty);
              expect(yield* binaries.resolve("python")).toMatchObject({
                _tag: "Unavailable",
                reason: "setting_path_missing",
                installable: false,
              });
              NodeFS.mkdirSync(ty);
              expect(yield* binaries.resolve("python")).toMatchObject({
                reason: "setting_path_missing",
              });
            }),
          );
        })),
      );

      it.effect("refuses a file inside a project, also through a link from outside it", () =>
        inScratch((dir) => Effect.gen(function* () {
          const project = NodePath.join(dir, "project");
          const inside = NodePath.join(project, "bin", "ty");
          const link = NodePath.join(dir, "ty-link");
          yield* putExecutable(inside);
          NodeFS.symlinkSync(inside, link);
          for (const configured of [inside, link]) {
            yield* inRig(
              { serverPaths: { python: configured }, projects: [NodeFS.realpathSync(project)] },
              ({ binaries }) =>
                Effect.gen(function* () {
                  expect(yield* binaries.resolve("python")).toMatchObject({
                    _tag: "Unavailable",
                    reason: "setting_path_in_project",
                    installable: false,
                  });
                }),
            );
          }
        })),
      );

      it.effect("does not fall through to the bundled TypeScript either", () =>
        inRig({ serverPaths: { typescript: "/nonexistent/tsc" } }, ({ binaries }) =>
          Effect.gen(function* () {
            expect(yield* binaries.resolve("typescript")).toMatchObject({
              _tag: "Unavailable",
              reason: "setting_path_missing",
              installable: false,
            });
          }),
        ),
      );

      for (const relative of ["package.json", "./package.json", "../server/package.json", "src"]) {
        it.effect(`never takes the relative path ${JSON.stringify(relative)}, which would mean the server's cwd`, () =>
          inRig({ serverPaths: { python: relative } }, ({ binaries }) =>
            Effect.gen(function* () {
              expect(NodeFS.existsSync(NodePath.resolve(NodeProcess.cwd(), relative))).toBe(true);
              expect(yield* binaries.resolve("python")).toMatchObject({
                _tag: "Unavailable",
                reason: "setting_path_missing",
                installable: false,
              });
            }),
          ),
        );
      }

      it.effect("treats an empty path as unset, and sees a setting change on the next call", () =>
        inScratch((dir) => Effect.gen(function* () {
          const ty = NodePath.join(dir, "my-ty");
          yield* putExecutable(ty);
          yield* inRig({ serverPaths: { python: "" } }, ({ binaries, settings }) =>
            Effect.gen(function* () {
              expect(yield* binaries.resolve("python")).toMatchObject({ reason: "not_installed" });
              yield* settings.updateSettings({ codeIntel: { serverPaths: { python: ty } } });
              expect(yield* binaries.resolve("python")).toMatchObject({
                source: "setting",
                command: ty,
              });
              yield* settings.updateSettings({ codeIntel: { serverPaths: { python: "" } } });
              expect(yield* binaries.resolve("python")).toMatchObject({ reason: "not_installed" });
            }),
          );
        })),
      );

      it.effect("expands a leading ~ against the home directory", () =>
        inScratch((home) => Effect.gen(function* () {
          yield* putExecutable(NodePath.join(home, "bin", "ty"));
          yield* inRig({ home, serverPaths: { python: "~/bin/ty" } }, ({ binaries }) =>
            Effect.gen(function* () {
              expect(yield* binaries.resolve("python")).toMatchObject({
                source: "setting",
                command: NodePath.join(home, "bin", "ty"),
              });
            }),
          );
        })),
      );

      it.effect("follows a symlink to a file", () =>
        inScratch((dir) => Effect.gen(function* () {
          yield* putExecutable(NodePath.join(dir, "real-ty"));
          NodeFS.symlinkSync(NodePath.join(dir, "real-ty"), NodePath.join(dir, "link-ty"));
          yield* inRig({ serverPaths: { python: NodePath.join(dir, "link-ty") } }, ({ binaries }) =>
            Effect.gen(function* () {
              expect(yield* binaries.resolve("python")).toMatchObject({ source: "setting" });
            }),
          );
        })),
      );
    });

    describe("the bundled TypeScript", () => {
      it.effect("is the package's binary and version, bundled, with the tsc language-server args", () =>
        inRig({}, ({ binaries }) =>
          Effect.gen(function* () {
            expect(yield* binaries.resolve("typescript")).toEqual({
              _tag: "LaunchSpec",
              languageId: "typescript",
              name: "TypeScript",
              version: "7.0.2",
              command: "/opt/tsc/tsc",
              args: ["--lsp", "--stdio"],
              source: "bundled",
            });
          }),
        ),
      );

      it.effect("is unsupported_platform, not installable, while its platform package is missing, and is not cached", () =>
        inRig({ platform: "freebsd" }, (rig) =>
          Effect.gen(function* () {
            rig.typescript = undefined;
            expect(yield* rig.binaries.resolve("typescript")).toMatchObject({
              _tag: "Unavailable",
              reason: "unsupported_platform",
              installable: false,
            });
            rig.typescript = { command: "/opt/tsc/tsc", version: "7.0.2" };
            expect(yield* rig.binaries.resolve("typescript")).toMatchObject({ _tag: "LaunchSpec" });
            rig.typescript = undefined;
            expect(yield* rig.binaries.resolve("typescript")).toMatchObject({
              reason: "unsupported_platform",
            });
          }),
        ),
      );

      it.effect("is found through the installed typescript package, which resolves to a file", () =>
        inRig({ realTypeScript: true }, ({ binaries }) =>
          Effect.gen(function* () {
            const spec = yield* binaries.resolve("typescript");
            expect(spec).toMatchObject({ _tag: "LaunchSpec", source: "bundled", name: "TypeScript" });
            if (spec._tag !== "LaunchSpec") return;
            expect(NodePath.isAbsolute(spec.command)).toBe(true);
            expect(NodeFS.statSync(spec.command).isFile()).toBe(true);
            expect(spec.version).toMatch(/^\d+\.\d+\.\d+/u);
          }),
        ),
      );
    });

    describe("what a workspace cannot do", () => {
      it.effect("does not run what it finds: a setting path, the managed binary, or a ty on PATH", () =>
        inScratch((dir) => Effect.gen(function* () {
          const marker = (name: string) => NodePath.join(dir, `${name}.ran`);
          const script = (name: string) => `#!/bin/sh\ntouch ${marker(name)}\n`;
          yield* putExecutable(NodePath.join(dir, "bin", "ty"), script("path"));
          yield* putExecutable(NodePath.join(dir, "setting-ty"), script("setting"));
          yield* inRig(
            {
              serverPaths: { python: NodePath.join(dir, "setting-ty") },
              environment: { PATH: NodePath.join(dir, "bin") },
              workingDirectory: dir,
            },
            ({ binaries, settings, tyPath }) =>
              Effect.gen(function* () {
                yield* binaries.resolve("python");
                yield* putExecutable(tyPath, script("managed"));
                yield* settings.updateSettings({ codeIntel: { serverPaths: { python: "" } } });
                expect(yield* binaries.resolve("python")).toMatchObject({ source: "managed" });
              }),
          );
          expect(NodeFS.readdirSync(dir).filter((name) => name.endsWith(".ran"))).toEqual([]);
        })),
      );

      it.effect("never resolves a ty from PATH or the working directory", () =>
        inScratch((dir) => Effect.gen(function* () {
          yield* putExecutable(NodePath.join(dir, "bin", "ty"));
          yield* putExecutable(NodePath.join(dir, ".venv", "bin", "ty"));
          yield* putExecutable(NodePath.join(dir, "ty"));
          yield* inRig(
            { environment: { PATH: NodePath.join(dir, "bin") }, workingDirectory: dir },
            ({ binaries }) =>
              Effect.gen(function* () {
                expect(yield* binaries.resolve("python")).toMatchObject({
                  _tag: "Unavailable",
                  reason: "not_installed",
                });
              }),
          );
        })),
      );

      it.effect("makes no request, from resolve, in any state", () =>
        inRig({}, (rig) =>
          Effect.gen(function* () {
            yield* rig.binaries.resolve("python");
            yield* rig.binaries.resolve("typescript");
            yield* rig.binaries.resolve("ruby");
            expect(rig.requests).toEqual([]);
            expect(yield* listing(rig.stateDir)).not.toContain("language-servers");
          }),
        ),
      );
    });
  });

  describe("install", () => {
    it.effect("downloads the pinned asset, unpacks its one binary, and puts it in place executable", () => {
      const archive = tyArchive();
      return inRig({ tyRelease: releaseFor(archive), respond: serve(archive) }, (rig) =>
        Effect.gen(function* () {
          const spec = yield* rig.binaries.install("python");

          expect(rig.requests).toEqual([ASSET_URL]);
          expect(spec).toEqual({
            _tag: "LaunchSpec",
            languageId: "python",
            name: "ty",
            version: "0.0.94",
            command: rig.tyPath,
            args: ["server"],
            source: "managed",
          });
          expect(NodeFS.readFileSync(rig.tyPath, "utf8")).toBe(TY_BYTES);
          expect(NodeFS.statSync(rig.tyPath).mode & 0o777).toBe(0o755);
          expect(yield* listing(NodePath.join(rig.stateDir, "language-servers"))).toEqual([
            "ty",
            "ty/0.0.94",
            "ty/0.0.94/ty",
          ]);
          expect(yield* rig.binaries.resolve("python")).toEqual(spec);
          expect(yield* rig.binaries.installProgress("python")).toBeUndefined();
        }),
      );
    });

    it.effect("finds the binary behind a pax header and a directory entry, and ignores a lookalike symlink", () => {
      const members: ReadonlyArray<TarMember> = [
        { name: "pax_global_header", type: "g", content: "52 comment=made by a test\n" },
        { name: `${MEMBER_DIR}/`, type: "5" },
        { name: `${MEMBER_DIR}/ty-link`, type: "2" },
        { name: `${MEMBER_DIR}/README.md`, content: "x".repeat(700) },
        { name: `${MEMBER_DIR}/ty`, content: TY_BYTES },
      ];
      const archive = tarGz(members);
      return inRig({ tyRelease: releaseFor(archive), respond: serve(archive) }, (rig) =>
        Effect.gen(function* () {
          yield* rig.binaries.install("python");
          expect(NodeFS.readFileSync(rig.tyPath, "utf8")).toBe(TY_BYTES);
        }),
      );
    });

    it.effect("makes no request when the binary is already installed", () =>
      inRig({ tyRelease: releaseFor(tyArchive()) }, (rig) =>
        Effect.gen(function* () {
          yield* putExecutable(rig.tyPath, "already here\n");

          expect(yield* rig.binaries.install("python")).toMatchObject({ command: rig.tyPath });
          expect(rig.requests).toEqual([]);
          expect(NodeFS.readFileSync(rig.tyPath, "utf8")).toBe("already here\n");
        }),
      ),
    );

    it.effect("replaces a version directory that holds no usable binary", () => {
      const archive = tyArchive();
      return inRig({ tyRelease: releaseFor(archive), respond: serve(archive) }, (rig) =>
        Effect.gen(function* () {
          yield* putExecutable(rig.tyPath, "half written\n");
          NodeFS.chmodSync(rig.tyPath, 0o644);
          NodeFS.writeFileSync(NodePath.join(rig.tyDirectory, "stale"), "left over");

          yield* rig.binaries.install("python");

          expect(NodeFS.readFileSync(rig.tyPath, "utf8")).toBe(TY_BYTES);
          expect(NodeFS.readdirSync(rig.tyDirectory)).toEqual(["ty"]);
        }),
      );
    });

    for (const row of [
      { platform: "linux", arch: "x64", target: "x86_64-unknown-linux-gnu" },
      { platform: "linux", arch: "arm64", target: "aarch64-unknown-linux-gnu" },
      { platform: "darwin", arch: "arm64", target: "aarch64-apple-darwin" },
      { platform: "darwin", arch: "x64", target: "x86_64-apple-darwin" },
    ] as const) {
      it.effect(`asks for the ${row.target} asset of 0.0.94 on ${row.platform}-${row.arch}, and refuses any other bytes`, () =>
        inRig({ ...row, respond: serve(new Uint8Array(1024)) }, (rig) =>
          Effect.gen(function* () {
            const error = yield* installFailure(rig.binaries.install("python"));

            expect(rig.requests).toEqual([
              `https://github.com/astral-sh/ty/releases/download/0.0.94/ty-${row.target}.tar.gz`,
            ]);
            expect(error.reason).toBe("checksum_mismatch");
            expect(yield* listing(rig.stateDir)).not.toContain("language-servers");
          }),
        ),
      );
    }

    describe("a failure leaves the state directory as it was", () => {
      const good = tyArchive();
      const rows: ReadonlyArray<{
        readonly name: string;
        readonly reason: string;
        readonly release: TyRelease;
        readonly respond: Respond;
      }> = [
        { name: "an HTTP 404", reason: "download_failed", release: releaseFor(good), respond: status(404) },
        { name: "an HTTP 500", reason: "download_failed", release: releaseFor(good), respond: status(500) },
        { name: "a transport error", reason: "download_failed", release: releaseFor(good), respond: transportFailure },
        { name: "a connection that drops mid-body", reason: "download_failed", release: releaseFor(good), respond: connectionReset },
        {
          name: "a body one byte short",
          reason: "checksum_mismatch",
          release: releaseFor(good),
          respond: serve(good.subarray(0, good.length - 1)),
        },
        {
          name: "a body one byte long",
          reason: "checksum_mismatch",
          release: releaseFor(good),
          respond: serve(new Uint8Array([...good, 0])),
        },
        {
          name: "an empty body",
          reason: "checksum_mismatch",
          release: releaseFor(good),
          respond: serve(new Uint8Array()),
        },
        {
          name: "bytes of the right size under another checksum",
          reason: "checksum_mismatch",
          release: { ...releaseFor(good), sha256: sha256Hex(new Uint8Array([1])) },
          respond: serve(good),
        },
        {
          name: "a checksum in uppercase hex, which the table never writes",
          reason: "checksum_mismatch",
          release: { ...releaseFor(good), sha256: sha256Hex(good).toUpperCase() },
          respond: serve(good),
        },
        (() => {
          const notGzip = new TextEncoder().encode("this is not a gzip stream at all");
          return {
            name: "bytes that are not gzip",
            reason: "extract_failed",
            release: releaseFor(notGzip),
            respond: serve(notGzip),
          };
        })(),
        (() => {
          const truncated = tarGz([{ name: `${MEMBER_DIR}/ty`, content: TY_BYTES }]).subarray(0, 30);
          return {
            name: "a gzip stream cut short",
            reason: "extract_failed",
            release: releaseFor(truncated),
            respond: serve(truncated),
          };
        })(),
        ...[
          { name: "an archive without the member", members: [{ name: `${MEMBER_DIR}/README.md`, content: "x" }] },
          { name: "an empty archive", members: [] },
          { name: "a member under another directory", members: [{ name: "ty-other-target/ty", content: TY_BYTES }] },
          { name: "a member that is only a symlink", members: [{ name: `${MEMBER_DIR}/ty`, type: "2" }] },
          { name: "a member that is a directory", members: [{ name: `${MEMBER_DIR}/ty`, type: "5" }] },
        ].map(({ name, members }) => {
          const archive = tarGz(members);
          return {
            name,
            reason: "extract_failed",
            release: releaseFor(archive),
            respond: serve(archive),
          };
        }),
        (() => {
          const cut = gzip(tar([{ name: `${MEMBER_DIR}/ty`, content: TY_BYTES }]).subarray(0, 520));
          return {
            name: "a member whose contents are cut off",
            reason: "extract_failed",
            release: releaseFor(cut),
            respond: serve(cut),
          };
        })(),
        (() => {
          const empty = gzip(new Uint8Array());
          return {
            name: "an empty gzip stream",
            reason: "extract_failed",
            release: releaseFor(empty),
            respond: serve(empty),
          };
        })(),
      ];

      for (const row of rows) {
        it.effect(`after ${row.name}: ${row.reason}, and nothing written`, () =>
          inRig({ tyRelease: row.release, respond: row.respond }, (rig) =>
            Effect.gen(function* () {
              // A neighbour already installed must be untouched, and no staging directory may remain.
              yield* putExecutable(NodePath.join(rig.stateDir, "language-servers", "ty", "0.0.93", "ty"));
              const before = yield* listing(rig.stateDir);

              const error = yield* installFailure(rig.binaries.install("python"));

              expect(error).toMatchObject({
                _tag: "LanguageServerInstallError",
                languageId: "python",
                reason: row.reason,
              });
              expect(yield* listing(rig.stateDir)).toEqual(before);
              expect(yield* rig.binaries.installProgress("python")).toBeUndefined();
              expect(yield* rig.binaries.resolve("python")).toMatchObject({ reason: "not_installed" });
              expect(rig.requests).toHaveLength(1);
            }),
          ),
        );
      }

      it.effect("after a failed placement, because something else holds the path", () => {
        const archive = tyArchive();
        return inRig({ tyRelease: releaseFor(archive), respond: serve(archive) }, (rig) =>
          Effect.gen(function* () {
            NodeFS.mkdirSync(NodePath.join(rig.stateDir, "language-servers"), { recursive: true });
            NodeFS.writeFileSync(NodePath.join(rig.stateDir, "language-servers", "ty"), "a file");
            const before = yield* listing(rig.stateDir);

            const error = yield* installFailure(rig.binaries.install("python"));

            expect(error.reason).toBe("extract_failed");
            expect(yield* listing(rig.stateDir)).toEqual(before);
          }),
        );
      });

      it.effect("says what failed in a fixed message, without the cause's words", () =>
        inRig({ tyRelease: releaseFor(good), respond: transportFailure }, (rig) =>
          Effect.gen(function* () {
            const error = yield* installFailure(rig.binaries.install("python"));

            expect(error.reason).toBe("download_failed");
            expect(error.message).toContain("download failed");
            expect(error.message).not.toContain("private");
            expect(error.message).not.toContain("example");
          }),
        ),
      );

      it.effect("can be tried again, and the next attempt asks again", () => {
        const archive = tyArchive();
        return inRig({ tyRelease: releaseFor(archive), respond: status(503) }, (rig) =>
          Effect.gen(function* () {
            expect((yield* installFailure(rig.binaries.install("python"))).reason).toBe("download_failed");
            rig.respond = serve(archive);

            expect(yield* rig.binaries.install("python")).toMatchObject({ source: "managed" });
            expect(rig.requests).toHaveLength(2);
          }),
        );
      });
    });

    describe("what cannot be installed", () => {
      for (const id of ["typescript", "ruby", "constructor", "__proto__", ""]) {
        it.effect(`says ${JSON.stringify(id)} is not_installable, with no request`, () =>
          inRig({ respond: serve(tyArchive()) }, (rig) =>
            Effect.gen(function* () {
              const error = yield* installFailure(rig.binaries.install(id));

              expect(error).toMatchObject({ languageId: id, reason: "not_installable" });
              expect(rig.requests).toEqual([]);
              expect(yield* listing(rig.stateDir)).not.toContain("language-servers");
            }),
          ),
        );
      }

      for (const row of [
        { platform: "linux", arch: "x64", libc: "musl" },
        { platform: "win32", arch: "x64", libc: "gnu" },
        { platform: "linux", arch: "ia32", libc: "gnu" },
      ] as const) {
        it.effect(`says ty is unsupported_platform on ${row.platform}-${row.arch}-${row.libc}, with no request`, () =>
          inRig({ ...row, respond: serve(tyArchive()) }, (rig) =>
            Effect.gen(function* () {
              const error = yield* installFailure(rig.binaries.install("python"));

              expect(error).toMatchObject({ languageId: "python", reason: "unsupported_platform" });
              expect(rig.requests).toEqual([]);
              expect(yield* listing(rig.stateDir)).not.toContain("language-servers");
            }),
          ),
        );
      }
    });

    describe("concurrent calls and progress", () => {
      const gated = Effect.fnUntraced(function* (archive: Uint8Array) {
        const requested = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const respond: Respond = () =>
          Deferred.succeed(requested, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(new Response(body(archive))),
          );
        return { requested, release, respond };
      });

      it.effect("share one download, show progress only while it is in flight, and all get the answer", () => {
        const archive = tyArchive();
        return Effect.gen(function* () {
          const gate = yield* gated(archive);
          yield* inRig(
            { tyRelease: releaseFor(archive), respond: gate.respond },
            (rig) =>
              Effect.gen(function* () {
                expect(yield* rig.binaries.installProgress("python")).toBeUndefined();

                const first = yield* startInstall(rig.binaries);
                yield* Deferred.await(gate.requested);
                const second = yield* startInstall(rig.binaries);
                const third = yield* startInstall(rig.binaries);

                expect(yield* rig.binaries.installProgress("python")).toEqual({
                  receivedBytes: 0,
                  totalBytes: archive.length,
                });
                expect(yield* rig.binaries.installProgress("typescript")).toBeUndefined();
                expect(yield* first.settled).toBe(false);

                yield* Deferred.succeed(gate.release, undefined);
                for (const call of [first, second, third]) {
                  expect(yield* call.outcome).toMatchObject({
                    _tag: "Success",
                    value: { command: rig.tyPath },
                  });
                }
                expect(rig.requests).toHaveLength(1);
                expect(yield* rig.binaries.installProgress("python")).toBeUndefined();
              }),
          );
        });
      });

      it.effect("give every waiting caller the same failure, and clear the progress", () => {
        const archive = tyArchive();
        return Effect.gen(function* () {
          const gate = yield* gated(new Uint8Array(archive.length));
          yield* inRig({ tyRelease: releaseFor(archive), respond: gate.respond }, (rig) =>
            Effect.gen(function* () {
              const first = yield* startInstall(rig.binaries);
              yield* Deferred.await(gate.requested);
              const second = yield* startInstall(rig.binaries);

              yield* Deferred.succeed(gate.release, undefined);
              for (const call of [first, second]) {
                expect(yield* call.outcome).toMatchObject({
                  _tag: "Failure",
                  error: { reason: "checksum_mismatch" },
                });
              }
              expect(rig.requests).toHaveLength(1);
              expect(yield* rig.binaries.installProgress("python")).toBeUndefined();
              expect(yield* listing(rig.stateDir)).not.toContain("language-servers");
            }),
          );
        });
      });

      it.effect("do not share anything across languages: other ids fail at once while ty downloads", () => {
        const archive = tyArchive();
        return Effect.gen(function* () {
          const gate = yield* gated(archive);
          yield* inRig({ tyRelease: releaseFor(archive), respond: gate.respond }, (rig) =>
            Effect.gen(function* () {
              const ty = yield* startInstall(rig.binaries);
              yield* Deferred.await(gate.requested);

              expect((yield* installFailure(rig.binaries.install("typescript"))).reason).toBe(
                "not_installable",
              );
              expect(yield* ty.settled).toBe(false);
              yield* Deferred.succeed(gate.release, undefined);
              expect(yield* ty.outcome).toMatchObject({ _tag: "Success" });
            }),
          );
        });
      });

      it.effect("give up on a download that never answers after 10 minutes, as download_failed", () => {
        const archive = tyArchive();
        return Effect.gen(function* () {
          const requested = yield* Deferred.make<void>();
          yield* inRig(
            {
              tyRelease: releaseFor(archive),
              respond: () => Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
            },
            (rig) =>
              Effect.gen(function* () {
                const install = yield* startInstall(rig.binaries);
                yield* Deferred.await(requested);

                yield* TestClock.adjust("599 seconds");
                expect(yield* install.settled).toBe(false);
                yield* TestClock.adjust("1 second");

                expect(yield* install.outcome).toMatchObject({
                  _tag: "Failure",
                  error: { reason: "download_failed" },
                });
                expect(yield* rig.binaries.installProgress("python")).toBeUndefined();
                expect(yield* listing(rig.stateDir)).not.toContain("language-servers");
              }),
          );
        });
      });
    });
  });

  it.effect("fails nothing it is asked: every outcome is a value", () =>
    inRig({}, ({ binaries }) =>
      Effect.gen(function* () {
        for (const id of ["python", "typescript", "ruby", "constructor"]) {
          expect(Exit.isSuccess(yield* Effect.exit(binaries.resolve(id)))).toBe(true);
        }
      }),
    ),
  );
});
