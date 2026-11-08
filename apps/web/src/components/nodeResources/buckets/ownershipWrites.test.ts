import type { ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ownershipWrites } from "./ownershipWrites";

const config = (capabilities: Record<string, unknown>) =>
  ({ environment: { capabilities } }) as unknown as ServerConfig;

describe("ownershipWrites", () => {
  it.each([
    ["a capable server with write access", config({ machineOwnership: true }), true, "allowed"],
    ["a PR2 server without the flag", config({ machineResources: true }), true, "olderServer"],
    ["a server reporting the flag false", config({ machineOwnership: false }), true, "olderServer"],
    ["no config yet, so no older-server line flashes", null, true, "hidden"],
    ["no write access, even when capable", config({ machineOwnership: true }), false, "hidden"],
    ["no write access on an older server", config({}), false, "hidden"],
  ] as const)("%s", (_, serverConfig, canWrite, expected) => {
    expect(ownershipWrites({ config: serverConfig, canWrite })).toBe(expected);
  });
});
