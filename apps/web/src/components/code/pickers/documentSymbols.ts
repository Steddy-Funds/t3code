import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { CodeSymbol } from "@t3tools/contracts";
import { fileContentRevision } from "@t3tools/shared/fileContentRevision";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { codeIntelEnvironment } from "~/state/codeIntel";

import { getProjectFileQueryAtom } from "../../files/projectFilesQueryState";
import { fileExtension } from "../codeLanguages";
import { codeIntelFailureMessage } from "../codeNavigationMessages";
import { codeIntelOutcome, codeIntelStep } from "../codeNavigationModel";
import type { CodeViewer, CodeViewerDocument } from "../navigation";

export type DocumentSymbolsAnswer =
  | {
      readonly _tag: "symbols";
      readonly symbols: ReadonlyArray<CodeSymbol>;
      readonly document: CodeViewerDocument;
    }
  | { readonly _tag: "message"; readonly message: string }
  | { readonly _tag: "none" };

/**
 * The outline of the file the viewer shows, for the text it shows. A clean file that changed on
 * disk is reloaded and asked once more; unsaved edits ask for a save, as D1's lookups do.
 */
export async function documentSymbolsFor(
  viewer: CodeViewer,
  signal?: AbortSignal,
  retried = false,
): Promise<DocumentSymbolsAnswer> {
  const asked = viewer.document();
  if (asked === null) return { _tag: "none" };
  const result = await executeAtomQuery(
    appAtomRegistry,
    codeIntelEnvironment.documentSymbols({
      environmentId: asked.environmentId,
      input: {
        document: { cwd: asked.cwd, path: asked.path, ifRevision: fileContentRevision(asked.text) },
      },
    }),
    { reportFailure: false, reportDefect: false, ...(signal ? { signal } : {}) },
  );
  const shown = viewer.document();
  if (signal?.aborted || shown === null || shown.path !== asked.path) return { _tag: "none" };
  const step = codeIntelStep(
    codeIntelOutcome(result),
    { revision: fileContentRevision(shown.text), unsaved: shown.unsaved },
    retried,
  );
  switch (step._tag) {
    case "use":
      return { _tag: "symbols", symbols: step.value.symbols, document: shown };
    case "ignore":
    case "close":
      return { _tag: "none" };
    case "hint":
      return { _tag: "message", message: step.message };
    case "reload":
      await executeAtomQuery(
        appAtomRegistry,
        getProjectFileQueryAtom(shown.environmentId, shown.cwd, shown.path),
        { refresh: true, reportFailure: false, reportDefect: false },
      );
      return documentSymbolsFor(viewer, signal, true);
    case "failed":
      return {
        _tag: "message",
        message: codeIntelFailureMessage(step.reason, step.message, {
          extension: fileExtension(shown.path),
          server: null,
        }),
      };
  }
}
