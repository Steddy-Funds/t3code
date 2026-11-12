import type { MouseEvent } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { MiddleTruncate } from "../ui/middle-truncate";
import { toastManager } from "../ui/toast";

const stopRowActivation = (event: MouseEvent<HTMLElement>) => event.stopPropagation();

/** A card's branch name; clicking copies it instead of opening the thread. */
export function SidebarBranchName(props: { branch: string }) {
  const { branch } = props;
  const copy = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    void writeTextToClipboard(branch, "branch name").then(
      (didCopy) => {
        if (!didCopy) return;
        toastManager.add({ type: "success", title: "Branch name copied", description: branch });
      },
      () => toastManager.add({ type: "error", title: "Failed to copy branch name" }),
    );
  };
  return (
    <button
      type="button"
      aria-label={`Copy branch name ${branch}`}
      onPointerDown={stopRowActivation}
      onClick={copy}
      className="inline-flex min-w-0 max-w-full cursor-copy rounded-sm text-start outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <MiddleTruncate value={branch} showTitle={false} />
    </button>
  );
}
