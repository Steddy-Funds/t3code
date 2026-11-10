import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpSaveScheduledTaskInput,
} from "./orchestratorMcp.ts";

const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeListScheduledTasks = Schema.decodeUnknownSync(OrchestratorMcpListScheduledTasksResult);

describe("orchestrator MCP contracts", () => {
  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
    expect(result.pendingApproval).toBeNull();
    const pendingApproval = {
      requestId: "request-approval-1",
      kind: "command",
      runId: "run-child-1",
    };
    expect(
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, input: { command: "private command" } },
      }).pendingApproval,
    ).toEqual(pendingApproval);
    expect(() =>
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, kind: "user_input" },
      }),
    ).toThrow();
  });
});

describe("load schedules over MCP", () => {
  const load = {
    type: "load",
    condition: { metric: "memoryUsedPercent", op: "<=", threshold: 40, sustainSeconds: 120 },
  };
  const decodeSchedule = Schema.decodeUnknownSync(
    Schema.Struct({ schedule: OrchestratorMcpSaveScheduledTaskInput.fields.schedule }),
  );

  it("reads a load schedule as an object or as JSON text", () => {
    expect(decodeSchedule({ schedule: load })).toEqual({ schedule: load });
    expect(decodeSchedule({ schedule: JSON.stringify(load) })).toEqual({ schedule: load });
    expect(() =>
      decodeSchedule({
        schedule: JSON.stringify({
          ...load,
          condition: { ...load.condition, sustainSeconds: 3601 },
        }),
      }),
    ).toThrow();
  });

  it("drops a forwarded task with an unknown schedule type and keeps the rest", () => {
    const listed = {
      scheduledTaskId: "scheduled-task:idle",
      title: "When idle",
      prompt: "Run the benchmarks",
      enabled: true,
      projectId: "project:1",
      boundThreadId: null,
      freshSession: false,
      schedule: load,
      nextRunAt: null,
      lastRunStatus: "never",
    };
    const newer = {
      ...listed,
      scheduledTaskId: "scheduled-task:newer",
      schedule: { type: "on_commit" },
    };
    expect(decodeListScheduledTasks({ tasks: [newer, listed] })).toEqual({ tasks: [listed] });
  });
});
