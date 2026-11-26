import { msg } from "gt-react";
import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import { useAuth } from "@clerk/react";
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import {
  AgentFeedbackMode,
  DEFAULT_WORKFLOW_SKIPPED_RUNS_KEPT,
  MAX_WORKFLOW_SKIPPED_RUNS_KEPT,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { previewGambaCoin } from "~/gambaMode";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { useState } from "react";

import { isElectron } from "~/env";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { commitNumberFieldOnEnter } from "./commitNumberFieldOnEnter";
import { ScopedSwitch } from "./ScopedSwitch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { firstManagedDenial, usePrimaryManagedPolicy } from "~/state/managedPolicy";

/** Features still settling in. */
export function LabsSettingsPanel() {
  const gt = useGT();
  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title={gt("Beta")}>
        <BoringSidebarRow />
        <GambaModeRow />
        {/* Clerk is only mounted when this build has T3 Connect. */}
        {hasCloudPublicConfig() ? <GuestLinksRowWithSignIn /> : <GuestLinksRow />}
        <LinkedEnvironmentsRow />
        <WorkflowsRow />
        <WorkflowSkippedRunsRow />
        <PromptSuggestionsRow />
        <AgentReviewNotesRow />
        <SmartDiffRow />
        <SimlockHostsRow />
        <FastWorktreeCheckoutRow />
        <NativeTrackpadDialogsRow />
        <AgentFeedbackRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function BoringSidebarRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar")}
      devicePreference
      description={gt(
        "Group sidebar threads into project folders. Pinned threads stay on top, and Snoozed and Settled stay below the folders.",
      )}
      control={
        <Switch
          checked={settings.boringSidebarEnabled}
          onCheckedChange={(checked) => updateSettings({ boringSidebarEnabled: Boolean(checked) })}
          aria-label={gt("Boring sidebar (group by project)")}
        />
      }
    >
      {settings.boringSidebarEnabled ? (
        <div className="mt-2 mb-2 border-l-2 border-border/60 ps-3">
          <BoringSidebarMultilineRow />
        </div>
      ) : null}
    </SettingsRow>
  );
}

function BoringSidebarMultilineRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar-multiline")}
      devicePreference
      className="px-0 py-2 sm:px-0"
      description={gt(
        "Show folder threads on two lines: the title, then the branch, pull request, and agent.",
      )}
      control={
        <Switch
          checked={settings.boringSidebarMultilineRows}
          onCheckedChange={(checked) =>
            updateSettings({ boringSidebarMultilineRows: Boolean(checked) })
          }
          aria-label={gt("Two-line folder rows")}
        />
      }
    />
  );
}

function GambaModeRow() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const volume = settings.gambaModeVolume;
  return (
    <SettingsRow
      {...searchableSetting("gamba-mode")}
      description={gt(
        "Play a coin every time an agent finishes a turn, subagents included, so you can hear how busy the swarm is.",
      )}
      control={
        <Switch
          checked={settings.gambaModeEnabled}
          onCheckedChange={(checked) => updateSettings({ gambaModeEnabled: Boolean(checked) })}
          aria-label={gt("Gamba mode")}
        />
      }
    >
      {settings.gambaModeEnabled ? (
        <div className="mt-3 flex items-center gap-3 pb-3.5 sm:w-72">
          <output
            className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
            htmlFor="gamba-mode-volume"
          >
            {volume}%
          </output>
          <input
            aria-label={gt("Gamba mode volume")}
            className="settings-slider min-w-0 flex-1"
            id="gamba-mode-volume"
            max={100}
            min={0}
            onChange={(event) => {
              const gambaModeVolume = Number(event.currentTarget.value);
              if (Number.isInteger(gambaModeVolume) && gambaModeVolume >= 0) {
                updateSettings({ gambaModeVolume });
              }
            }}
            onPointerUp={previewGambaCoin}
            onKeyUp={previewGambaCoin}
            step={5}
            style={
              {
                "--settings-slider-progress": `${volume}%`,
                "--settings-slider-fill-offset": `${0.5 - volume / 100}rem`,
              } as CSSProperties
            }
            type="range"
            value={volume}
          />
        </div>
      ) : null}
    </SettingsRow>
  );
}

/** Signed out of T3 Connect, the row offers to sign in instead of its switch. */
function GuestLinksRowWithSignIn() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const { isSignedIn } = useAuth();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  // `isSignedIn` is undefined until Clerk loads.
  if (isSignedIn !== false) return <GuestLinksRow />;
  return (
    <SettingsRow
      {...searchableSetting("guest-links")}
      description={gt(
        "Share a thread with a guest who watches it live in a browser and sends messages you approve. Sign in to T3 Connect to use guest links.",
      )}
      control={
        <Button size="sm" variant="outline" onClick={openAuthPrompt}>
          <T>Sign in</T>
        </Button>
      }
    />
  );
}

function GuestLinksRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  const messages = useMessages();
  const scope = useOptionalSettingsScope();
  const primaryPolicy = usePrimaryManagedPolicy();
  // Guests arrive through T3 Connect, so a policy that turns Connect off turns this off too.
  const connectDenial = firstManagedDenial(
    scope
      ? scope.connectedEnvironments.map((environment) => environment.serverConfig?.managedPolicy)
      : [primaryPolicy],
    (policy) => managedCapabilityDenial(policy, "connect", messages),
  );
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("guest-links")}
      settingKeys={["guestSharingEnabled"]}
      // Turning guest links off still works without T3 Connect.
      managed={settings.guestSharingEnabled ? undefined : connectDenial}
      description={
        <T>
          Share a thread with a guest who watches it live in a browser and sends messages you
          approve. Needs T3 Connect: sign in and link this machine in{" "}
          <Link to="/settings/access" className="underline underline-offset-2">
            Sharing & access
          </Link>
          . Turning it off stops every guest link.
        </T>
      }
      control={
        <ScopedSwitch
          settingKeys={["guestSharingEnabled"]}
          checked={settings.guestSharingEnabled}
          onCheckedChange={(checked) => updateSettings({ guestSharingEnabled: Boolean(checked) })}
          aria-label={gt("Guest links")}
        />
      }
    />
  );
}

function LinkedEnvironmentsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linked-environments-beta")}
      settingKeys={["linkedEnvironmentsEnabled"]}
      description={
        <T>
          Let agents here work on your other machines, and theirs here. Turn it on for each machine,
          then link them in{" "}
          <Link to="/settings/connections" className="underline underline-offset-2">
            Connections
          </Link>
          . While off, nothing new starts over a link; running tasks finish.
        </T>
      }
      control={
        <ScopedSwitch
          settingKeys={["linkedEnvironmentsEnabled"]}
          checked={settings.linkedEnvironmentsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ linkedEnvironmentsEnabled: Boolean(checked) })
          }
          aria-label={gt("Linked environments")}
        />
      }
    />
  );
}

function WorkflowsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("workflows-beta")}
      settingKeys={["workflowsEnabled"]}
      description={gt(
        "Run multi-step workflows from files in the workflows folder of this server's T3 home. Open them from the command palette. While off, nothing in that folder runs; runs wait until it is on again.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["workflowsEnabled"]}
          checked={settings.workflowsEnabled}
          onCheckedChange={(checked) => updateSettings({ workflowsEnabled: Boolean(checked) })}
          aria-label={gt("Workflows")}
        />
      }
    />
  );
}

const NO_GROUPING: Intl.NumberFormatOptions = { useGrouping: false };

export function WorkflowSkippedRunsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["workflowSkippedRunsKept"]);
  const gt = useGT();
  if (!settings.workflowsEnabled) return null;
  const kept = settings.workflowSkippedRunsKept;
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("workflow-skipped-runs")}
      settingKeys={["workflowSkippedRunsKept"]}
      description={gt(
        "How many skipped runs each workflow keeps in its history. Older skipped runs are deleted; runs that did something are always kept.",
      )}
      resetAction={
        mixed || kept !== DEFAULT_WORKFLOW_SKIPPED_RUNS_KEPT ? (
          <SettingResetButton
            ariaLabel={gt("Reset skipped runs kept to default")}
            onClick={() =>
              updateSettings({ workflowSkippedRunsKept: DEFAULT_WORKFLOW_SKIPPED_RUNS_KEPT })
            }
          />
        ) : null
      }
      control={
        <div className="w-24">
          <NumberField
            value={mixed ? null : kept}
            min={0}
            max={MAX_WORKFLOW_SKIPPED_RUNS_KEPT}
            format={NO_GROUPING}
            size="sm"
            onValueCommitted={(value) => {
              if (value === null || !Number.isInteger(value) || (!mixed && value === kept)) return;
              updateSettings({ workflowSkippedRunsKept: value });
            }}
          >
            <NumberFieldGroup>
              <NumberFieldInput
                aria-label={gt("Skipped runs kept")}
                placeholder={mixed ? gt("Mixed") : undefined}
                onKeyDown={commitNumberFieldOnEnter}
              />
            </NumberFieldGroup>
          </NumberField>
        </div>
      }
    />
  );
}

function PromptSuggestionsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("prompt-suggestions-beta")}
      settingKeys={["promptSuggestionsEnabled"]}
      description={gt(
        "Show a predicted next message in the empty composer after a Claude or Codex turn. Tab uses it. Each is an extra cached request on your plan. Needs Codex 0.165+. Claude threads update on restart.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["promptSuggestionsEnabled"]}
          checked={settings.promptSuggestionsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ promptSuggestionsEnabled: Boolean(checked) })
          }
          aria-label={gt("Suggest next prompt")}
        />
      }
    />
  );
}

function AgentReviewNotesRow() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("agent-review-notes")}
      settingKeys={["agentReviewNotesEnabled"]}
      description={gt(
        "Let agents pin a note or question to lines they changed, and answer your review comments on their lines. You reply from the chat or the diff. Off stops new notes and replies at once.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["agentReviewNotesEnabled"]}
          checked={settings.agentReviewNotesEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ agentReviewNotesEnabled: Boolean(checked) })
          }
          aria-label={gt("Agent review notes")}
        />
      }
    />
  );
}

function SmartDiffRow() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("smart-diff")}
      description={gt(
        "In the side-by-side diff, show code that moved in purple, within a file or to another one, with a chip that jumps to where it went.",
      )}
      control={
        <Switch
          checked={settings.smartDiffEnabled}
          onCheckedChange={(checked) => updateSettings({ smartDiffEnabled: Boolean(checked) })}
          aria-label={gt("Smart Diff")}
        />
      }
    />
  );
}

function SimlockHostsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("simlock-hosts")}
      settingKeys={["simlockDeviceHostsEnabled"]}
      description={
        <T>
          Let the Device panel lease simulators and emulators from your own{" "}
          <a
            href="https://incubator.callstack.com/simlock/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Simlock
          </a>{" "}
          pool, added in{" "}
          <Link to="/settings/devices" className="underline underline-offset-2">
            Devices
          </Link>
          . An alpha that may change or break. T3 Code never installs Simlock.
        </T>
      }
      control={
        <ScopedSwitch
          settingKeys={["simlockDeviceHostsEnabled"]}
          checked={settings.simlockDeviceHostsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ simlockDeviceHostsEnabled: Boolean(checked) })
          }
          aria-label={gt("Simlock device hosts")}
        />
      }
    />
  );
}

/** Shows only when every machine in scope is a Mac, since only macOS servers honor it. */
function FastWorktreeCheckoutRow() {
  const searchableSetting = useSearchableSetting();
  const { scope, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  if (
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    connectedEnvironments.length === 0 ||
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.fastWorktreeCheckout !== true,
    )
  )
    return null;
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("worktree-fast-checkout")}
      settingKeys={["fastWorktreeCheckout"]}
      description={gt(
        "On a Mac, clone new worktrees from a checkout cached in the T3 home folder instead of writing every file. Uses Git’s normal checkout when it can’t. Turning it off deletes the cache.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["fastWorktreeCheckout"]}
          checked={settings.fastWorktreeCheckout}
          onCheckedChange={(checked) => updateSettings({ fastWorktreeCheckout: Boolean(checked) })}
          aria-label={gt("Fast worktree checkout")}
        />
      }
    />
  );
}

/** Glint's native dialogs replace a few web pickers; only the macOS desktop app can show them. */
function NativeTrackpadDialogsRow() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const [path, setPath] = useState(settings.glintHelperPath);
  if (!isElectron || window.desktopBridge?.getClientPlatform() !== "darwin") return null;
  const commitPath = () => {
    if (path.trim() !== settings.glintHelperPath) updateSettings({ glintHelperPath: path.trim() });
  };
  return (
    <SettingsRow
      {...searchableSetting("native-trackpad-dialogs")}
      description={gt(
        "Open custom snooze, the model picker and /color as Glint's trackpad dialogs. Needs the glint-helper app; without it, the usual pickers open.",
      )}
      control={
        <Switch
          checked={settings.glintEnabled}
          onCheckedChange={(checked) => updateSettings({ glintEnabled: Boolean(checked) })}
          aria-label={gt("Native trackpad dialogs")}
        />
      }
    >
      {settings.glintEnabled ? (
        <div className="mt-2 mb-2 border-l-2 border-border/60 ps-3">
          <Input
            size="sm"
            aria-label={gt("Glint helper path")}
            placeholder={gt("Helper path (default: $T3CODE_GLINT_HELPER)")}
            value={path}
            onValueChange={setPath}
            onBlur={commitPath}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitPath();
            }}
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs">
              <T>
                Mini draws dialogs at a quarter of the size, for demos. The trackpad works the same.
              </T>
            </p>
            <Select
              value={settings.glintDialogSize}
              onValueChange={(value) => {
                if (value === "full" || value === "mini")
                  updateSettings({ glintDialogSize: value });
              }}
            >
              <SelectTrigger size="sm" className="w-auto min-w-0" aria-label={gt("Dialog size")}>
                <SelectValue>
                  {settings.glintDialogSize === "mini" ? gt("Mini") : gt("Full")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="full">
                  <T>Full</T>
                </SelectItem>
                <SelectItem value="mini">
                  <T>Mini</T>
                </SelectItem>
              </SelectPopup>
            </Select>
          </div>
        </div>
      ) : null}
    </SettingsRow>
  );
}

/** Shows only when every machine in scope honors it; older servers drop the setting. */
const AGENT_FEEDBACK_MODES = AgentFeedbackMode.literals;
const AGENT_FEEDBACK_MODE_LABELS: Record<AgentFeedbackMode, string> = {
  off: msg("Off"),
  "on-request": msg("When I ask"),
  auto: msg("Automatic"),
};
const AGENT_FEEDBACK_MODE_DESCRIPTIONS: Record<AgentFeedbackMode, string> = {
  off: msg("Agents send no feedback to the T3 team."),
  "on-request": msg(
    "When you ask, agents show you a short report about T3 Code and send it to the T3 team if you approve.",
  ),
  auto: msg(
    "Agents also report T3 Code problems they hit on their own, such as a T3 tool that failed.",
  ),
};

function AgentFeedbackRow() {
  const searchableSetting = useSearchableSetting();
  const { scope, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  const m = useMessages();
  const mixed = useScopedSettingsMixed(["agentFeedback"]);
  if (
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    connectedEnvironments.length === 0 ||
    connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.agentFeedback !== true,
    )
  )
    return null;
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("agent-feedback")}
      settingKeys={["agentFeedback"]}
      description={
        mixed
          ? gt("The selected machines use different agent feedback modes.")
          : m(AGENT_FEEDBACK_MODE_DESCRIPTIONS[settings.agentFeedback.mode])
      }
      control={
        <Select
          value={mixed ? null : settings.agentFeedback.mode}
          onValueChange={(mode) => {
            if (mode !== null) updateSettings({ agentFeedback: { mode } });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={gt("Agent feedback")}>
            <SelectValue>
              {(mode: AgentFeedbackMode | null) =>
                mode === null ? gt("Mixed") : m(AGENT_FEEDBACK_MODE_LABELS[mode])
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {AGENT_FEEDBACK_MODES.map((mode) => (
              <SelectItem key={mode} hideIndicator value={mode}>
                {m(AGENT_FEEDBACK_MODE_LABELS[mode])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
