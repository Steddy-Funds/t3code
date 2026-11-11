import {
  CodeIntelError,
  type CodeIntelDefinitionInput,
  type CodeIntelDefinitionResult,
  type CodeIntelDocumentHighlightsResult,
  type CodeIntelDocumentInput,
  type CodeIntelDocumentSymbolsResult,
  type CodeIntelHoverResult,
  type CodeIntelInstallServerInput,
  type CodeIntelInstallServerResult,
  type CodeIntelPositionInput,
  type CodeIntelReferencesInput,
  type CodeIntelReferencesResult,
  type CodeIntelRestartInput,
  type CodeIntelSemanticTokensInput,
  type CodeIntelSemanticTokensResult,
  type CodeIntelStatusInput,
  type CodeIntelStatusResult,
  type CodeIntelWorkspaceSymbolsInput,
  type CodeIntelWorkspaceSymbolsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class CodeIntel extends Context.Service<
  CodeIntel,
  {
    /** Never starts a language server. */
    readonly status: (
      input: CodeIntelStatusInput,
    ) => Effect.Effect<CodeIntelStatusResult, CodeIntelError>;
    readonly definition: (
      input: CodeIntelDefinitionInput,
    ) => Effect.Effect<CodeIntelDefinitionResult, CodeIntelError>;
    readonly references: (
      input: CodeIntelReferencesInput,
    ) => Effect.Effect<CodeIntelReferencesResult, CodeIntelError>;
    readonly documentHighlights: (
      input: CodeIntelPositionInput,
    ) => Effect.Effect<CodeIntelDocumentHighlightsResult, CodeIntelError>;
    readonly hover: (
      input: CodeIntelPositionInput,
    ) => Effect.Effect<CodeIntelHoverResult, CodeIntelError>;
    readonly documentSymbols: (
      input: CodeIntelDocumentInput,
    ) => Effect.Effect<CodeIntelDocumentSymbolsResult, CodeIntelError>;
    readonly workspaceSymbols: (
      input: CodeIntelWorkspaceSymbolsInput,
    ) => Effect.Effect<CodeIntelWorkspaceSymbolsResult, CodeIntelError>;
    readonly semanticTokens: (
      input: CodeIntelSemanticTokensInput,
    ) => Effect.Effect<CodeIntelSemanticTokensResult, CodeIntelError>;
    /** The only path that downloads anything. */
    readonly installServer: (
      input: CodeIntelInstallServerInput,
    ) => Effect.Effect<CodeIntelInstallServerResult, CodeIntelError>;
    /** Stops this root's language servers and clears a `failed` state; the next request starts one. */
    readonly restart: (
      input: CodeIntelRestartInput,
    ) => Effect.Effect<CodeIntelStatusResult, CodeIntelError>;
  }
>()("t3/codeIntel/CodeIntel") {}

const notBuilt = () =>
  new CodeIntelError({
    reason: "server_unavailable",
    message: "Code intelligence is not available on this server yet.",
  });

export const layer = Layer.succeed(
  CodeIntel,
  CodeIntel.of({
    status: Effect.fn("CodeIntel.status")(function* () {
      return yield* notBuilt();
    }),
    definition: Effect.fn("CodeIntel.definition")(function* () {
      return yield* notBuilt();
    }),
    references: Effect.fn("CodeIntel.references")(function* () {
      return yield* notBuilt();
    }),
    documentHighlights: Effect.fn("CodeIntel.documentHighlights")(function* () {
      return yield* notBuilt();
    }),
    hover: Effect.fn("CodeIntel.hover")(function* () {
      return yield* notBuilt();
    }),
    documentSymbols: Effect.fn("CodeIntel.documentSymbols")(function* () {
      return yield* notBuilt();
    }),
    workspaceSymbols: Effect.fn("CodeIntel.workspaceSymbols")(function* () {
      return yield* notBuilt();
    }),
    semanticTokens: Effect.fn("CodeIntel.semanticTokens")(function* () {
      return yield* notBuilt();
    }),
    installServer: Effect.fn("CodeIntel.installServer")(function* () {
      return yield* notBuilt();
    }),
    restart: Effect.fn("CodeIntel.restart")(function* () {
      return yield* notBuilt();
    }),
  }),
);
