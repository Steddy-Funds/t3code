import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";

export type ProcessViewMode = "raw" | "tree" | "grouped";

const MODES: ReadonlyArray<{ readonly value: ProcessViewMode; readonly label: string }> = [
  { value: "raw", label: "Raw" },
  { value: "tree", label: "Tree" },
  { value: "grouped", label: "Grouped" },
];

function isProcessViewMode(value: unknown): value is ProcessViewMode {
  return MODES.some((mode) => mode.value === value);
}

/** Raw list, process tree, or one row per group. Always one mode selected. */
export function ProcessViewToggle({
  value,
  onValueChange,
}: {
  readonly value: ProcessViewMode;
  readonly onValueChange: (mode: ProcessViewMode) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Process view"
      variant="segmented"
      value={[value]}
      onValueChange={(next) => {
        const mode = next[0];
        if (isProcessViewMode(mode)) onValueChange(mode);
      }}
    >
      {MODES.map((mode) => (
        <ToggleGroupItem key={mode.value} value={mode.value}>
          {mode.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
