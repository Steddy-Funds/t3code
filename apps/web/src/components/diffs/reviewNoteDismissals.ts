import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, TurnItemId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "~/hooks/useLocalStorage";

const DismissedNoteIds = Schema.Array(Schema.String);
const NO_DISMISSED_NOTES: ReadonlyArray<string> = [];

/** Review notes the user dismissed from the diff: per thread, and in this browser only. */
export function useReviewNoteDismissals(ref: ScopedThreadRef | null) {
  const [ids, setIds] = useLocalStorage(
    `t3code.reviewNoteDismissals:${ref ? scopedThreadKey(ref) : ""}`,
    NO_DISMISSED_NOTES,
    DismissedNoteIds,
  );
  const dismissedIds: ReadonlySet<string> = new Set(ids);
  return {
    dismissedIds,
    dismiss: (noteId: TurnItemId) => {
      if (ref) setIds((current) => (current.includes(noteId) ? current : [...current, noteId]));
    },
    restore: (noteId: TurnItemId) => {
      if (ref) setIds((current) => current.filter((id) => id !== noteId));
    },
  };
}
