import {
  PROVIDER_DISPLAY_NAMES,
  type MachineBucketId,
  type ProcessOwner,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";

export type { ClaimId, MachineBucketId, ProcessOwner } from "@t3tools/contracts";

export type OwnerKind = ProcessOwner["type"];

export interface OwnerNames {
  /** Undefined when the thread is unknown here (deleted, or not loaded on this client). */
  readonly threadTitle: (threadId: ThreadId) => string | undefined;
  readonly bucketName: (bucketId: MachineBucketId) => string | undefined;
}

export interface OwnerLabel {
  readonly kind: OwnerKind;
  readonly text: string;
  /** The longer form for a tooltip, when it says more than `text`. */
  readonly detail?: string;
}

const SHORT_ID = 8;
const CONTAINER_ID = 12;

export const providerName = (provider: ProviderDriverKind): string =>
  PROVIDER_DISPLAY_NAMES[provider] ?? provider;

const threadName = (threadId: ThreadId, names: OwnerNames) =>
  names.threadTitle(threadId) ?? `thread ${threadId.slice(0, SHORT_ID)}`;

export const sharedText = (threadCount: number) =>
  `shared (${threadCount} ${threadCount === 1 ? "thread" : "threads"})`;

/** What an owner chip says. Unresolvable ids fall back to a short id, never an empty label. */
export function ownerLabel(owner: ProcessOwner, names: OwnerNames): OwnerLabel {
  switch (owner.type) {
    case "thread": {
      const text = threadName(owner.threadId, names);
      return owner.terminalId === undefined
        ? { kind: owner.type, text }
        : { kind: owner.type, text, detail: `${text} · terminal` };
    }
    case "shared":
      return {
        kind: owner.type,
        text: sharedText(owner.threadCount),
        detail: `${providerName(owner.provider)} ${owner.label}: ${sharedText(owner.threadCount)}`,
      };
    case "t3":
      return { kind: owner.type, text: owner.label };
    case "claimed": {
      const text = threadName(owner.threadId, names);
      return { kind: owner.type, text, detail: `Claimed by ${text}` };
    }
    case "bucket": {
      const name = names.bucketName(owner.bucketId);
      return name === undefined
        ? { kind: owner.type, text: "deleted bucket", detail: `bucket ${owner.bucketId}` }
        : { kind: owner.type, text: name };
    }
    case "provider":
      return { kind: owner.type, text: providerName(owner.provider) };
    case "container":
      return {
        kind: owner.type,
        text: `container ${owner.id.slice(0, CONTAINER_ID)}`,
        detail: `container ${owner.id}`,
      };
    case "other":
      return { kind: owner.type, text: "other", detail: "Not attributable to a thread or bucket" };
  }
}
