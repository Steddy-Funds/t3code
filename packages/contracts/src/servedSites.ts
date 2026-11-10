import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PortSchema,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const ServedSiteId = TrimmedNonEmptyString.pipe(Schema.brand("ServedSiteId"));
export type ServedSiteId = typeof ServedSiteId.Type;

/** A DNS label, so the public hook can use it as a subdomain. */
export const SERVED_SITE_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
export const ServedSiteName = Schema.String.check(Schema.isPattern(SERVED_SITE_NAME_PATTERN));

export const ServedSiteVisibility = Schema.Literals(["tailnet", "public"]);
export type ServedSiteVisibility = typeof ServedSiteVisibility.Type;

export const ServedSiteStatus = Schema.Literals([
  "publishing",
  "live",
  "stopping",
  "removed",
  "failed",
]);
export type ServedSiteStatus = typeof ServedSiteStatus.Type;

export const ServedSiteRemovedReason = Schema.Literals([
  "stopped",
  "pids-exited",
  "stop-command",
  "publish-failed",
]);
export type ServedSiteRemovedReason = typeof ServedSiteRemovedReason.Type;

export const ServedSiteProcess = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: NonNegativeInt,
});
export type ServedSiteProcess = typeof ServedSiteProcess.Type;

export const ServedSite = Schema.Struct({
  id: ServedSiteId,
  name: ServedSiteName,
  threadId: ThreadId,
  projectCwd: Schema.String,
  localPort: PortSchema,
  pids: Schema.Array(ServedSiteProcess),
  visibility: ServedSiteVisibility,
  tailnetUrl: Schema.NullOr(Schema.String),
  publicUrl: Schema.NullOr(Schema.String),
  servePort: Schema.NullOr(PortSchema),
  stopCommand: Schema.NullOr(Schema.String),
  status: ServedSiteStatus,
  removedReason: Schema.NullOr(ServedSiteRemovedReason),
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  removedAt: Schema.NullOr(IsoDateTime),
});
export type ServedSite = typeof ServedSite.Type;

export const ServedSitesSnapshot = Schema.Struct({ sites: Schema.Array(ServedSite) });
export type ServedSitesSnapshot = typeof ServedSitesSnapshot.Type;

export const ServedSiteStopInput = Schema.Struct({
  siteId: ServedSiteId,
  /** Signal the pinned processes even when the site has a custom stop command. */
  force: Schema.optionalKey(Schema.Boolean),
});
export type ServedSiteStopInput = typeof ServedSiteStopInput.Type;

export const ServedSiteDismissInput = Schema.Struct({ siteId: ServedSiteId });
export type ServedSiteDismissInput = typeof ServedSiteDismissInput.Type;

/** What this server can publish to: a tailnet via `tailscale serve`, the internet via its hook. */
export const ServedSitesCapability = Schema.Struct({
  tailnet: Schema.Boolean,
  public: Schema.Boolean,
});
export type ServedSitesCapability = typeof ServedSitesCapability.Type;

export class ServedSiteError extends Schema.TaggedError<ServedSiteError>()("ServedSiteError", {
  reason: Schema.Literals(["not-found", "invalid", "unavailable", "failed"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
