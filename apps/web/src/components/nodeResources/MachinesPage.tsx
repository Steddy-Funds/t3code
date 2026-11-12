import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { isElectron } from "~/env";
import { workspaceAreaProps } from "~/lib/workspaceFocus";
import { useEnvironmentIdentities } from "~/state/environments";

import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { CrossMachineView } from "./CrossMachineView";
import { TaskManagerView } from "./TaskManagerView";

/** `/machines` lists every machine; `/machines/$environmentId` is one machine's task manager. */
export function MachinesPage({ environmentId }: { readonly environmentId?: EnvironmentId }) {
  const label = useEnvironmentIdentities().find(
    (identity) => identity.environmentId === environmentId,
  )?.label;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div
        {...workspaceAreaProps("machines", 1, "Machines")}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background"
      >
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Machines breadcrumb">
            {environmentId === undefined ? (
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">Machines</h1>
              </WorkspaceBreadcrumbItem>
            ) : (
              <>
                <WorkspaceBreadcrumbItem>
                  <Link to="/machines">Machines</Link>
                </WorkspaceBreadcrumbItem>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem current>
                  <h1 className="truncate">{label ?? "Machine"}</h1>
                </WorkspaceBreadcrumbItem>
              </>
            )}
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
            {environmentId === undefined ? (
              <CrossMachineView />
            ) : (
              <TaskManagerView environmentId={environmentId} />
            )}
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}
