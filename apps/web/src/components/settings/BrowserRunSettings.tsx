import { useAtomValue } from "@effect/atom-react";
import {
  isSecretReference,
  type BrowserRunCheckResult,
  type EnvironmentId,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type BrowserRunPatch = NonNullable<ServerSettingsPatch["browserRun"]>;
type CheckState = "pending" | BrowserRunCheckResult | null;

const isAccountId = (value: string) => /^[0-9a-f]{32}$/i.test(value);

function checkMessage(result: BrowserRunCheckResult) {
  switch (result._tag) {
    case "Accepted":
      return "Cloudflare accepted the account and token.";
    case "NotConfigured":
      return "Enter the account ID and an API token first.";
    case "TokenUnreadable":
      return "The token could not be read from its secret provider.";
    case "Rejected":
      return result.status === 401 || result.status === 403
        ? "Cloudflare rejected the account ID or token."
        : `Cloudflare answered ${result.status}.`;
    case "Unreachable":
      return "Could not reach Cloudflare from this machine.";
  }
}

export function BrowserRunSettings() {
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsScopeNotice inline target="environment" targetId="browser-cloudflare">
        Choose one environment to configure Cloudflare Browser Run.
      </SettingsScopeNotice>
    );
  }
  return (
    <BrowserRunForm key={environment.environmentId} environmentId={environment.environmentId} />
  );
}

function BrowserRunForm({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useScopedSettings((settings) => settings.browserRun);
  const updateSettings = useUpdateScopedSettings();
  const secretSources = useSecretSources(environmentId);
  const canCheck = useAtomValue(serverEnvironment.checkBrowserRun.permissionAtom(environmentId));
  const checkBrowserRun = useAtomCommand(serverEnvironment.checkBrowserRun);
  const [rejectedAccountId, setRejectedAccountId] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckState>(null);
  // Counts field changes, so an answer about settings edited since it was asked is dropped.
  const settingsVersion = useRef(0);

  // A saved literal token arrives redacted and a reference as written; both are non-empty.
  const tokenSaved = saved.apiToken !== "";
  const configured = saved.accountId !== "" && tokenSaved;

  const save = (patch: BrowserRunPatch) => {
    settingsVersion.current += 1;
    setCheck(null);
    updateSettings({ browserRun: patch });
  };

  const runCheck = async () => {
    const version = settingsVersion.current;
    setCheck("pending");
    const response = await checkBrowserRun({ environmentId, input: {} });
    if (version !== settingsVersion.current) return;
    setCheck(response._tag === "Success" ? response.value : null);
  };

  return (
    <>
      <SettingsRow
        serverScoped
        title="Use Cloudflare Browser Run"
        description="Open public pages in agent browser tabs on Cloudflare's hosted Chrome, logged out. Local and private addresses, and tabs opened with a browser profile, stay on this machine's browser."
        status={configured ? undefined : "Save an account ID and an API token to turn this on."}
        control={
          <Switch
            aria-label="Use Cloudflare Browser Run"
            checked={saved.enabled}
            disabled={!configured && !saved.enabled}
            onCheckedChange={(enabled) => save({ enabled })}
          />
        }
      />
      <SettingsRow
        serverScoped
        title="Account ID"
        status={
          rejectedAccountId === null ? undefined : (
            <span role="alert" className="text-destructive">
              Enter the 32-character account ID from the Cloudflare dashboard.
            </span>
          )
        }
        control={
          <div className="w-full sm:w-72">
            <DraftInput
              nativeInput
              size="sm"
              font="mono"
              aria-label="Cloudflare account ID"
              aria-invalid={rejectedAccountId !== null}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={rejectedAccountId ?? saved.accountId}
              onCommit={(next) => {
                const accountId = next.trim();
                if (accountId !== "" && !isAccountId(accountId)) {
                  setRejectedAccountId(next);
                  return;
                }
                setRejectedAccountId(null);
                if (accountId === saved.accountId) return;
                save(accountId === "" ? { accountId, enabled: false } : { accountId });
              }}
            />
          </div>
        }
      />
      <SettingsRow
        serverScoped
        title="API token"
        description="A Cloudflare API token with the Browser Rendering Edit permission."
        control={
          <div className="flex w-full min-w-0 items-start gap-1.5 sm:w-72">
            <div className="min-w-0 flex-1">
              <SecretSourceInput
                size="sm"
                aria-label="Cloudflare API token"
                value={isSecretReference(saved.apiToken) ? saved.apiToken : ""}
                configured={tokenSaved}
                sources={secretSources}
                onCommit={(next) => {
                  const apiToken = next.trim();
                  if (apiToken !== "") save({ apiToken });
                }}
                onSecretChange={(secret) =>
                  save(secret ? { apiToken: secret } : { apiToken: "", enabled: false })
                }
              />
            </div>
            {tokenSaved ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label="Remove API token"
                      onClick={() => save({ apiToken: "", enabled: false })}
                    />
                  }
                >
                  <Trash2Icon />
                </TooltipTrigger>
                <TooltipPopup side="top">Remove API token</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        serverScoped
        title="Connection"
        status={
          check === null || check === "pending" ? undefined : (
            <span
              role="status"
              className={cn(
                check._tag === "Accepted" && "text-success-foreground",
                check._tag !== "Accepted" && check._tag !== "NotConfigured" && "text-destructive",
              )}
            >
              {checkMessage(check)}
            </span>
          )
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!canCheck || check === "pending"}
            onClick={() => void runCheck()}
          >
            {check === "pending" ? "Checking…" : "Check connection"}
          </Button>
        }
      />
    </>
  );
}
