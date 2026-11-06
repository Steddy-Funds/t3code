import type { ClientSettings } from "@t3tools/contracts";

// Ids are stored in client settings, so never rename one.
export const SIDEBAR_DETAILS_ITEMS = [
  { id: "branch", label: "Branch" },
  { id: "model", label: "Model" },
  { id: "changes", label: "Change count" },
] as const;

type SidebarDetailsItem = (typeof SIDEBAR_DETAILS_ITEMS)[number];
export type SidebarDetailsVisibility = Readonly<Record<SidebarDetailsItem["id"], boolean>>;

export function resolveSidebarDetailsVisibility(
  settings: Pick<ClientSettings, "sidebarDetailsItems">,
): SidebarDetailsVisibility {
  return Object.fromEntries(
    SIDEBAR_DETAILS_ITEMS.map((item) => [item.id, settings.sidebarDetailsItems[item.id] ?? true]),
  ) as Record<SidebarDetailsItem["id"], boolean>;
}

/** Stores only hidden items, so a later default change reaches everyone else. */
export function setSidebarDetailsItem(
  settings: Pick<ClientSettings, "sidebarDetailsItems">,
  item: SidebarDetailsItem,
  visible: boolean,
): ClientSettings["sidebarDetailsItems"] {
  const { [item.id]: _previous, ...rest } = settings.sidebarDetailsItems;
  return visible ? rest : { ...rest, [item.id]: false };
}
