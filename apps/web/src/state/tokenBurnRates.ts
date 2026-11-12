import { createTokenBurnRateAtoms } from "@t3tools/client-runtime/state/tokenBurnRates";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

export const tokenBurnRates = createTokenBurnRateAtoms(connectionAtomRuntime, {
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  configValueAtom: serverEnvironment.configValueAtom,
  childThreadsByParentAtom: environmentThreadShells.childThreadsByParentAtom,
});

/** Tokens per minute across a thread's agent tree, averaged over five minutes; 0 when idle. */
export function useTreeBurnRate(ref: ScopedThreadRef): number {
  return useAtomValue(tokenBurnRates.treeRateAtom(threadKey(ref)));
}

/** Tokens per minute across every thread in every connected environment; 0 when idle. */
export function useTotalBurnRate(): number {
  return useAtomValue(tokenBurnRates.totalRateAtom);
}

/** Tokens per minute across one machine's threads; 0 when idle. */
export function useEnvironmentBurnRate(environmentId: EnvironmentId): number {
  return useAtomValue(tokenBurnRates.environmentRateAtom(environmentId));
}
