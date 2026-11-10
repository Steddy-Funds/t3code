import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  type ServedSite,
  ServedSiteId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServedSites from "../../../servedSites/ServedSites.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServedSitesHandlers from "./handlers.ts";
import { ServedSitesToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:sites-caller");
const otherThreadId = ThreadId.make("thread:sites-other");

const site = (id: string, owner: ThreadId): ServedSite => ({
  id: ServedSiteId.make(id),
  name: id,
  threadId: owner,
  projectCwd: "/repo",
  localPort: 3000,
  pids: [{ pid: 4242, startTimeMs: 0 }],
  visibility: "tailnet",
  tailnetUrl: "https://box.tailnet.ts.net:3000",
  publicUrl: null,
  servePort: 3000,
  stopCommand: null,
  status: "live",
  removedReason: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  removedAt: null,
});

const harness = (linkOrigin?: {
  sessionId: string;
  label: string;
  access: "approval-required";
}) => {
  const calls: Array<string> = [];
  const mine = site("mine", threadId);
  const dependencies = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment:sites"),
      requestNamespace: "provider:sites",
      thread: {
        threadId,
        providerSessionId: "provider:sites",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["orchestration" as const]),
      issuedAt: 0,
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed({ ...liveThreadShell(id), worktreePath: "/worktree", linkOrigin }),
    }),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(ServedSites.ServedSites)({
      publish: (input) =>
        Effect.sync(() => {
          calls.push("publish");
          return { ...mine, projectCwd: input.projectCwd };
        }),
      list: Effect.succeed([mine, site("theirs", otherThreadId)]),
      stop: () => Effect.sync(() => (calls.push("stop"), mine)),
    }),
  );
  const toolkit = ServedSitesToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ServedSitesHandlers.layer).pipe(
        Layer.provide(dependencies),
      ),
    ),
  );
  return { calls, dependencies, toolkit };
};

it.effect("a linked caller can neither publish nor stop this machine's sites", () =>
  Effect.gen(function* () {
    const { calls, dependencies, toolkit } = harness({
      sessionId: "link:laptop",
      label: "Laptop",
      access: "approval-required",
    });
    const kit = yield* toolkit;
    const published = yield* kit
      .handle("t3_site_publish", { port: 3000 })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    const stopped = yield* kit
      .handle("t3_site_stop", { siteId: ServedSiteId.make("mine") })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(published.at(-1)?.result).toMatchObject({ code: "capability_denied" });
    expect(stopped.at(-1)?.result).toMatchObject({ code: "capability_denied" });
    expect(calls).toEqual([]);
  }),
);

it.effect("publishes from the caller's worktree and lists only the caller's sites", () =>
  Effect.gen(function* () {
    const { calls, dependencies, toolkit } = harness();
    const kit = yield* toolkit;
    const published = yield* kit
      .handle("t3_site_publish", { port: 3000 })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    const listed = yield* kit
      .handle("t3_site_list", {})
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(published.at(-1)?.result).toMatchObject({ projectCwd: "/worktree" });
    expect(listed.at(-1)?.result).toEqual({ sites: [expect.objectContaining({ id: "mine" })] });
    expect(calls).toEqual(["publish"]);
  }),
);
