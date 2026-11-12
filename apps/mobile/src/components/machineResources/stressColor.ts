import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";

/** The light red a stressed machine's symbol takes; web's `--machine-stress` (red-400, red-300 in dark). */
export function useMachineStressColor(): string {
  const { themeAppearance } = useAppearancePreferences();
  return themeAppearance === "dark" ? "#fca5a5" : "#f87171";
}
