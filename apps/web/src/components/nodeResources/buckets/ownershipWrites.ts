import type { ServerConfig } from "@t3tools/contracts";

/** Whether this client may save buckets or remove claims; "hidden" says nothing (no access, no config yet). */
export type OwnershipWrites = "allowed" | "olderServer" | "hidden";

/**
 * Bucket saves and claim removal need a server that advertises `machineOwnership`: an older one
 * accepts the settings patch and silently drops the buckets in it.
 */
export function ownershipWrites(input: {
  readonly config: Pick<ServerConfig, "environment"> | null | undefined;
  readonly canWrite: boolean;
}): OwnershipWrites {
  if (!input.canWrite || !input.config) return "hidden";
  return input.config.environment.capabilities.machineOwnership === true ? "allowed" : "olderServer";
}
