import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MAX_LOAD_SUSTAIN_SECONDS,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTask,
  ScheduledTaskListResult,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);
const encodeSchedule = Schema.encodeSync(ScheduledTaskSchedule);
const decodeTask = Schema.decodeUnknownSync(ScheduledTask);
const decodeTaskList = Schema.decodeUnknownSync(ScheduledTaskListResult);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("accepts a one-time run only with an offset", () => {
    for (const runAt of ["2026-11-03T09:00Z", "2026-11-03T09:00:00.000-08:00"]) {
      expect(decodeUpsertSchedule({ type: "once", runAt })).toEqual({ type: "once", runAt });
    }
    for (const runAt of [
      "2026-11-03T09:00",
      "2026-13-03T09:00Z",
      "2026-02-30T09:00Z",
      "9999-12-31T23:30-01:00",
      "0000-01-01T00:00+00:01",
      "tomorrow",
    ]) {
      expect(() => decodeUpsertSchedule({ type: "once", runAt })).toThrow();
    }
  });
});

it.each(["literal", " ", "\t\n", "{{body.bad", "{{unknown.field}}"])(
  "rejects invalid dedupe template %s",
  (replayKey) => {
    expect(() => decodeUpsertSchedule({ type: "webhook", dedupe: { replayKey } })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "webhook", dedupe: { coalesceKey: replayKey } }),
    ).toThrow();
  },
);
describe("webhook filters", () => {
  const accepts = (filters: unknown) => {
    try {
      decodeUpsertSchedule({ type: "webhook", filters });
      return true;
    } catch {
      return false;
    }
  };

  it("rejects empty or unknown paths, unknown ops, and values that do not fit the op", () => {
    expect(accepts([{ path: "", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "  ", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "request", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "header.x-github-event", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: "opened" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: [] }])).toBe(false);
    for (const value of ["", " opened", "opened ", "a,b"]) {
      expect(accepts([{ path: "body.action", op: "in", value: [value] }])).toBe(false);
    }
    expect(accepts([{ path: "body.label.name", op: "in", value: ["needs review"] }])).toBe(true);
    expect(accepts([{ path: "body.action", op: "equals" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "matches", value: "^opened$" }])).toBe(false);
  });
});

describe("load schedules", () => {
  const condition = { metric: "cpuPercent", op: ">=", threshold: 90, sustainSeconds: 60 } as const;
  const accepts = (schedule: unknown) => {
    try {
      decodeUpsertSchedule(schedule);
      decodeSchedule(schedule);
      return true;
    } catch {
      return false;
    }
  };

  it("round-trips a condition with an optional clear and gpuId", () => {
    const schedule = {
      type: "load",
      condition: { ...condition, metric: "gpuUtilPercent", gpuId: "gpu-0" },
      clear: { ...condition, op: "<=", threshold: 20, sustainSeconds: 0 },
    };
    expect(decodeUpsertSchedule(schedule)).toEqual(schedule);
    expect(decodeSchedule(schedule)).toEqual(schedule);
    expect(encodeSchedule(decodeSchedule(schedule))).toEqual(schedule);
    expect(decodeSchedule({ type: "load", condition })).toEqual({ type: "load", condition });
  });

  it("bounds sustainSeconds and refuses unknown metrics, ops or a blank gpuId", () => {
    expect(accepts({ type: "load", condition: { ...condition, sustainSeconds: 0 } })).toBe(true);
    expect(
      accepts({
        type: "load",
        condition: { ...condition, sustainSeconds: MAX_LOAD_SUSTAIN_SECONDS },
      }),
    ).toBe(true);
    for (const bad of [
      { ...condition, sustainSeconds: MAX_LOAD_SUSTAIN_SECONDS + 1 },
      { ...condition, sustainSeconds: -1 },
      { ...condition, sustainSeconds: 1.5 },
      { ...condition, threshold: Number.POSITIVE_INFINITY },
      { ...condition, metric: "diskUsedPercent" },
      { ...condition, op: ">" },
      { ...condition, gpuId: "" },
      { ...condition, gpuId: "  " },
      { metric: "cpuPercent", op: ">=", threshold: 90 },
    ]) {
      expect(accepts({ type: "load", condition: bad })).toBe(false);
      expect(accepts({ type: "load", condition, clear: bad })).toBe(false);
    }
    expect(accepts({ type: "load" })).toBe(false);
  });
});

describe("stock task decode", () => {
  const task = {
    id: "scheduled-task:nightly",
    title: "Nightly",
    prompt: "Check the build",
    enabled: true,
    schedule: { type: "interval", everyMs: 3_600_000 },
    projectId: "project:1",
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };
  const loadTask = {
    ...task,
    id: "builtin:machine-buckets",
    schedule: {
      type: "load",
      condition: { metric: "unbucketedSharePercent", op: ">=", threshold: 20, sustainSeconds: 0 },
    },
    nextRunAt: null,
    builtIn: "machine-buckets",
  };

  it("decodes a task from before load schedules unchanged, and one with them", () => {
    expect(decodeTask(task)).toEqual(task);
    expect(decodeTask(loadTask)).toEqual(loadTask);
    expect(() => decodeTask({ ...loadTask, builtIn: "something-else" })).toThrow();
  });

  it("keeps a list holding a load task, and drops only a task it cannot read", () => {
    const later = { ...task, id: "scheduled-task:later", schedule: { type: "on_commit" } };
    expect(decodeTaskList({ tasks: [task, loadTask, later] })).toEqual({ tasks: [task, loadTask] });
  });
});
