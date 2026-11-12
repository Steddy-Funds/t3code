import { describe, expect, it } from "vite-plus/test";

import {
  compactDynamicToolOutput,
  machineCardFromToolItem,
  machineCardsEqual,
  MAX_TOOL_OUTPUT_IMAGES,
  mcpToolResultOutput,
  toolOutputImages,
  toolOutputIndicatesFailure,
} from "./toolOutput.ts";

describe("compactDynamicToolOutput", () => {
  it("extracts IDs through the MCP result envelopes used by T3 summaries", () => {
    const metadata = { threadId: "thread-1", messageId: "message-1" };
    const json = JSON.stringify({ ...metadata, response: "Private response body" });
    for (const value of [
      { ...metadata, response: "Private response body" },
      { structuredContent: JSON.parse(json), content: "Ignored alternative body" },
      [{ type: "text", text: json }],
      { content: [{ text: { text: json } }], isError: false },
      json,
    ]) {
      expect(compactDynamicToolOutput(value)).toEqual(metadata);
    }
  });

  it("keeps nested thread identity and scalar task IDs without result bodies", () => {
    const output = {
      thread: { threadId: "thread-1", messages: ["Private message"] },
      taskId: "task-1",
      scheduledTaskId: "scheduled-1",
      status: "failed",
      summary: "A child failed; the tool itself succeeded.",
      unlinked: [{ repository: "acme/app", state: "merged", numbers: [1] }],
      unlinkedCount: 1,
      linkedCount: 2,
    };
    expect(compactDynamicToolOutput(output)).toEqual({
      thread: { threadId: "thread-1" },
      taskId: "task-1",
      scheduledTaskId: "scheduled-1",
      linkedCount: 2,
      unlinkedCount: 1,
    });
    expect(output.thread.messages).toEqual(["Private message"]);
  });

  it("keeps explicit envelope failure while dropping error text and arbitrary output", () => {
    for (const failure of [
      { isError: true },
      { is_error: true },
      { _tag: "OrchestratorMcpFailure" },
      { error: { message: "Private error" } },
    ]) {
      expect(
        compactDynamicToolOutput({
          ...failure,
          structuredContent: { threadId: "thread-1", error: "Private details" },
        }),
      ).toEqual({ isError: true, threadId: "thread-1" });
    }
    expect(compactDynamicToolOutput("Private plain text")).toBeUndefined();
    expect(compactDynamicToolOutput({ result: { body: "Private result" } })).toBeUndefined();
  });

  it("uses the first result data but combines explicit failure flags across content blocks", () => {
    expect(
      compactDynamicToolOutput([
        { text: JSON.stringify({ threadId: "first" }) },
        { text: JSON.stringify({ threadId: "second", isError: true, error: "Private error" }) },
      ]),
    ).toEqual({ threadId: "first", isError: true });
    expect(
      compactDynamicToolOutput([{ text: "{}" }, { text: JSON.stringify({ threadId: "second" }) }]),
    ).toBeUndefined();
  });

  it("keeps complete thread creation batches and rollback markers without row bodies", () => {
    expect(
      compactDynamicToolOutput({
        threads: [
          { threadId: "created", status: "running", messages: ["Private message"] },
          { threadId: "reverted", status: "rolled_back", error: "Private error" },
          { status: "rolled_back" },
        ],
      }),
    ).toEqual({
      threads: [
        { threadId: "created" },
        { threadId: "reverted", status: "rolled_back" },
        { status: "rolled_back" },
      ],
    });
    expect(compactDynamicToolOutput({ threadId: "reverted", status: "rolled_back" })).toEqual({
      threadId: "reverted",
      status: "rolled_back",
    });
    expect(compactDynamicToolOutput({ threads: [] })).toEqual({ threads: [] });
  });

  it("omits incomplete or oversized creation evidence instead of returning a partial count", () => {
    for (const threads of [
      [{ threadId: "known" }, { title: "No confirmed ID" }],
      Array.from({ length: 101 }, (_, index) => ({ threadId: `thread-${index}` })),
      Array.from({ length: 100 }, (_, index) => ({ threadId: `${index}`.padEnd(256, "x") })),
      [{ threadId: "x".repeat(257) }],
    ]) {
      expect(
        compactDynamicToolOutput({
          threadId: "must-not-be-counted-as-one",
          status: "rolled_back",
          taskId: "task-1",
          threads,
        }),
      ).toEqual({ taskId: "task-1" });
    }
    const normalBatch = {
      threads: Array.from({ length: 100 }, (_, index) => ({
        threadId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
    };
    expect(compactDynamicToolOutput(normalBatch)).toEqual(normalBatch);
    expect(
      new TextEncoder().encode(JSON.stringify(compactDynamicToolOutput(normalBatch))).byteLength,
    ).toBeLessThanOrEqual(8_192);
  });

  it("bounds parsing and envelope scanning while preserving an outer failure marker", () => {
    const oversizedJson = JSON.stringify({ threadId: "hidden", body: "😄".repeat(5_000) });
    for (const content of [
      "x".repeat(1_000_000),
      oversizedJson,
      Array.from({ length: 33 }, () => ({ text: JSON.stringify({ threadId: "hidden" }) })),
      { content: { content: { content: { content: { threadId: "too-deep" } } } } },
    ]) {
      expect(compactDynamicToolOutput({ isError: true, content })).toEqual({ isError: true });
    }
    expect(compactDynamicToolOutput({ threadId: "known", body: "x".repeat(1_000_000) })).toEqual({
      threadId: "known",
    });
  });
});

describe("machine card", () => {
  const snapshot = {
    verdict: "stressed",
    reason: { rule: "load", value: 2.4, threshold: 2, heldForMs: 30_000 },
    totals: {
      cpuUtilization: 0.93,
      cpuCount: 8,
      load: { one: 19.2, five: 12, fifteen: 6 },
      memoryTotalBytes: 16_000_000_000,
      memoryAvailableBytes: 2_000_000_000,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      memoryPressure: null,
    },
  };
  const card = { environmentId: "environment:mac", snapshot };
  const readOutput = { verdict: "stressed", perCore: [99, 12], machineCard: card };

  it("reads the card through each result envelope and keeps only its static snapshot", () => {
    const json = JSON.stringify(readOutput);
    for (const value of [
      readOutput,
      { structuredContent: JSON.parse(json), content: [{ type: "text", text: json }] },
      [{ type: "text", text: json }],
      json,
    ]) {
      expect(compactDynamicToolOutput(value)).toEqual({ machineCard: card });
      expect(
        machineCardFromToolItem({ toolName: "mcp__t3-code__t3_machine_read", output: value }),
      ).toEqual(card);
    }
    const extra = {
      machineCard: {
        ...card,
        live: true,
        snapshot: { ...snapshot, sample: { perCore: [1] }, history: { count: 1 } },
      },
    };
    expect(compactDynamicToolOutput(extra)).toEqual({ machineCard: card });
  });

  it("keeps an ok card with no reason or totals", () => {
    const ok = {
      environmentId: "environment:mac",
      snapshot: { verdict: "ok", reason: null, totals: null },
    };
    expect(
      machineCardFromToolItem({ toolName: "t3_machine_read", output: { machineCard: ok } }),
    ).toEqual(ok);
  });

  it("drops a card whose id does not read, and keeps a live card when only the snapshot does not", () => {
    for (const machineCard of [
      { snapshot },
      { environmentId: "", snapshot },
      { environmentId: "   ", snapshot },
      { environmentId: 42, snapshot },
      { environmentId: "x".repeat(257), snapshot },
      "environment:mac",
      null,
    ]) {
      expect(compactDynamicToolOutput({ taskId: "task-1", machineCard })).toEqual({
        taskId: "task-1",
      });
    }
    for (const badSnapshot of [
      undefined,
      { ...snapshot, verdict: "melting" },
      { verdict: "ok", reason: null },
      { ...snapshot, reason: { rule: "disk" } },
      "stressed",
      null,
    ]) {
      expect(
        compactDynamicToolOutput({
          taskId: "task-1",
          machineCard: { environmentId: "environment:mac", snapshot: badSnapshot },
        }),
      ).toEqual({ taskId: "task-1", machineCard: { environmentId: "environment:mac" } });
    }
  });

  it("returns no card from a failed tool call", () => {
    expect(
      machineCardFromToolItem({
        toolName: "t3_machine_read",
        output: { isError: true, structuredContent: readOutput },
      }),
    ).toBeUndefined();
    expect(
      machineCardFromToolItem({ toolName: "t3_machine_read", output: undefined }),
    ).toBeUndefined();
  });

  it("keeps the compact output within the metadata limit with an oversized device name", () => {
    const deviceName = "GPU".repeat(4_000);
    const heavy = {
      ...card,
      snapshot: { ...snapshot, reason: { ...snapshot.reason, rule: "gpuVram", deviceName } },
    };
    for (const value of [{ machineCard: heavy }, JSON.stringify({ machineCard: heavy })]) {
      const output = compactDynamicToolOutput({ threadId: "thread-1", structuredContent: value });
      expect(new TextEncoder().encode(JSON.stringify(output ?? {})).byteLength).toBeLessThanOrEqual(
        8_192,
      );
    }
  });
});

describe("toolOutputIndicatesFailure", () => {
  it("preserves the command failure phrases across shells without copying the output", () => {
    for (const text of [
      "FILE NOT FOUND",
      "No files found",
      "ENOENT",
      "No such file or directory",
      "CommandNotFoundException",
      "command not found",
      "Cannot find path 'a' because it does not exist",
      "The term 'example' is not recognized",
      "is not recognized as the name of a cmdlet",
      "A parameter cannot be found that matches parameter name",
      "<exited with exit code 2>",
      "Exited with exit code 1",
      "exit code: 127",
    ])
      expect(toolOutputIndicatesFailure(text)).toBe(true);
  });

  it("does not mark successful exit codes or incomplete failure phrases", () => {
    for (const text of [
      "Done",
      "exit code: 0",
      "Exited with exit code 0",
      "cannot find path",
      "is not recognized",
    ]) {
      expect(toolOutputIndicatesFailure(text)).toBe(false);
    }
  });
});

describe("toolOutputImages", () => {
  const mcpImage = { type: "image", data: "AAAA", mimeType: "image/png" };
  const claudeImage = {
    type: "image",
    source: { type: "base64", media_type: "image/JPEG", data: "BBBB" },
  };
  const text = { type: "text", text: "{}" };

  it("finds images in each place providers store them, in order", () => {
    expect(toolOutputImages({ content: [text, claudeImage, mcpImage] })).toEqual([
      { mimeType: "image/jpeg", data: "BBBB" },
      { mimeType: "image/png", data: "AAAA" },
    ]);
    expect(toolOutputImages([mcpImage])).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
    expect(toolOutputImages(mcpImage)).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
    const structuredContent = { screenshot: { mimeType: "image/png", width: 728, height: 354 } };
    const content = [text, mcpImage];
    const output = mcpToolResultOutput({ content, structuredContent });
    expect(toolOutputImages(output)).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
    expect(output).toEqual({ content, structuredContent });
    expect(mcpToolResultOutput({ content: [text], structuredContent })).toBe(structuredContent);
    expect(mcpToolResultOutput({ content })).toBe(content);
  });

  it("skips types the server must not serve inline", () => {
    expect(
      toolOutputImages([
        { ...mcpImage, mimeType: "image/svg+xml" },
        { ...mcpImage, mimeType: "text/html" },
        { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
      ]),
    ).toEqual([]);
  });

  it("stops after the first few images", () => {
    const images = toolOutputImages(Array.from({ length: 10_000 }, () => mcpImage));
    expect(images).toHaveLength(MAX_TOOL_OUTPUT_IMAGES);
  });
});

describe("inline machine card from t3_machine_read", () => {
  const snapshot = {
    verdict: "stressed",
    reason: { rule: "cpu", value: 97, threshold: 90, heldForMs: 60_000 },
    totals: {
      cpuUtilization: 0.97,
      cpuCount: 8,
      load: { one: 9, five: 7, fifteen: 4 },
      memoryTotalBytes: 16_000_000_000,
      memoryAvailableBytes: 4_000_000_000,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      memoryPressure: null,
    },
  };
  const card = { environmentId: "environment:mac", snapshot };
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const heavySnapshot = (size: number) => ({
    ...snapshot,
    reason: { ...snapshot.reason, rule: "gpuVram", deviceName: "g".repeat(size) },
  });
  const app = (cspSize: number) => ({
    attachmentId: "machine-app-html",
    server: "weather",
    tool: "get_weather",
    resourceUri: "ui://weather/dashboard",
    ...(cspSize === 0
      ? {}
      : {
          csp: {
            connectDomains: Array.from(
              { length: cspSize },
              (_, index) => `https://${"d".repeat(220)}${index}.example.com`,
            ),
          },
        }),
  });

  it("draws a card only for T3's own machine read", () => {
    const output = { structuredContent: { machineCard: card }, content: [] };
    for (const toolName of ["t3_machine_read", "mcp__t3-code__t3_machine_read"]) {
      expect(machineCardFromToolItem({ toolName, output })).toEqual(card);
    }
    for (const toolName of [
      "other_server.t3_machine_read",
      "mcp__other__t3_machine_read",
      "html_render",
      "mcp__t3-code__html_render",
      "t3_machine_reads",
      null,
      undefined,
    ]) {
      expect(machineCardFromToolItem({ toolName, output })).toBeUndefined();
    }
    expect(
      machineCardFromToolItem({
        toolName: "t3_machine_read",
        output: { ...output, isError: true },
      }),
    ).toBeUndefined();
  });

  it("reads a machine read beside a full process table, which other tools may not", () => {
    const processes = Array.from({ length: 80 }, (_, pid) => ({
      pid,
      command: "/usr/bin/node ".padEnd(480, "x"),
      cpu: 1,
    }));
    const text = JSON.stringify({ processes, machineCard: card });
    expect(text.length).toBeGreaterThan(36_000);
    const output = { content: [{ type: "text", text }] };
    expect(machineCardFromToolItem({ toolName: "t3_machine_read", output })).toEqual(card);
    expect(compactDynamicToolOutput(output, "mcp__t3-code__t3_machine_read")).toEqual({
      machineCard: card,
    });
    expect(compactDynamicToolOutput(output)).toBeUndefined();
    expect(compactDynamicToolOutput(output, "html_render")).toBeUndefined();
  });

  it("keeps the live card when its snapshot does not decode", () => {
    for (const machineCard of [
      { environmentId: "environment:mac" },
      { environmentId: "environment:mac", snapshot: { ...snapshot, verdict: "bogus" } },
      { environmentId: "environment:mac", snapshot: "frozen" },
    ]) {
      expect(
        machineCardFromToolItem({ toolName: "t3_machine_read", output: { machineCard } }),
      ).toEqual({ environmentId: "environment:mac" });
    }
    expect(
      machineCardFromToolItem({
        toolName: "t3_machine_read",
        output: { machineCard: { environmentId: " ", snapshot } },
      }),
    ).toBeUndefined();
  });

  it("prunes threads before the app's csp, the app, then the card's snapshot", () => {
    const threads = Array.from({ length: 60 }, (_, index) => ({
      threadId: `thread-${index}-${"t".repeat(120)}`,
    }));
    expect(compactDynamicToolOutput({ threads, machineCard: card })).toEqual({ machineCard: card });

    const withCsp = compactDynamicToolOutput({ t3McpApp: app(32), machineCard: card });
    expect(withCsp).toEqual({ t3McpApp: app(0), machineCard: card });

    const bigUri = { ...app(0), resourceUri: `ui://weather/${"u".repeat(4_000)}` };
    const heavy = { environmentId: "environment:mac", snapshot: heavySnapshot(5_000) };
    expect(compactDynamicToolOutput({ t3McpApp: bigUri, machineCard: heavy })).toEqual({
      machineCard: heavy,
    });

    const heavier = { environmentId: "e".repeat(256), snapshot: heavySnapshot(9_000) };
    const pruned = compactDynamicToolOutput(
      { taskId: "task-1", t3McpApp: app(32), machineCard: heavier },
      "t3_machine_read",
    );
    expect(pruned).toEqual({ taskId: "task-1", machineCard: { environmentId: "e".repeat(256) } });
    expect(bytes(pruned)).toBeLessThanOrEqual(8_192);
  });

  it("compares cards by value, so a rebuilt card is the same card", () => {
    const rebuilt = machineCardFromToolItem({
      toolName: "t3_machine_read",
      output: JSON.stringify({ machineCard: card }),
    });
    if (rebuilt === undefined) throw new Error("Expected a card");
    expect(machineCardsEqual(rebuilt, structuredClone(card) as typeof rebuilt)).toBe(true);
    expect(machineCardsEqual(rebuilt, { environmentId: "environment:mac" })).toBe(false);
    expect(
      machineCardsEqual(rebuilt, {
        ...rebuilt,
        snapshot: { ...snapshot, verdict: "ok", reason: null } as NonNullable<
          typeof rebuilt.snapshot
        >,
      }),
    ).toBe(false);
  });
});
