import type { MachineIndicator } from "@t3tools/client-runtime/state/machineIndicator";
import { EnvironmentId, type MachineVerdictReason } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { stubGlobal } from "../../test/render";
import { appAtomRegistry } from "../rpc/atomRegistry";

const state = vi.hoisted(() => ({
  mode: "notifications",
  inApp: false,
  notifyOnMachineStressed: true,
  toast: vi.fn(),
  settingsListeners: new Set<() => void>(),
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast as never } };
});
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  subscribeClientSettings: ((listener: () => void) => {
    state.settingsListeners.add(listener);
    return () => state.settingsListeners.delete(listener);
  }) as never,
  getClientSettings: (() => ({
    notificationMode: state.mode,
    inAppNotificationsEnabled: state.inApp,
    notifyOnMachineStressed: state.notifyOnMachineStressed,
  })) as never,
}));
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      // Read lazily: the factory runs before this module's own bindings exist.
      get environmentIdsAtom() {
        return environmentIdsAtom as never;
      },
      get identitiesAtom() {
        return identitiesAtom as never;
      },
    },
  };
});
// The real module opens connection runtimes; the coordinator only reads the indicator atom.
vi.mock(import("../state/machineResources"), () => ({
  machineResources: {} as never,
  machineIndicator: {
    get machineIndicatorAtom() {
      return indicatorAtom as never;
    },
  } as never,
}));

import { startMachineStressNotifications } from "./MachineStressNotificationCoordinator";

const ONE = EnvironmentId.make("one");
const environmentIdsAtom = Atom.make<ReadonlyArray<EnvironmentId>>([]).pipe(Atom.keepAlive);
const identitiesAtom = Atom.make([{ environmentId: ONE, label: "Studio" }]).pipe(Atom.keepAlive);
const indicatorAtom = Atom.family((_id: EnvironmentId) =>
  Atom.make<MachineIndicator>(indicator("unknown")).pipe(Atom.keepAlive),
);

const REASON: MachineVerdictReason = {
  rule: "load",
  value: 20,
  threshold: 12.5,
  heldForMs: 60_000,
};

function indicator(
  verdict: MachineIndicator["verdict"],
  overrides: Partial<MachineIndicator> = {},
): MachineIndicator {
  return {
    show: true,
    verdict,
    unreachable: false,
    lastSeen: null,
    reason: verdict === "stressed" ? REASON : null,
    ...overrides,
  };
}

class TestNotification extends EventTarget {
  static permission = "granted";
  static sent: TestNotification[] = [];
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    TestNotification.sent.push(this);
  }
}

let focused = false;

// The mocked modules read `state` and the focus flag, so every test resets them before starting.
function setup() {
  vi.clearAllMocks();
  const stack = new DisposableStack();
  state.mode = "notifications";
  state.inApp = false;
  state.notifyOnMachineStressed = true;
  state.settingsListeners.clear();
  focused = false;
  TestNotification.sent = [];
  appAtomRegistry.set(indicatorAtom(ONE), indicator("unknown"));
  appAtomRegistry.set(environmentIdsAtom, [ONE]);
  stack.use(stubGlobal("Notification", TestNotification));
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => focused));
  stack.use(vi.spyOn(document, "visibilityState", "get").mockImplementation(() => "visible"));
  return {
    start: () => {
      stack.defer(startMachineStressNotifications());
    },
    show: (...steps: ReadonlyArray<MachineIndicator>) => {
      for (const step of steps) appAtomRegistry.set(indicatorAtom(ONE), step);
    },
    changeSettings: () => {
      for (const listener of state.settingsListeners) listener();
    },
    [Symbol.dispose]: () => stack.dispose(),
  };
}

it("takes the first verdict as the baseline without notifying", () => {
  using app = setup();
  app.show(indicator("stressed"));
  app.start();
  app.show(indicator("stressed", { reason: { ...REASON, heldForMs: 90_000 } }));
  expect(TestNotification.sent).toEqual([]);
});

it("sends one silent notification per machine when ok turns stressed", () => {
  using app = setup();
  app.start();
  app.show(indicator("ok"), indicator("stressed"));
  expect(TestNotification.sent).toHaveLength(1);
  expect(TestNotification.sent[0]).toMatchObject({
    title: "Studio is stressed",
    options: {
      body: "Load 20.0 / 12.5 per core for 1 m",
      tag: "machine-stress:one",
      silent: true,
    },
  });
  // The same episode, still stressed with a longer hold: no second notification.
  app.show(indicator("stressed", { reason: { ...REASON, heldForMs: 120_000 } }));
  expect(TestNotification.sent).toHaveLength(1);
  expect(state.toast).not.toHaveBeenCalled();
});

it.each([
  { label: "unknown", between: indicator("unknown") },
  {
    label: "unreachable",
    between: indicator("unknown", {
      unreachable: true,
      lastSeen: { verdict: "ok", ageMs: 80_000 },
    }),
  },
])("keeps ok as the baseline through $label", ({ between }) => {
  using app = setup();
  app.start();
  app.show(indicator("ok"), between, indicator("stressed"));
  expect(TestNotification.sent).toHaveLength(1);
});

it("notifies again after the machine recovers and is stressed once more", () => {
  using app = setup();
  app.start();
  app.show(indicator("ok"), indicator("stressed"), indicator("ok"), indicator("stressed"));
  expect(TestNotification.sent).toHaveLength(2);
});

it.each([
  {
    label: "the machine-stressed toggle is off",
    mode: "notifications",
    inApp: true,
    notify: false,
  },
  { label: "notifications are off and in-app is off", mode: "off", inApp: false, notify: true },
  { label: "only sound is on and in-app is off", mode: "sound", inApp: false, notify: true },
])("stays quiet when $label", ({ mode, inApp, notify }) => {
  using app = setup();
  state.mode = mode;
  state.inApp = inApp;
  state.notifyOnMachineStressed = notify;
  focused = true;
  app.start();
  app.show(indicator("ok"), indicator("stressed"));
  focused = false;
  app.show(indicator("ok"), indicator("stressed"));
  expect(TestNotification.sent).toEqual([]);
  expect(state.toast).not.toHaveBeenCalled();
});

it("starts watching when the toggle is turned back on", () => {
  using app = setup();
  state.notifyOnMachineStressed = false;
  app.start();
  state.notifyOnMachineStressed = true;
  app.changeSettings();
  app.show(indicator("ok"), indicator("stressed"));
  expect(TestNotification.sent).toHaveLength(1);
});

it("shows a toast instead of an OS notification while the app is in the foreground", () => {
  using app = setup();
  state.inApp = true;
  focused = true;
  app.start();
  app.show(indicator("ok"), indicator("stressed"));
  expect(TestNotification.sent).toEqual([]);
  expect(state.toast).toHaveBeenCalledExactlyOnceWith({
    type: "warning",
    title: "Studio is stressed",
    description: "Load 20.0 / 12.5 per core for 1 m",
  });
});
