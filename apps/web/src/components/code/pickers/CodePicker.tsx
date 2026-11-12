import { useAtomValue } from "@effect/atom-react";
import type { LegendListRef } from "@legendapp/list/react";
import { type KeyboardEvent, type ReactNode, useRef } from "react";

import { primaryServerKeybindingsAtom } from "~/state/server";

import {
  buildCommandPaletteRows,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  findHighlightedCommandPaletteItem,
} from "../../CommandPalette.logic";
import { CommandPaletteContent } from "../../CommandPaletteContent";
import {
  CommandPaletteVirtualizedResults,
  scrollCommandPaletteRowIntoView,
} from "../../CommandPaletteResults";
import { stepHighlight } from "./codePickers.logic";

const HIGHLIGHT_STEPS = {
  ArrowDown: "next",
  ArrowUp: "previous",
  PageDown: "pageDown",
  PageUp: "pageUp",
} as const;

/** The highlighted value while it is in the list, else the starting one, else the first item. */
export function effectiveHighlight(
  itemValues: ReadonlyArray<string>,
  highlightedValue: string | null,
  initialValue: string | null = null,
): string | null {
  for (const value of [highlightedValue, initialValue]) {
    if (value !== null && itemValues.includes(value)) return value;
  }
  return itemValues[0] ?? null;
}

export interface CodePickerProps {
  readonly label: string;
  readonly testId: string;
  readonly placeholder: string;
  /** Null when Enter has nothing it could open. */
  readonly footerActionLabel: string | null;
  readonly escapeLabel: "Back" | "Close";
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  /** Kept by the picker; null follows `initialValue`, else the first item. */
  readonly highlightedValue: string | null;
  /** Where the highlight starts, and the row the list opens on. */
  readonly initialValue?: string | null;
  readonly onHighlight: (value: string | null) => void;
  readonly emptyStateMessage: string;
  readonly footerTrailing?: ReactNode;
  readonly disabled?: boolean;
  readonly onExecute: (item: CommandPaletteActionItem) => void;
}

/** A palette list whose highlight the picker owns: Enter opens it, the arrows move it. */
export function CodePicker(props: CodePickerProps) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const listRef = useRef<LegendListRef | null>(null);
  const { rows, itemValues, rowIndexByItemIndex } = buildCommandPaletteRows(props.groups);
  const highlighted = effectiveHighlight(
    itemValues,
    props.highlightedValue,
    props.initialValue ?? null,
  );
  const highlightedIndex = highlighted === null ? null : itemValues.indexOf(highlighted);
  const initialIndex = props.initialValue == null ? -1 : itemValues.indexOf(props.initialValue);

  const execute = (item: ReturnType<typeof findHighlightedCommandPaletteItem>) => {
    if (item?.kind === "action" && !item.disabled) props.onExecute(item);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const preventBaseUI = () => {
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
    };
    const step = HIGHLIGHT_STEPS[event.key as keyof typeof HIGHLIGHT_STEPS];
    if (step !== undefined) {
      preventBaseUI();
      const next = stepHighlight(highlightedIndex, itemValues.length, step);
      if (next === null) return;
      props.onHighlight(itemValues[next] ?? null);
      scrollCommandPaletteRowIntoView(listRef.current, rowIndexByItemIndex[next] ?? 0);
      return;
    }
    if (event.key === "Enter") {
      preventBaseUI();
      event.stopPropagation();
      execute(findHighlightedCommandPaletteItem(props.groups, highlighted));
    }
  };

  return (
    <CommandPaletteContent
      aria-label={props.label}
      autoHighlight={false}
      escapeLabel={props.escapeLabel}
      {...(props.footerActionLabel === null ? {} : { footerActionLabel: props.footerActionLabel })}
      footerTrailing={props.footerTrailing}
      inputProps={{
        placeholder: props.placeholder,
        onKeyDown,
        ...(props.disabled ? { disabled: true } : {}),
      }}
      items={itemValues}
      mode="none"
      onItemHighlighted={(value, details) => {
        if (details.reason === "pointer" && typeof value === "string") props.onHighlight(value);
      }}
      onValueChange={(value) => props.onQueryChange(value)}
      panelSize="tall-list"
      testId={props.testId}
      value={props.query}
      virtualized
    >
      <CommandPaletteVirtualizedResults
        rows={rows}
        listRef={listRef}
        highlightedItemValue={highlighted}
        {...(initialIndex > 0 ? { initialRowIndex: rowIndexByItemIndex[initialIndex] ?? 0 } : {})}
        isActionsOnly={false}
        keybindings={keybindings}
        onExecuteItem={execute}
        emptyStateMessage={props.emptyStateMessage}
      />
    </CommandPaletteContent>
  );
}
