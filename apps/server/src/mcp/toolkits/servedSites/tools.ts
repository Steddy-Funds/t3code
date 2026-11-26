import {
  OrchestratorMcpFailure,
  PortSchema,
  PositiveInt,
  ServedSite,
  ServedSiteId,
  ServedSiteVisibility,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";
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
    "Publish a server you started at an HTTPS tailnet URL. It is removed when all its `pids` exit; they default to the port's owner, so pass them for a server no thread started. `visibility: \"public\"` needs this server's public URL hook. `stopCommand` runs with sh in the project when the user stops the site.",
  parameters: Schema.Struct({
    port: PortSchema,
    pids: Schema.optionalKey(Schema.Array(PositiveInt)),
    name: Schema.optionalKey(Schema.String),
    visibility: Schema.optionalKey(ServedSiteVisibility),
    stopCommand: Schema.optionalKey(Schema.String),
  }),
  success: ServedSite,
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const SiteListTool = Tool.make("t3_site_list", {
  ...shared,
  description: "List this thread's sites with URLs and status.",
  success: Schema.Struct({ sites: Schema.Array(ServedSite) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const SiteStopTool = Tool.make("t3_site_stop", {
  ...shared,
  description:
    "Stop a site: runs its `stopCommand`, else signals its pids. `force` always signals.",
  parameters: Schema.Struct({
    siteId: ServedSiteId,
    force: Schema.optionalKey(Schema.Boolean),
  }),
  success: ServedSite,
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const ServedSitesToolkit = Toolkit.make(SitePublishTool, SiteListTool, SiteStopTool);
