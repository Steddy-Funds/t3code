import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { isPullRequestWatchTask } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

export type ThreadRelationshipKind = "parent" | "fork" | "subagent" | "transfer";

/** A settled thread whose own subagents still run: a kind of working, not done. */
export const AWAITING_CHILDREN_STATUS = "awaiting_children";

type ThreadStatusSource = {
  readonly activityRunStatus?: string | null | undefined;
  readonly pendingBackgroundTasks?: ReadonlyArray<{ readonly kind: string }> | undefined;
};

export function threadAwaitsChildren(thread: ThreadStatusSource | null | undefined): boolean {
  return thread?.pendingBackgroundTasks?.some((task) => task.kind === "subagent") === true;
}

export type ThreadWaitReason = "agents" | "pull_request" | "background";

function countLabel(count: number, noun: string, unknown: string) {
  return count === 0 ? unknown : `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** What a waiting thread waits on, so a list row can say more than "Waiting". */
export function resolveThreadWait(thread: {
  readonly blockedOnThreadWait?: boolean | undefined;
  readonly pendingBackgroundTasks?:
    | ReadonlyArray<{ readonly kind: string; readonly taskId: string }>
    | undefined;
}): { readonly reason: ThreadWaitReason; readonly label: string } {
  const tasks = thread.pendingBackgroundTasks ?? [];
  const agents = tasks.filter((task) => task.kind === "subagent").length;
  // A blocking delegate or t3_thread_wait holds an active run, which lists no tasks.
  if (agents > 0 || thread.blockedOnThreadWait === true) {
    return { reason: "agents", label: countLabel(agents, "agent", "Agents") };
  }
  const pullRequests = tasks.filter(isPullRequestWatchTask).length;
  if (pullRequests > 0) {
    return { reason: "pull_request", label: pullRequests === 1 ? "PR" : `${pullRequests} PRs` };
  }
  return { reason: "background", label: "Waiting" };
}

export interface AgentTreeNode {
  readonly key: string;
  readonly thread: {
    readonly id: string;
    readonly activityRunStatus?: string | null | undefined;
    readonly blockedOnThreadWait?: boolean | undefined;
    readonly pendingBackgroundTasks?:
      | ReadonlyArray<{ readonly kind: string; readonly childThreadId?: string | undefined }>
      | undefined;
  };
}

export interface AgentTree<Node> {
  /** Null for a pending subagent whose thread is not known yet. */
  readonly node: Node | null;
  /** Counts as a live agent itself. */
  readonly working: boolean;
  /** Live agents in this subtree. */
  readonly live: number;
  /** Agents in this subtree, idle ones included. */
  readonly size: number;
  readonly children: ReadonlyArray<AgentTree<Node>>;
}

/**
 * A thread's agent lineage, grandchildren included. A thread works while its run does,
 * unless it only waits on its children. A child its parent still waits on works even
 * between its runs, and a pending subagent with no known thread works as one agent.
 */
export function buildAgentTree<Node extends AgentTreeNode>(
  root: Node,
  childrenOf: (node: Node) => ReadonlyArray<Node>,
): AgentTree<Node> {
  const seen = new Set<string>([root.key]);
  const build = (node: Node, awaited: boolean): AgentTree<Node> => {
    const { thread } = node;
    const children = childrenOf(node).filter((child) => !seen.has(child.key));
    for (const child of children) seen.add(child.key);
    const childIds = new Set(children.map((child) => child.thread.id));
    const awaitedChildIds = new Set<string>();
    const subtrees: AgentTree<Node>[] = [];
    for (const task of thread.pendingBackgroundTasks ?? []) {
      if (task.kind !== "subagent") continue;
      if (task.childThreadId !== undefined && childIds.has(task.childThreadId)) {
        awaitedChildIds.add(task.childThreadId);
      } else {
        subtrees.push({ node: null, working: true, live: 1, size: 1, children: [] });
      }
    }
    for (const child of children) {
      subtrees.push(build(child, awaitedChildIds.has(child.thread.id)));
    }
    const below = subtrees.reduce((sum, subtree) => sum + subtree.live, 0);
    const running =
      thread.blockedOnThreadWait !== true &&
      (thread.activityRunStatus === "preparing" ||
        thread.activityRunStatus === "starting" ||
        thread.activityRunStatus === "running");
    const working = running || (awaited && below === 0);
    return {
      node,
      working,
      live: below + (working ? 1 : 0),
      size: 1 + subtrees.reduce((sum, subtree) => sum + subtree.size, 0),
      children: subtrees,
    };
  };
  return build(root, false);
}

function shellRelationshipStatus(thread: ThreadStatusSource, settled: string | null) {
  return (
    thread.activityRunStatus ?? (threadAwaitsChildren(thread) ? AWAITING_CHILDREN_STATUS : settled)
  );
}

export interface ThreadRelationshipNode {
  readonly threadId: ThreadId;
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly missing: boolean;
}

export interface ThreadRelationshipEdge {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly kind: ThreadRelationshipKind;
  readonly status: string | null;
}

export interface ThreadRelationshipGraph {
  readonly nodes: ReadonlyMap<ThreadId, ThreadRelationshipNode>;
  readonly edges: ReadonlyArray<ThreadRelationshipEdge>;
}

export interface ThreadRelationshipWalkRow {
  readonly threadId: ThreadId;
  readonly fromThreadId: ThreadId;
  readonly depth: number;
  readonly edge: ThreadRelationshipEdge;
}

export function resolveMergeBackTargetThreadId(
  projection: Pick<OrchestrationV2ThreadProjection, "thread"> | null,
): ThreadId | null {
  if (projection?.thread.lineage.relationshipToParent !== "fork") return null;
  return projection.thread.forkedFrom?.type === "run"
    ? projection.thread.forkedFrom.threadId
    : projection.thread.lineage.parentThreadId;
}

function edgeKey(edge: ThreadRelationshipEdge): string {
  return `${edge.sourceThreadId}\u001f${edge.targetThreadId}\u001f${edge.kind}`;
}

export function deriveThreadRelationshipGraph(input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projection: OrchestrationV2ThreadProjection | null;
}): ThreadRelationshipGraph {
  const threadsById = new Map<ThreadId, OrchestrationV2ThreadShell>();
  for (const thread of input.threads) {
    // Callers order shells from most to least authoritative. In particular,
    // live shells precede archived snapshots, which may still contain a stale
    // copy during archive refresh.
    if (!threadsById.has(thread.id)) {
      threadsById.set(thread.id, thread);
    }
  }
  const threads = [...threadsById.values()];
  const nodes = new Map<ThreadId, ThreadRelationshipNode>(
    threads.map((thread) => [thread.id, { threadId: thread.id, thread, missing: false }]),
  );
  const edgesByKey = new Map<string, ThreadRelationshipEdge>();
  const ensureNode = (threadId: ThreadId) => {
    if (!nodes.has(threadId)) {
      nodes.set(threadId, { threadId, thread: null, missing: true });
    }
  };
  const addEdge = (edge: ThreadRelationshipEdge) => {
    ensureNode(edge.sourceThreadId);
    ensureNode(edge.targetThreadId);
    edgesByKey.set(
      edgeKey(edge),
      edge.kind === "subagent" && edge.status === "rolled_back"
        ? { ...edge, status: "interrupted" }
        : edge,
    );
  };

  const selectedThread = input.projection?.thread;
  const lineageThreads =
    selectedThread !== undefined && !threadsById.has(selectedThread.id)
      ? [...threads, { ...selectedThread, activityRunStatus: null, status: null }]
      : threads;
  for (const thread of lineageThreads) {
    const parentThreadId =
      thread.forkedFrom?.type === "run"
        ? thread.forkedFrom.threadId
        : thread.lineage.parentThreadId;
    if (parentThreadId === null) continue;
    addEdge({
      sourceThreadId: parentThreadId,
      targetThreadId: thread.id,
      kind: thread.lineage.relationshipToParent === "subagent" ? "subagent" : "fork",
      status: shellRelationshipStatus(thread, thread.status),
    });
  }

  if (input.projection !== null) {
    const ownerThreadId = input.projection.thread.id;
    for (const subagent of input.projection.subagents) {
      if (subagent.childThreadId === null) continue;
      const child = threadsById.get(subagent.childThreadId);
      addEdge({
        sourceThreadId: ownerThreadId,
        targetThreadId: subagent.childThreadId,
        kind: "subagent",
        status:
          child === undefined
            ? subagent.status
            : shellRelationshipStatus(
                child,
                child.latestRunId != null && !isOrchestrationV2WorkActive(subagent.status)
                  ? child.status
                  : subagent.status,
              ),
      });
    }
    for (const transfer of input.projection.contextTransfers) {
      if (transfer.sourceThreadId === transfer.targetThreadId) continue;
      addEdge({
        sourceThreadId: transfer.sourceThreadId,
        targetThreadId: transfer.targetThreadId,
        kind: "transfer",
        status: transfer.status,
      });
    }
  }

  return { nodes, edges: [...edgesByKey.values()] };
}

export function immediateThreadRelationships(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadRelationshipWalkRow> {
  const visited = new Set<ThreadId>();
  const rows: ThreadRelationshipWalkRow[] = [];

  for (const edge of graph.edges) {
    const relatedId =
      edge.sourceThreadId === threadId
        ? edge.targetThreadId
        : edge.targetThreadId === threadId
          ? edge.sourceThreadId
          : null;
    if (relatedId === null || visited.has(relatedId)) continue;
    visited.add(relatedId);
    rows.push({ threadId: relatedId, fromThreadId: threadId, depth: 1, edge });
  }

  return rows;
}

export function isParentThreadRelationship(
  edge: ThreadRelationshipEdge,
  currentThreadId: ThreadId,
): boolean {
  return edge.kind !== "transfer" && edge.targetThreadId === currentThreadId;
}

export function threadRelationshipRowStatus(
  graph: ThreadRelationshipGraph,
  row: Pick<ThreadRelationshipWalkRow, "threadId" | "edge">,
): string | null {
  if (row.edge.kind === "transfer" || row.threadId === row.edge.targetThreadId) {
    return row.edge.status;
  }
  const thread = graph.nodes.get(row.threadId)?.thread;
  return thread ? shellRelationshipStatus(thread, thread.status) : null;
}

function threadCreatedAtMillis(node: ThreadRelationshipNode | undefined): number | null {
  const createdAt: unknown = node?.thread?.createdAt;
  if (!DateTime.isDateTime(createdAt)) return null;
  const millis = DateTime.toEpochMillis(createdAt);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * Web pins the parent and distinct merge-back target before newest-created-first ordering.
 * Mobile does not share this exception; do not reuse it as the canonical relationship order.
 */
export function orderWebThreadLineageRows(input: {
  readonly graph: ThreadRelationshipGraph;
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly currentThreadId: ThreadId;
  readonly mergeTargetThreadId: ThreadId | null;
}): ReadonlyArray<ThreadRelationshipWalkRow> {
  const pinRank = (row: ThreadRelationshipWalkRow): number => {
    if (isParentThreadRelationship(row.edge, input.currentThreadId)) return 0;
    if (row.threadId === input.mergeTargetThreadId) return 1;
    return 2;
  };

  return [...input.rows].sort((left, right) => {
    const rankDelta = pinRank(left) - pinRank(right);
    if (rankDelta !== 0) return rankDelta;
    const leftCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(left.threadId));
    const rightCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(right.threadId));
    if (leftCreatedAt !== rightCreatedAt) {
      if (leftCreatedAt === null) return 1;
      if (rightCreatedAt === null) return -1;
      return rightCreatedAt - leftCreatedAt;
    }
    return left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0;
  });
}
