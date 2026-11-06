import { ChevronDownIcon } from "lucide-react";

import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import {
  resolveSidebarDetailsVisibility,
  setSidebarDetailsItem,
  SIDEBAR_DETAILS_ITEMS,
} from "../sidebar/sidebarDetailsItems";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function SidebarDetailsItemsRow() {
  const visibility = useClientSettings(resolveSidebarDetailsVisibility);
  const enabled = SIDEBAR_DETAILS_ITEMS.filter((item) => visibility[item.id]).length;
  return (
    <SettingsRow
      {...searchableSetting("sidebar-details-items")}
      description="Choose what each sidebar thread card shows. Without the branch, cards fit in two rows."
      resetAction={
        enabled === SIDEBAR_DETAILS_ITEMS.length ? null : (
          <SettingResetButton
            label="sidebar details"
            onClick={() => updateClientSettings({ sidebarDetailsItems: {} })}
          />
        )
      }
      control={
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-between sm:w-40"
                aria-label={`Sidebar details: ${enabled} of ${SIDEBAR_DETAILS_ITEMS.length} on`}
              />
            }
          >
            {enabled} of {SIDEBAR_DETAILS_ITEMS.length} on
            <ChevronDownIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuGroup>
              <MenuGroupLabel>Show on sidebar cards</MenuGroupLabel>
              {SIDEBAR_DETAILS_ITEMS.map((item) => (
                <MenuCheckboxItem
                  key={item.id}
                  checked={visibility[item.id]}
                  onCheckedChange={(checked) =>
                    updateClientSettings({
                      sidebarDetailsItems: setSidebarDetailsItem(
                        getClientSettings(),
                        item,
                        checked,
                      ),
                    })
                  }
                >
                  {item.label}
                </MenuCheckboxItem>
              ))}
            </MenuGroup>
          </MenuPopup>
        </Menu>
      }
    />
  );
}
