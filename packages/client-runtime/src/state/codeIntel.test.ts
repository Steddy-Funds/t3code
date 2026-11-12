import { describe, expect, it } from "@effect/vitest";
import {
  CodeIntelError,
  EnvironmentId,
  WS_METHODS,
  type CodeIntelPositionInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE, BearerConnectionTarget } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createCodeIntelEnvironmentAtoms, isCodeIntelUnsupportedError } from "./codeIntel.ts";

const ENVIRONMENT_ID = EnvironmentId.make("code-intel-environment");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("code-intel-other-environment");

type HoverHandler = (input: CodeIntelPositionInput) => Effect.Effect<unknown, CodeIntelError>;

const answer = Effect.succeed({ markdown: "**greet**", revision: "r1" });
const unknownTag = Effect.die(new Error(`Unknown request tag: ${WS_METHODS.codeIntelHover}`));

const makeHarness = Effect.fnUntraced(function* (initial: HoverHandler) {
  const calls: Array<{ readonly environmentId: EnvironmentId; readonly line: number }> = [];
  const makeSession = (environmentId: EnvironmentId, handler: HoverHandler) =>
    ({
      client: {
        [WS_METHODS.codeIntelHover]: (input: CodeIntelPositionInput) => {
          calls.push({ environmentId, line: input.position.line });
          return handler(input);
        },
      },
    }) as unknown as RpcSession;
  const supervisorFor = Effect.fnUntraced(function* (environmentId: EnvironmentId, handler: HoverHandler) {
    const session = yield* SubscriptionRef.make(Option.some(makeSession(environmentId, handler)));
    const state = yield* SubscriptionRef.make({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected" as const,
    });
    return {
      target: new BearerConnectionTarget({
        environmentId,
        label: "Test",
        connectionId: "test",
      }),
      session,
      state,
    } as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  });
  const supervisors = new Map([
    [ENVIRONMENT_ID, yield* supervisorFor(ENVIRONMENT_ID, initial)],
    [OTHER_ENVIRONMENT_ID, yield* supervisorFor(OTHER_ENVIRONMENT_ID, () => answer)],
  ]);
  const supervisorOf = (environmentId: EnvironmentId) => supervisors.get(environmentId)!;
  const environmentRegistry = {
    run: (environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisorOf(environmentId)),
    followStream: (environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisorOf(environmentId)),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"];
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
  );
  const atoms = createCodeIntelEnvironmentAtoms(runtime);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return {
    calls,
    hover: (line: number, environmentId = ENVIRONMENT_ID) =>
      AtomRegistry.getResult(
        registry,
        atoms.hover({
          environmentId,
          input: {
            document: { cwd: "/repo", path: "app.py" },
            position: { line, character: 0 },
          },
        }),
        { suspendOnWaiting: true },
      ),
    reconnect: (handler: HoverHandler, environmentId = ENVIRONMENT_ID) =>
      SubscriptionRef.set(
        supervisorOf(environmentId).session,
        Option.some(makeSession(environmentId, handler)),
      ),
  };
});

describe("code intelligence client calls", () => {
  it.effect("turns an older server's unknown request tag into CodeIntelUnsupportedError", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(() => unknownTag);

        const error = yield* harness.hover(0).pipe(Effect.flip);

        expect(isCodeIntelUnsupportedError(error)).toBe(true);
        expect(harness.calls).toHaveLength(1);
      }),
    ),
  );

  it.effect("fails every later call on that session the same way without asking", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(() => unknownTag);
        yield* harness.hover(0).pipe(Effect.flip);

        const later = yield* Effect.all([harness.hover(1), harness.hover(2)]).pipe(Effect.flip);

        expect(isCodeIntelUnsupportedError(later)).toBe(true);
        expect(harness.calls).toHaveLength(1);
      }),
    ),
  );

  it.effect("asks again on a new session, and leaves other environments alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(() => unknownTag);
        yield* harness.hover(0).pipe(Effect.flip);

        expect(yield* harness.hover(0, OTHER_ENVIRONMENT_ID)).toMatchObject({ markdown: "**greet**" });
        yield* harness.reconnect(() => answer);

        expect(yield* harness.hover(1)).toMatchObject({ markdown: "**greet**" });
        expect(harness.calls.map((call) => call.environmentId)).toEqual([
          ENVIRONMENT_ID,
          OTHER_ENVIRONMENT_ID,
          ENVIRONMENT_ID,
        ]);
      }),
    ),
  );

  it.effect("marks a session unsupported only for the unknown request tag defect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(() => Effect.die(new Error("Out of memory")));

        const exit = yield* harness.hover(0).pipe(Effect.exit);
        yield* harness.reconnect(() => answer);

        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
        expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain("Out of memory");
        expect(yield* harness.hover(1)).toMatchObject({ markdown: "**greet**" });
      }),
    ),
  );

  it.effect("keeps asking on a session whose call failed with an ordinary error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let fail = true;
        const harness = yield* makeHarness(() =>
          fail
            ? Effect.fail(new CodeIntelError({ reason: "server_failed", message: "Crashed." }))
            : answer,
        );

        const error = yield* harness.hover(0).pipe(Effect.flip);
        fail = false;

        expect(isCodeIntelUnsupportedError(error)).toBe(false);
        expect(yield* harness.hover(1)).toMatchObject({ markdown: "**greet**" });
        expect(harness.calls).toHaveLength(2);
      }),
    ),
  );
});
