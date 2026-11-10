import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  isServedSiteTearingDown,
  type ServedSite,
  type ServedSiteId,
  type ThreadId,
} from "@t3tools/contracts";
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

interface SiteStatus {
  readonly label: string;
  readonly detail: string | null;
}

/** Null for a healthy live site; otherwise one short word, with the sentence for the tooltip. */
function siteStatus(site: ServedSite): SiteStatus | null {
  if (isServedSiteTearingDown(site)) {
    return { label: "Taking down", detail: "Retrying until its routes come down." };
  }
  switch (site.status) {
    case "publishing":
      return { label: "Publishing", detail: null };
    case "stopping":
      return site.awaitingExit === true
        ? { label: "Waiting", detail: "The stop command ran; waiting for the server to exit." }
        : { label: "Stopping", detail: null };
    case "live":
      return null;
    case "failed":
      return { label: "Failed", detail: null };
    case "removed":
      switch (site.removedReason) {
        case "pids-exited":
          return { label: "Exited", detail: `${pidLabel(site)} exited.` };
        case "stop-command":
          return { label: "Stopped", detail: "Stopped by its stop command." };
        default:
          return { label: "Stopped", detail: null };
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

/*
 * One line: globe, name, Public badge, URL, copy, status, action. Everything after the name is
 * shrink-0 except the URL, which gives up its width first (shrink weight 1000); the name truncates
 * only once the URL is gone. The widest fixed set (a public site publishing: padding, globe,
 * badge, copy, "Publishing", Stop and gaps) is about 14.5rem, so the name keeps 5rem in a 20rem row.
 */
function SiteRow(props: SiteRowProps) {
  const { site } = props;
  const ended = isEnded(site);
  const tearingDown = isServedSiteTearingDown(site);
  const url = ended || tearingDown ? null : siteUrl(site);
  // A live site's error is a stop that left the server running; a failed one's is why. A
  // pending teardown is still retrying.
  const error =
    site.status === "live" || site.status === "failed" || tearingDown ? site.lastError : null;
  const status = siteStatus(site);
  const showForceStop =
    props.canStop &&
    site.status === "live" &&
    !tearingDown &&
    error !== null &&
    site.stopCommand !== null;

  return (
    <li
      data-thread-details-site-overflow={props.overflow || undefined}
      className={cn("flex min-w-0 flex-col rounded-lg px-2 py-1", ended && "opacity-64")}
    >
      <div className="flex h-6 min-w-0 items-center gap-1.5">
        <GlobeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="min-w-0 truncate text-sm font-medium leading-4 text-foreground/85" />
            }
          >
            {site.name}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {site.name} · {pidLabel(site)}
          </TooltipPopup>
        </Tooltip>
        {site.visibility === "public" ? (
          <Badge size="sm" variant="info">
            Public
          </Badge>
        ) : null}
        {url === null ? null : <SiteUrl site={site} url={url} />}
        <span className="flex-1" />
        {status === null ? null : <StatusLabel status={status} />}
        <SiteActions {...props} ended={ended} tearingDown={tearingDown} hasError={error !== null} />
      </div>
      {error !== null ? (
        <div className="flex min-w-0 items-center gap-1.5 ps-5.5">
          <SiteError error={error} />
          {showForceStop ? (
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
      ) : null}
    </li>
  );
}

function StatusLabel(props: { readonly status: SiteStatus }) {
  const label = (
    <span className="shrink-0 whitespace-nowrap text-2xs text-muted-foreground">
      {props.status.label}
    </span>
  );
  if (props.status.detail === null) return label;
  return (
    <Tooltip>
      <TooltipTrigger render={label} />
      <TooltipPopup side="left">{props.status.detail}</TooltipPopup>
    </Tooltip>
  );
}

/** The headline on one line; the detail after it (the hook's stderr) on hover. */
function SiteError(props: { readonly error: string }) {
  const [headline = "", ...rest] = props.error.split("\n");
  const detail = rest.join("\n").trim();
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="min-w-0 truncate text-2xs text-destructive" />}>
        {headline}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <span className="block max-w-96 whitespace-pre-wrap break-words">
          {detail === "" ? headline : detail}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

function SiteUrl(props: { readonly site: ServedSite; readonly url: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <a
              href={props.url}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 shrink-[1000] truncate text-2xs text-muted-foreground underline-offset-2 hover:underline"
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
    </>
  );
}

function SiteActions(
  props: SiteRowProps & {
    readonly ended: boolean;
    readonly tearingDown: boolean;
    readonly hasError: boolean;
  },
) {
  const { site } = props;
  if (props.ended || props.tearingDown) {
    if (!props.canDismiss) return null;
    const dismiss = (
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
    );
    if (props.ended) return dismiss;
    return (
      <Tooltip>
        <TooltipTrigger render={dismiss} />
        <TooltipPopup side="left">
          Stop retrying; the public or tailnet route may stay up.
        </TooltipPopup>
      </Tooltip>
    );
  }
  if (!props.canStop) return null;
  const stopProps = {
    size: "xs",
    variant: "ghost",
    part: "meta",
    tone: "destructive",
    disabled: props.busy,
    onClick: () => props.onStop(false),
  } as const;
  // Stopping a publishing site interrupts its hook; no stop command runs.
  if (site.status === "publishing") {
    return <ThreadDetailsControl {...stopProps}>Stop</ThreadDetailsControl>;
  }
  // A live site with an error and a stop command offers Force stop beside the error instead.
  if (site.status !== "live" || (props.hasError && site.stopCommand !== null)) return null;
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
      <Tooltip>
        <TooltipTrigger
          render={
            <ThreadDetailsControl
              size="xs"
              variant="ghost"
              part="meta"
              tone="destructive"
              disabled={props.busy}
              onClick={() => setConfirming(true)}
            />
          }
        >
          Stop
        </TooltipTrigger>
        <TooltipPopup side="left">
          Runs <code className="font-mono">{props.command}</code>
        </TooltipPopup>
      </Tooltip>
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
