import { EnvironmentId, ThreadId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  onRetainedMobileBackgroundScopesChange,
  observeMobileBackgroundActivitySubscription,
  retainedMobileBackgroundScopes,
  retainMobileBackgroundScope,
} from "./background-activity-scopes";

describe("mobile background activity", () => {
  it.effect("retains VCS demand only while the mobile subscription is active", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("mobile-environment");
      const releasePassive = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "/workspace", includeRemote: false },
      });
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
      const release = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "/workspace" },
      });

      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([
        { type: "vcs-status", cwd: "/workspace" },
      ]);

      yield* releasePassive;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([
        { type: "vcs-status", cwd: "/workspace" },
      ]);

      yield* release;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("leases diagnostics for machine views only while they sample", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("machine-lease-environment");
      const releaseVerdict = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeMachine,
        input: {},
      });
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);

      const releaseSamples = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeMachine,
        input: { intervalMs: 1_000 },
      });
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([{ type: "diagnostics" }]);
      const releaseProcesses = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeMachineProcesses,
        input: { intervalMs: 2_000 },
      });
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([{ type: "diagnostics" }]);

      yield* releaseSamples;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([{ type: "diagnostics" }]);
      yield* releaseProcesses;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
      yield* releaseVerdict;
    }),
  );

  it.effect("keeps delimiter-containing environment and scope values distinct", () =>
    Effect.gen(function* () {
      const firstEnvironmentId = EnvironmentId.make("a");
      const secondEnvironmentId = EnvironmentId.make("a:vcs-status:b");
      const releaseFirst = yield* observeMobileBackgroundActivitySubscription({
        environmentId: firstEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "b:vcs-status:c" },
      });
      const releaseSecond = yield* observeMobileBackgroundActivitySubscription({
        environmentId: secondEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "c" },
      });

      expect(retainedMobileBackgroundScopes(firstEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "b:vcs-status:c" },
      ]);
      expect(retainedMobileBackgroundScopes(secondEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "c" },
      ]);

      yield* Effect.all([releaseFirst, releaseSecond]);
    }),
  );

  it.effect("returns a release handle when a retained-scope listener throws", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("throwing-listener-environment");
      const removeListener = onRetainedMobileBackgroundScopesChange(() => {
        throw new Error("listener failed");
      });

      const release = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "/workspace" },
      });
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([
        { type: "vcs-status", cwd: "/workspace" },
      ]);

      yield* release;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
      removeListener();
    }),
  );

  it("refcounts a retained thread focus scope and notifies only on first retain and last release", () => {
    const environmentId = EnvironmentId.make("focus-lease-environment");
    const scope = { type: "thread" as const, threadId: ThreadId.make("thread:focused") };
    let changes = 0;
    const removeListener = onRetainedMobileBackgroundScopesChange(() => {
      changes += 1;
    });

    const releaseFirst = retainMobileBackgroundScope(environmentId, scope);
    expect([retainedMobileBackgroundScopes(environmentId), changes]).toEqual([[scope], 1]);
    const releaseSecond = retainMobileBackgroundScope(environmentId, { ...scope });
    expect([retainedMobileBackgroundScopes(environmentId), changes]).toEqual([[scope], 1]);

    // Releasing one handle twice must not drop the other holder's retain.
    releaseFirst();
    releaseFirst();
    expect([retainedMobileBackgroundScopes(environmentId), changes]).toEqual([[scope], 1]);
    releaseSecond();
    expect([retainedMobileBackgroundScopes(environmentId), changes]).toEqual([[], 2]);

    // A release after the scope is gone is a no-op: no negative count, no second notify,
    // and a fresh retain starts again from one.
    releaseSecond();
    releaseFirst();
    expect([retainedMobileBackgroundScopes(environmentId), changes]).toEqual([[], 2]);
    const releaseThird = retainMobileBackgroundScope(environmentId, scope);
    expect([retainedMobileBackgroundScopes(environmentId), changes]).toEqual([[scope], 3]);
    releaseThird();
    expect([retainedMobileBackgroundScopes(environmentId), changes]).toEqual([[], 4]);
    removeListener();
  });
});
