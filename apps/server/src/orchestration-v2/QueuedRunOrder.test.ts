import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { queuedRunsInDeliveryOrder, queuedRunsMergedInto } from "./QueuedRunOrder.ts";

const at = (time: string) => DateTime.makeUnsafe(`2026-01-01T${time}Z`);
const delegatedCompletion = {
  generation: 1,
  parentRunId: "run:parent",
  taskIds: ["task:child"],
};

describe("queued run delivery order", () => {
  it("delivers completions and queued messages in request order, keeping manual queue order", () => {
    const projection = {
      messages: [
        { id: "message:old" },
        { id: "message:moved" },
        { id: "message:earlier-completion", delegatedCompletion },
        { id: "message:later-completion", delegatedCompletion },
      ],
      runs: [
        {
          id: "run:old",
          ordinal: 3,
          queuePosition: 2,
          requestedAt: at("10:00:00"),
          status: "queued",
          userMessageId: "message:old",
        },
        {
          id: "run:moved",
          ordinal: 4,
          queuePosition: 1,
          requestedAt: at("10:02:00"),
          status: "queued",
          userMessageId: "message:moved",
        },
        {
          id: "run:earlier-completion",
          ordinal: 2,
          queuePosition: 3,
          requestedAt: at("09:59:00"),
          status: "queued",
          userMessageId: "message:earlier-completion",
        },
        {
          id: "run:later-completion",
          ordinal: 5,
          queuePosition: 4,
          requestedAt: at("10:03:00"),
          status: "queued",
          userMessageId: "message:later-completion",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:earlier-completion",
      "run:moved",
      "run:old",
      "run:later-completion",
    ]);
  });
});

describe("queued agent messages that start in one turn", () => {
  const selection = { instanceId: "codex", model: "test-model" };
  type Entry = { run?: object; message?: object; shown?: boolean };
  const agent: Entry = {};
  const person: Entry = { message: { createdBy: "user", creationSource: "web" } };
  const mergedBehindFirst = (entries: ReadonlyArray<Entry>) => {
    const projection = {
      runs: entries.map((entry, index) => ({
        id: `run:${index}`,
        ordinal: index + 2,
        queuePosition: index + 1,
        status: "queued",
        userMessageId: `message:${index}`,
        modelSelection: selection,
        ...entry.run,
      })),
      messages: entries.map((entry, index) => ({
        id: `message:${index}`,
        runId: `run:${index}`,
        createdBy: "agent",
        creationSource: "mcp",
        text: `report ${index}`,
        attachments: [],
        ...entry.message,
      })),
      turnItems: entries.flatMap((entry, index) =>
        entry.shown ? [{ type: "user_message", messageId: `message:${index}` }] : [],
      ),
    };
    return queuedRunsMergedInto(projection as never, projection.runs[0] as never).map(
      ({ run }) => run.id,
    );
  };

  it("takes every agent message directly behind the first", () => {
    expect(mergedBehindFirst([agent, agent, agent])).toEqual(["run:1", "run:2"]);
  });

  it("follows delivery order, not the order the runs were created in", () => {
    expect(
      mergedBehindFirst([
        agent,
        { run: { queuePosition: 3 } },
        { run: { queuePosition: 2 }, message: { createdBy: "user", creationSource: "web" } },
      ]),
    ).toEqual([]);
  });

  it.each<[string, ReadonlyArray<Entry>, ReadonlyArray<string>]>([
    ["stops at a person's message", [agent, agent, person, agent], ["run:1"]],
    ["merges nothing into a person's message", [person, agent, agent], []],
    ["stops at a queued command", [agent, { message: { text: " /compact" } }, agent], []],
    ["stops at an attachment", [agent, { message: { attachments: [{ id: "image" }] } }, agent], []],
    ["stops at a held message", [agent, { run: { queueHeld: true } }, agent], []],
    ["stops at a fresh session", [agent, { run: { freshContext: true } }, agent], []],
    [
      "stops at a delegated task's follow-up",
      [agent, { run: { delegatedTaskId: "task" } }, agent],
      [],
    ],
    ["stops at a scheduled task", [agent, { message: { scheduledTaskId: "task" } }, agent], []],
    [
      "stops at a server notification",
      [agent, { message: { creationSource: "server", notification: {} } }, agent],
      [],
    ],
    [
      "stops at another model",
      [agent, { run: { modelSelection: { ...selection, model: "other" } } }, agent],
      [],
    ],
    ["stops at a message that already has its transcript row", [agent, { shown: true }, agent], []],
    [
      "stops before the batch outgrows one message's size limit",
      [
        { message: { text: "a".repeat(60_000) } },
        { message: { text: "b".repeat(50_000) } },
        { message: { text: "c".repeat(20_000) } },
      ],
      ["run:1"],
    ],
  ])("%s", (_rule, entries, expected) => {
    expect(mergedBehindFirst(entries)).toEqual(expected);
  });
});
