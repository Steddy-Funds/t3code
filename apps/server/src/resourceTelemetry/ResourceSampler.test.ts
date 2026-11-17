import { it } from "@effect/vitest";
import { type ProcessOwner, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import { ProcessOwnership } from "./ProcessOwnership.ts";
import { layer as samplerLayer, ResourceSampler, SAMPLE_INTERVAL_MS } from "./ResourceSampler.ts";

const threadA = ThreadId.make("thread-a");

const hostSample = (sequence: number): NativeTelemetryClient.NativeHostSample => ({
  generation: 0,
  statics: new Map(),
  sample: {
    version: 4,
    type: "hostSample",
    sequence,
    sampledAtUnixMs: sequence * SAMPLE_INTERVAL_MS,
    collectionDurationMicros: 1,
    scannedProcessCount: 1,
    inaccessibleProcessCount: 0,
    staticReset: false,
    processes: { pid: [7], ppid: [1], startTimeMs: [70], cpuPercent: [1], residentBytes: [100] },
  },
});

/**
 * A monitor whose host streams share one feed, as the real client's do. Each stream's demand
 * shows in `opened` once it is subscribed, and in `closed` when it ends.
 */
const makeWorld = Effect.gen(function* () {
  const feed = yield* PubSub.unbounded<NativeTelemetryClient.NativeHostSample>();
  const opened = yield* Queue.unbounded<NativeTelemetryClient.HostSampleDemand>();
  const closed = yield* Queue.unbounded<NativeTelemetryClient.HostSampleDemand>();
  const attributions = yield* Ref.make(0);
  const owners = new Map<string, ProcessOwner>([["7:70", { type: "thread", threadId: threadA }]]);
  const native = NativeTelemetryClient.layerTest({
    hostSamples: (demand) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(feed);
          yield* Effect.acquireRelease(Queue.offer(opened, demand), () =>
            Queue.offer(closed, demand),
          );
          return Stream.fromSubscription(subscription);
        }),
      ),
  });
  const ownership = {
    ...ProcessOwnership.defaultValue(),
    attribute: () => Ref.update(attributions, (count) => count + 1).pipe(Effect.as(owners)),
  };
  const run = <A, E>(body: Effect.Effect<A, E, ResourceSampler | Scope.Scope>) =>
    body.pipe(
      Effect.provide(samplerLayer.pipe(Layer.provide(native))),
      Effect.provideService(ProcessOwnership, ownership),
      Effect.scoped,
    );
  return { feed, opened, closed, attributions, run };
});

describe("ResourceSampler", () => {
  it.effect(
    "walks the host for its whole life and attributes each sample once for every reader",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* world.run(
          Effect.gen(function* () {
            const sampler = yield* ResourceSampler;
            expect(yield* Queue.take(world.opened)).toEqual({
              intervalMs: SAMPLE_INTERVAL_MS,
              processes: true,
              gpus: false,
              gpuProcesses: false,
            });
            const readers = yield* Effect.forEach([1, 2, 3], () =>
              Stream.toQueue(sampler.samples, { capacity: "unbounded" }),
            );

            yield* PubSub.publish(world.feed, hostSample(1));
            const received = yield* Effect.forEach(readers, (reader) => Queue.take(reader));
            expect(new Set(received).size).toBe(1);
            expect(received[0]?.owners.get("7:70")).toEqual({ type: "thread", threadId: threadA });
            expect(yield* Ref.get(world.attributions)).toBe(1);

            // A reader arriving later gets the newest sample at once, without a walk of its own.
            const late = yield* Stream.toQueue(sampler.samples, { capacity: "unbounded" });
            expect(yield* Queue.take(late)).toBe(received[0]);
            expect(Option.getOrUndefined(yield* sampler.latest)).toBe(received[0]);
            expect(yield* Ref.get(world.attributions)).toBe(1);
            expect(yield* Queue.size(world.opened)).toBe(0);
          }),
        );
      }),
  );

  it.effect("holds a view's demand only while its scope is open", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* world.run(
        Effect.gen(function* () {
          const sampler = yield* ResourceSampler;
          yield* Queue.take(world.opened);

          const view = { intervalMs: 1_000, processes: true, gpus: true, gpuProcesses: true };
          const scope = yield* Scope.make();
          yield* sampler.demand(view).pipe(Scope.provide(scope));
          expect(yield* Queue.take(world.opened)).toEqual(view);
          expect(yield* Queue.size(world.closed)).toBe(0);

          yield* Scope.close(scope, Exit.void);
          expect(yield* Queue.take(world.closed)).toEqual(view);
          // The base walk stays.
          expect(yield* Queue.size(world.closed)).toBe(0);
        }),
      );
    }),
  );
});
