import type { Claim, ProcessOwner } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import { ProcessOwnership, type OwnershipRow } from "./ProcessOwnership.ts";

/** The base walk: every process on the host, for the server's lifetime. Live views may raise it. */
export const SAMPLE_INTERVAL_MS = 5_000;

const BASE_DEMAND: NativeTelemetryClient.HostSampleDemand = {
  intervalMs: SAMPLE_INTERVAL_MS,
  processes: true,
  gpus: false,
  gpuProcesses: false,
};

/** One host sample with an owner for every process in it. */
export interface AttributedSample {
  readonly sample: NativeTelemetryClient.NativeHostSample;
  /** By process key (`pid:startTimeMs`). */
  readonly owners: ReadonlyMap<string, ProcessOwner>;
  readonly claims: ReadonlyArray<Claim>;
}

export interface ResourceSamplerShape {
  /** The newest attributed sample; none before the first, or without a host-mode monitor. */
  readonly latest: Effect.Effect<Option.Option<AttributedSample>>;
  /** The newest sample at once, when there is one, then every new one. */
  readonly samples: Stream.Stream<AttributedSample>;
  /**
   * Raises the shared walk to a live view's rate and fields while the scope is open. Its samples
   * still arrive through `samples`, attributed once for every reader.
   */
  readonly demand: (
    demand: NativeTelemetryClient.HostSampleDemand,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

/**
 * The server's one process sampler. Thread totals, process views, the load monitor and the MCP
 * machine tools all read its latest sample; none of them walks the host or attributes on its own.
 */
export class ResourceSampler extends Context.Service<ResourceSampler, ResourceSamplerShape>()(
  "t3/resourceTelemetry/ResourceSampler",
) {}

/** Every process in a host sample as attribution reads it, statics "" where unread. */
export function hostOwnershipRows(
  sample: NativeTelemetryClient.NativeHostSample["sample"],
  statics: NativeTelemetryClient.HostProcessStatics,
): Array<OwnershipRow> {
  const columns = sample.processes;
  if (!columns) return [];
  return columns.pid.map((pid, index) => {
    const startTimeMs = columns.startTimeMs[index]!;
    const known = statics.get(pid);
    const entry = known?.startTimeMs === startTimeMs ? known : undefined;
    return {
      pid,
      ppid: columns.ppid[index]!,
      startTimeMs,
      name: entry?.name ?? "",
      command: entry?.command ?? "",
      exe: entry?.exe ?? "",
      cwd: entry?.cwd ?? "",
      user: entry?.user ?? "",
      cgroup: entry?.cgroup ?? "",
      containerId: entry?.containerId ?? "",
    };
  });
}

const make = Effect.gen(function* () {
  const native = yield* NativeTelemetryClient.NativeTelemetryClient;
  const ownership = yield* ProcessOwnership;
  // Only the newest matters: a reader that falls behind skips to it.
  const changes = yield* PubSub.sliding<AttributedSample>(1);
  let latest: Option.Option<AttributedSample> = Option.none();

  // Every sample for the server's lifetime; a span each would only add noise.
  const attribute = Effect.fnUntraced(function* (sample: NativeTelemetryClient.NativeHostSample) {
    const owners = yield* ownership.attribute(hostOwnershipRows(sample.sample, sample.statics));
    const claims = yield* ownership.claims;
    const next: AttributedSample = { sample, owners, claims };
    latest = Option.some(next);
    yield* PubSub.publish(changes, next);
  });

  // The client resends the demand after a monitor restart; a failed send retries the stream.
  yield* forkParked(
    native.hostSamples(BASE_DEMAND).pipe(
      Stream.runForEach(attribute),
      Effect.tapError((error) =>
        Effect.logWarning("Host process sampling stopped; retrying", { cause: error.message }),
      ),
      Effect.retry(Schedule.spaced("30 seconds")),
    ),
  );

  const samples = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe first, so a sample between the two reads is not lost; at worst one repeats.
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.concat(
        Stream.fromIterable(Option.toArray(latest)),
        Stream.fromSubscription(subscription),
      );
    }),
  );

  const demand: ResourceSamplerShape["demand"] = (input) =>
    native
      .hostSamples(input)
      .pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped, Effect.asVoid);

  return ResourceSampler.of({ latest: Effect.sync(() => latest), samples, demand });
});

export const layer = Layer.effect(ResourceSampler, make);
