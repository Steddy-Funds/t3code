import type { ThemeEditorColors } from "@t3tools/shared/themePalettes";
import type { CSSProperties } from "react";

// Lucide Bot Message Square, ISC license: marks the count of comments sent to the agent.
const AGENT_COMMENTS_ICON = encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 6V2H8'/><path d='M15 11v2'/><path d='M2 12h2'/><path d='M20 12h2'/><path d='M20 16a2 2 0 0 1-2 2H8.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 4 20.286V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z'/><path d='M9 11v2'/></svg>`,
);

/** The tree row decoration for a file's comments sent to the agent; the CSS draws its icon. */
export const agentCommentsDecoration = (count: number) => ({
  text: String(count),
  title: `${count} ${count === 1 ? "comment" : "comments"} sent to the agent`,
});

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
  span[title$=' sent to the agent'] { display: inline-flex; align-items: center; gap: 2px; font-variant-numeric: tabular-nums; }
  span[title$=' sent to the agent']::before {
    content: ''; width: 12px; height: 12px; background: currentColor;
    mask: url("data:image/svg+xml,${AGENT_COMMENTS_ICON}") center / contain no-repeat;
  }
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
