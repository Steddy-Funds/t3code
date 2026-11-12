import { isMacPlatform } from "@t3tools/shared/keybindings";
import { useEffect, useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { useProjectPaneStore } from "~/components/project/projectPaneStore";
import { focusScopeProps } from "~/lib/focusScopes";
import { render } from "../../../test/render";
import { SidebarModes } from "./SidebarModes";

interface SidebarState {
  open: boolean;
  setOpen: (open: boolean) => void;
  isMobile: boolean;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
}
let sidebar: SidebarState;

function setup({ open }: { open: boolean }): SidebarState {
  useProjectPaneStore.setState({
    mode: "threads",
    treeFocusPending: false,
    sidebarOpenedForPane: false,
  });
  sidebar = { open, setOpen: vi.fn(), isMobile: false, openMobile: false, setOpenMobile: vi.fn() };
  return sidebar;
}

// projectPane.toggle is desktop-only.
vi.mock("~/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/env")>()),
  isElectron: true,
}));
vi.mock("~/components/ui/sidebar", () => ({ useSidebar: () => sidebar }));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => null,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: vi.fn() },
  sessionHasScope: () => true,
}));
vi.mock("~/components/project/ProjectPane", () => ({
  default: FakeProjectPane,
  useProjectPaneTarget: () => null,
}));

function FakeProjectPane() {
  const focusPending = useProjectPaneStore((state) => state.treeFocusPending);
  const row = useRef<HTMLButtonElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stands in for the tree taking a requested focus
  useEffect(() => {
    if (!focusPending) return;
    row.current?.focus();
    useProjectPaneStore.getState().treeFocusHandled();
  }, [focusPending]);
  return (
    <div {...focusScopeProps("project-tree")}>
      <button ref={row} type="button">
        app.ts
      </button>
    </div>
  );
}

function pressModOne(): void {
  const mac = isMacPlatform(navigator.platform);
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "1",
      metaKey: mac,
      ctrlKey: !mac,
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );
}

describe("SidebarModes", () => {
  it.each([
    { sidebarOpen: false, sidebarToggles: [[true], [false]] },
    { sidebarOpen: true, sidebarToggles: [] },
  ])(
    "mod+1 moves focus from code to the tree and back (sidebar open: $sidebarOpen)",
    async ({ sidebarOpen, sidebarToggles }) => {
      const { setOpen } = setup({ open: sidebarOpen });
      await using _screen = await render(
        <>
          <textarea aria-label="Composer" />
          <SidebarModes header={null} footer={null}>
            <button type="button">Thread one</button>
          </SidebarModes>
          <div role="region" aria-label="Code" tabIndex={0} {...focusScopeProps("code")}>
            const answer = 42;
          </div>
        </>,
      );
      const composer = page.getByRole("textbox", { name: "Composer" });
      await userEvent.click(composer);
      pressModOne();
      expect(useProjectPaneStore.getState().mode).toBe("threads");
      await expect.element(composer).toHaveFocus();

      const code = page.getByRole("region", { name: "Code" });
      await userEvent.click(code);
      pressModOne();
      await expect.element(page.getByRole("button", { name: "app.ts" })).toHaveFocus();
      expect(useProjectPaneStore.getState().mode).toBe("project");
      await expect
        .element(page.getByRole("button", { name: "Project", exact: true }))
        .toHaveAttribute("aria-pressed", "true");
      const threadButton = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Thread one",
      );
      expect(threadButton?.closest("[inert]")).not.toBeNull();

      pressModOne();
      await expect.element(code).toHaveFocus();
      expect(useProjectPaneStore.getState().mode).toBe("threads");
      expect(threadButton?.closest("[inert]")).toBeNull();
      expect(vi.mocked(setOpen).mock.calls).toEqual(sidebarToggles);
    },
  );
});
