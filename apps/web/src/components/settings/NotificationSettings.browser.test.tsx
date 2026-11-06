import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  settings: null as unknown as UnifiedSettings,
  updateSettings: vi.fn(),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((selector?: (settings: UnifiedSettings) => unknown) =>
    selector ? selector(state.settings) : state.settings) as never,
  useUpdateScopedSettings: (() => state.updateSettings) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      <h4>{title}</h4>
      <p>{description}</p>
      {control}
    </div>
  )) as never,
}));

import { MachineStressedNotificationSetting } from "./NotificationSettings";

function setup(settings: Partial<UnifiedSettings>) {
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS, ...settings };
  state.updateSettings.mockReset();
}

describe("MachineStressedNotificationSetting", () => {
  it("is disabled with a hint while desktop and in-app notifications are both off", async () => {
    setup({ notificationMode: "off", inAppNotificationsEnabled: false });
    await using screen = await render(<MachineStressedNotificationSetting />);

    await expect
      .element(screen.getByRole("switch", { name: "Machine becomes stressed" }))
      .toBeDisabled();
    await expect
      .element(screen.getByText("Turn on desktop or in-app notifications to get this alert."))
      .toBeVisible();
  });

  it.each([
    ["desktop notifications", { notificationMode: "notifications", inAppNotificationsEnabled: false }],
    ["in-app notifications", { notificationMode: "sound", inAppNotificationsEnabled: true }],
  ] as const)("saves the toggle while %s are on", async (_label, settings) => {
    setup({ ...settings, notifyOnMachineStressed: true });
    await using screen = await render(<MachineStressedNotificationSetting />);
    const toggle = screen.getByRole("switch", { name: "Machine becomes stressed" });

    await expect.element(toggle).toBeEnabled();
    await expect
      .element(screen.getByText("Notify when a connected machine goes from ok to stressed."))
      .toBeVisible();
    await userEvent.click(toggle);

    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({ notifyOnMachineStressed: false });
  });
});
