import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

export type SidebarMode = "threads" | "project";

interface ProjectPaneState {
  mode: SidebarMode;
  /** The tree takes keyboard focus, at the opened file, once it can. */
  treeFocusPending: boolean;
  /** The sidebar was collapsed until a shortcut opened it for the pane; leaving closes it again. */
  sidebarOpenedForPane: boolean;
  setMode: (mode: SidebarMode) => void;
  focusTree: (options?: { sidebarOpenedForPane?: boolean }) => void;
  treeFocusHandled: () => void;
}

export const useProjectPaneStore = create<ProjectPaneState>()(
  persist(
    (set) => ({
      mode: "threads",
      treeFocusPending: false,
      sidebarOpenedForPane: false,
      setMode: (mode) => set({ mode, sidebarOpenedForPane: false }),
      focusTree: (options) =>
        set((state) => ({
          mode: "project",
          treeFocusPending: true,
          sidebarOpenedForPane: options?.sidebarOpenedForPane ?? state.sidebarOpenedForPane,
        })),
      treeFocusHandled: () => set({ treeFocusPending: false }),
    }),
    {
      name: "t3code:sidebar-mode:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ mode: state.mode }),
    },
  ),
);
