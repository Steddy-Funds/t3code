import { isCodeIntelUnsupportedError } from "@t3tools/client-runtime/state/code-intel";
import type { CodeLibraryRoot, CodeServerStatus, EnvironmentId } from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";

import { codeIntelEnvironment } from "~/state/codeIntel";
import { useEnvironmentQuery } from "~/state/query";

import { libraryRootForPath, serverForPath } from "./codeLanguages";

const NO_SERVERS: ReadonlyArray<CodeServerStatus> = [];

export interface CodeIntelFile {
  /** The server answered status; false while it loads and on servers older than code intel. */
  readonly supported: boolean;
  readonly servers: ReadonlyArray<CodeServerStatus>;
  /** The language server for this file's language; null for languages without one. */
  readonly server: CodeServerStatus | null;
  /** Set for files under a virtualenv, stdlib, stubs or node_modules: read-only library code. */
  readonly libraryRoot: CodeLibraryRoot | null;
  readonly refreshStatus: () => void;
}

/** What code intelligence knows about one file. Reading status never starts a server. */
export function useCodeIntelFile(
  environmentId: EnvironmentId,
  cwd: string,
  path: string | null,
  enabled: boolean,
): CodeIntelFile {
  const status = useEnvironmentQuery(
    enabled && path !== null
      ? codeIntelEnvironment.status({ environmentId, input: { cwd } })
      : null,
  );
  const servers = status.data?.servers ?? NO_SERVERS;
  return {
    supported: status.data !== null && !isCodeIntelUnsupportedError(status.failure),
    servers,
    server: path === null ? null : serverForPath(servers, path),
    libraryRoot:
      path === null ? null : libraryRootForPath(servers, resolvePathLinkTarget(path, cwd)),
    refreshStatus: status.refresh,
  };
}
