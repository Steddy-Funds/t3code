import { Schema } from "effect";

import { useLocalStorage } from "~/hooks/useLocalStorage";

import type { ProcessViewMode } from "./primitives/ProcessViewToggle";

export const TASK_MANAGER_TICKS = [500, 1000, 2000, 5000] as const;
export type TaskManagerTick = (typeof TASK_MANAGER_TICKS)[number];

const TaskManagerPreferences = Schema.Struct({
  tick: Schema.Literals(TASK_MANAGER_TICKS),
  viewMode: Schema.Literals(["raw", "tree", "grouped"] satisfies ReadonlyArray<ProcessViewMode>),
});
type TaskManagerPreferences = typeof TaskManagerPreferences.Type;

const TASK_MANAGER_PREFERENCES_KEY = "t3code:task-manager-preferences:v1";

const DEFAULT_TASK_MANAGER_PREFERENCES: TaskManagerPreferences = {
  tick: 1000,
  viewMode: "raw",
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
  };
}
