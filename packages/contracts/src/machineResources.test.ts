import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { isUnknownUnionMember } from "./baseSchemas.ts";
import {
  MachineProcessFrame,
  MachineResourcesSettings,
  type MachineBucketId,
} from "./machineResources.ts";

// Frames cross the websocket as JSON.
const decodeWire = Schema.decodeUnknownSync(Schema.toCodecJson(MachineProcessFrame));
const encodeWire = Schema.encodeSync(Schema.toCodecJson(MachineProcessFrame));
const decodeSettings = Schema.decodeSync(Schema.toCodecJson(MachineResourcesSettings));

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

  it("decodes an owner kind from a newer server as unknown on that row only", () => {
    const frame = decodeWire({
      ...base,
      added: [
        { ...base.added[0], owner: { type: "thread", threadId: "thread-a" } },
        { ...base.added[0], key: 1, pid: 8, owner: { type: "gpu-pool", poolId: "p" } },
      ],
      rows: { key: [0, 1], cpu: [1, 2], rss: [4, 8] },
    });
    expect(frame.added[0]?.owner).toEqual({ type: "thread", threadId: "thread-a" });
    const owner = frame.added[1]?.owner;
    expect(isUnknownUnionMember(owner)).toBe(true);
    expect(owner).toMatchObject({ tag: "type", value: "gpu-pool" });
  });

  it("drops claims and buckets with kinds from a newer server and keeps the known ones", () => {
    const provenance = {
      createdBy: { type: "user" },
      updatedBy: { type: "user" },
      updatedAt: "2026-11-07T00:00:00.000Z",
    };
    const claim = {
      id: "claim-1",
      threadId: "thread-a",
      target: { type: "process", pid: 7, startTimeMs: 10 },
      createdAt: "2026-11-07T00:00:00.000Z",
      createdBy: { type: "agent", threadId: "thread-a" },
    };
    const frame = decodeWire({
      ...base,
      claims: [
        claim,
        { ...claim, id: "claim-2", target: { type: "vm", name: "x" } },
        { ...claim, id: "claim-3", createdBy: { type: "scheduler" } },
      ],
    });
    expect(frame.claims?.map((entry) => entry.id)).toEqual(["claim-1"]);

    const settings = decodeSettings({
      buckets: {
        builds: {
          id: "builds",
          name: "Builds",
          rules: [{ field: "command", op: "contains", value: "cargo" }],
          provenance,
        },
        gpu: { id: "gpu", name: "GPU", rules: [{ field: "gpu", device: 0 }], provenance },
        scheduled: {
          id: "scheduled",
          name: "Scheduled",
          rules: [],
          provenance: { ...provenance, updatedBy: { type: "scheduler" } },
        },
      },
    });
    expect(Object.keys(settings.buckets)).toEqual(["builds"]);
    expect(settings.buckets["builds" as MachineBucketId]?.rules).toHaveLength(1);
  });
});
