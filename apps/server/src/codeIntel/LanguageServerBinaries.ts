import * as NodeModule from "node:module";
import * as NodeZlib from "node:zlib";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";

const TY = { languageId: "python", name: "ty", args: ["server"] } as const;
const TYPESCRIPT = {
  languageId: "typescript",
  name: "TypeScript",
  args: ["--lsp", "--stdio"],
} as const;

// ty ships weekly and is pre-1.0: bump the version and every row of the table together.
const TY_VERSION = "0.0.94";
const TY_DOWNLOAD_TIMEOUT = "10 minutes";
const TAR_BLOCK_BYTES = 512;

interface TyRelease {
  /** The Rust target: the asset is `ty-<target>.tar.gz` and holds `ty-<target>/ty`. */
  readonly target: string;
  readonly sha256: string;
  readonly bytes: number;
}

// The checksum of each release asset, written here so it is never fetched beside the asset.
const TY_RELEASES: Readonly<Record<string, TyRelease>> = {
  "linux-x64": {
    target: "x86_64-unknown-linux-gnu",
    sha256: "4213096cf7985ed5866428a7afe7dc96f5200bb1913b8b27464b03cf0831ede6",
    bytes: 16_260_428,
  },
  "linux-arm64": {
    target: "aarch64-unknown-linux-gnu",
    sha256: "ba90c093d3d810986ae5162e91a70d6c0c6248d755f7ce89463df14d6957a433",
    bytes: 13_381_906,
  },
  "darwin-arm64": {
    target: "aarch64-apple-darwin",
    sha256: "2f74dec02c3a417f68c96bd7300ec2c0727c363daf3561e0eb7516e5c9f8d286",
    bytes: 13_074_962,
  },
  "darwin-x64": {
    target: "x86_64-apple-darwin",
    sha256: "76982b9ad850267ea0b64b2f66f542509bcb5ca51a2cd6c7162d7592ded7069d",
    bytes: 13_964_253,
  },
};

interface BundledTypeScript {
  readonly command: string;
  readonly version: string;
}

export interface LaunchSpec {
  readonly _tag: "LaunchSpec";
  readonly languageId: string;
  /** Display name: "ty", "TypeScript". */
  readonly name: string;
  /** The pinned version for a bundled or managed binary; absent for a user-set path. */
  readonly version: string | undefined;
  /** Absolute path of the executable. Never inside a workspace. */
  readonly command: string;
  /** `["server"]` for ty, `["--lsp", "--stdio"]` for tsc. */
  readonly args: ReadonlyArray<string>;
  readonly source: "bundled" | "managed" | "setting";
}

export interface Unavailable {
  readonly _tag: "Unavailable";
  readonly languageId: string;
  readonly name: string;
  readonly reason:
    | "not_installed"
    | "unsupported_platform"
    | "setting_path_missing"
    | "setting_path_in_project"
    | "unknown_language";
  /** True when `install(languageId)` can fix it. */
  readonly installable: boolean;
  /** What is missing and what to do, for the status chip. No file contents, no secrets. */
  readonly message: string;
}

export interface InstallProgress {
  readonly receivedBytes: number;
  readonly totalBytes: number | undefined;
}

export class LanguageServerInstallError extends Schema.TaggedError<LanguageServerInstallError>()(
  "LanguageServerInstallError",
  {
    languageId: Schema.String,
    reason: Schema.Literals([
      "not_installable",
      "unsupported_platform",
      "download_failed",
      "checksum_mismatch",
      "extract_failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_installable":
        return "T3 Code does not install a language server for this language.";
      case "unsupported_platform":
        return "T3 Code has no language server download for this platform.";
      case "download_failed":
        return "The language server download failed. Check the network connection, then try again. Nothing was installed.";
      case "checksum_mismatch":
        return "The language server download did not match its pinned checksum. Nothing was installed.";
      case "extract_failed":
        return "The language server download could not be unpacked. Nothing was installed.";
    }
  }
}

export interface LanguageServerBinariesOptions {
  /** Stands in for this platform's row of the ty release table. */
  readonly tyRelease?: TyRelease;
  /** Stands in for the installed `typescript` package; throws when its binary is missing. */
  readonly locateTypeScript?: () => BundledTypeScript;
}

export class LanguageServerBinaries extends Context.Service<
  LanguageServerBinaries,
  {
    /** Never fails. Order: the user's `serverPaths` entry, then bundled (TypeScript) or managed (ty). */
    readonly resolve: (languageId: string) => Effect.Effect<LaunchSpec | Unavailable>;
    /** Installs the pinned managed binary. Concurrent calls for one language share one install. */
    readonly install: (languageId: string) => Effect.Effect<LaunchSpec, LanguageServerInstallError>;
    /** Present only while an install of that language is in flight. */
    readonly installProgress: (languageId: string) => Effect.Effect<InstallProgress | undefined>;
  }
>()("t3/codeIntel/LanguageServerBinaries") {}

// Resolved from this module's own location, so a workspace's packages are never candidates.
const requireFromServer = NodeModule.createRequire(import.meta.url);

const unavailable = (
  language: { readonly languageId: string; readonly name: string },
  reason: Unavailable["reason"],
  message: string,
): Unavailable => ({
  _tag: "Unavailable",
  languageId: language.languageId,
  name: language.name,
  reason,
  installable: reason === "not_installed",
  message,
});

const tarField = (archive: Uint8Array, start: number, length: number) => {
  const bytes = archive.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
};

/** One regular file of a tar archive. Reads plain ustar headers, which is what a ty release holds. */
const readTarMember = (archive: Uint8Array, memberName: string): Uint8Array | undefined => {
  let header = 0;
  while (header + TAR_BLOCK_BYTES <= archive.length) {
    const name = tarField(archive, header, 100);
    if (name === "") return undefined;
    const prefix = tarField(archive, header + 345, 155);
    const size = Number.parseInt(tarField(archive, header + 124, 12).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0) return undefined;
    const typeFlag = tarField(archive, header + 156, 1);
    const contents = header + TAR_BLOCK_BYTES;
    const isRegularFile = typeFlag === "0" || typeFlag === "";
    if (isRegularFile && (prefix === "" ? name : `${prefix}/${name}`) === memberName) {
      return contents + size <= archive.length
        ? archive.subarray(contents, contents + size)
        : undefined;
    }
    header = contents + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }
  return undefined;
};

/** @public */
export const make = Effect.fn("LanguageServerBinaries.make")(function* (
  options: LanguageServerBinariesOptions = {},
) {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const libc = yield* HostProcess.LinuxLibc;
  const home = yield* HostProcess.HomeDirectory;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;

  const tyRoot = path.join(config.stateDir, "language-servers", "ty");
  const tyDirectory = path.join(tyRoot, TY_VERSION);
  const tyBinary = path.join(tyDirectory, "ty");
  const tySpec: LaunchSpec = {
    _tag: "LaunchSpec",
    languageId: TY.languageId,
    name: TY.name,
    version: TY_VERSION,
    command: tyBinary,
    args: TY.args,
    source: "managed",
  };
  // The Linux assets are glibc builds, so a musl host has none.
  const tyRelease =
    options.tyRelease ??
    (platform === "linux" && libc === "musl" ? undefined : TY_RELEASES[`${platform}-${arch}`]);
  const progress = new Map<string, InstallProgress>();

  const locateTypeScript =
    options.locateTypeScript ??
    ((): BundledTypeScript => {
      const manifestPath = requireFromServer.resolve("typescript/package.json");
      // The package's own resolver finds `@typescript/typescript-<platform>-<arch>`. It is not in
      // the package's exports, so it is loaded by path.
      const getExePath = requireFromServer(
        path.join(path.dirname(manifestPath), "lib", "getExePath.js"),
      ) as { readonly default: () => string };
      const manifest = requireFromServer(manifestPath) as { readonly version: string };
      return { command: getExePath.default(), version: manifest.version };
    });

  // The helpers below are untraced: each runs inside the span of the operation that calls it.

  const statFile = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) => (info.type === "File" ? info : undefined)),
      Effect.orElseSucceed(() => undefined),
    );

  const isInstalled = (binary: string) =>
    statFile(binary).pipe(Effect.map((info) => info !== undefined && (info.mode & 0o111) !== 0));

  const resolveFromSetting = Effect.fnUntraced(function* (language: typeof TY | typeof TYPESCRIPT) {
    const setting = yield* settings.getSettings.pipe(
      Effect.map((current) => current.codeIntel.serverPaths[language.languageId]),
      Effect.orElseSucceed(() => undefined),
    );
    if (!setting) return undefined;
    const configured = expandHomePath(setting, home);
    // A relative path would resolve against the server's working directory, which can be a workspace.
    const command = path.isAbsolute(configured)
      ? yield* fileSystem.realPath(configured).pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
    if (command === undefined || (yield* statFile(command)) === undefined) {
      return unavailable(
        language,
        "setting_path_missing",
        `The ${language.name} language server path in settings is not an absolute path to a file that exists.`,
      );
    }
    // A workspace's own files are never run, even by a path the user set (or a link to one).
    if (yield* knownWorkspaces.contains(command)) {
      return unavailable(
        language,
        "setting_path_in_project",
        `The ${language.name} language server path in settings is inside a project. T3 Code never runs a project's files: install the server outside it.`,
      );
    }
    return {
      _tag: "LaunchSpec",
      languageId: language.languageId,
      name: language.name,
      version: undefined,
      command,
      args: language.args,
      source: "setting",
    } satisfies LaunchSpec;
  });

  const resolveTy = Effect.fnUntraced(function* () {
    if (yield* isInstalled(tyBinary)) return tySpec;
    return tyRelease === undefined
      ? unavailable(
          TY,
          "unsupported_platform",
          `T3 Code has no ty download for ${platform}-${arch}. Install ty yourself and set its path in settings.`,
        )
      : unavailable(
          TY,
          "not_installed",
          `ty ${TY_VERSION} is not installed. Install it to navigate Python code.`,
        );
  });

  const resolveTypeScript = Effect.sync((): LaunchSpec | Unavailable => {
    try {
      const bundled = locateTypeScript();
      return {
        _tag: "LaunchSpec",
        languageId: TYPESCRIPT.languageId,
        name: TYPESCRIPT.name,
        version: bundled.version,
        command: bundled.command,
        args: TYPESCRIPT.args,
        source: "bundled",
      };
    } catch {
      return unavailable(
        TYPESCRIPT,
        "unsupported_platform",
        `The TypeScript language server for ${platform}-${arch} is missing from this T3 Code install.`,
      );
    }
  });

  const resolve: LanguageServerBinaries["Service"]["resolve"] = Effect.fn(
    "LanguageServerBinaries.resolve",
  )(function* (languageId) {
    const language = [TY, TYPESCRIPT].find((candidate) => candidate.languageId === languageId);
    if (language === undefined) {
      return unavailable(
        { languageId, name: languageId },
        "unknown_language",
        "T3 Code has no language server for this language.",
      );
    }
    const fromSetting = yield* resolveFromSetting(language);
    if (fromSetting !== undefined) return fromSetting;
    return yield* language === TY ? resolveTy() : resolveTypeScript;
  });

  const downloadTy = Effect.fn("LanguageServerBinaries.downloadTy")(
    function* (release: TyRelease) {
      const response = yield* http
        .execute(
          HttpClientRequest.get(
            `https://github.com/astral-sh/ty/releases/download/${TY_VERSION}/ty-${release.target}.tar.gz`,
          ),
        )
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      // The pinned size bounds the download: a longer body is not the pinned asset.
      const archive = new Uint8Array(release.bytes);
      let receivedBytes = 0;
      yield* Stream.runForEach(response.stream, (chunk) => {
        if (receivedBytes + chunk.byteLength > release.bytes) {
          return Effect.fail(
            new LanguageServerInstallError({
              languageId: TY.languageId,
              reason: "checksum_mismatch",
            }),
          );
        }
        archive.set(chunk, receivedBytes);
        receivedBytes += chunk.byteLength;
        progress.set(TY.languageId, { receivedBytes, totalBytes: release.bytes });
        return Effect.void;
      });
      return archive.subarray(0, receivedBytes);
    },
    Effect.timeout(TY_DOWNLOAD_TIMEOUT),
    Effect.catchTags({
      HttpClientError: (cause) =>
        Effect.fail(
          new LanguageServerInstallError({
            languageId: TY.languageId,
            reason: "download_failed",
            cause,
          }),
        ),
      TimeoutError: (cause) =>
        Effect.fail(
          new LanguageServerInstallError({
            languageId: TY.languageId,
            reason: "download_failed",
            cause,
          }),
        ),
    }),
  );

  const gunzip = (archive: Uint8Array) =>
    Effect.callback<Uint8Array, LanguageServerInstallError>((resume) => {
      NodeZlib.gunzip(archive, (cause, unpacked) => {
        resume(
          cause === null
            ? Effect.succeed(unpacked)
            : Effect.fail(
                new LanguageServerInstallError({
                  languageId: TY.languageId,
                  reason: "extract_failed",
                  cause,
                }),
              ),
        );
      });
    });

  /** Builds the version directory in a scratch directory beside it, then renames it into place. */
  const placeTy = Effect.fn("LanguageServerBinaries.placeTy")(
    function* (binary: Uint8Array) {
      yield* fileSystem.makeDirectory(tyRoot, { recursive: true });
      const staging = yield* fileSystem.makeTempDirectoryScoped({
        directory: tyRoot,
        prefix: ".install-",
      });
      const stagedDirectory = path.join(staging, TY_VERSION);
      const stagedBinary = path.join(stagedDirectory, "ty");
      yield* fileSystem.makeDirectory(stagedDirectory);
      yield* fileSystem.writeFile(stagedBinary, binary);
      yield* fileSystem.chmod(stagedBinary, 0o755);
      // A version directory that is still here holds no usable binary, or install returned early.
      yield* fileSystem.remove(tyDirectory, { recursive: true, force: true });
      yield* fileSystem.rename(stagedDirectory, tyDirectory);
    },
    Effect.scoped,
    Effect.mapError(
      (cause) =>
        new LanguageServerInstallError({
          languageId: TY.languageId,
          reason: "extract_failed",
          cause,
        }),
    ),
  );

  // Nothing touches the disk until the archive is verified and unpacked in memory.
  const installTy = Effect.fn("LanguageServerBinaries.installTy")(
    function* () {
      if (yield* isInstalled(tyBinary)) return tySpec;
      if (tyRelease === undefined) {
        return yield* new LanguageServerInstallError({
          languageId: TY.languageId,
          reason: "unsupported_platform",
        });
      }
      progress.set(TY.languageId, { receivedBytes: 0, totalBytes: tyRelease.bytes });
      const archive = yield* downloadTy(tyRelease);
      if ((yield* digest.digestHex(Digest.sha256, archive)) !== tyRelease.sha256) {
        return yield* new LanguageServerInstallError({
          languageId: TY.languageId,
          reason: "checksum_mismatch",
        });
      }
      const binary = readTarMember(yield* gunzip(archive), `ty-${tyRelease.target}/ty`);
      if (binary === undefined) {
        return yield* new LanguageServerInstallError({
          languageId: TY.languageId,
          reason: "extract_failed",
        });
      }
      yield* placeTy(binary);
      yield* Effect.logInfo("Installed a managed language server", {
        languageId: TY.languageId,
        version: TY_VERSION,
      });
      return tySpec;
    },
    Effect.ensuring(Effect.sync(() => progress.delete(TY.languageId))),
  );

  // Callers of one language join the same lookup; a zero lifetime keeps no result, so the next
  // call probes the disk again.
  const installs = yield* Cache.makeWith(
    (languageId: string) =>
      languageId === TY.languageId
        ? installTy()
        : Effect.fail(new LanguageServerInstallError({ languageId, reason: "not_installable" })),
    { capacity: 16, timeToLive: () => Duration.zero },
  );

  const install: LanguageServerBinaries["Service"]["install"] = Effect.fn(
    "LanguageServerBinaries.install",
  )(function* (languageId) {
    return yield* Cache.get(installs, languageId);
  });

  const installProgress: LanguageServerBinaries["Service"]["installProgress"] = (languageId) =>
    Effect.sync(() => progress.get(languageId));

  return LanguageServerBinaries.of({ resolve, install, installProgress });
});

export const layer = Layer.effect(LanguageServerBinaries, make());
