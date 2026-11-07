import { MACHINE_HISTORY_MAX_MS } from "@t3tools/contracts";
import { Effect, Schema } from "effect";

import { useLocalStorage } from "~/hooks/useLocalStorage";

import type { ProcessViewMode } from "./primitives/ProcessViewToggle";

export const TASK_MANAGER_TICKS = [500, 1000, 2000, 5000] as const;
export type TaskManagerTick = (typeof TASK_MANAGER_TICKS)[number];

/** How far back the graphs reach: 15 min, or the server's whole hour of history. */
export const TASK_MANAGER_RANGES = [900_000, MACHINE_HISTORY_MAX_MS] as const;
export type TaskManagerRange = (typeof TASK_MANAGER_RANGES)[number];
const DEFAULT_TASK_MANAGER_RANGE: TaskManagerRange = 900_000;

const TaskManagerPreferences = Schema.Struct({
  tick: Schema.Literals(TASK_MANAGER_TICKS),
  viewMode: Schema.Literals(["raw", "tree", "grouped"] satisfies ReadonlyArray<ProcessViewMode>),
  // Stored preferences predate the range, so a missing one decodes to the default.
  rangeMs: Schema.Literals(TASK_MANAGER_RANGES).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TASK_MANAGER_RANGE)),
  ),
});
type TaskManagerPreferences = typeof TaskManagerPreferences.Type;

const TASK_MANAGER_PREFERENCES_KEY = "t3code:task-manager-preferences:v1";

const DEFAULT_TASK_MANAGER_PREFERENCES: TaskManagerPreferences = {
  tick: 1000,
  viewMode: "raw",
  rangeMs: DEFAULT_TASK_MANAGER_RANGE,
};

/** Tick and process view mode, shared by every task manager on this client. */
export function useTaskManagerPreferences() {
  const [preferences, setPreferences] = useLocalStorage(
    TASK_MANAGER_PREFERENCES_KEY,
    DEFAULT_TASK_MANAGER_PREFERENCES,
    TaskManagerPreferences,
  );
  return {
    ...preferences,
    setTick: (tick: TaskManagerTick) => setPreferences((current) => ({ ...current, tick })),
    setViewMode: (viewMode: ProcessViewMode) =>
      setPreferences((current) => ({ ...current, viewMode })),
    setRange: (rangeMs: TaskManagerRange) => setPreferences((current) => ({ ...current, rangeMs })),
  };
}
