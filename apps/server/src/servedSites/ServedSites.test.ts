import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ResourceMonitorProcessTableEntry,
  type ServedSite,
  ServedSiteError,
  ServedSiteId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServedSitesRepository from "../persistence/ServedSites.ts";
import * as Settings from "../serverSettings.ts";
import * as ServedSites from "./ServedSites.ts";
import * as Host from "./ServedSitesHost.ts";

const threadId = ThreadId.make("thread:sites");
const HOOK = ["/hooks/expose-site"];
const MAGIC_DNS = "box.tailnet.ts.net";
const PID = 4242;
const START = 50_000;
const ENVIRONMENT_ID = EnvironmentId.make("environment:sites");

const entry = (pid: number, startTimeMs: number, ppid = 1): ResourceMonitorProcessTableEntry => ({
  pid,
  ppid,
  name: "node",
  startTimeMs,
});

const storedSite = (overrides: Partial<ServedSite> & Pick<ServedSite, "id">): ServedSite => ({
  name: overrides.id.replace(/[^a-z0-9]+/g, "-"),
  threadId,
  projectCwd: "/repo",
  localPort: 3000,
  pids: [{ pid: PID, startTimeMs: START }],
  visibility: "tailnet",
  tailnetUrl: `https://${MAGIC_DNS}:3000`,
  publicUrl: null,
  servePort: 3000,
  stopCommand: null,
  status: "live",
  removedReason: null,
  lastError: null,
  createdAt: "1970-01-01T00:00:00.000Z",
  removedAt: null,
  ...overrides,
});

interface Options {
  readonly hookPrefix?: ReadonlyArray<string>;
  readonly stored?: ReadonlyArray<ServedSite>;
  /** Serve routes already on the node: serve port to the local port it proxies. */
  readonly routes?: ReadonlyArray<readonly [servePort: number, localPort: number]>;
  /** Pids holding the published port's listening socket; default: PID. */
  readonly listenerPids?: ReadonlyArray<number>;
  /** How many unserve calls fail before one succeeds. */
  readonly unserveFailures?: number;
  readonly stopGroupsError?: string;
  readonly serveError?: (servePort: number) => string | null;
  readonly hook?: (argv: ReadonlyArray<string>) => Host.HookRun;
  /** What signaling the process groups does to the table; default: the pids exit. */
  readonly onStopGroups?: (pids: ReadonlyArray<number>) => void;
}

const harness = Effect.fn("harness")(function* (options: Options = {}) {
  const state = {
    table: [entry(PID, START)] as ReadonlyArray<ResourceMonitorProcessTableEntry>,
    tableFails: false,
    rows: new Map((options.stored ?? []).map((site) => [site.id, site])),
    routes: new Map(options.routes ?? []),
    unserveFailures: options.unserveFailures ?? 0,
    hookEnv: [] as Array<Readonly<Record<string, string>>>,
    serves: [] as Array<{ servePort: number; localPort: number }>,
    unserves: [] as Array<number>,
    hookArgv: [] as Array<ReadonlyArray<string>>,
    stoppedGroups: [] as Array<ReadonlyArray<number>>,
    stopCommands: [] as Array<{ command: string; cwd: string }>,
  };
  const dropPids = (pids: ReadonlyArray<number>) => {
    state.table = state.table.filter((each) => !pids.includes(each.pid));
  };
  const reconciled = yield* Deferred.make<void>();
  let uuid = 0;

  const dependencies = Layer.mergeAll(
    Layer.succeed(ServedSitesRepository.ServedSitesRepository, {
      list: Effect.sync(() => [...state.rows.values()]),
      upsert: (site) => Effect.sync(() => void state.rows.set(site.id, site)),
      remove: (id) => Effect.sync(() => void state.rows.delete(id)),
    }),
    Layer.succeed(Host.SiteTailscale, {
      magicDnsName: Effect.succeed(MAGIC_DNS),
      routes: Effect.sync(() => {
        const routes = new Map(state.routes);
        return {
          ports: new Set(routes.keys()),
          proxies: (servePort: number, localPort: number) => routes.get(servePort) === localPort,
        };
      }),
      serve: (input) =>
        Effect.suspend(() => {
          state.serves.push(input);
          const error = options.serveError?.(input.servePort) ?? null;
          if (error !== null) {
            return Effect.fail(new ServedSiteError({ reason: "failed", detail: error }));
          }
          state.routes.set(input.servePort, input.localPort);
          return Effect.void;
        }),
      unserve: (servePort) =>
        Effect.suspend(() => {
          if (state.unserveFailures > 0) {
            state.unserveFailures -= 1;
            return Effect.fail(new ServedSiteError({ reason: "failed", detail: "serve is stuck" }));
          }
          state.unserves.push(servePort);
          state.routes.delete(servePort);
          return Effect.void;
        }),
    }),
    Layer.succeed(Host.SiteHookRunner, {
      run: (input) =>
        Effect.sync(() => {
          state.hookArgv.push(input.argv);
          state.hookEnv.push(input.env);
          return (
            options.hook?.(input.argv) ??
            ({ _tag: "exited", code: 0, stdout: "https://web.example.com\n", stderr: "" } as const)
          );
        }),
    }),
    Layer.succeed(Host.SiteProcesses, {
      table: Effect.suspend(() =>
        state.tableFails
          ? Effect.fail(new ServedSiteError({ reason: "unavailable", detail: "no monitor" }))
          : Effect.succeed(state.table),
      ).pipe(Effect.ensuring(Deferred.succeed(reconciled, undefined))),
      isListening: () => Effect.succeed(true),
      portOwner: () => Effect.succeed(null),
      listenerPids: () => Effect.succeed(options.listenerPids ?? [PID]),
      stopProcessGroups: (pids) =>
        Effect.suspend(() => {
          state.stoppedGroups.push(pids);
          if (options.stopGroupsError !== undefined) {
            return Effect.fail(
              new ServedSiteError({ reason: "failed", detail: options.stopGroupsError }),
            );
          }
          (options.onStopGroups ?? dropPids)(pids);
          return Effect.void;
        }),
      runStopCommand: (input) =>
        Effect.sync(() => {
          state.stopCommands.push({ command: input.command, cwd: input.cwd });
          return { code: 0, timedOut: false, stderr: "" };
        }),
    }),
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        servedSites: { publicExposeCommand: options.hookPrefix ?? [] },
      }),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
    }),
    Layer.succeed(ServerConfig.ServerConfig, {
      baseDir: "/t3-base",
    } as ServerConfig.ServerConfig["Service"]),
    Layer.succeed(
      SecureRandom.SecureRandom,
      SecureRandom.make((size) => new Uint8Array(size).fill(++uuid)),
    ),
  );
  const context = yield* Layer.build(ServedSites.layerWith.pipe(Layer.provide(dependencies)));
  const sites = Context.get(context, ServedSites.ServedSites);
  // Reconcile reads the stored list before the table; a publish before that would be overwritten.
  yield* Deferred.await(reconciled);

  const byId = (id: ServedSiteId) =>
    sites.list.pipe(Effect.map((list) => list.find((site) => site.id === id)));
  const waitFor = (done: (list: ReadonlyArray<ServedSite>) => boolean) =>
    sites.changes.pipe(
      Stream.filter((snapshot) => done(snapshot.sites)),
      Stream.runHead,
    );
  const publish = (input: Partial<ServedSites.PublishInput> = {}) =>
    sites.publish({
      threadId,
      projectCwd: "/repo",
      port: 3000,
      pids: [PID],
      name: "web",
      visibility: "tailnet",
      ...input,
    });
  return { sites, state, dropPids, byId, waitFor, publish };
});

const tick = TestClock.adjust("2 seconds");

describe("ServedSites", () => {
  it.effect("refuses a public site with no hook and records it failed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sites, state, publish } = yield* harness();
        const error = yield* Effect.flip(publish({ visibility: "public" }));
        expect(error).toMatchObject({
          reason: "invalid",
          detail: ServedSites.PUBLIC_NOT_CONFIGURED,
        });
        expect(yield* sites.list).toMatchObject([
          {
            name: "web",
            status: "failed",
            removedReason: "publish-failed",
            lastError: ServedSites.PUBLIC_NOT_CONFIGURED,
          },
        ]);
        expect(state.serves).toEqual([]);
        expect(state.hookArgv).toEqual([]);
      }),
    ),
  );

  it.effect(
    "takes ports used by Serve routes or active sites, and names only active sites hold",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { state, publish } = yield* harness({
            routes: [
              [3000, 9000],
              [10_000, 9001],
            ],
          });
          yield* Effect.flip(publish({ name: "Web App", visibility: "public" }));
          const first = yield* publish({ name: "Web App" });
          const second = yield* publish({ name: "Web App" });
          expect(first).toMatchObject({
            name: "web-app",
            servePort: 10_001,
            tailnetUrl: `https://${MAGIC_DNS}:10001`,
            status: "live",
            publicUrl: null,
          });
          expect(second).toMatchObject({ name: "web-app-2", servePort: 10_002, status: "live" });
          expect(state.serves).toEqual([
            { servePort: 10_001, localPort: 3000 },
            { servePort: 10_002, localPort: 3000 },
          ]);
          expect(state.rows.get(second.id)?.status).toBe("live");
        }),
      ),
  );

  it.effect("goes live with the URL the public hook prints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, publish } = yield* harness({ hookPrefix: HOOK });
        const site = yield* publish({ visibility: "public" });
        expect(site).toMatchObject({
          status: "live",
          servePort: 3000,
          publicUrl: "https://web.example.com",
        });
        expect(state.hookArgv).toEqual([[...HOOK, "expose", "web", "http://127.0.0.1:3000"]]);
        expect(state.hookEnv).toEqual([
          {
            T3_SITE_ID: site.id,
            T3_SITE_THREAD_ID: threadId,
            T3_SITE_PROJECT_CWD: "/repo",
            T3_ENVIRONMENT_ID: ENVIRONMENT_ID,
          },
        ]);
      }),
    ),
  );

  it.effect.each<{ readonly name: string; readonly run: Host.HookRun; readonly error: string }>([
    {
      name: "a refusal",
      run: { _tag: "exited", code: 3, stdout: "", stderr: "no quota" },
      error: "Public URL refused: no quota",
    },
    { name: "a timeout", run: { _tag: "timed-out" }, error: "The public URL hook timed out." },
  ])("after $name the route comes down, the hook unexposes, the record fails", ({ run, error }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, publish, sites } = yield* harness({
          hookPrefix: HOOK,
          hook: (argv) =>
            argv.includes("expose") ? run : { _tag: "exited", code: 0, stdout: "", stderr: "" },
        });
        expect(yield* Effect.flip(publish({ visibility: "public" }))).toMatchObject({
          reason: "failed",
          detail: error,
        });
        expect(state.hookArgv.at(-1)).toEqual([...HOOK, "unexpose", "web"]);
        expect(state.hookEnv.at(-1)).toMatchObject({ T3_ENVIRONMENT_ID: ENVIRONMENT_ID });
        expect(state.unserves).toEqual([3000]);
        expect(yield* sites.list).toMatchObject([
          { status: "failed", removedReason: "publish-failed", lastError: error, publicUrl: null },
        ]);
      }),
    ),
  );

  it.effect("a Serve failure ends the record failed without running the hook", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, publish, sites } = yield* harness({
          hookPrefix: HOOK,
          serveError: () => "serve is off",
        });
        expect(yield* Effect.flip(publish({ visibility: "public" }))).toMatchObject({
          detail: "serve is off",
        });
        expect(state.hookArgv).toEqual([]);
        expect(yield* sites.list).toMatchObject([
          { status: "failed", removedReason: "publish-failed", lastError: "serve is off" },
        ]);
      }),
    ),
  );

  it.effect.each<{
    readonly name: string;
    readonly pids: ReadonlyArray<number>;
    readonly accepted: boolean;
  }>([
    { name: "the listener", pids: [PID], accepted: true },
    { name: "the listener's parent", pids: [PID - 1], accepted: true },
    { name: "the listener's child", pids: [PID + 1], accepted: true },
    { name: "an unrelated process", pids: [PID + 7], accepted: false },
    { name: "the listener and an unrelated process", pids: [PID, PID + 7], accepted: false },
  ])("pins $name to the port only when it serves the port", ({ pids, accepted }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, publish } = yield* harness();
        state.table = [
          entry(PID - 1, START),
          entry(PID, START, PID - 1),
          entry(PID + 1, START, PID),
          entry(PID + 7, START),
        ];
        const result = yield* Effect.result(publish({ pids }));
        if (accepted) {
          expect(result).toMatchObject({ _tag: "Success", success: { status: "live" } });
        } else {
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { reason: "invalid", detail: `pid ${PID + 7} is not serving port 3000` },
          });
          expect(state.serves).toEqual([]);
        }
      }),
    ),
  );

  it.effect("keeps a site whose teardown failed and retries it on the next tick", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, publish, dropPids, byId } = yield* harness({ unserveFailures: 1 });
        const site = yield* publish();
        dropPids([PID]);
        yield* tick;
        expect(yield* byId(site.id)).toMatchObject({
          status: "live",
          teardownPending: { reason: "pids-exited" },
          lastError: expect.stringContaining("serve is stuck"),
        });
        expect(state.routes.has(3000)).toBe(true);
        yield* tick;
        expect(yield* byId(site.id)).toMatchObject({
          status: "removed",
          removedReason: "pids-exited",
          lastError: null,
        });
        expect((yield* byId(site.id))?.teardownPending).toBeUndefined();
        expect(state.unserves).toEqual([3000]);
      }),
    ),
  );

  it.effect.each<{
    readonly name: string;
    readonly pids: ReadonlyArray<number>;
    readonly table: (state: {
      tableFails: boolean;
    }) => ReadonlyArray<ResourceMonitorProcessTableEntry>;
    readonly removed: boolean;
  }>([
    { name: "every pinned pid exited", pids: [PID], table: () => [], removed: true },
    {
      name: "the pid was reused by a later process",
      pids: [PID],
      table: () => [entry(PID, START + 5_000)],
      removed: true,
    },
    {
      name: "one of two pids is still running",
      pids: [PID, PID + 1],
      table: () => [entry(PID + 1, START)],
      removed: false,
    },
    {
      name: "the process table is unreadable",
      pids: [PID],
      table: (state) => {
        state.tableFails = true;
        return [];
      },
      removed: false,
    },
  ])("the watcher when $name", ({ pids, table, removed }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, publish, byId } = yield* harness({ hookPrefix: HOOK });
        state.table = [entry(PID, START), entry(PID + 1, START, PID)];
        const site = yield* publish({ visibility: "public", pids });
        state.table = table(state);
        yield* tick;
        if (removed) {
          expect(yield* byId(site.id)).toMatchObject({
            status: "removed",
            removedReason: "pids-exited",
          });
          expect(state.unserves).toEqual([3000]);
          expect(state.hookArgv.at(-1)).toEqual([...HOOK, "unexpose", "web"]);
        } else {
          expect(yield* byId(site.id)).toMatchObject({ status: "live", removedReason: null });
          expect(state.unserves).toEqual([]);
        }
      }),
    ),
  );

  describe("stop", () => {
    it.effect("with a stop command, removes the site once the pids exit within 15 s", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { sites, state, publish, dropPids, byId } = yield* harness();
          const site = yield* publish({ stopCommand: "make down" });
          const stopping = yield* sites.stop({ siteId: site.id }).pipe(Effect.forkChild);
          yield* TestClock.adjust("10 seconds");
          expect(yield* byId(site.id)).toMatchObject({ status: "stopping" });
          dropPids([PID]);
          yield* TestClock.adjust("500 millis");
          expect(yield* Fiber.join(stopping)).toMatchObject({
            status: "removed",
            removedReason: "stop-command",
          });
          expect(state.stopCommands).toEqual([{ command: "make down", cwd: "/repo" }]);
          expect(state.stoppedGroups).toEqual([]);
          expect(state.unserves).toEqual([3000]);
        }),
      ),
    );

    it.effect("with a stop command that leaves the pids running, goes back to live", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { sites, state, publish } = yield* harness();
          const site = yield* publish({ stopCommand: "make down" });
          const stopping = yield* sites.stop({ siteId: site.id }).pipe(Effect.forkChild);
          yield* TestClock.adjust("15 seconds");
          expect(yield* Fiber.join(stopping)).toMatchObject({
            status: "live",
            lastError: ServedSites.STOP_COMMAND_LEFT_PIDS,
          });
          expect(state.unserves).toEqual([]);
        }),
      ),
    );

    it.effect("force signals the process groups even with a stop command", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { sites, state, publish } = yield* harness();
          const site = yield* publish({ stopCommand: "make down" });
          expect(yield* sites.stop({ siteId: site.id, force: true })).toMatchObject({
            status: "removed",
            removedReason: "stopped",
          });
          expect(state.stoppedGroups).toEqual([[PID]]);
          expect(state.stopCommands).toEqual([]);
        }),
      ),
    );
    it.effect("a signal stop refused for a shared group goes back to live with the error", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { sites, state, publish } = yield* harness({
            stopGroupsError: "Its process group also holds the T3 server or an agent.",
          });
          const site = yield* publish();
          expect(yield* sites.stop({ siteId: site.id })).toMatchObject({
            status: "live",
            lastError: "Its process group also holds the T3 server or an agent.",
          });
          expect(state.stoppedGroups).toEqual([[PID]]);
          expect(state.unserves).toEqual([]);
        }),
      ),
    );
  });

  it.effect("reconciles stored sites on start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const id = (name: string) => ServedSiteId.make(`site_${name}`);
        const { state, sites, waitFor } = yield* harness({
          hookPrefix: HOOK,
          stored: [
            storedSite({ id: id("publishing"), status: "publishing", servePort: 3001 }),
            storedSite({
              id: id("dead"),
              visibility: "public",
              servePort: 3002,
              pids: [{ pid: 9999, startTimeMs: START }],
            }),
            storedSite({ id: id("stopping"), status: "stopping", servePort: 3003 }),
            storedSite({ id: id("live"), servePort: 3004 }),
            storedSite({ id: id("taken"), servePort: 3006 }),
            storedSite({ id: id("unserved"), servePort: 3005 }),
            storedSite({
              id: id("removed"),
              status: "removed",
              removedReason: "stopped",
              removedAt: "1970-01-01T00:00:00.000Z",
            }),
          ],
          serveError: (port) => (port === 3005 ? "serve is off" : null),
          routes: [
            [3001, 3000],
            [3002, 3000],
            [3003, 3000],
            [3004, 3000],
            [3006, 4000],
          ],
        });
        const byName = (list: ReadonlyArray<ServedSite>, name: string) =>
          list.find((site) => site.id === id(name));
        yield* waitFor((list) => byName(list, "unserved")?.lastError === "serve is off");
        const list = yield* sites.list;
        expect(byName(list, "publishing")).toMatchObject({
          status: "failed",
          removedReason: "publish-failed",
          lastError: "The T3 server restarted while publishing.",
        });
        expect(byName(list, "dead")).toMatchObject({
          status: "removed",
          removedReason: "pids-exited",
        });
        expect(byName(list, "stopping")).toMatchObject({ status: "live" });
        expect(byName(list, "live")).toMatchObject({ status: "live", lastError: null });
        expect(byName(list, "removed")).toMatchObject({ status: "removed" });
        expect(byName(list, "taken")).toMatchObject({
          status: "failed",
          lastError: ServedSites.ROUTE_TAKEN(3006),
        });
        expect(state.routes.get(3006)).toBe(4000);
        expect(state.unserves.toSorted()).toEqual([3001, 3002]);
        expect(state.hookArgv).toEqual([[...HOOK, "unexpose", "site-dead"]]);
        expect(state.serves.map((each) => each.servePort)).toEqual([3003, 3004, 3005]);
      }),
    ),
  );

  it.effect("deletes a removed site an hour after it was removed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sites, state, publish } = yield* harness();
        yield* Effect.flip(publish({ visibility: "public" }));
        const [failed] = yield* sites.list;
        yield* TestClock.adjust("1 hour");
        expect(yield* sites.list).toHaveLength(1);
        yield* tick;
        expect(yield* sites.list).toEqual([]);
        expect(state.rows.has(failed!.id)).toBe(false);
      }),
    ),
  );

  it.effect("dismisses an ended site now and refuses an active one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sites, state, publish } = yield* harness();
        yield* Effect.flip(publish({ visibility: "public" }));
        const [failed] = yield* sites.list;
        const live = yield* publish({ name: "live" });
        yield* sites.dismiss({ siteId: failed!.id });
        expect(state.rows.has(failed!.id)).toBe(false);
        expect(yield* Effect.flip(sites.dismiss({ siteId: live.id }))).toMatchObject({
          reason: "invalid",
        });
        expect((yield* sites.list).map((site) => site.id)).toEqual([live.id]);
      }),
    ),
  );
});
