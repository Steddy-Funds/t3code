import { useEffect, useEffectEvent, useState } from "react";

import { type ActiveProjectTarget, useActiveProjectTarget } from "~/hooks/useActiveProjectTarget";
import { useTheme } from "~/hooks/useTheme";
import { useRightPanelStore } from "~/rightPanelStore";
import { registerCommands } from "~/shortcuts/dispatcher";
import { recentFileList, useCodeSymbolsStore } from "~/state/codeSymbols";

import { PierreEntryIcon } from "../../chat/PierreEntryIcon";
import {
  type CommandPaletteActionItem,
  findHighlightedCommandPaletteItem,
} from "../../CommandPalette.logic";
import { codeNavigationThreadKey } from "../navigation";
import { CodePicker, effectiveHighlight } from "./CodePicker";
import { fileName, matchIndices, parentFolder } from "./codePickers.logic";
import { HighlightedName } from "./HighlightedName";

const NO_FILES: ReadonlyArray<string> = [];

function RecentFiles(props: {
  readonly target: ActiveProjectTarget;
  readonly escapeLabel: "Back" | "Close";
  readonly setOpen: (open: boolean) => void;
}) {
  const { target } = props;
  const threadKey = codeNavigationThreadKey(target.threadRef);
  const recorded = useCodeSymbolsStore(
    (state) => state.recentFilesByThreadKey[threadKey] ?? NO_FILES,
  );
  const panel = useRightPanelStore((state) => state.byThreadKey[threadKey]);
  const { resolvedTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);

  const paths = recentFileList(recorded, panel).filter(
    (path) => matchIndices(path, query) !== null,
  );
  const items: CommandPaletteActionItem[] = paths.map((path) => ({
    kind: "action",
    value: `recent:${path}`,
    searchTerms: [path],
    title: <HighlightedName name={fileName(path)} query={query} />,
    ...(parentFolder(path) === "" ? {} : { description: parentFolder(path) }),
    icon: <PierreEntryIcon pathValue={path} kind="file" theme={resolvedTheme} />,
    run: async () => {
      useRightPanelStore.getState().openFile(target.threadRef, path);
    },
  }));
  const groups = items.length === 0 ? [] : [{ value: "recent-files", label: "", items }];

  const execute = (item: CommandPaletteActionItem) => {
    props.setOpen(false);
    void item.run();
  };

  // Cmd+E again opens the highlighted file: twice in a row goes back to the previous one.
  const openHighlighted = useEffectEvent((event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    const value = effectiveHighlight(
      items.map((item) => item.value),
      highlightedValue,
    );
    const item = findHighlightedCommandPaletteItem(groups, value);
    if (item?.kind === "action") execute(item);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- takes the recent files key from the window dispatcher while the list is open
  useEffect(
    () =>
      registerCommands(
        { "code.recentFiles": (event) => openHighlighted(event) },
        { capture: true },
      ),
    [],
  );

  return (
    <CodePicker
      label="Recent files"
      testId="code-recent-files-picker"
      placeholder="Filter recent files…"
      footerActionLabel="Open file"
      escapeLabel={props.escapeLabel}
      query={query}
      onQueryChange={(value) => {
        setQuery(value);
        setHighlightedValue(null);
      }}
      groups={groups}
      highlightedValue={highlightedValue}
      onHighlight={setHighlightedValue}
      emptyStateMessage={
        query.trim() === "" ? "No other files opened in this thread yet" : "No recent files match"
      }
      onExecute={execute}
    />
  );
}

export function RecentFilesPicker(props: {
  readonly escapeLabel: "Back" | "Close";
  readonly setOpen: (open: boolean) => void;
}) {
  const target = useActiveProjectTarget();
  if (target === null) {
    return (
      <CodePicker
        label="Recent files"
        testId="code-recent-files-picker"
        placeholder="Filter recent files…"
        footerActionLabel={null}
        escapeLabel={props.escapeLabel}
        query=""
        onQueryChange={() => undefined}
        groups={[]}
        highlightedValue={null}
        onHighlight={() => undefined}
        emptyStateMessage="Open a thread to see its recent files."
        disabled
        onExecute={() => undefined}
      />
    );
  }
  return (
    <RecentFiles
      key={target.threadRef.threadId}
      target={target}
      escapeLabel={props.escapeLabel}
      setOpen={props.setOpen}
    />
  );
}
