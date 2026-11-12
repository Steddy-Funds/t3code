import type { CodePosition, CodeRange, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

/** A place a code jump left from or went to: a file and a position in it. */
export interface CodeHistoryEntry {
  readonly path: string;
  readonly position: CodePosition;
}

export interface CodeHistory {
  readonly back: ReadonlyArray<CodeHistoryEntry>;
  readonly forward: ReadonlyArray<CodeHistoryEntry>;
}

export type CodeHistoryDirection = "back" | "forward";

/** A jump target whose viewer still has to put its caret there. */
export interface CodeReveal {
  readonly path: string;
  readonly range: CodeRange;
  readonly id: number;
}

/** The thread of the most recent code jump, and the app location it happened at. */
export interface CodeJump {
  readonly threadRef: ScopedThreadRef;
  readonly href: string;
}

const CODE_HISTORY_LIMIT = 100;

export const EMPTY_CODE_HISTORY: CodeHistory = { back: [], forward: [] };

function sameEntry(left: CodeHistoryEntry, right: CodeHistoryEntry): boolean {
  return (
    left.path === right.path &&
    left.position.line === right.position.line &&
    left.position.character === right.position.character
  );
}

function appendEntry(
  entries: ReadonlyArray<CodeHistoryEntry>,
  entry: CodeHistoryEntry,
): ReadonlyArray<CodeHistoryEntry> {
  const last = entries.at(-1);
  if (last && sameEntry(last, entry)) return entries;
  return [...entries, entry].slice(-CODE_HISTORY_LIMIT);
}

/** A jump records where it left from; like a browser, it drops what forward held. */
export function pushCodeHistory(history: CodeHistory, origin: CodeHistoryEntry): CodeHistory {
  return { back: appendEntry(history.back, origin), forward: [] };
}

/** Moves one step, keeping `current` on the other stack so the step can be undone. */
export function stepCodeHistory(
  history: CodeHistory,
  direction: CodeHistoryDirection,
  current: CodeHistoryEntry | null,
): { readonly history: CodeHistory; readonly target: CodeHistoryEntry } | null {
  const from = direction === "back" ? history.back : history.forward;
  const target = from.at(-1);
  if (target === undefined) return null;
  const remaining = from.slice(0, -1);
  const to = direction === "back" ? history.forward : history.back;
  const opposite = current === null ? to : appendEntry(to, current);
  return {
    target,
    history:
      direction === "back"
        ? { back: remaining, forward: opposite }
        : { back: opposite, forward: remaining },
  };
}

interface CodeNavigationState {
  readonly historyByThreadKey: Record<string, CodeHistory>;
  readonly revealByThreadKey: Record<string, CodeReveal>;
  readonly lastJump: CodeJump | null;
  readonly recordOrigin: (threadKey: string, origin: CodeHistoryEntry) => void;
  readonly setHistory: (threadKey: string, history: CodeHistory) => void;
  readonly reveal: (
    threadKey: string,
    threadRef: ScopedThreadRef,
    path: string,
    range: CodeRange,
  ) => void;
}

let nextRevealId = 1;

// In memory only: like the IDE, history lasts as long as the window.
export const useCodeNavigationStore = create<CodeNavigationState>()((set) => ({
  historyByThreadKey: {},
  revealByThreadKey: {},
  lastJump: null,
  recordOrigin: (threadKey, origin) =>
    set((state) => ({
      historyByThreadKey: {
        ...state.historyByThreadKey,
        [threadKey]: pushCodeHistory(
          state.historyByThreadKey[threadKey] ?? EMPTY_CODE_HISTORY,
          origin,
        ),
      },
    })),
  setHistory: (threadKey, history) =>
    set((state) => ({
      historyByThreadKey: { ...state.historyByThreadKey, [threadKey]: history },
    })),
  reveal: (threadKey, threadRef, path, range) =>
    set((state) => ({
      revealByThreadKey: {
        ...state.revealByThreadKey,
        [threadKey]: { path, range, id: nextRevealId++ },
      },
      lastJump: { threadRef, href: window.location.href },
    })),
}));
