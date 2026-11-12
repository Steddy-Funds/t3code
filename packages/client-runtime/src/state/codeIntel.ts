import { type CodeIntelStatusResult, type CodeServerState, WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { type EnvironmentRpcInput, request } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily, createEnvironmentRpcCommand } from "./runtime.ts";

/** The connected server is older than code intelligence. Hide the feature for this connection. */
export class CodeIntelUnsupportedError extends Schema.TaggedError<CodeIntelUnsupportedError>()(
  "CodeIntelUnsupportedError",
  {},
) {
  override get message(): string {
    return "This environment's server does not have code intelligence.";
  }
}

export const isCodeIntelUnsupportedError = Schema.is(CodeIntelUnsupportedError);

// An older server rejects a method it does not know with this defect.
const isUnknownRequestTag = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some(
    (reason) => Cause.isDieReason(reason) && String(reason.defect).includes("Unknown request tag"),
  );

// Sessions known to lack the methods, so one refusal stops every later call on that connection.
const unsupportedSessions = new WeakSet<object>();

const whenSupported = Effect.fn("codeIntel.whenSupported")(function* <A, E, R>(
  call: Effect.Effect<A, E, R>,
): Effect.fn.Return<
  A,
  E | CodeIntelUnsupportedError,
  R | EnvironmentSupervisor.EnvironmentSupervisor
> {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const session = Option.getOrNull(yield* SubscriptionRef.get(supervisor.session));
  if (session !== null && unsupportedSessions.has(session)) {
    return yield* new CodeIntelUnsupportedError();
  }
  return yield* call.pipe(
    Effect.catchCause((cause): Effect.Effect<never, E | CodeIntelUnsupportedError> => {
      if (!isUnknownRequestTag(cause)) return Effect.failCause(cause);
      if (session !== null) unsupportedSessions.add(session);
      return Effect.fail(new CodeIntelUnsupportedError());
    }),
  );
});

const SETTLED_SERVER_STATES: ReadonlySet<CodeServerState> = new Set([
  "unavailable",
  "stopped",
  "ready",
  "failed",
]);

// Answers depend on other files too, so even a revision-pinned input goes stale quickly.
const POSITION_QUERY = { staleTimeMs: 5_000, idleTtlMs: 30_000 } as const;
const DOCUMENT_QUERY = { staleTimeMs: 30_000, idleTtlMs: 60_000 } as const;

export function createCodeIntelEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Never starts a language server. Refreshes while one is starting or indexing. */
    status: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:code-intel:status",
      staleTimeMs: 2_000,
      idleTtlMs: 60_000,
      refreshIntervalMs: 2_000,
      isFinal: (result: CodeIntelStatusResult) =>
        result.servers.every((server) => SETTLED_SERVER_STATES.has(server.state)),
      execute: (input: EnvironmentRpcInput<typeof WS_METHODS.codeIntelStatus>) =>
        whenSupported(request(WS_METHODS.codeIntelStatus, input)),
    }),
    definition: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:code-intel:definition",
      ...POSITION_QUERY,
      execute: (input: EnvironmentRpcInput<typeof WS_METHODS.codeIntelDefinition>) =>
        whenSupported(request(WS_METHODS.codeIntelDefinition, input)),
    }),
    references: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:code-intel:references",
      ...POSITION_QUERY,
      execute: (input: EnvironmentRpcInput<typeof WS_METHODS.codeIntelReferences>) =>
        whenSupported(request(WS_METHODS.codeIntelReferences, input)),
    }),
    documentHighlights: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:code-intel:document-highlights",
      ...POSITION_QUERY,
      execute: (input: EnvironmentRpcInput<typeof WS_METHODS.codeIntelDocumentHighlights>) =>
        whenSupported(request(WS_METHODS.codeIntelDocumentHighlights, input)),
    }),
    hover: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:code-intel:hover",
      ...POSITION_QUERY,
      execute: (input: EnvironmentRpcInput<typeof WS_METHODS.codeIntelHover>) =>
        whenSupported(request(WS_METHODS.codeIntelHover, input)),
    }),
    documentSymbols: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:code-intel:document-symbols",
      ...DOCUMENT_QUERY,
      execute: (input: EnvironmentRpcInput<typeof WS_METHODS.codeIntelDocumentSymbols>) =>
        whenSupported(request(WS_METHODS.codeIntelDocumentSymbols, input)),
    }),
    workspaceSymbols: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:code-intel:workspace-symbols",
      ...POSITION_QUERY,
      execute: (input: EnvironmentRpcInput<typeof WS_METHODS.codeIntelWorkspaceSymbols>) =>
        whenSupported(request(WS_METHODS.codeIntelWorkspaceSymbols, input)),
    }),
    semanticTokens: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:code-intel:semantic-tokens",
      ...DOCUMENT_QUERY,
      execute: (input: EnvironmentRpcInput<typeof WS_METHODS.codeIntelSemanticTokens>) =>
        whenSupported(request(WS_METHODS.codeIntelSemanticTokens, input)),
    }),
    installServer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:code-intel:install-server",
      tag: WS_METHODS.codeIntelInstallServer,
    }),
    restart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:code-intel:restart",
      tag: WS_METHODS.codeIntelRestart,
    }),
  };
}
