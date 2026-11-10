import {
  type ServedSite,
  ServedSiteError,
  ServedSiteId,
  type ServedSiteDismissInput,
  type ServedSiteProcess,
  type ServedSiteRemovedReason,
  type ServedSitesSnapshot,
  type ServedSiteStopInput,
  type ServedSiteVisibility,
  type ThreadId,
} from "@t3tools/contracts";
import { buildTailscaleHttpsBaseUrl } from "@t3tools/tailscale";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import * as ServedSitesRepository from "../persistence/ServedSites.ts";
import { tableLiveness } from "../resourceTelemetry/ProcessOwnership.ts";
import * as Settings from "../serverSettings.ts";
import {
  chooseServePort,
  dedupeSiteName,
  interpretExpose,
  isActive,
  slugSiteName,
} from "./rules.ts";
import * as Host from "./ServedSitesHost.ts";

const WATCH_INTERVAL = Duration.seconds(2);
const REMOVED_TTL_MS = 60 * 60 * 1000;
const EXPOSE_TIMEOUT = Duration.seconds(120);
const UNEXPOSE_TIMEOUT = Duration.seconds(60);
const STOP_COMMAND_TIMEOUT = Duration.seconds(60);
const STOP_EXIT_WAIT_MS = 15_000;
const STOP_EXIT_POLL = Duration.millis(500);

export const PUBLIC_NOT_CONFIGURED =
  "public URLs are not configured on this server (servedSites.publicExposeCommand)";
const withoutAwaitingExit = ({ awaitingExit: _awaitingExit, ...site }: ServedSite) => site;

export const STOP_COMMAND_LEFT_PIDS =
  "Stop command ran, but the server is still running. Force stop kills it.";

export interface PublishInput {
  readonly threadId: ThreadId;
  readonly projectCwd: string;
  readonly port: number;
  readonly pids?: ReadonlyArray<number> | undefined;
  readonly name?: string | undefined;
  readonly visibility: ServedSiteVisibility;
  readonly stopCommand?: string | undefined;
}

export class ServedSites extends Context.Service<
  ServedSites,
  {
    /** Publishes a listening local port on the tailnet, and publicly through the hook. */
    readonly publish: (input: PublishInput) => Effect.Effect<ServedSite, ServedSiteError>;
    readonly list: Effect.Effect<ReadonlyArray<ServedSite>>;
    /** The current list, then the list after every change. */
    readonly changes: Stream.Stream<ServedSitesSnapshot>;
    readonly stop: (input: ServedSiteStopInput) => Effect.Effect<ServedSite, ServedSiteError>;
    readonly dismiss: (input: ServedSiteDismissInput) => Effect.Effect<void, ServedSiteError>;
  }
>()("t3/servedSites/ServedSites") {}

const invalid = (detail: string) => new ServedSiteError({ reason: "invalid", detail });
const notFound = (siteId: string) =>
  new ServedSiteError({ reason: "not-found", detail: `No site ${siteId}.` });

export const make = Effect.gen(function* () {
  const repository = yield* ServedSitesRepository.ServedSitesRepository;
  const tailscale = yield* Host.SiteTailscale;
  const hook = yield* Host.SiteHookRunner;
  const processes = yield* Host.SiteProcesses;
  const settings = yield* Settings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const random = yield* SecureRandom.SecureRandom;
  const scope = yield* Effect.scope;

  const sites = yield* SubscriptionRef.make<ReadonlyArray<ServedSite>>([]);
  // Reconcile replaces the in-memory list with the stored rows; changes wait so none is lost.
  const reconciled = yield* Deferred.make<void>();
  const lock = yield* Semaphore.make(1);
  /** How a site in `stopping` is removed once its processes exit. */
  const stopKinds = new Map<ServedSiteId, ServedSiteRemovedReason>();
  const tearingDown = new Set<ServedSiteId>();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const find = (siteId: ServedSiteId) =>
    SubscriptionRef.get(sites).pipe(Effect.map((list) => list.find((site) => site.id === siteId)));

  // Memory is authoritative while the server runs; a failed write only loses the record on restart.
  const saveUnlocked = (site: ServedSite) =>
    repository.upsert(site).pipe(
      Effect.catch((error) => Effect.logWarning("served site was not saved", error)),
      Effect.andThen(
        SubscriptionRef.update(sites, (list) =>
          list.some((each) => each.id === site.id)
            ? list.map((each) => (each.id === site.id ? site : each))
            : [...list, site],
        ),
      ),
      Effect.as(site),
    );

  const update = (siteId: ServedSiteId, change: (site: ServedSite) => ServedSite) =>
    lock.withPermits(1)(
      find(siteId).pipe(
        Effect.flatMap((site) =>
          site === undefined ? Effect.undefined : saveUnlocked(change(site)),
        ),
      ),
    );

  const removeRecord = (siteId: ServedSiteId) =>
    repository.remove(siteId).pipe(
      Effect.catch((error) => Effect.logWarning("served site was not deleted", error)),
      Effect.andThen(
        SubscriptionRef.update(sites, (list) => list.filter((site) => site.id !== siteId)),
      ),
    );

  const hookPrefix = settings.getSettings.pipe(
    Effect.map((current) => current.servedSites.publicExposeCommand),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  const hookEnv = (site: ServedSite) => ({
    T3_SITE_THREAD_ID: site.threadId,
    T3_SITE_PROJECT_CWD: site.projectCwd,
  });

  const unexpose = Effect.fn("ServedSites.unexpose")(function* (site: ServedSite) {
    const prefix = yield* hookPrefix;
    if (prefix.length === 0) return;
    const run = yield* hook.run({
      argv: [...prefix, "unexpose", site.name],
      env: hookEnv(site),
      cwd: config.baseDir,
      timeout: UNEXPOSE_TIMEOUT,
    });
    if (run._tag !== "exited" || run.code !== 0) {
      yield* Effect.logWarning("served site unexpose failed", { site: site.name, run });
    }
  });

  /** Takes the routes down and marks the record; each site tears down once. */
  const teardown = Effect.fn("ServedSites.teardown")(function* (
    site: ServedSite,
    reason: ServedSiteRemovedReason,
    options: { readonly lastError?: string; readonly exposed?: boolean } = {},
  ) {
    if (tearingDown.has(site.id)) return;
    tearingDown.add(site.id);
    yield* Effect.gen(function* () {
      if (site.servePort !== null) {
        yield* tailscale
          .unserve(site.servePort)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("served site tailscale serve off failed", error),
            ),
          );
      }
      if (options.exposed ?? site.visibility === "public") yield* unexpose(site);
      const removedAt = yield* nowIso;
      yield* update(site.id, (current) => ({
        ...withoutAwaitingExit(current),
        status: reason === "publish-failed" ? "failed" : "removed",
        removedReason: reason,
        removedAt,
        lastError: options.lastError ?? current.lastError,
      }));
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          tearingDown.delete(site.id);
          stopKinds.delete(site.id);
        }),
      ),
    );
  });

  const removedReasonFor = (site: ServedSite): ServedSiteRemovedReason =>
    site.status === "stopping" ? (stopKinds.get(site.id) ?? "stopped") : "pids-exited";

  /** The watcher path: removes every live or stopping site whose pinned processes all exited. */
  const removeExited = Effect.fn("ServedSites.removeExited")(function* () {
    const watched = (yield* SubscriptionRef.get(sites)).filter(
      (site) => site.status === "live" || site.status === "stopping",
    );
    if (watched.length === 0) return;
    // An unreadable table never reads as every process having exited.
    const table = yield* processes.table.pipe(Effect.option);
    if (Option.isNone(table)) return;
    const isAlive = tableLiveness(table.value);
    const exited = watched.filter(
      (site) => !site.pids.some((pinned) => isAlive(pinned.pid, pinned.startTimeMs)),
    );
    yield* Effect.forEach(exited, (site) => teardown(site, removedReasonFor(site)), {
      discard: true,
    });
  });

  const expireRemoved = Effect.fn("ServedSites.expireRemoved")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const expired = (yield* SubscriptionRef.get(sites)).filter(
      (site) =>
        !isActive(site) &&
        site.removedAt !== null &&
        now - Date.parse(site.removedAt) > REMOVED_TTL_MS,
    );
    yield* Effect.forEach(expired, (site) => removeRecord(site.id), { discard: true });
  });

  // Publish and stop outlive the request that started them, so a dropped client or a cancelled
  // tool call never leaves a site half-published or stuck stopping.
  const detached = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.forkIn(effect, scope).pipe(Effect.flatMap(Fiber.join));

  const publishNow = Effect.fn("ServedSites.publish")(function* (input: PublishInput) {
    const prefix = yield* hookPrefix;
    if (!(yield* processes.isListening(input.port))) {
      return yield* invalid(
        `Nothing is listening on 127.0.0.1:${input.port}. Start the server first, bound to localhost or all interfaces.`,
      );
    }
    const owner =
      input.pids === undefined || input.pids.length === 0
        ? yield* processes.portOwner(input.port)
        : null;
    const pids = owner === null ? (input.pids ?? []) : [owner.pid];
    if (pids.length === 0) {
      return yield* invalid(
        `Could not tell which process listens on port ${input.port}. Pass its \`pids\`.`,
      );
    }
    const startTimes = new Map(
      (yield* processes.table).map((entry) => [entry.pid, entry.startTimeMs]),
    );
    const pinned: Array<ServedSiteProcess> = [];
    for (const pid of new Set(pids)) {
      const startTimeMs = startTimes.get(pid);
      if (startTimeMs === undefined) return yield* invalid(`Process ${pid} is not running.`);
      pinned.push({ pid, startTimeMs });
    }
    const id = ServedSiteId.make(`site_${yield* random.uuidV4()}`);
    const createdAt = yield* nowIso;
    const siteName = (active: ReadonlyArray<ServedSite>) =>
      dedupeSiteName(
        slugSiteName(input.name ?? owner?.processName ?? `site-${input.port}`),
        new Set(active.map((each) => each.name)),
      );
    const draft = {
      id,
      threadId: input.threadId,
      projectCwd: input.projectCwd,
      localPort: input.port,
      pids: pinned,
      visibility: input.visibility,
      publicUrl: null,
      stopCommand: input.stopCommand ?? null,
      createdAt,
    };

    // Recorded so the thread shows the request and why public URLs are off.
    if (input.visibility === "public" && prefix.length === 0) {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          return yield* saveUnlocked({
            ...draft,
            name: siteName((yield* SubscriptionRef.get(sites)).filter(isActive)),
            tailnetUrl: null,
            servePort: null,
            status: "failed",
            removedReason: "publish-failed",
            lastError: PUBLIC_NOT_CONFIGURED,
            removedAt: createdAt,
          });
        }),
      );
      return yield* invalid(PUBLIC_NOT_CONFIGURED);
    }

    const magicDnsName = yield* tailscale.magicDnsName;
    const routePorts = yield* tailscale.servePorts;

    const site = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const active = (yield* SubscriptionRef.get(sites)).filter(isActive);
        const servePort = chooseServePort(
          input.port,
          new Set([...routePorts, ...active.flatMap((each) => each.servePort ?? [])]),
        );
        if (servePort === null) return yield* invalid("No free Tailscale Serve port is left.");
        return yield* saveUnlocked({
          ...draft,
          name: siteName(active),
          tailnetUrl: buildTailscaleHttpsBaseUrl({ magicDnsName, servePort }).replace(/\/$/, ""),
          servePort,
          status: "publishing",
          removedReason: null,
          lastError: null,
          removedAt: null,
        });
      }),
    );

    const servePort = site.servePort!;
    const served = yield* tailscale
      .serve({ servePort, localPort: site.localPort })
      .pipe(Effect.result);
    if (served._tag === "Failure") {
      yield* teardown(site, "publish-failed", {
        lastError: served.failure.detail,
        exposed: false,
      });
      return yield* served.failure;
    }

    let publicUrl: string | null = null;
    if (site.visibility === "public") {
      const outcome = interpretExpose(
        yield* hook.run({
          argv: [...prefix, "expose", site.name, `http://127.0.0.1:${site.localPort}`],
          env: hookEnv(site),
          cwd: config.baseDir,
          timeout: EXPOSE_TIMEOUT,
        }),
      );
      if (outcome._tag !== "exposed") {
        yield* teardown(site, "publish-failed", { lastError: outcome.error, exposed: true });
        return yield* new ServedSiteError({ reason: "failed", detail: outcome.error });
      }
      publicUrl = outcome.url;
    }

    const live = yield* update(site.id, (current) => ({ ...current, status: "live", publicUrl }));
    return live ?? site;
  });

  const backToLive = (siteId: ServedSiteId, lastError: string) =>
    Effect.sync(() => stopKinds.delete(siteId)).pipe(
      Effect.andThen(
        update(siteId, (current) =>
          current.status === "stopping"
            ? { ...withoutAwaitingExit(current), status: "live", lastError }
            : current,
        ),
      ),
    );

  const alivePids = (site: ServedSite) =>
    processes.table.pipe(
      Effect.map((table) => {
        const isAlive = tableLiveness(table);
        return site.pids.filter((pinned) => isAlive(pinned.pid, pinned.startTimeMs));
      }),
    );

  const signalStop = Effect.fn("ServedSites.signalStop")(function* (site: ServedSite) {
    const alive = yield* alivePids(site);
    yield* processes.stopProcessGroups(alive.map((pinned) => pinned.pid));
    yield* removeExited();
    if ((yield* alivePids(site)).length > 0) {
      yield* backToLive(site.id, "The server is still running after the stop signal.");
    }
  });

  const commandStop = Effect.fn("ServedSites.commandStop")(function* (
    site: ServedSite,
    command: string,
  ) {
    const result = yield* processes.runStopCommand({
      command,
      cwd: site.projectCwd,
      timeout: STOP_COMMAND_TIMEOUT,
    });
    yield* update(site.id, (current) =>
      current.status === "stopping" ? { ...current, awaitingExit: true } : current,
    );
    const deadline = (yield* Clock.currentTimeMillis) + STOP_EXIT_WAIT_MS;
    while ((yield* alivePids(site)).length > 0) {
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* backToLive(
          site.id,
          result.timedOut
            ? "Stop command timed out, and the server is still running. Force stop kills it."
            : STOP_COMMAND_LEFT_PIDS,
        );
      }
      yield* Effect.sleep(STOP_EXIT_POLL);
    }
    yield* removeExited();
  });

  const stopNow = Effect.fn("ServedSites.stop")(function* (input: ServedSiteStopInput) {
    const site = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* find(input.siteId);
        if (current === undefined) return yield* notFound(input.siteId);
        if (current.status !== "live" && !(current.status === "stopping" && input.force === true)) {
          return yield* invalid(`Site ${current.name} is ${current.status}.`);
        }
        return yield* saveUnlocked({ ...current, status: "stopping", lastError: null });
      }),
    );
    const command = input.force === true ? null : site.stopCommand;
    stopKinds.set(site.id, command === null ? "stopped" : "stop-command");
    const stopped = yield* (command === null ? signalStop(site) : commandStop(site, command)).pipe(
      Effect.result,
    );
    if (stopped._tag === "Failure") yield* backToLive(site.id, stopped.failure.detail);
    return (yield* find(site.id)) ?? site;
  });

  const dismiss: ServedSites["Service"]["dismiss"] = Effect.fn("ServedSites.dismiss")(
    function* (input) {
      yield* Deferred.await(reconciled);
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const site = yield* find(input.siteId);
          if (site === undefined) return yield* notFound(input.siteId);
          if (isActive(site)) return yield* invalid("Stop the site before dismissing it.");
          yield* removeRecord(site.id);
        }),
      );
    },
  );

  /** On start: drop records whose processes exited while the server was down, re-serve the rest. */
  const reconcile = Effect.fn("ServedSites.reconcile")(function* () {
    const stored = yield* repository.list.pipe(
      Effect.catch((error) =>
        Effect.logWarning("served sites could not be read", error).pipe(Effect.as([])),
      ),
    );
    yield* SubscriptionRef.set(sites, stored);
    const table = yield* processes.table.pipe(Effect.option);
    const isAlive = Option.map(table, tableLiveness);
    yield* Effect.forEach(
      stored.filter(isActive),
      Effect.fnUntraced(function* (site) {
        if (site.status === "publishing") {
          return yield* teardown(site, "publish-failed", {
            lastError: "The T3 server restarted while publishing.",
          });
        }
        const exited = Option.match(isAlive, {
          onNone: () => false,
          onSome: (alive) => !site.pids.some((pinned) => alive(pinned.pid, pinned.startTimeMs)),
        });
        if (exited) return yield* teardown(site, removedReasonFor(site));
        // A stop the restart interrupted ends with the site still up.
        if (site.status === "stopping") {
          yield* update(site.id, (current) => ({ ...current, status: "live" }));
        }
        if (site.servePort === null) return;
        yield* tailscale
          .serve({ servePort: site.servePort, localPort: site.localPort })
          .pipe(
            Effect.catch((error) =>
              update(site.id, (current) => ({ ...current, lastError: error.detail })),
            ),
          );
      }),
      { discard: true },
    );
  });

  yield* reconcile().pipe(
    Effect.ensuring(Deferred.succeed(reconciled, undefined)),
    Effect.andThen(
      Effect.all([removeExited(), expireRemoved()]).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("served sites check failed", Cause.pretty(cause)),
        ),
        Effect.repeat(Schedule.spaced(WATCH_INTERVAL)),
      ),
    ),
    Effect.forkScoped,
  );

  return ServedSites.of({
    publish: Effect.fn("ServedSites.publishDetached")((input) =>
      Deferred.await(reconciled).pipe(Effect.andThen(detached(publishNow(input)))),
    ),
    list: SubscriptionRef.get(sites),
    changes: SubscriptionRef.changes(sites).pipe(Stream.map((list) => ({ sites: list }))),
    stop: Effect.fn("ServedSites.stopDetached")((input) =>
      Deferred.await(reconciled).pipe(Effect.andThen(detached(stopNow(input)))),
    ),
    dismiss,
  });
});

export const layerWith = Layer.effect(ServedSites, make);

export const layer = layerWith.pipe(
  Layer.provide(ServedSitesRepository.layer),
  Layer.provide(Layer.mergeAll(Host.layerTailscale, Host.layerHookRunner, Host.layerProcesses)),
);
