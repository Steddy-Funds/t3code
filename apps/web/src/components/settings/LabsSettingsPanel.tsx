import { useAuth } from "@clerk/react";
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { managedCapabilityDenial } from "@t3tools/contracts";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { previewGambaCoin } from "~/gambaMode";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { useState } from "react";

import { isElectron } from "~/env";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { firstManagedDenial, usePrimaryManagedPolicy } from "~/state/managedPolicy";

/** Features still settling in. */
export function LabsSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title="Beta">
        <BoringSidebarRow />
        <GambaModeRow />
        {/* Clerk is only mounted when this build has T3 Connect. */}
        {hasCloudPublicConfig() ? <GuestLinksRowWithSignIn /> : <GuestLinksRow />}
        <LinkedEnvironmentsRow />
        <PromptSuggestionsRow />
        <AgentReviewNotesRow />
        <SmartDiffRow />
        <SimlockHostsRow />
        <FastWorktreeCheckoutRow />
        <NativeTrackpadDialogsRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function BoringSidebarRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar")}
      description="Group sidebar threads into project folders. Pinned threads stay on top, and Snoozed and Settled stay below the folders."
      control={
        <Switch
          checked={settings.boringSidebarEnabled}
          onCheckedChange={(checked) => updateSettings({ boringSidebarEnabled: Boolean(checked) })}
          aria-label="Boring sidebar (group by project)"
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
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar-multiline")}
      className="px-0 py-2 sm:px-0"
      description="Show folder threads on two lines: the title, then the branch, pull request, and agent."
      control={
        <Switch
          checked={settings.boringSidebarMultilineRows}
          onCheckedChange={(checked) =>
            updateSettings({ boringSidebarMultilineRows: Boolean(checked) })
          }
          aria-label="Two-line folder rows"
        />
      }
    />
  );
}

function GambaModeRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const volume = settings.gambaModeVolume;
  return (
    <SettingsRow
      {...searchableSetting("gamba-mode")}
      description="Play a coin every time an agent finishes a turn, subagents included, so you can hear how busy the swarm is."
      control={
        <Switch
          checked={settings.gambaModeEnabled}
          onCheckedChange={(checked) => updateSettings({ gambaModeEnabled: Boolean(checked) })}
          aria-label="Gamba mode"
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
            aria-label="Gamba mode volume"
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
  const { isSignedIn } = useAuth();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  // `isSignedIn` is undefined until Clerk loads.
  if (isSignedIn !== false) return <GuestLinksRow />;
  return (
    <SettingsRow
      {...searchableSetting("guest-links")}
      description="Share a thread with a guest who watches it live in a browser and sends messages you approve. Sign in to T3 Connect to use guest links."
      control={
        <Button size="sm" variant="outline" onClick={openAuthPrompt}>
          Sign in
        </Button>
      }
    />
  );
}

function GuestLinksRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const scope = useOptionalSettingsScope();
  const primaryPolicy = usePrimaryManagedPolicy();
  // Guests arrive through T3 Connect, so a policy that turns Connect off turns this off too.
  const connectDenial = firstManagedDenial(
    scope
      ? scope.connectedEnvironments.map((environment) => environment.serverConfig?.managedPolicy)
      : [primaryPolicy],
    (policy) => managedCapabilityDenial(policy, "connect"),
  );
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("guest-links")}
      settingKeys={["guestSharingEnabled"]}
      // Turning guest links off still works without T3 Connect.
      managed={settings.guestSharingEnabled ? undefined : connectDenial}
      description={
        <>
          Share a thread with a guest who watches it live in a browser and sends messages you
          approve. Needs T3 Connect: sign in and link this machine in{" "}
          <Link to="/settings/access" className="underline underline-offset-2">
            Sharing & access
          </Link>
          . Turning it off stops every guest link.
        </>
      }
      control={
        <ScopedSwitch
          settingKeys={["guestSharingEnabled"]}
          checked={settings.guestSharingEnabled}
          onCheckedChange={(checked) => updateSettings({ guestSharingEnabled: Boolean(checked) })}
          aria-label="Guest links"
        />
      }
    />
  );
}

function LinkedEnvironmentsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linked-environments-beta")}
      settingKeys={["linkedEnvironmentsEnabled"]}
      description={
        <>
          Let agents here work on your other machines, and theirs here. Turn it on for each machine,
          then link them in{" "}
          <Link to="/settings/connections" className="underline underline-offset-2">
            Connections
          </Link>
          . While off, nothing new starts over a link; running tasks finish.
        </>
      }
      control={
        <ScopedSwitch
          settingKeys={["linkedEnvironmentsEnabled"]}
          checked={settings.linkedEnvironmentsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ linkedEnvironmentsEnabled: Boolean(checked) })
          }
          aria-label="Linked environments"
        />
      }
    />
  );
}

function PromptSuggestionsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("prompt-suggestions-beta")}
      settingKeys={["promptSuggestionsEnabled"]}
      description="Show a predicted next message in the empty composer after a Claude or Codex turn. Tab uses it. Each is an extra cached request on your plan. Needs Codex 0.165+. Claude threads update on restart."
      control={
        <ScopedSwitch
          settingKeys={["promptSuggestionsEnabled"]}
          checked={settings.promptSuggestionsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ promptSuggestionsEnabled: Boolean(checked) })
          }
          aria-label="Suggest next prompt"
        />
      }
    />
  );
}

function AgentReviewNotesRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("agent-review-notes")}
      settingKeys={["agentReviewNotesEnabled"]}
      description="Let agents pin a note or question to lines they changed, for you to weigh before it ships. You reply from the chat or the diff. Off stops new notes at once."
      control={
        <ScopedSwitch
          settingKeys={["agentReviewNotesEnabled"]}
          checked={settings.agentReviewNotesEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ agentReviewNotesEnabled: Boolean(checked) })
          }
          aria-label="Agent review notes"
        />
      }
    />
  );
}

function SmartDiffRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("smart-diff")}
      description="In the side-by-side diff, show code that moved in purple, within a file or to another one, with a chip that jumps to where it went."
      control={
        <Switch
          checked={settings.smartDiffEnabled}
          onCheckedChange={(checked) => updateSettings({ smartDiffEnabled: Boolean(checked) })}
          aria-label="Smart Diff"
        />
      }
    />
  );
}

function SimlockHostsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("simlock-hosts")}
      settingKeys={["simlockDeviceHostsEnabled"]}
      description={
        <>
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
        </>
      }
      control={
        <ScopedSwitch
          settingKeys={["simlockDeviceHostsEnabled"]}
          checked={settings.simlockDeviceHostsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ simlockDeviceHostsEnabled: Boolean(checked) })
          }
          aria-label="Simlock device hosts"
        />
      }
    />
  );
}

/** Shows only when every machine in scope is a Mac, since only macOS servers honor it. */
function FastWorktreeCheckoutRow() {
  const { scope, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
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
      description="On a Mac, clone new worktrees from a checkout cached in the T3 home folder instead of writing every file. Uses Git’s normal checkout when it can’t. Turning it off deletes the cache."
      control={
        <ScopedSwitch
          settingKeys={["fastWorktreeCheckout"]}
          checked={settings.fastWorktreeCheckout}
          onCheckedChange={(checked) => updateSettings({ fastWorktreeCheckout: Boolean(checked) })}
          aria-label="Fast worktree checkout"
        />
      }
    />
  );
}

/** Glint's native dialogs replace a few web pickers; only the macOS desktop app can show them. */
function NativeTrackpadDialogsRow() {
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
      description="Open custom snooze, the model picker and /color as Glint's trackpad dialogs. Needs the glint-helper app; without it, the usual pickers open."
      control={
        <Switch
          checked={settings.glintEnabled}
          onCheckedChange={(checked) => updateSettings({ glintEnabled: Boolean(checked) })}
          aria-label="Native trackpad dialogs"
        />
      }
    >
      {settings.glintEnabled ? (
        <div className="mt-2 mb-2 border-l-2 border-border/60 ps-3">
          <Input
            size="sm"
            aria-label="Glint helper path"
            placeholder="Helper path (default: $T3CODE_GLINT_HELPER)"
            value={path}
            onValueChange={setPath}
            onBlur={commitPath}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitPath();
            }}
          />
        </div>
      ) : null}
    </SettingsRow>
  );
}
