import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  Claim,
  ClaimId,
  ClaimTarget,
  ExecutionEnvironmentDescriptor,
  MachineBucket,
  MachineBucketId,
  MachineBucketInput,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
  ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and preferences. Providers and models: `orchestrator_capabilities`.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update environment-wide preferences. Live full-access or default caller thread only. Omitted fields are unchanged; `customInstructions: ''` clears it.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
const MachineBucketsTool = Tool.make("t3_machine_buckets", {
  ...shared,
  dependencies: [...shared.dependencies, SecureRandom.SecureRandom],
  description:
    "Group this machine's processes into named buckets for its task manager. `list` shows buckets and who last edited them; `upsert` creates one (omit `bucket.id`) or replaces it; `delete` removes `bucketId`. A process matching any rule joins the bucket.",
  parameters: Schema.Struct({
    action: Schema.Literals(["list", "upsert", "delete"]),
    bucket: Schema.optionalKey(
      Schema.Struct({
        id: Schema.optionalKey(MachineBucketId),
        name: MachineBucketInput.fields.name,
        rules: MachineBucketInput.fields.rules,
      }),
    ),
    bucketId: Schema.optionalKey(MachineBucketId),
  }),
  success: Schema.Struct({
    buckets: Schema.optionalKey(Schema.Array(MachineBucket)),
    bucket: Schema.optionalKey(MachineBucket),
    deleted: Schema.optionalKey(MachineBucketId),
  }),
}).annotate(Tool.Destructive, true);
const ResourceClaimTool = Tool.make("t3_resource_claim", {
  ...shared,
  description:
    "Count a process tree, container or cgroup you started (a dev server, a test stack) as a thread's CPU and memory. `claim` takes `target` (a process needs its start time in epoch ms: `ps -o lstart= -p <pid>` converted; within 1 s matches), `release` takes `claimId`, `list` shows the thread's claims. `threadId` defaults to this thread. Claims end when the target exits or the server restarts.",
  parameters: Schema.Struct({
    action: Schema.Literals(["claim", "release", "list"]),
    target: Schema.optionalKey(ClaimTarget),
    threadId: Schema.optionalKey(ThreadId),
    claimId: Schema.optionalKey(ClaimId),
  }),
  success: Schema.Struct({
    claims: Schema.optionalKey(Schema.Array(Claim)),
    claim: Schema.optionalKey(Claim),
    released: Schema.optionalKey(ClaimId),
  }),
}).annotate(Tool.Destructive, false);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  MachineBucketsTool,
  ResourceClaimTool,
);
