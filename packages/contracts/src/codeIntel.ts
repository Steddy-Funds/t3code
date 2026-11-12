import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

const CODE_INTEL_REFERENCES_MAX_LIMIT = 500;
const CODE_INTEL_WORKSPACE_SYMBOLS_MAX_LIMIT = 200;
const CODE_INTEL_QUERY_MAX_LENGTH = 256;
export const CODE_INTEL_LINE_TEXT_MAX_LENGTH = 400;

/** LSP's position: zero-based line, UTF-16 code unit within it. */
export const CodePosition = Schema.Struct({
  line: NonNegativeInt,
  character: NonNegativeInt,
});
export type CodePosition = typeof CodePosition.Type;

export const CodeRange = Schema.Struct({
  start: CodePosition,
  end: CodePosition,
});
export type CodeRange = typeof CodeRange.Type;

export const CodeDocument = Schema.Struct({
  /** A known workspace root. */
  cwd: TrimmedNonEmptyString,
  /** Workspace-relative, or an absolute host path. */
  path: TrimmedNonEmptyString,
  /** The revision of the text the client shows; a different file on disk answers `stale_document`. */
  ifRevision: Schema.optional(Schema.String),
});
export type CodeDocument = typeof CodeDocument.Type;

export const CodeLocation = Schema.Struct({
  /** Relative when inside `cwd`, else absolute. */
  path: Schema.String,
  /** Under a library root or outside `cwd`; `.venv/...` inside `cwd` is relative and external. */
  external: Schema.Boolean,
  range: CodeRange,
  lineText: Schema.optional(
    Schema.String.check(Schema.isMaxLength(CODE_INTEL_LINE_TEXT_MAX_LENGTH)),
  ),
});
export type CodeLocation = typeof CodeLocation.Type;

export const CodeSymbolKind = Schema.Literals([
  "file",
  "module",
  "namespace",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "enumMember",
  "struct",
  "typeParameter",
  "other",
]);
export type CodeSymbolKind = typeof CodeSymbolKind.Type;

export interface CodeSymbol {
  readonly name: string;
  readonly detail?: string | undefined;
  readonly kind: CodeSymbolKind;
  readonly range: CodeRange;
  readonly selectionRange: CodeRange;
  readonly children: ReadonlyArray<CodeSymbol>;
}
export const CodeSymbol: Schema.Codec<CodeSymbol> = Schema.Struct({
  name: Schema.String,
  detail: Schema.optional(Schema.String),
  kind: CodeSymbolKind,
  range: CodeRange,
  selectionRange: CodeRange,
  children: Schema.Array(Schema.suspend((): Schema.Codec<CodeSymbol> => CodeSymbol)),
});

export const CodeServerState = Schema.Literals([
  "unavailable",
  "stopped",
  "starting",
  "indexing",
  "ready",
  "failed",
]);
export type CodeServerState = typeof CodeServerState.Type;

export const CodeLibraryRootKind = Schema.Literals([
  "site-packages",
  "stdlib",
  "stubs",
  "node_modules",
]);
export type CodeLibraryRootKind = typeof CodeLibraryRootKind.Type;

export const CodeLibraryRoot = Schema.Struct({
  /** Absolute. */
  path: Schema.String,
  label: Schema.String,
  kind: CodeLibraryRootKind,
});
export type CodeLibraryRoot = typeof CodeLibraryRoot.Type;

export const CodeServerStatus = Schema.Struct({
  languageId: Schema.String,
  name: Schema.String,
  version: Schema.optional(Schema.String),
  state: CodeServerState,
  message: Schema.optional(Schema.String),
  interpreter: Schema.optional(
    Schema.Struct({
      path: Schema.String,
      version: Schema.optional(Schema.String),
    }),
  ),
  libraryRoots: Schema.Array(CodeLibraryRoot),
});
export type CodeServerStatus = typeof CodeServerStatus.Type;

export const CodeIntelStatusInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export type CodeIntelStatusInput = typeof CodeIntelStatusInput.Type;

export const CodeIntelStatusResult = Schema.Struct({ servers: Schema.Array(CodeServerStatus) });
export type CodeIntelStatusResult = typeof CodeIntelStatusResult.Type;

export const CodeDefinitionKind = Schema.Literals([
  "definition",
  "typeDefinition",
  "implementation",
]);
export type CodeDefinitionKind = typeof CodeDefinitionKind.Type;

export const CodeIntelDefinitionInput = Schema.Struct({
  document: CodeDocument,
  position: CodePosition,
  /** `definition` is source first; JetBrains' "Go to Declaration" maps to it. */
  kind: CodeDefinitionKind,
});
export type CodeIntelDefinitionInput = typeof CodeIntelDefinitionInput.Type;

export const CodeIntelDefinitionResult = Schema.Struct({
  locations: Schema.Array(CodeLocation),
  revision: Schema.String,
});
export type CodeIntelDefinitionResult = typeof CodeIntelDefinitionResult.Type;

export const CodeIntelInstallServerInput = Schema.Struct({ languageId: TrimmedNonEmptyString });
export type CodeIntelInstallServerInput = typeof CodeIntelInstallServerInput.Type;

export const CodeIntelInstallServerResult = Schema.Struct({
  state: CodeServerState,
  message: Schema.optional(Schema.String),
});
export type CodeIntelInstallServerResult = typeof CodeIntelInstallServerResult.Type;

export const CodeIntelRestartInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /** Absent: every language server of this root. */
  languageId: Schema.optional(TrimmedNonEmptyString),
});
export type CodeIntelRestartInput = typeof CodeIntelRestartInput.Type;

export const CodeIntelReferencesInput = Schema.Struct({
  document: CodeDocument,
  position: CodePosition,
  includeDeclaration: Schema.Boolean,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(CODE_INTEL_REFERENCES_MAX_LIMIT)),
});
export type CodeIntelReferencesInput = typeof CodeIntelReferencesInput.Type;

export const CodeIntelReferencesResult = Schema.Struct({
  locations: Schema.Array(CodeLocation),
  truncated: Schema.Boolean,
  revision: Schema.String,
});
export type CodeIntelReferencesResult = typeof CodeIntelReferencesResult.Type;

export const CodeIntelPositionInput = Schema.Struct({
  document: CodeDocument,
  position: CodePosition,
});
export type CodeIntelPositionInput = typeof CodeIntelPositionInput.Type;

export const CodeHighlightKind = Schema.Literals(["text", "read", "write"]);
export type CodeHighlightKind = typeof CodeHighlightKind.Type;

export const CodeIntelDocumentHighlightsResult = Schema.Struct({
  ranges: Schema.Array(Schema.Struct({ range: CodeRange, kind: CodeHighlightKind })),
  revision: Schema.String,
});
export type CodeIntelDocumentHighlightsResult = typeof CodeIntelDocumentHighlightsResult.Type;

export const CodeIntelHoverResult = Schema.Struct({
  markdown: Schema.NullOr(Schema.String),
  range: Schema.optional(CodeRange),
  revision: Schema.String,
});
export type CodeIntelHoverResult = typeof CodeIntelHoverResult.Type;

export const CodeIntelDocumentInput = Schema.Struct({ document: CodeDocument });
export type CodeIntelDocumentInput = typeof CodeIntelDocumentInput.Type;

export const CodeIntelDocumentSymbolsResult = Schema.Struct({
  symbols: Schema.Array(CodeSymbol),
  revision: Schema.String,
});
export type CodeIntelDocumentSymbolsResult = typeof CodeIntelDocumentSymbolsResult.Type;

export const CodeIntelWorkspaceSymbolsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /** Absent: every language with a server for this root. */
  languageId: Schema.optional(TrimmedNonEmptyString),
  query: TrimmedString.check(Schema.isMaxLength(CODE_INTEL_QUERY_MAX_LENGTH)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(CODE_INTEL_WORKSPACE_SYMBOLS_MAX_LIMIT)),
  kinds: Schema.optional(Schema.Array(CodeSymbolKind)),
});
export type CodeIntelWorkspaceSymbolsInput = typeof CodeIntelWorkspaceSymbolsInput.Type;

export const CodeWorkspaceSymbol = Schema.Struct({
  name: Schema.String,
  kind: CodeSymbolKind,
  containerName: Schema.optional(Schema.String),
  location: CodeLocation,
});
export type CodeWorkspaceSymbol = typeof CodeWorkspaceSymbol.Type;

export const CodeIntelWorkspaceSymbolsResult = Schema.Struct({
  symbols: Schema.Array(CodeWorkspaceSymbol),
  truncated: Schema.Boolean,
});
export type CodeIntelWorkspaceSymbolsResult = typeof CodeIntelWorkspaceSymbolsResult.Type;

export const CodeIntelSemanticTokensInput = Schema.Struct({
  document: CodeDocument,
  range: Schema.optional(CodeRange),
});
export type CodeIntelSemanticTokensInput = typeof CodeIntelSemanticTokensInput.Type;

export const CodeSemanticTokensLegend = Schema.Struct({
  tokenTypes: Schema.Array(Schema.String),
  tokenModifiers: Schema.Array(Schema.String),
});
export type CodeSemanticTokensLegend = typeof CodeSemanticTokensLegend.Type;

export const CodeIntelSemanticTokensResult = Schema.Union([
  Schema.Struct({
    legend: CodeSemanticTokensLegend,
    /** LSP's packed relative encoding: five integers a token. */
    data: Schema.Array(NonNegativeInt),
    revision: Schema.String,
  }),
  /** The language server has no semantic tokens. */
  Schema.Struct({ legend: Schema.Null, revision: Schema.String }),
]);
export type CodeIntelSemanticTokensResult = typeof CodeIntelSemanticTokensResult.Type;

export const CodeIntelErrorReason = Schema.Literals([
  "unsupported_language",
  "server_unavailable",
  "server_failed",
  "timeout",
  "stale_document",
  "file_too_large",
  "not_found",
  "path_not_allowed",
]);
export type CodeIntelErrorReason = typeof CodeIntelErrorReason.Type;

export class CodeIntelError extends Schema.TaggedError<CodeIntelError>()("CodeIntelError", {
  reason: CodeIntelErrorReason,
  message: Schema.String,
}) {}
