import type { ThemeEditorColors } from "@t3tools/shared/themePalettes";
import type { CSSProperties } from "react";

export const PIERRE_TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 0.75rem;
  }
  [data-truncate-content='visible'] { overflow: hidden; text-overflow: ellipsis; }
  [data-truncate-marker] { display: none; }
  button[data-type='item'], button[data-type='item']::before { border-radius: var(--radius-md); }
  svg[data-icon-name='t3-tree-icon-loading'] { opacity: 0.6; }
  @media (prefers-reduced-motion: no-preference) {
    svg[data-icon-name='t3-tree-icon-loading'] { animation: t3-tree-spin 1s linear infinite; }
  }
  @keyframes t3-tree-spin { to { transform: rotate(360deg); } }
`;

/**
 * A theme's file status colours go in Pierre's status variables, below its git ones, so the
 * blue-orange diff colours still win where the user picked them.
 */
export function pierreTreeStyle(
  colorScheme: "light" | "dark",
  fileStatus?: ThemeEditorColors["fileStatus"],
): CSSProperties {
  const style: Record<string, string> = {
    colorScheme,
    "--trees-fg-override": "var(--contrast-foreground)",
  };
  for (const [status, color] of Object.entries(fileStatus ?? {})) {
    style[`--trees-status-${status}-override`] = color;
  }
  return style;
}
