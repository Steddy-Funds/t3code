import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ServedSite, ServedSiteId, ThreadId } from "@t3tools/contracts";
import { CheckIcon, CopyIcon, GlobeIcon } from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
import { servedSitesEnvironment, siteUrl, useThreadServedSites } from "../../state/servedSites";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

/** Rows past this many scroll with the card instead of counting toward its density. */
const SITE_FITTING_ROWS = 2;

interface ThreadSitesPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const isEnded = (site: ServedSite) => site.status === "removed" || site.status === "failed";

const pidLabel = (site: ServedSite) =>
  `${site.pids.length === 1 ? "PID" : "PIDs"} ${site.pids.map((each) => each.pid).join(", ")}`;

/** `host:port` with the MagicDNS suffix dropped, so the port survives truncation. */
function shortUrl(site: ServedSite, url: string): string {
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  const host = site.visibility === "public" ? parsed.hostname : parsed.hostname.split(".")[0];
  return parsed.port === ""
    ? `${host}${parsed.pathname.replace(/\/$/, "")}`
    : `${host}:${parsed.port}`;
}

function statusLabel(site: ServedSite): string {
  switch (site.status) {
    case "publishing":
      return "Publishing…";
    case "stopping":
      return site.awaitingExit === true ? "Waiting for the server to exit…" : "Stopping…";
    case "live":
      return "Live";
    case "failed":
      return "Failed";
    case "removed":
      switch (site.removedReason) {
        case "pids-exited":
          return site.pids.length === 1 ? `${pidLabel(site)} exited` : "PIDs exited";
        case "stop-command":
          return "Stopped by custom command";
        default:
          return "Stopped";
      }
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
  const [busyIds, setBusyIds] = useState<ReadonlySet<ServedSiteId>>(new Set());

  if (sites.length === 0) return null;
  const showPublicHint =
    !publicEnabled &&
    sites.some((site) => site.visibility === "public" && site.status === "failed");

  const run = async (
    site: ServedSite,
    title: string,
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    if (busyIds.has(site.id)) return;
    setBusyIds((current) => new Set(current).add(site.id));
    const result = await action();
    setBusyIds((current) => {
      const next = new Set(current);
      next.delete(site.id);
      return next;
    });
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
      <ul className="m-0 list-none p-0">
        {sites.map((site, index) => (
          <SiteRow
            key={site.id}
            site={site}
            overflow={index >= SITE_FITTING_ROWS}
            busy={busyIds.has(site.id)}
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

interface SiteRowProps {
  readonly site: ServedSite;
  readonly overflow: boolean;
  readonly busy: boolean;
  readonly canStop: boolean;
  readonly canDismiss: boolean;
  readonly onStop: (force: boolean) => void;
  readonly onDismiss: () => void;
}

function SiteRow(props: SiteRowProps) {
  const { site } = props;
  const ended = isEnded(site);
  const url = ended ? null : siteUrl(site);
  // A live site's error is a stop that left the server running; a failed one's is why. A
  // pending teardown is still retrying.
  const error =
    site.status === "live" || site.status === "failed" || site.teardownPending !== undefined
      ? site.lastError
      : null;
  // Removed rows already name their pids, and a failed site never served its process.
  const showPids = !ended;

  return (
    <li
      data-thread-details-site-overflow={props.overflow || undefined}
      className={cn("flex min-w-0 flex-col rounded-lg px-2 py-1", ended && "opacity-64")}
    >
      <div className="flex h-6 min-w-0 items-center gap-1.5">
        <GlobeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className="min-w-0 shrink truncate text-sm font-medium leading-4 text-foreground/85">
          {site.name}
        </span>
        <Badge size="sm" variant={site.visibility === "public" ? "info" : "outline"}>
          {site.visibility === "public" ? "Public" : "Tailnet"}
        </Badge>
        {url === null ? <span className="flex-1" /> : <SiteUrl site={site} url={url} />}
        {showPids ? (
          <Tooltip>
            <TooltipTrigger render={<span className="shrink-0 text-2xs text-muted-foreground" />}>
              {statusLabel(site)}
            </TooltipTrigger>
            <TooltipPopup side="left">{pidLabel(site)}</TooltipPopup>
          </Tooltip>
        ) : (
          <span className="shrink-0 text-2xs text-muted-foreground">{statusLabel(site)}</span>
        )}
        <SiteActions {...props} ended={ended} hasError={error !== null} />
      </div>
      {error !== null ? <span className="ps-5.5 text-2xs text-destructive">{error}</span> : null}
    </li>
  );
}

function SiteUrl(props: { readonly site: ServedSite; readonly url: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <span className="flex min-w-0 flex-1 items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <a
              href={props.url}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 truncate text-2xs text-muted-foreground underline-offset-2 hover:underline"
            />
          }
        >
          {shortUrl(props.site, props.url)}
        </TooltipTrigger>
        <TooltipPopup side="top">{props.url}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <ThreadDetailsControl
              size="icon-xs"
              variant="ghost"
              part="icon"
              aria-label={`Copy ${props.url}`}
              onClick={() => copyToClipboard(props.url, undefined)}
            />
          }
        >
          {isCopied ? (
            <CheckIcon aria-hidden className="size-3" />
          ) : (
            <CopyIcon aria-hidden className="size-3" />
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{isCopied ? "Copied" : "Copy URL"}</TooltipPopup>
      </Tooltip>
    </span>
  );
}

function SiteActions(
  props: SiteRowProps & { readonly ended: boolean; readonly hasError: boolean },
) {
  const { site } = props;
  if (props.ended) {
    return props.canDismiss ? (
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
    ) : null;
  }
  if (site.status !== "live" || site.teardownPending !== undefined || !props.canStop) return null;
  if (props.hasError && site.stopCommand !== null) {
    return (
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
    );
  }
  const stopProps = {
    size: "xs",
    variant: "ghost",
    part: "meta",
    tone: "destructive",
    disabled: props.busy,
    onClick: () => props.onStop(false),
  } as const;
  if (site.stopCommand === null) {
    return <ThreadDetailsControl {...stopProps}>Stop</ThreadDetailsControl>;
  }
  return (
    <CustomStop
      command={site.stopCommand}
      busy={props.busy}
      onConfirm={() => props.onStop(false)}
    />
  );
}

/** The agent wrote this command and it runs unsandboxed, so the user reads it before it runs. */
function CustomStop(props: {
  readonly command: string;
  readonly busy: boolean;
  readonly onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <ThreadDetailsControl
        size="xs"
        variant="ghost"
        part="meta"
        tone="destructive"
        disabled={props.busy}
        onClick={() => setConfirming(true)}
      >
        Stop (custom)
      </ThreadDetailsControl>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Run the agent's stop command?</AlertDialogTitle>
            <AlertDialogDescription>
              It runs on this machine outside the agent's sandbox.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <pre className="mx-6 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
            {props.command}
          </pre>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirming(false);
                props.onConfirm();
              }}
            >
              Run and stop
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
