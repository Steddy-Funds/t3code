import {
  type EnvironmentId,
  type ServerConfig,
  type ThreadId,
  type TokenBurnRates,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import { threadKey } from "./entities.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

const NO_RATES: ReadonlyMap<string, number> = new Map();

/**
 * Adds each thread's rate to every thread above it, so a parent reads its whole agent tree.
 * `childrenByParent` is keyed by thread key, like the agent tree's.
 */
export function rollUpTreeBurnRates(
  ownRates: ReadonlyMap<string, number>,
  childrenByParent: ReadonlyMap<
    string,
    ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly thread: { readonly id: ThreadId };
    }>
  >,
): ReadonlyMap<string, number> {
  if (ownRates.size === 0) return NO_RATES;
  const parentOf = new Map<string, string>();
  for (const [parent, children] of childrenByParent) {
    for (const child of children) {
      parentOf.set(
        threadKey({ environmentId: child.environmentId, threadId: child.thread.id }),
        parent,
      );
    }
  }
  const tree = new Map(ownRates);
  for (const [key, rate] of ownRates) {
    const seen = new Set([key]);
    for (let parent = parentOf.get(key); parent !== undefined; parent = parentOf.get(parent)) {
      if (seen.has(parent)) break;
      seen.add(parent);
      tree.set(parent, (tree.get(parent) ?? 0) + rate);
    }
  }
  return tree;
}

function sameRates(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, rate] of a) if (b.get(key) !== rate) return false;
  return true;
}

export function createTokenBurnRateAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  input: {
    readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
    readonly configValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
    readonly childThreadsByParentAtom: Atom.Atom<
      ReadonlyMap<
        string,
        ReadonlyArray<{
          readonly environmentId: EnvironmentId;
          readonly thread: { readonly id: ThreadId };
        }>
      >
    >;
  },
) {
  const subscription = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "token-burn-rates",
    tag: WS_METHODS.subscribeTokenBurnRates,
    idleTtlMs: 60_000,
  });

  /** Every capable environment's own per-thread rates, by thread key, and each one's total. */
  const snapshotAtom = Atom.make((get) => {
    const rates = new Map<string, number>();
    const environments = new Map<EnvironmentId, number>();
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const config = get(input.configValueAtom(environmentId));
      if (config?.environment.capabilities.tokenBurnRates !== true) continue;
      const result = get(subscription({ environmentId, input: {} }));
      const snapshot: TokenBurnRates | null = AsyncResult.isFailure(result)
        ? Option.getOrNull(Option.map(result.previousSuccess, (success) => success.value))
        : Option.getOrNull(AsyncResult.value(result));
      let total = 0;
      for (const { threadId, tokensPerMinute } of snapshot?.threads ?? []) {
        rates.set(threadKey({ environmentId, threadId }), tokensPerMinute);
        total += tokensPerMinute;
      }
      environments.set(environmentId, total);
    }
    return {
      rates: rates as ReadonlyMap<string, number>,
      environments: environments as ReadonlyMap<EnvironmentId, number>,
    };
  }).pipe(Atom.withLabel("token-burn-rates:snapshot"));
  const ownRatesAtom = Atom.make((get) => get(snapshotAtom).rates).pipe(
    Atom.withLabel("token-burn-rates:own"),
  );

  // Kept by identity while the numbers hold, so shell updates re-sort nothing.
  const treeRatesAtom = (() => {
    let previous: ReadonlyMap<string, number> = NO_RATES;
    return Atom.make((get) => {
      const next = rollUpTreeBurnRates(get(ownRatesAtom), get(input.childThreadsByParentAtom));
      if (sameRates(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel("token-burn-rates:tree"));
  })();

  const totalRateAtom = Atom.make((get) => {
    let total = 0;
    for (const rate of get(snapshotAtom).environments.values()) total += rate;
    return total;
  }).pipe(Atom.withLabel("token-burn-rates:total"));

  const environmentRateAtomFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(snapshotAtom).environments.get(environmentId) ?? 0).pipe(
      Atom.withLabel(`token-burn-rates:environment:${environmentId}`),
    ),
  );

  const treeRateAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => get(treeRatesAtom).get(key) ?? 0).pipe(
      Atom.withLabel(`token-burn-rate:${key}`),
    ),
  );

  return {
    /** Tokens per minute in each thread's agent tree, by thread key; idle trees are absent. */
    treeRatesAtom,
    /** Tokens per minute across every connected environment. */
    totalRateAtom,
    /** Tokens per minute across one environment's threads. */
    environmentRateAtom: (environmentId: EnvironmentId) => environmentRateAtomFamily(environmentId),
    treeRateAtom: (key: string) => treeRateAtomFamily(key),
  };
}
