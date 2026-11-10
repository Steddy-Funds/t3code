import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ServedSite, ThreadId } from "@t3tools/contracts";
import { CheckIcon, CopyIcon, GlobeIcon } from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
import { servedSitesEnvironment, siteUrl, useThreadServedSites } from "../../state/servedSites";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

interface ThreadSitesPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const pidList = (site: ServedSite) => site.pids.map((each) => each.pid).join(", ");

function removedLabel(site: ServedSite): string {
  switch (site.removedReason) {
    case "pids-exited":
      return site.pids.length === 1
        ? `PID ${pidList(site)} exited`
        : `PIDs ${pidList(site)} exited`;
    case "stopped":
      return "Stopped";
    case "stop-command":
      return "Stopped by custom command";
    default:
      return site.lastError ?? "Could not publish";
  }
}

function statusLabel(site: ServedSite): string | null {
  switch (site.status) {
    case "publishing":
      return "Publishing…";
    case "stopping":
      return "Stopping…";
    case "live":
      return null;
    default:
      return removedLabel(site);
  }
}

/** Sites this thread's agent published. Hidden while it has none. */
export function ThreadSitesPanel(props: ThreadSitesPanelProps) {
  const sites = useThreadServedSites(props);
  const publicEnabled =
    useEnvironment(props.environmentId)?.serverConfig?.environment.capabilities.servedSites
      ?.public === true;
  const canStop = useAtomValue(servedSitesEnvironment.stop.permissionAtom(props.environmentId));
  const canDismiss = useAtomValue(
    servedSitesEnvironment.dismiss.permissionAtom(props.environmentId),
  );
  const stopSite = useAtomCommand(servedSitesEnvironment.stop, { label: "served site stop" });
  const dismissSite = useAtomCommand(servedSitesEnvironment.dismiss, {
    label: "served site dismiss",
  });
  const [busyId, setBusyId] = useState<string | null>(null);

  if (sites.length === 0) return null;
  const showPublicHint =
    !publicEnabled &&
    sites.some((site) => site.visibility === "public" && site.status === "failed");

  const run = async (
    site: ServedSite,
    title: string,
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    if (busyId !== null) return;
    setBusyId(site.id);
    const result = await action();
    setBusyId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const stop = (site: ServedSite, force: boolean) =>
    run(site, "Could not stop site", () =>
      stopSite({
        environmentId: props.environmentId,
        input: force ? { siteId: site.id, force } : { siteId: site.id },
      }),
    );
  const dismiss = (site: ServedSite) =>
    run(site, "Could not dismiss site", () =>
      dismissSite({ environmentId: props.environmentId, input: { siteId: site.id } }),
    );

  return (
    <ThreadDetailsSection headingId="thread-details-sites-heading" title="Sites">
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {sites.map((site) => (
          <SiteRow
            key={site.id}
            site={site}
            busy={busyId !== null}
            canStop={canStop}
            canDismiss={canDismiss}
            onStop={(force) => void stop(site, force)}
            onDismiss={() => void dismiss(site)}
          />
        ))}
      </ul>
      {showPublicHint ? (
        <p className="m-0 px-2 text-2xs text-muted-foreground">
          Public URLs need servedSites.publicExposeCommand in the server's settings.json.
        </p>
      ) : null}
    </ThreadDetailsSection>
  );
}

function SiteRow(props: {
  readonly site: ServedSite;
  readonly busy: boolean;
  readonly canStop: boolean;
  readonly canDismiss: boolean;
  readonly onStop: (force: boolean) => void;
  readonly onDismiss: () => void;
}) {
  const { site } = props;
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const url = siteUrl(site);
  const ended = site.status === "removed" || site.status === "failed";
  const status = statusLabel(site);
  const liveError = site.status === "live" ? site.lastError : null;

  return (
    <li className={cn("flex flex-col gap-0.5 rounded-lg px-2 py-1", ended && "opacity-64")}>
      <div className="flex min-w-0 items-center gap-2">
        <GlobeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-4 text-foreground/85">
          {site.name}
        </span>
        <Badge size="sm" variant={site.visibility === "public" ? "info" : "outline"}>
          {site.visibility === "public" ? "Public" : "Tailnet"}
        </Badge>
      </div>
      {url !== null && !ended ? (
        <div className="flex min-w-0 items-center gap-1 ps-6">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 truncate text-2xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {url}
          </a>
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  aria-label={`Copy ${url}`}
                  onClick={() => copyToClipboard(url, undefined)}
                />
              }
            >
              {isCopied ? (
                <CheckIcon aria-hidden className="size-3" />
              ) : (
                <CopyIcon aria-hidden className="size-3" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="left">{isCopied ? "Copied" : "Copy URL"}</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-col gap-0.5 ps-6 text-2xs text-muted-foreground">
        <span className="truncate">
          {[site.pids.length === 1 ? `PID ${pidList(site)}` : `PIDs ${pidList(site)}`, status]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {site.stopCommand !== null && !ended ? (
          <code className="truncate font-mono">{site.stopCommand}</code>
        ) : null}
        {liveError !== null ? <span className="text-destructive">{liveError}</span> : null}
      </div>
      <SiteActions
        {...props}
        ended={ended}
        offerForce={liveError !== null && site.stopCommand !== null}
      />
    </li>
  );
}

function SiteActions(props: {
  readonly site: ServedSite;
  readonly ended: boolean;
  readonly offerForce: boolean;
  readonly busy: boolean;
  readonly canStop: boolean;
  readonly canDismiss: boolean;
  readonly onStop: (force: boolean) => void;
  readonly onDismiss: () => void;
}) {
  const { site } = props;
  if (props.ended) {
    if (!props.canDismiss) return null;
    return (
      <div className="flex gap-1 ps-6">
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="meta"
          tone="muted"
          disabled={props.busy}
          onClick={props.onDismiss}
        >
          Dismiss
        </ThreadDetailsControl>
      </div>
    );
  }
  if (site.status !== "live" || !props.canStop) return null;
  return (
    <div className="flex gap-1 ps-6">
      <ThreadDetailsControl
        size="xs"
        variant="ghost"
        part="meta"
        tone="destructive"
        disabled={props.busy}
        onClick={() => props.onStop(false)}
      >
        {site.stopCommand === null ? "Stop" : "Stop (custom)"}
      </ThreadDetailsControl>
      {props.offerForce ? (
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="meta"
          tone="destructive"
          disabled={props.busy}
          onClick={() => props.onStop(true)}
        >
          Force stop
        </ThreadDetailsControl>
      ) : null}
    </div>
  );
}
