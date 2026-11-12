import { useAtomValue } from "@effect/atom-react";
import { AuthFilesystemWriteScope } from "@t3tools/contracts";
import { LockIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import ProjectPane, {
  type ProjectPaneTarget,
  useProjectPaneTarget,
} from "~/components/project/ProjectPane";
import {
  rememberFocusBeforeTree,
  restoreFocusAfterTree,
} from "~/components/project/projectPaneFocus";
import { useProjectPaneStore } from "~/components/project/projectPaneStore";
import { Badge } from "~/components/ui/badge";
import { useSidebar } from "~/components/ui/sidebar";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useStableCallback } from "~/hooks/useStableCallback";
import { provideShortcutCapability } from "~/keybindings";
import { readFocusScopes } from "~/lib/focusScopes";
import { cn } from "~/lib/utils";
import { registerCommands } from "~/shortcuts/dispatcher";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { environmentSession, sessionHasScope } from "~/state/session";

function consume(event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function ProjectPaneLabel({ target }: { target: ProjectPaneTarget }) {
  const environment = useEnvironment(target.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Quiet until the session loads, so a writable connection never flashes "Read only".
  const readOnly = useAtomValue(
    environmentSession.sessionStateAtom(target.environmentId),
    (result) =>
      result._tag === "Success" ? !sessionHasScope(result, AuthFilesystemWriteScope) : false,
  );
  const remoteLabel =
    environment !== null && target.environmentId !== primaryEnvironmentId
      ? environment.label
      : null;
  return (
    <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate text-xs text-muted-foreground" />}
        >
          {target.projectName}
        </TooltipTrigger>
        <TooltipPopup>{target.cwd}</TooltipPopup>
      </Tooltip>
      {remoteLabel ? (
        <Badge size="sm" variant="secondary" className="max-w-24 shrink-0 truncate">
          {remoteLabel}
        </Badge>
      ) : null}
      {readOnly ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span role="img" aria-label="Read only" className="shrink-0 text-muted-foreground" />
            }
          >
            <LockIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>Read only: this connection can browse files but not change them.</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

/**
 * The left sidebar's Threads and Project modes, between its header and footer. Threads stays
 * mounted and laid out underneath, so its scroll position, search and shortcuts survive a trip
 * to Project.
 */
export function SidebarModes({
  header,
  footer,
  children,
}: {
  header: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const mode = useProjectPaneStore((state) => state.mode);
  const projectMode = mode === "project";
  const target = useProjectPaneTarget();
  const sidebar = useSidebar();
  // Mounted on first use, then kept, so its expanded folders survive switching back and forth.
  const [paneMounted, setPaneMounted] = useState(projectMode);
  if (projectMode && !paneMounted) setPaneMounted(true);

  const enterTree = useStableCallback(() => {
    rememberFocusBeforeTree();
    const collapsed = sidebar.isMobile ? !sidebar.openMobile : !sidebar.open;
    if (collapsed) {
      if (sidebar.isMobile) sidebar.setOpenMobile(true);
      else sidebar.setOpen(true);
    }
    useProjectPaneStore
      .getState()
      .focusTree(collapsed ? { sidebarOpenedForPane: true } : undefined);
  });
  const leaveTree = useStableCallback(() => {
    const { sidebarOpenedForPane, setMode } = useProjectPaneStore.getState();
    setMode("threads");
    if (sidebarOpenedForPane) {
      if (sidebar.isMobile) sidebar.setOpenMobile(false);
      else sidebar.setOpen(false);
    }
    restoreFocusAfterTree();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the Project pane's shortcuts and capability for as long as the sidebar is mounted
  useEffect(() => {
    const disposers = [
      provideShortcutCapability("projectPane"),
      registerCommands({
        "projectPane.toggle": (event) => {
          consume(event);
          if (readFocusScopes(event.target).projectTreeFocus) leaveTree();
          else enterTree();
        },
        "projectPane.selectOpenedFile": (event) => {
          consume(event);
          enterTree();
        },
      }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [enterTree, leaveTree]);

  return (
    <>
      {header}
      <div className="flex h-9 shrink-0 items-center gap-2 px-[var(--sidebar-content-inset)]">
        <ToggleGroup
          aria-label="Sidebar view"
          className="shrink-0"
          variant="segmented"
          value={[mode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "threads" || next === "project")
              useProjectPaneStore.getState().setMode(next);
          }}
        >
          <Toggle value="threads">Threads</Toggle>
          <Toggle value="project">Project</Toggle>
        </ToggleGroup>
        {projectMode && target ? <ProjectPaneLabel target={target} /> : null}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          className={cn("flex min-h-0 flex-1 flex-col", projectMode && "invisible")}
          inert={projectMode}
        >
          {children}
        </div>
        {paneMounted ? (
          <div
            className={cn("absolute inset-0 flex flex-col", !projectMode && "invisible")}
            inert={!projectMode}
          >
            <ProjectPane target={target} active={projectMode} />
          </div>
        ) : null}
      </div>
      {footer}
    </>
  );
}
