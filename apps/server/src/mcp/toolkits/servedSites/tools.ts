import {
  OrchestratorMcpFailure,
  PortSchema,
  PositiveInt,
  ServedSite,
  ServedSiteId,
  ServedSiteVisibility,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const SitePublishTool = Tool.make("t3_site_publish", {
  ...shared,
  description:
    'Share a server you started at an HTTPS tailnet URL; `visibility: "public"` also gets a public URL where this server has a public URL hook. `port` must be listening on 127.0.0.1. The site is pinned to `pids` (default: the port\'s owner) and goes away by itself when they all exit. The user can stop it from T3 Code: `stopCommand` (run with sh in the project) replaces signaling the pids.',
  parameters: Schema.Struct({
    port: PortSchema,
    pids: Schema.optionalKey(Schema.Array(PositiveInt)),
    name: Schema.optionalKey(Schema.String),
    visibility: Schema.optionalKey(ServedSiteVisibility),
    stopCommand: Schema.optionalKey(Schema.String),
  }),
  success: ServedSite,
}).annotate(Tool.Destructive, false);

const SiteListTool = Tool.make("t3_site_list", {
  ...shared,
  description: "List this thread's published sites, with their URLs and status.",
  parameters: Schema.Struct({}),
  success: Schema.Struct({ sites: Schema.Array(ServedSite) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SiteStopTool = Tool.make("t3_site_stop", {
  ...shared,
  description:
    "Stop a published site: runs its `stopCommand`, or signals its pids. `force: true` signals the pids even with a stop command. The site is removed once the pids exit.",
  parameters: Schema.Struct({
    siteId: ServedSiteId,
    force: Schema.optionalKey(Schema.Boolean),
  }),
  success: ServedSite,
}).annotate(Tool.Destructive, true);

export const ServedSitesToolkit = Toolkit.make(SitePublishTool, SiteListTool, SiteStopTool);
