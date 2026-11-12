import type { CodeIntelErrorReason, CodeServerStatus } from "@t3tools/contracts";

export type CodeNavigationAction =
  | "declaration"
  | "typeDeclaration"
  | "implementation"
  | "usages"
  | "highlightUsages"
  | "documentation"
  | "definition";

const NO_RESULT: Record<CodeNavigationAction, string> = {
  declaration: "No declaration found",
  typeDeclaration: "No type declaration found",
  implementation: "No implementations found",
  usages: "No usages found",
  highlightUsages: "No usages found in this file",
  documentation: "No documentation found",
  definition: "No definition found",
};

export function noResultMessage(action: CodeNavigationAction): string {
  return NO_RESULT[action];
}

export function waitingMessage(server: CodeServerStatus | null): string {
  const name = server?.name ?? "the language server";
  if (server?.state === "indexing") return `Waiting for ${name} to finish indexing…`;
  if (server?.state === "starting" || server?.state === "stopped") {
    return `Waiting for ${name} to start…`;
  }
  return `Waiting for ${name}…`;
}

export function codeIntelFailureMessage(
  reason: CodeIntelErrorReason,
  message: string,
  context: { readonly extension: string; readonly server: CodeServerStatus | null },
): string {
  const name = context.server?.name ?? "The language server";
  switch (reason) {
    case "unsupported_language":
      return context.extension === ""
        ? "No language server for this file"
        : `No language server for .${context.extension}`;
    case "server_unavailable":
      return message || `${name} is not installed`;
    case "server_failed":
      return message || `${name} stopped working`;
    case "timeout":
      return context.server?.state === "indexing"
        ? `${name} is still indexing. Try again in a moment.`
        : `${name} did not answer in time`;
    case "stale_document":
      return "The file changed on disk. Reopen it to navigate.";
    case "file_too_large":
      return "This file is too large for the language server";
    case "not_found":
      return "This file no longer exists";
    case "path_not_allowed":
      return "This connection cannot read that file";
  }
}
