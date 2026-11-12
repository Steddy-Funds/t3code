import { useAtomValue } from "@effect/atom-react";
import { isCodeIntelUnsupportedError } from "@t3tools/client-runtime/state/code-intel";
import type { CodeLibraryRoot, CodeServerStatus, EnvironmentId } from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { useEffect, useState } from "react";

import { codeIntelEnvironment } from "~/state/codeIntel";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import { isLibraryPath, libraryRootForPath, serverForPath } from "./codeLanguages";

const NO_SERVERS: ReadonlyArray<CodeServerStatus> = [];

export interface CodeIntelFile {
  /** The server answered status; false while it loads and on servers older than code intel. */
  readonly supported: boolean;
  readonly servers: ReadonlyArray<CodeServerStatus>;
  /** Turned off in the environment's settings; false from servers older than the switch. */
  readonly turnedOff: boolean;
  /** The language server for this file's language; null for languages without one. */
  readonly server: CodeServerStatus | null;
  /** The virtualenv, stdlib, stubs or node_modules root the file lies under. */
  readonly libraryRoot: CodeLibraryRoot | null;
  /** Read-only: under a library root, or in a node_modules or site-packages folder anywhere. */
  readonly libraryCode: boolean;
  readonly refreshStatus: () => void;
}

/** What code intelligence knows about one file. Reading status never starts a server. */
export function useCodeIntelFile(
  environmentId: EnvironmentId,
  cwd: string,
  path: string | null,
  enabled: boolean,
): CodeIntelFile {
  // Status retries every 2 s until it settles, and a refusal never does; stop asking here.
  const [unsupportedIn, setUnsupportedIn] = useState<EnvironmentId | null>(null);
  const unsupported = unsupportedIn === environmentId;
  const status = useEnvironmentQuery(
    enabled && path !== null && !unsupported
      ? codeIntelEnvironment.status({ environmentId, input: { cwd } })
      : null,
  );
  if (!unsupported && isCodeIntelUnsupportedError(status.failure)) setUnsupportedIn(environmentId);
  const turnedOnInSettings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId))
    ?.codeIntel.enabled;
  const statusEnabled = status.data?.enabled;
  const switchMoved =
    turnedOnInSettings !== undefined &&
    statusEnabled !== undefined &&
    turnedOnInSettings !== statusEnabled;
  const { refresh } = status;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a settled status is never asked again; a switch moved elsewhere arrives only as a settings push.
  useEffect(() => {
    if (switchMoved) refresh();
  }, [switchMoved, refresh]);
  const servers = status.data?.servers ?? NO_SERVERS;
  const supported = status.data !== null && !isCodeIntelUnsupportedError(status.failure);
  const libraryRoot =
    path === null ? null : libraryRootForPath(servers, resolvePathLinkTarget(path, cwd));
  return {
    supported,
    servers,
    turnedOff: status.data?.enabled === false,
    server: path === null ? null : serverForPath(servers, path),
    libraryRoot,
    libraryCode: libraryRoot !== null || (supported && path !== null && isLibraryPath(path)),
    refreshStatus: status.refresh,
  };
}
