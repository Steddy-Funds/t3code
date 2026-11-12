import type { AgentTree } from "@t3tools/client-runtime/state/thread-relationships";
import type { AgentLineageNode, AgentTreeSummary } from "@t3tools/client-runtime/state/threads";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { BotIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { useState, type MouseEvent } from "react";

import { getClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { cn } from "~/lib/utils";
import { useAgentTree } from "../../state/entities";
import { tokenBurnRates, useTreeBurnRate } from "../../state/tokenBurnRates";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BurnRateValue } from "./SidebarBurnRate";
import { setSidebarDetailsItem } from "./sidebarDetailsItems";

const stopRowActivation = (event: MouseEvent<HTMLElement>) => event.stopPropagation();

function setFullLineage(on: boolean) {
  updateClientSettings({
    sidebarDetailsItems: setSidebarDetailsItem(getClientSettings(), "agentLineage", on),
  });
}

/** Active agents show from two, the thread and one more; lineage from one agent below it. */
export function showsAgentBadge(agents: AgentTreeSummary, fullLineage: boolean): boolean {
  return fullLineage ? agents.size > 1 : agents.live >= 2;
}

export function SidebarAgentBadge(props: {
  threadRef: ScopedThreadRef;
  agents: AgentTreeSummary;
  fullLineage: boolean;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
}) {
  const { agents } = props;
  const [open, setOpen] = useState(false);
  const openThread = (threadRef: ScopedThreadRef) => {
    setOpen(false);
    props.onThreadActivate(threadRef);
  };
  // Lineage reads grey once every agent below the thread is idle.
  const active = !props.fullLineage || agents.descendantsLive > 0;
  const label = props.fullLineage
    ? `${agents.live} of ${agents.size} agents working`
    : `${agents.live} agents working`;
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onPointerDown={stopRowActivation}
            onClick={stopRowActivation}
            className="inline-flex shrink-0 cursor-default items-center gap-0.5 rounded-sm font-normal text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <BotIcon
          aria-hidden
          className={cn("size-3 shrink-0", active ? "text-info-foreground" : "text-icon-muted")}
        />
        <span className="text-secondary-label">
          {props.fullLineage ? `${agents.live}/${agents.size}` : agents.live}
        </span>
      </TooltipTrigger>
      <TooltipPopup
        side="top"
        sideOffset={0}
        variant="glass"
        // React bubbles portal events through the row, which would open the thread.
        onClick={stopRowActivation}
        onPointerDown={stopRowActivation}
        className="pointer-events-auto text-left whitespace-normal"
      >
        {/* The popup's viewport hugs its content, so the width lives here. */}
        <div className="w-64 max-w-[calc(100vw-3rem)]">
          <div className="flex items-center justify-between gap-2 pb-1.5">
            <span className="font-medium text-foreground text-xs">Agents</span>
            <ToggleGroup
              value={[props.fullLineage ? "lineage" : "active"]}
              onValueChange={(value) => {
                const next = value[0];
                if (next !== undefined) setFullLineage(next === "lineage");
              }}
            >
              <ToggleGroupItem value="active">Active</ToggleGroupItem>
              <ToggleGroupItem value="lineage">Lineage</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="-mx-1 max-h-[calc(var(--available-height)-3rem)] overflow-y-auto overscroll-contain px-1">
            <AgentLineageTree
              threadRef={props.threadRef}
              fullLineage={props.fullLineage}
              onOpenThread={openThread}
            />
          </div>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

// Mounted only while the card is open, so closed rows never subscribe to the whole tree.
function AgentLineageTree(props: {
  threadRef: ScopedThreadRef;
  fullLineage: boolean;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const tree = useAgentTree(props.threadRef);
  const burnRates = useAtomValue(tokenBurnRates.treeRatesAtom);
  if (tree === null) return null;
  return (
    <ul className="flex flex-col gap-0.5">
      <AgentLineageRows
        tree={tree}
        depth={0}
        fullLineage={props.fullLineage}
        burnRates={burnRates}
        onOpenThread={props.onOpenThread}
      />
    </ul>
  );
}

function AgentLineageRows(props: {
  tree: AgentTree<AgentLineageNode>;
  depth: number;
  fullLineage: boolean;
  burnRates: ReadonlyMap<string, number>;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const { tree } = props;
  const { node } = tree;
  // An agent that stopped stays listed while its five-minute rate winds down.
  const children = props.fullLineage
    ? tree.children
    : tree.children.filter(
        (child) =>
          child.live > 0 ||
          (child.node !== null &&
            (props.burnRates.get(
              threadKey(scopeThreadRef(child.node.environmentId, child.node.thread.id)),
            ) ?? 0) > 0),
      );
  const content = (
    <>
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          tree.working ? "bg-info-foreground" : "bg-muted-foreground/40",
        )}
      />
      <span
        className={cn(
          "min-w-0 truncate",
          tree.working ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {node?.thread.title ?? "Starting agent"}
      </span>
      <span className="sr-only">{tree.working ? ", working" : ", idle"}</span>
      {node === null ? null : (
        <LineageBurnRate threadRef={scopeThreadRef(node.environmentId, node.thread.id)} />
      )}
    </>
  );
  return (
    <>
      <li className="min-w-0" style={{ paddingInlineStart: `${props.depth * 0.875}rem` }}>
        {node === null ? (
          <span className="flex min-w-0 items-center gap-1.5 px-1 py-0.5 text-xs">{content}</span>
        ) : (
          <button
            type="button"
            onClick={() => props.onOpenThread(scopeThreadRef(node.environmentId, node.thread.id))}
            className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {content}
          </button>
        )}
      </li>
      {children.map((child, index) => (
        <AgentLineageRows
          key={child.node?.key ?? `pending-${index}`}
          tree={child}
          depth={props.depth + 1}
          fullLineage={props.fullLineage}
          burnRates={props.burnRates}
          onOpenThread={props.onOpenThread}
        />
      ))}
    </>
  );
}

/** The agent and everything below it, like the row's own number. */
function LineageBurnRate(props: { threadRef: ScopedThreadRef }) {
  const tokensPerMinute = useTreeBurnRate(props.threadRef);
  return tokensPerMinute > 0 ? (
    <BurnRateValue tokensPerMinute={tokensPerMinute} className="ml-auto pl-2" />
  ) : null;
}
