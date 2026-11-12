import { EnvironmentId } from "@t3tools/contracts";
import { AppBar } from "../../components/ui/AppBar";
import { useMachineHeaderAction } from "../../components/machineResources/useMachineHeaderAction";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
}) {
  const goBack = useWorkspaceBackNavigation("threads");
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls);
  const machine = useMachineHeaderAction(EnvironmentId.make(props.gitControls.environmentId));
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const fileActions: AppBarAction[] = props.hasThreadCwd
    ? [
        {
          accessibilityLabel: filesVisible ? "Close files" : "Open files",
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : [];
  const actions = machine.action ? [machine.action, ...fileActions] : fileActions;
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);

  return (
    <>
      <AppBar
        title={props.title}
        subtitle={props.subtitle}
        onBackToList={goBack}
        onCompose={props.draft ? undefined : startNewTask}
        backInSplitView={
          props.onReturnToThread
            ? {
                accessibilityLabel: "Return to chat",
                icon: "chevron.left",
                onPress: props.onReturnToThread,
              }
            : undefined
        }
        actions={actions}
        menus={menus}
        hideBottomBorder
      />
      {machine.sheet}
    </>
  );
}
