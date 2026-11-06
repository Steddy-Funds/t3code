import { EnvironmentId, type MachineStatusSnapshot, type ServerConfig } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { BearerConnectionTarget, type SupervisorConnectionState } from "../connection/model.ts";
import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import {
  createMachineIndicatorAtoms,
  MACHINE_STATUS_STALE_MS,
  resolveMachineIndicator,
} from "./machineIndicator.ts";

const OK: MachineStatusSnapshot = {
  sequence: 1,
  verdict: "ok",
  verdictAgeMs: 0,
  reason: null,
  sampleAgeMs: 0,
  totals: null,
};
const REASON = { rule: "load", value: 20, threshold: 12.5, heldForMs: 60_000 } as const;
const STRESSED: MachineStatusSnapshot = {
  ...OK,
  sequence: 2,
  verdict: "stressed",
  reason: REASON,
};

const NOW = 1_000_000;

describe("resolveMachineIndicator", () => {
  const fresh = (snapshot: MachineStatusSnapshot) =>
    AsyncResult.success(snapshot, { timestamp: NOW });
  const failure = (previous: MachineStatusSnapshot | null) =>
    AsyncResult.failure<MachineStatusSnapshot, unknown>(Cause.fail("lost"), {
      previousSuccess:
        previous === null ? Option.none() : Option.some(AsyncResult.success(previous)),
    });
  const plain = { show: false, verdict: "ok", unreachable: false, lastSeen: null, reason: null };
  const pending = {
    show: true,
    verdict: "unknown",
    unreachable: false,
    lastSeen: null,
    reason: null,
  };

  it.each<{
    label: string;
    capable?: boolean;
    result: AsyncResult.AsyncResult<MachineStatusSnapshot, unknown>;
    connection?: EnvironmentConnectionPhase;
    receivedAt?: number;
    expected: object;
  }>([
    { label: "not capable", capable: false, result: fresh(STRESSED), expected: plain },
    { label: "unsupported", result: fresh(STRESSED), connection: "unsupported", expected: plain },
    { label: "initial, connected", result: AsyncResult.initial(), expected: pending },
    {
      label: "initial, connecting",
      result: AsyncResult.initial(),
      connection: "connecting",
      expected: pending,
    },
    {
      label: "initial, offline",
      result: AsyncResult.initial(),
      connection: "offline",
      expected: { ...pending, unreachable: true, lastSeen: null },
    },
    {
      label: "fresh ok",
      result: fresh(OK),
      expected: { show: true, verdict: "ok", unreachable: false, lastSeen: null, reason: null },
    },
    {
      label: "fresh stressed",
      result: fresh(STRESSED),
      expected: { show: true, verdict: "stressed", unreachable: false, reason: REASON },
    },
    {
      label: "fresh stressed with no reason",
      result: fresh({ ...STRESSED, reason: null }),
      expected: { verdict: "stressed", reason: null },
    },
    {
      label: "just under 75 s",
      result: fresh(OK),
      receivedAt: NOW - MACHINE_STATUS_STALE_MS + 1,
      expected: { verdict: "ok", unreachable: false },
    },
    {
      label: "exactly 75 s",
      result: fresh(STRESSED),
      receivedAt: NOW - MACHINE_STATUS_STALE_MS,
      expected: {
        ...pending,
        unreachable: true,
        lastSeen: { verdict: "stressed", ageMs: MACHINE_STATUS_STALE_MS },
      },
    },
    {
      label: "disconnected with a fresh ok",
      result: fresh(OK),
      connection: "reconnecting",
      expected: { ...pending, unreachable: true, lastSeen: { verdict: "ok", ageMs: 0 } },
    },
    {
      label: "offline with a fresh ok",
      result: fresh(OK),
      connection: "offline",
      expected: { verdict: "unknown", unreachable: true },
    },
    {
      label: "failure keeps the previous value",
      result: failure(STRESSED),
      expected: { verdict: "stressed", unreachable: false, reason: REASON },
    },
    { label: "failure with nothing before", result: failure(null), expected: pending },
  ])(
    "$label",
    ({ capable = true, result, connection = "connected", receivedAt = NOW, expected }) => {
      expect(
        resolveMachineIndicator({ capable, result, receivedAt, connection, now: NOW }),
      ).toMatchObject(expected);
    },
  );
});

const ENVIRONMENT = EnvironmentId.make("machine-1");
const OTHER = EnvironmentId.make("machine-2");

function entry(environmentId: EnvironmentId, enabled = true): ConnectionCatalogEntry {
  return {
    target: new BearerConnectionTarget({
      environmentId,
      label: environmentId,
      connectionId: `${environmentId}-connection`,
    }),
    profile: Option.none(),
    enabled,
  };
}

function connectionState(phase: SupervisorConnectionState["phase"]): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase,
    stage: null,
    attempt: 1,
    generation: 0,
    lastFailure: null,
    retryAt: null,
  };
}

function capableConfig(machineResources: boolean): ServerConfig {
  // Only this capability is read.
  return { environment: { capabilities: { machineResources } } } as unknown as ServerConfig;
}

// The registry defers atom removal; the test runs those tasks itself to observe unmounts.
function setup() {
  const tasks: Array<() => void> = [];
  const flush = () => {
    while (tasks.length > 0) tasks.shift()!();
  };
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => undefined;
    },
  });
  const mounted = new Set<EnvironmentId>();
  const status = Atom.family((_id: EnvironmentId) =>
    Atom.make<AsyncResult.AsyncResult<MachineStatusSnapshot, unknown>>(AsyncResult.initial()).pipe(
      Atom.keepAlive,
    ),
  );
  const machine = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      mounted.add(environmentId);
      get.addFinalizer(() => mounted.delete(environmentId));
      return get(status(environmentId));
    }),
  );
  const catalog = Atom.make<EnvironmentCatalogState>({
    isReady: true,
    entries: new Map([
      [ENVIRONMENT, entry(ENVIRONMENT)],
      [OTHER, entry(OTHER)],
    ]),
  }).pipe(Atom.keepAlive);
  const connection = Atom.family((_id: EnvironmentId) =>
    Atom.make<AsyncResult.AsyncResult<SupervisorConnectionState, unknown>>(
      AsyncResult.success(connectionState("connected")),
    ).pipe(Atom.keepAlive),
  );
  const config = Atom.family((_id: EnvironmentId) =>
    Atom.make<ServerConfig | null>(capableConfig(true)).pipe(Atom.keepAlive),
  );
  const atoms = createMachineIndicatorAtoms({
    machine: (environmentId) => machine(environmentId),
    catalogValueAtom: catalog,
    connectionStateAtom: connection,
    configValueAtom: config,
  });
  const set = <A>(atom: Atom.Writable<A>, value: A) => {
    registry.set(atom, value);
    flush();
  };
  return {
    registry,
    atoms,
    catalog,
    mounted,
    flush,
    setStatus: (environmentId: EnvironmentId, snapshot: MachineStatusSnapshot) =>
      set(status(environmentId), AsyncResult.success(snapshot)),
    setPhase: (environmentId: EnvironmentId, phase: SupervisorConnectionState["phase"]) =>
      set(connection(environmentId), AsyncResult.success(connectionState(phase))),
    setCapable: (environmentId: EnvironmentId, capable: boolean) =>
      set(config(environmentId), capableConfig(capable)),
    setEnabled: (environmentId: EnvironmentId, enabled: boolean) =>
      set(catalog, {
        isReady: true,
        entries: new Map([
          ...registry.get(catalog).entries,
          [environmentId, entry(environmentId, enabled)],
        ]),
      }),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

describe("machineIndicatorAtom", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flips to unreachable when the verdict reaches 75 s old, from one pending timer", () => {
    vi.useFakeTimers({ now: 0 });
    using app = setup();
    app.setStatus(ENVIRONMENT, OK);
    const listener = vi.fn();
    const unsubscribe = app.registry.subscribe(
      app.atoms.machineIndicatorAtom(ENVIRONMENT),
      listener,
      { immediate: true },
    );
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ verdict: "ok" }));
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(MACHINE_STATUS_STALE_MS - 1);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        verdict: "unknown",
        unreachable: true,
        lastSeen: { verdict: "ok", ageMs: MACHINE_STATUS_STALE_MS + 1 },
      }),
    );
    expect(vi.getTimerCount()).toBe(1);
    unsubscribe();
    app.flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not notify for a heartbeat with the same verdict, and re-arms the expiry from it", () => {
    vi.useFakeTimers({ now: 0 });
    using app = setup();
    app.setStatus(ENVIRONMENT, STRESSED);
    const listener = vi.fn();
    const unsubscribe = app.registry.subscribe(
      app.atoms.machineIndicatorAtom(ENVIRONMENT),
      listener,
    );
    expect(app.registry.get(app.atoms.machineIndicatorAtom(ENVIRONMENT)).verdict).toBe("stressed");

    vi.advanceTimersByTime(30_000);
    app.setStatus(ENVIRONMENT, { ...STRESSED, verdictAgeMs: 30_000, sampleAgeMs: 0 });
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    // Stale only 75 s after the heartbeat, not after the first snapshot.
    vi.advanceTimersByTime(MACHINE_STATUS_STALE_MS - 30_000 + 1);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        unreachable: true,
        lastSeen: expect.objectContaining({ verdict: "stressed" }),
      }),
    );
    unsubscribe();
  });

  it("remembers the last verdict after the connection drops", () => {
    vi.useFakeTimers({ now: 0 });
    using app = setup();
    app.setStatus(ENVIRONMENT, OK);
    const unsubscribe = app.registry.subscribe(
      app.atoms.machineIndicatorAtom(ENVIRONMENT),
      () => {},
    );
    vi.advanceTimersByTime(5_000);
    app.setPhase(ENVIRONMENT, "offline");
    expect(app.registry.get(app.atoms.machineIndicatorAtom(ENVIRONMENT))).toMatchObject({
      verdict: "unknown",
      unreachable: true,
      lastSeen: { verdict: "ok", ageMs: 5_000 },
    });
    // Offline, the indicator holds no subscription to the machine stream.
    expect(app.mounted.has(ENVIRONMENT)).toBe(false);
    unsubscribe();
  });

  it("is plain for a machine without the capability", () => {
    using app = setup();
    app.setCapable(ENVIRONMENT, false);
    expect(app.registry.get(app.atoms.machineIndicatorAtom(ENVIRONMENT)).show).toBe(false);
    expect(app.registry.get(app.atoms.machineCapableAtom(ENVIRONMENT))).toBe(false);
  });

  it("is plain for a capable machine whose saved connection is unsupported", () => {
    using app = setup();
    app.setStatus(OTHER, STRESSED);
    app.registry.set(app.catalog, {
      isReady: true,
      entries: new Map([
        ...app.registry.get(app.catalog).entries,
        [OTHER, { ...entry(OTHER), unsupportedReason: "Server too old" }],
      ]),
    });
    expect(app.registry.get(app.atoms.machineIndicatorAtom(OTHER)).show).toBe(false);
    expect(app.registry.get(app.atoms.machineCapableAtom(OTHER))).toBe(false);
  });
});

describe("startMachineStatus", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mounts the stream for each enabled, capable, connected machine and follows changes", () => {
    using app = setup();
    app.setPhase(OTHER, "connecting");
    const stop = app.atoms.startMachineStatus(app.registry);
    expect([...app.mounted]).toEqual([ENVIRONMENT]);

    app.setPhase(OTHER, "connected");
    expect([...app.mounted].toSorted()).toEqual([ENVIRONMENT, OTHER]);

    app.setPhase(ENVIRONMENT, "backoff");
    expect([...app.mounted]).toEqual([OTHER]);
    app.setPhase(ENVIRONMENT, "connected");
    expect(app.mounted.has(ENVIRONMENT)).toBe(true);

    app.setCapable(ENVIRONMENT, false);
    expect([...app.mounted]).toEqual([OTHER]);
    app.setCapable(ENVIRONMENT, true);
    expect(app.mounted.has(ENVIRONMENT)).toBe(true);

    app.setEnabled(OTHER, false);
    expect([...app.mounted]).toEqual([ENVIRONMENT]);

    stop();
    app.flush();
    expect(app.mounted.size).toBe(0);
  });

  it("forgets a removed machine's last verdict, so re-adding it under the same id shows no last seen", () => {
    vi.useFakeTimers({ now: 0 });
    using app = setup();
    const stop = app.atoms.startMachineStatus(app.registry);
    const indicator = (environmentId: EnvironmentId) => {
      const value = app.registry.get(app.atoms.machineIndicatorAtom(environmentId));
      app.flush();
      return value;
    };
    const setEntries = (environmentIds: ReadonlyArray<EnvironmentId>) =>
      app.registry.set(app.catalog, {
        isReady: true,
        entries: new Map(
          environmentIds.map((environmentId) => [environmentId, entry(environmentId)]),
        ),
      });
    app.setStatus(ENVIRONMENT, STRESSED);
    app.setStatus(OTHER, STRESSED);
    expect(indicator(ENVIRONMENT).verdict).toBe("stressed");
    expect(indicator(OTHER).verdict).toBe("stressed");
    app.setPhase(ENVIRONMENT, "offline");
    app.setPhase(OTHER, "offline");

    // Control: removing another machine keeps this one's last verdict.
    setEntries([ENVIRONMENT]);
    app.flush();
    expect(indicator(ENVIRONMENT).lastSeen).toEqual({ verdict: "stressed", ageMs: 0 });

    setEntries([]);
    app.flush();
    setEntries([ENVIRONMENT]);
    app.flush();
    expect(indicator(ENVIRONMENT)).toMatchObject({
      verdict: "unknown",
      unreachable: true,
      lastSeen: null,
    });
    stop();
  });
});
