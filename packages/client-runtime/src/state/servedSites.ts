import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createServedSitesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:served-sites:list",
      tag: WS_METHODS.servedSitesSubscribe,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:served-sites:stop",
      tag: WS_METHODS.servedSitesStop,
    }),
    dismiss: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:served-sites:dismiss",
      tag: WS_METHODS.servedSitesDismiss,
    }),
  };
}
