import type { ClientSettings } from "@t3tools/contracts";

// Ids are stored in client settings, so never rename one.
export const SIDEBAR_DETAILS_ITEMS = [
  { id: "branch", label: "Branch", defaultOn: true },
  { id: "model", label: "Model", defaultOn: true },
  { id: "machine", label: "Machine", defaultOn: true },
  { id: "agentLineage", label: "Full agent lineage", defaultOn: false },
] as const;

type SidebarDetailsItem = (typeof SIDEBAR_DETAILS_ITEMS)[number];
export type SidebarDetailsVisibility = Readonly<Record<SidebarDetailsItem["id"], boolean>>;

export function resolveSidebarDetailsVisibility(
  settings: Pick<ClientSettings, "sidebarDetailsItems">,
): SidebarDetailsVisibility {
  return Object.fromEntries(
    SIDEBAR_DETAILS_ITEMS.map((item) => [
      item.id,
      settings.sidebarDetailsItems[item.id] ?? item.defaultOn,
    ]),
  ) as Record<SidebarDetailsItem["id"], boolean>;
}

/** Stores only changed items, so a later default change reaches everyone else. */
export function setSidebarDetailsItem(
  settings: Pick<ClientSettings, "sidebarDetailsItems">,
  id: SidebarDetailsItem["id"],
  on: boolean,
): ClientSettings["sidebarDetailsItems"] {
  const item = SIDEBAR_DETAILS_ITEMS.find((candidate) => candidate.id === id);
  const { [id]: _previous, ...rest } = settings.sidebarDetailsItems;
  return on === item?.defaultOn ? rest : { ...rest, [id]: on };
}
