import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { MachineProcessFrame } from "./machineResources.ts";

// Frames cross the websocket as JSON.
const decodeWire = Schema.decodeUnknownSync(Schema.toCodecJson(MachineProcessFrame));
const encodeWire = Schema.encodeSync(Schema.toCodecJson(MachineProcessFrame));

const base = {
  generation: 0,
  full: true,
  sequence: 0,
  sampleAgeMs: 0,
  source: "host",
  added: [{ key: 0, pid: 7, ppid: 1, startTimeMs: 10, name: "node", user: "dev", command: "node" }],
  removed: [],
  rows: { key: [0], cpu: [1], rss: [4] },
};

describe("MachineProcessFrame", () => {
  it("decodes a frame from a server before ownership without owners or claims", () => {
    const frame = decodeWire(base);
    expect(frame).not.toHaveProperty("claims");
    expect(frame.added[0]).not.toHaveProperty("owner");
  });

  it("carries owners and claims across the wire", () => {
    const wire = {
      ...base,
      added: [{ ...base.added[0], owner: { type: "thread", threadId: "thread-a" } }],
      claims: [
        {
          id: "claim-1",
          threadId: "thread-a",
          target: { type: "process", pid: 7, startTimeMs: 10 },
          createdAt: "2026-11-07T00:00:00.000Z",
          createdBy: { type: "agent", threadId: "thread-a" },
          measurable: false,
        },
      ],
    };
    const frame = decodeWire(JSON.parse(JSON.stringify(wire)));
    expect(frame.added[0]?.owner).toEqual({ type: "thread", threadId: "thread-a" });
    expect(frame.claims?.[0]).toMatchObject({ id: "claim-1", measurable: false });
    expect(encodeWire(frame)).toEqual(wire);
  });
});
