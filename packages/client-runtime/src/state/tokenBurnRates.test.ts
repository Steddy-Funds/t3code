import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadKey } from "./entities.ts";
import { rollUpTreeBurnRates } from "./tokenBurnRates.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const key = (environmentId: EnvironmentId, id: string) =>
  threadKey({ environmentId, threadId: ThreadId.make(id) });
const child = (environmentId: EnvironmentId, id: string) => ({
  environmentId,
  thread: { id: ThreadId.make(id) },
});

describe("rollUpTreeBurnRates", () => {
  it("adds each thread's rate to every thread above it, across environments", () => {
    const childrenByParent = new Map([
      [key(local, "root"), [child(local, "sub"), child(remote, "delegated")]],
      [key(local, "sub"), [child(local, "grandchild")]],
      // A cycle in stale shells must not loop.
      [key(local, "a"), [child(local, "b")]],
      [key(local, "b"), [child(local, "a")]],
    ]);
    const own = new Map([
      [key(local, "root"), 100],
      [key(local, "grandchild"), 10],
      [key(remote, "delegated"), 1_000],
      [key(local, "a"), 5],
    ]);

    expect(Object.fromEntries(rollUpTreeBurnRates(own, childrenByParent))).toEqual({
      [key(local, "root")]: 1_110,
      [key(local, "sub")]: 10,
      [key(local, "grandchild")]: 10,
      [key(remote, "delegated")]: 1_000,
      [key(local, "a")]: 5,
      [key(local, "b")]: 5,
    });
  });
});
