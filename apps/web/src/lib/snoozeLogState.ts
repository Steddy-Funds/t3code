import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  MAX_SNOOZE_LOG_ENTRIES,
  type ThreadSnoozeLogEntry,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { orchestrationEnvironment } from "../state/orchestration";
import { formatEnvironmentQueryError } from "../state/query";

export interface EnvironmentSnoozeLogEntry extends ThreadSnoozeLogEntry {
  readonly environmentId: EnvironmentId;
}

interface SnoozeLogsState {
  /** Newest first, across every environment asked for. */
  readonly entries: ReadonlyArray<EnvironmentSnoozeLogEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
}

const KEY_SEPARATOR = "\n";

const snoozeLogsAtom = Atom.family((environmentKey: string) =>
  Atom.make((get): SnoozeLogsState => {
    const entries: EnvironmentSnoozeLogEntry[] = [];
    let error: string | null = null;
    let isLoading = false;
    const environmentIds = environmentKey ? environmentKey.split(KEY_SEPARATOR) : [];
    for (const id of environmentIds) {
      const environmentId = EnvironmentId.make(id);
      const result = get(
        orchestrationEnvironment.snoozeLog({
          environmentId,
          input: { limit: MAX_SNOOZE_LOG_ENTRIES },
        }),
      );
      isLoading ||= result.waiting;
      if (result._tag === "Failure") error ??= formatEnvironmentQueryError(result.cause);
      if (result._tag === "Success") {
        for (const entry of result.value.entries) entries.push({ ...entry, environmentId });
      }
    }
    return {
      entries: entries.toSorted((left, right) => right.snoozedAt.localeCompare(left.snoozedAt)),
      error,
      isLoading,
    };
  }),
);

export function useSnoozeLogs(environmentIds: ReadonlyArray<EnvironmentId>): SnoozeLogsState {
  return useAtomValue(snoozeLogsAtom(environmentIds.toSorted().join(KEY_SEPARATOR)));
}
