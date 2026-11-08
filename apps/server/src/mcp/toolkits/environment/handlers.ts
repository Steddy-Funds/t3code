import {
  type BucketEditedError,
  MACHINE_BUCKETS_THREAD_TAG,
  type MachineActor,
  MachineBucketId,
  type MachineBucketLimitError,
  type MachineClaimError,
  OrchestratorMcpFailure,
  type ServerSettings,
  type ServerSettingsError,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProcessOwnership from "../../../resourceTelemetry/ProcessOwnership.ts";
import * as Settings from "../../../serverSettings.ts";
import { assertNotLinked, assertSameLink } from "../../linkOrigin.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  assertTargetWithinLimits,
  type Caller,
  loadCaller,
  readCaller,
  threadNotFound,
  unavailable,
} from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const ownershipFailure = (
  error: MachineClaimError | BucketEditedError | MachineBucketLimitError | ServerSettingsError,
) => {
  switch (error._tag) {
    case "ServerSettingsError":
      return unavailable();
    case "BucketEditedError":
      return new OrchestratorMcpFailure({ code: "capability_denied", message: error.message });
    case "MachineClaimError":
      return error.reason === "refused"
        ? new OrchestratorMcpFailure({ code: "capability_denied", message: error.message })
        : invalid(error.message);
    case "MachineBucketLimitError":
      return invalid(error.message);
  }
};

/** Threads tagged for auto-buckets write as `auto`; clients outside a thread act for the user. */
const bucketActor = ({ caller }: Caller): MachineActor =>
  caller === undefined
    ? { type: "user" }
    : caller.tags?.includes(MACHINE_BUCKETS_THREAD_TAG) === true
      ? { type: "auto", threadId: caller.id }
      : { type: "agent", threadId: caller.id };

/** Another thread's claims follow the same rule as changing that thread. */
const assertMayChangeThread = Effect.fn("EnvironmentHandlers.assertMayChangeThread")(function* (
  caller: Caller,
  threadId: ThreadId,
) {
  if (threadId === caller.caller?.id) return;
  const target = yield* caller.threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
  if (target === null || target.deletedAt !== null) {
    return yield* threadNotFound(caller.threads, threadId, "The thread was not found.");
  }
  yield* assertTargetWithinLimits(caller.limits, target);
  yield* assertSameLink(caller, target);
});

const newBucketId = Effect.fn("EnvironmentHandlers.newBucketId")(function* () {
  const random = yield* SecureRandom.SecureRandom;
  return MachineBucketId.make(`bucket_${yield* random.uuidV4()}`);
});

export const layer = McpToolAccess.toLayer(
  EnvironmentToolkit,
  Effect.gen(function* () {
    const ownership = yield* ProcessOwnership.ProcessOwnership;
    return {
      t3_environment_read: McpToolAccess.reads(() =>
        Effect.gen(function* () {
          const { descriptor, settings } = yield* access;
          const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
          return {
            environmentId: descriptor.environmentId,
            label: descriptor.label,
            serverVersion: descriptor.serverVersion,
            platform: descriptor.platform,
            preferences: preferences(current),
          };
        }),
      ),
      t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
          const update = Effect.gen(function* () {
            // The turn may have ended, or the thread's modes changed, while this waited for the lock.
            yield* check;
            const { settings } = yield* access;
            return preferences(
              yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
            );
          });
          return yield* scope.thread === undefined
            ? update
            : executor.withLock(scope.thread.threadId, update);
        }),
      ),
      t3_machine_buckets: McpToolAccess.either(
        (input) => input.action === "list",
        McpToolAccess.reads(() =>
          Effect.gen(function* () {
            const { settings } = yield* access;
            const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
            return { buckets: Object.values(current.machineResources.buckets) };
          }),
        ),
        McpToolAccess.writes(
          (input) =>
            Effect.gen(function* () {
              const context = yield* access;
              const actor = bucketActor(context);
              if (input.action === "delete") {
                if (input.bucketId === undefined) return yield* invalid("Pass `bucketId`.");
                yield* ownership
                  .deleteBucket(input.bucketId, actor)
                  .pipe(Effect.mapError(ownershipFailure));
                return { deleted: input.bucketId };
              }
              if (input.bucket === undefined) return yield* invalid("Pass `bucket`.");
              const id = input.bucket.id ?? (yield* newBucketId());
              const bucket = yield* ownership
                .upsertBucket({ ...input.bucket, id }, actor)
                .pipe(Effect.mapError(ownershipFailure));
              return { bucket };
            }),
          { noun: "this machine's buckets" },
        ),
      ),
      t3_resource_claim: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const caller = yield* loadCaller();
          const scope = yield* McpInvocationContext.requireThreadScope(caller.scope, "This tool");
          const callerThreadId = scope.thread.threadId;
          if (input.action === "list") {
            const threadId = input.threadId ?? callerThreadId;
            const claims = yield* ownership.claims;
            return { claims: claims.filter((claim) => claim.threadId === threadId) };
          }
          yield* assertNotLinked(caller, "claim or release this machine's processes");
          const actor: MachineActor = { type: "agent", threadId: callerThreadId };
          if (input.action === "claim") {
            if (input.target === undefined) return yield* invalid("Pass `target`.");
            const threadId = input.threadId ?? callerThreadId;
            yield* assertMayChangeThread(caller, threadId);
            const claim = yield* ownership
              .claim({ threadId, target: input.target }, actor)
              .pipe(Effect.mapError(ownershipFailure));
            return { claim };
          }
          if (input.claimId === undefined) return yield* invalid("Pass `claimId`.");
          const claim = (yield* ownership.claims).find((each) => each.id === input.claimId);
          if (claim === undefined) {
            return yield* invalid(
              `No claim ${input.claimId}: it was released, its target exited, or the server restarted.`,
            );
          }
          yield* assertMayChangeThread(caller, claim.threadId);
          yield* ownership.release(claim.id);
          return { released: claim.id };
        }),
      ),
    } satisfies McpToolAccess.Handlers<typeof EnvironmentToolkit.tools>;
  }),
);
