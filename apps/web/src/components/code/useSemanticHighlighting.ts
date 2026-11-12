import { useAtomValue } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { CodeSemanticTokensLegend, CodeServerState, EnvironmentId } from "@t3tools/contracts";
import { fileContentRevision } from "@t3tools/shared/fileContentRevision";
import type { PostRenderPhase } from "@pierre/diffs";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { usePaintedThemeEditorColors } from "~/lib/paintedThemeEditorColors";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { codeIntelEnvironment } from "~/state/codeIntel";

import {
  getProjectFileContents,
  getUnsavedProjectFileQueryData,
  optimisticFileAtom,
} from "../files/projectFilesQueryState";
import {
  adoptSemanticHighlightStyles,
  decodeSemanticTokens,
  hasSemanticColors,
  mergeSemanticTokens,
  renderedLineSpan,
  type SemanticHighlightOf,
  SemanticHighlighter,
  semanticChunkRange,
  semanticChunksFor,
  semanticHighlightResolver,
  type SemanticTokenLines,
  supportsSemanticHighlighting,
  textLines,
  unchangedLineMap,
  WHOLE_DOCUMENT_MAX_LINES,
} from "./semanticHighlighting";
import type { CodeIntelFile } from "./useCodeIntelFile";

const EDIT_DEBOUNCE_MS = 250;
const SCROLL_DEBOUNCE_MS = 150;

interface SemanticAnswer {
  readonly documentKey: string;
  readonly revision: string;
  readonly lines: ReadonlyArray<string>;
  readonly legend: CodeSemanticTokensLegend;
  readonly tokens: SemanticTokenLines;
  /** The chunks answered for a file asked by chunks; null when it was asked whole. */
  readonly chunks: Set<number> | null;
  /** When it was asked: an older answer never replaces a newer one. */
  readonly order: number;
}

/** The server state a revision and chunk was last asked in, and whether that ask is still out. */
interface AskRecord {
  readonly key: string;
  readonly revision: string;
  readonly state: CodeServerState;
  pending: boolean;
}

function lineCount(text: string): number {
  let count = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
}

function sameLegend(a: CodeSemanticTokensLegend, b: CodeSemanticTokensLegend): boolean {
  return (
    a.tokenTypes.join() === b.tokenTypes.join() &&
    a.tokenModifiers.join() === b.tokenModifiers.join()
  );
}

export interface SemanticHighlightingOptions {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string | null;
  readonly text: string;
  /** A raw text file is on screen. */
  readonly shown: boolean;
  readonly intel: CodeIntelFile;
}

/**
 * The language server's semantic token colours over the lexer's, in the painted theme's colours.
 * Nothing is asked under a theme without semantic colours, for a file without a language server,
 * or in a browser without the CSS Custom Highlight API. The lexer's colours show until an answer
 * arrives; answers live in refs and paint straight into the DOM, so none re-renders the viewer.
 */
export function useSemanticHighlighting(options: SemanticHighlightingOptions) {
  const { environmentId, cwd, path, text, intel } = options;
  const theme = usePaintedThemeEditorColors();
  const serverState: CodeServerState | null = intel.server?.state ?? null;
  const active =
    options.shown &&
    path !== null &&
    intel.supported &&
    serverState !== null &&
    serverState !== "unavailable" &&
    serverState !== "failed" &&
    hasSemanticColors(theme) &&
    supportsSemanticHighlighting();
  const documentKey = active ? `${environmentId}\n${cwd}\n${path}` : null;
  const chunked = active && lineCount(text) > WHOLE_DOCUMENT_MAX_LINES;
  // The server reads the file on disk, so an edit is asked about once it is saved.
  const optimistic = useAtomValue(optimisticFileAtom(environmentId, cwd, path ?? ""));
  const unsaved = optimistic != null && optimistic.confirmedAgainst === undefined;

  const [highlighter] = useState(() => new SemanticHighlighter());
  const containerRef = useRef<HTMLElement | null>(null);
  const answerRef = useRef<SemanticAnswer | null>(null);
  const askedRef = useRef(new Map<string, AskRecord>());
  const generationRef = useRef(new AbortController());
  const orderRef = useRef(0);
  const lastAskedRef = useRef<string | null>(null);
  const mappingRef = useRef<{
    readonly answer: SemanticAnswer;
    readonly text: string;
    readonly lineOf: (line: number) => number | null;
  } | null>(null);
  const resolverRef = useRef<{
    readonly theme: object;
    readonly legend: CodeSemanticTokensLegend;
    readonly highlightOf: SemanticHighlightOf;
  } | null>(null);
  const scrollTimerRef = useRef<number | null>(null);

  const currentText = () =>
    path === null ? text : (getProjectFileContents(environmentId, cwd, path) ?? text);

  const highlightOfFor = (answer: SemanticAnswer): SemanticHighlightOf | null => {
    if (!hasSemanticColors(theme)) return null;
    const cached = resolverRef.current;
    if (cached?.theme === theme && cached.legend === answer.legend) return cached.highlightOf;
    const highlightOf = semanticHighlightResolver(theme, answer.legend);
    resolverRef.current = { theme, legend: answer.legend, highlightOf };
    return highlightOf;
  };

  // The answer's lines carried over to the text on screen; edited lines have none.
  const lineMapFor = (answer: SemanticAnswer, shown: string) => {
    const cached = mappingRef.current;
    if (cached?.answer === answer && cached.text === shown) return cached.lineOf;
    const lineOf = unchangedLineMap(answer.lines, textLines(shown));
    mappingRef.current = { answer, text: shown, lineOf };
    return lineOf;
  };

  const paint = () => {
    const root = containerRef.current?.shadowRoot ?? null;
    const answer = answerRef.current;
    const highlightOf = answer === null ? null : highlightOfFor(answer);
    if (root === null || answer === null || answer.documentKey !== documentKey || !highlightOf) {
      highlighter.clear();
      return;
    }
    const lineOf = lineMapFor(answer, currentText());
    highlighter.paint(
      root,
      (line) => {
        const answered = lineOf(line);
        const tokens = answered === null ? undefined : answer.tokens.get(answered);
        return tokens === undefined ? null : { text: answer.lines[answered!]!, tokens };
      },
      highlightOf,
    );
  };

  // Kept and painted with the latest render's props, so a theme switch meanwhile paints the new one.
  const keep = useEffectEvent(
    (
      answer: Omit<SemanticAnswer, "documentKey" | "chunks"> & { readonly chunk: number | null },
    ) => {
      if (documentKey === null) return;
      const current = answerRef.current;
      if (
        answer.chunk !== null &&
        current?.documentKey === documentKey &&
        current.revision === answer.revision &&
        current.chunks !== null &&
        sameLegend(current.legend, answer.legend)
      ) {
        mergeSemanticTokens(current.tokens, answer.tokens);
        current.chunks.add(answer.chunk);
      } else if (current?.documentKey !== documentKey || current.order < answer.order) {
        answerRef.current = {
          documentKey,
          revision: answer.revision,
          lines: answer.lines,
          legend: answer.legend,
          tokens: answer.tokens,
          chunks: answer.chunk === null ? null : new Set([answer.chunk]),
          order: answer.order,
        };
      }
      paint();
    },
  );

  // An ask made before the server was ready is made once more when it is.
  const asksAgain = useEffectEvent((record: AskRecord) => {
    if (serverState !== "ready") {
      // Asking may have started the server; the status chip follows it while it loads.
      intel.refreshStatus();
      return false;
    }
    return record.state !== "ready" && lastAskedRef.current === record.revision;
  });

  const ask = async function askTokens(
    record: AskRecord,
    filePath: string,
    asked: string,
    chunk: number | null,
    refresh: boolean,
  ): Promise<void> {
    const generation = generationRef.current;
    orderRef.current += 1;
    const order = orderRef.current;
    const result = await executeAtomQuery(
      appAtomRegistry,
      codeIntelEnvironment.semanticTokens({
        environmentId,
        input: {
          document: { cwd, path: filePath, ifRevision: record.revision },
          ...(chunk === null ? {} : { range: semanticChunkRange(chunk) }),
        },
      }),
      { refresh, reportFailure: false, reportDefect: false, signal: generation.signal },
    );
    if (generation.signal.aborted) return;
    record.pending = false;
    // A failure leaves the lexer's colours; an answer must be for the text that was asked.
    if (
      result._tag === "Success" &&
      result.value.legend !== null &&
      result.value.revision === record.revision
    ) {
      keep({
        lines: textLines(asked),
        revision: record.revision,
        chunk,
        order,
        legend: result.value.legend,
        tokens: decodeSemanticTokens(result.value.data),
      });
    }
    if (!asksAgain(record)) return;
    const again: AskRecord = { ...record, state: "ready", pending: true };
    askedRef.current.set(record.key, again);
    await askTokens(again, filePath, asked, chunk, true);
  };

  const askMissing = () => {
    if (documentKey === null || path === null || serverState === null) return;
    if (getUnsavedProjectFileQueryData(environmentId, cwd, path) !== null) return;
    const asked = currentText();
    const revision = fileContentRevision(asked);
    let chunks: ReadonlyArray<number | null> = [null];
    if (lineCount(asked) > WHOLE_DOCUMENT_MAX_LINES) {
      const root = containerRef.current?.shadowRoot ?? null;
      const span = root === null ? null : renderedLineSpan(root);
      if (span === null) return;
      chunks = semanticChunksFor(span.first, span.last);
    }
    lastAskedRef.current = revision;
    for (const chunk of chunks) {
      const key = `${revision}:${chunk ?? "all"}`;
      const previous = askedRef.current.get(key);
      if (
        previous !== undefined &&
        (previous.pending || previous.state === "ready" || serverState !== "ready")
      ) {
        continue;
      }
      const record: AskRecord = { key, revision, state: serverState, pending: true };
      askedRef.current.set(key, record);
      void ask(record, path, asked, chunk, previous !== undefined);
    }
  };

  const askSoon = useEffectEvent(() => askMissing());
  const repaint = useEffectEvent(() => paint());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new file or the feature switching off cancels what was asked and wipes what was painted for the last one
  useEffect(() => {
    if (documentKey === null) return;
    const asked = askedRef.current;
    return () => {
      generationRef.current.abort();
      generationRef.current = new AbortController();
      asked.clear();
      answerRef.current = null;
      if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = null;
      highlighter.clear();
    };
  }, [documentKey, highlighter]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the language server about the text on screen once it is on disk
  useEffect(() => {
    if (documentKey === null || unsaved) return;
    const timer = window.setTimeout(askSoon, answerRef.current === null ? 0 : EDIT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A saved edit or a new server state asks again.
  }, [documentKey, text, unsaved, serverState]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an edit or a theme switch repaints the rendered rows before the browser shows them
  useLayoutEffect(() => {
    repaint();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- An edit or a theme switch repaints.
  }, [text, theme, documentKey]);

  const onPostRender = (fileContainer: HTMLElement, phase: PostRenderPhase) => {
    if (phase === "unmount") {
      if (containerRef.current !== fileContainer) return;
      containerRef.current = null;
      highlighter.clear();
      return;
    }
    containerRef.current = fileContainer;
    if (documentKey === null) {
      highlighter.clear();
      return;
    }
    if (fileContainer.shadowRoot) adoptSemanticHighlightStyles(fileContainer.shadowRoot);
    paint();
    if (!chunked) return;
    // A long file asks for the chunks on screen once scrolling settles.
    if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      scrollTimerRef.current = null;
      askSoon();
    }, SCROLL_DEBOUNCE_MS);
  };

  return { onPostRender };
}
