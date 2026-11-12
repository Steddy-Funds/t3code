import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import {
  type RightPanelSurface,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";

export const RECENT_FILES_PER_THREAD = 50;
export const RECENT_FILE_THREADS = 100;

type RecentFilesByThreadKey = Readonly<Record<string, ReadonlyArray<string>>>;

interface CodeSymbolsState {
  /** Per right panel host thread, most recent first. */
  readonly recentFilesByThreadKey: RecentFilesByThreadKey;
}

/** Moves the path to the front of the thread's list; the least recently used thread drops out. */
export function withRecentFile(
  byThreadKey: RecentFilesByThreadKey,
  threadKey: string,
  path: string,
): RecentFilesByThreadKey {
  const previous = byThreadKey[threadKey] ?? [];
  if (previous[0] === path && Object.keys(byThreadKey).at(-1) === threadKey) return byThreadKey;
  const { [threadKey]: _moved, ...rest } = byThreadKey;
  const keys = Object.keys(rest);
  const kept = keys.slice(Math.max(0, keys.length - (RECENT_FILE_THREADS - 1)));
  return {
    ...Object.fromEntries(kept.map((key) => [key, rest[key] ?? []])),
    [threadKey]: [path, ...previous.filter((entry) => entry !== path)].slice(
      0,
      RECENT_FILES_PER_THREAD,
    ),
  };
}

function activeFilePath(state: ThreadRightPanelState | undefined): string | null {
  const surface = state?.surfaces.find((entry) => entry.id === state.activeSurfaceId);
  return surface?.kind === "file" && surface.id.startsWith("file:") ? surface.relativePath : null;
}

/** The files that became a thread's active panel tab between two panel states. */
export function activatedFiles(
  next: Readonly<Record<string, ThreadRightPanelState>>,
  previous: Readonly<Record<string, ThreadRightPanelState>>,
): ReadonlyArray<{ readonly threadKey: string; readonly path: string }> {
  const activated: Array<{ readonly threadKey: string; readonly path: string }> = [];
  for (const [threadKey, state] of Object.entries(next)) {
    const before = previous[threadKey];
    if (state === before || state.activeSurfaceId === before?.activeSurfaceId) continue;
    const path = activeFilePath(state);
    if (path !== null) activated.push({ threadKey, path });
  }
  return activated;
}

function fileSurfacePath(surface: RightPanelSurface): string | null {
  return surface.kind === "file" && surface.id.startsWith("file:") ? surface.relativePath : null;
}

/**
 * Recent files for the picker: the recorded ones, then open tabs never recorded, without the file
 * the panel shows now, so the first entry is the one to go back to.
 */
export function recentFileList(
  recorded: ReadonlyArray<string>,
  panel: ThreadRightPanelState | undefined,
): ReadonlyArray<string> {
  const shown = panel?.isOpen ? activeFilePath(panel) : null;
  const open = (panel?.surfaces ?? []).flatMap((surface) => {
    const path = fileSurfacePath(surface);
    return path === null ? [] : [path];
  });
  const paths = [...recorded, ...open.filter((path) => !recorded.includes(path))];
  return paths.filter((path) => path !== shown);
}

function isRecentFilesByThreadKey(value: unknown): value is RecentFilesByThreadKey {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every(
      (paths) => Array.isArray(paths) && paths.every((path) => typeof path === "string"),
    )
  );
}

export const useCodeSymbolsStore = create<CodeSymbolsState>()(
  persist(() => ({ recentFilesByThreadKey: {} }), {
    name: "t3code:recent-code-files:v1",
    version: 1,
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
    merge: (persisted, current) => {
      const recent =
        typeof persisted === "object" && persisted !== null && "recentFilesByThreadKey" in persisted
          ? persisted.recentFilesByThreadKey
          : null;
      return isRecentFilesByThreadKey(recent)
        ? { ...current, recentFilesByThreadKey: recent }
        : current;
    },
  }),
);

useRightPanelStore.subscribe((next, previous) => {
  if (next.byThreadKey === previous.byThreadKey) return;
  const activated = activatedFiles(next.byThreadKey, previous.byThreadKey);
  if (activated.length === 0) return;
  useCodeSymbolsStore.setState((state) => ({
    recentFilesByThreadKey: activated.reduce(
      (byThreadKey, { threadKey, path }) => withRecentFile(byThreadKey, threadKey, path),
      state.recentFilesByThreadKey,
    ),
  }));
});
