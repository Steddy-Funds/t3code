#!/usr/bin/env node
// Stands in for Glint's native helper: answers each `present` with a canned value after a delay.
// GLINT_MOCK_MODE: result (default) | cancel | error | crash | silent (never ready).
// GLINT_MOCK_DELAY_MS: dialog time, default 800. GLINT_MOCK_LOG: a file for one line per request.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const mode = process.env.GLINT_MOCK_MODE ?? "result";
const delayMs = Number(process.env.GLINT_MOCK_DELAY_MS ?? 800);
const logPath = process.env.GLINT_MOCK_LOG;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const log = (message) => {
  process.stderr.write(`glint-mock: ${JSON.stringify(message)}\n`);
  if (logPath) NodeFS.appendFileSync(logPath, `${JSON.stringify(message)}\n`);
};

function cannedValue(kind, params) {
  if (kind === "timeFromNow") {
    return { date: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() };
  }
  if (kind === "color") return { hex: "#3A7BD5", action: "pick" };
  // The model after the selected one, at its highest effort, with fast mode flipped.
  const selection = params?.selection ?? {};
  const provider = params?.providers?.find((candidate) => candidate.id === selection.provider);
  const models = provider?.models ?? [];
  const index = models.findIndex((model) => model.id === selection.model);
  const model = models[(index + 1) % Math.max(models.length, 1)];
  if (!provider || !model) return { selection };
  return {
    selection: {
      provider: provider.id,
      model: model.id,
      ...(model.efforts.length > 0 ? { effort: model.efforts.at(-1) } : {}),
      ...(model.supportsFast ? { fast: !selection.fast } : {}),
    },
  };
}

let current = null;

function finish(id, message) {
  if (current?.id !== id) return;
  clearTimeout(current.timer);
  current = null;
  send({ ...message, id });
}

if (mode !== "silent") send({ type: "ready", version: 1 });

NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log(message);
  if (message.type === "dismiss") {
    finish(message.id, { type: "cancelled" });
    return;
  }
  if (message.type !== "present") return;
  if (current) finish(current.id, { type: "cancelled" });
  if (mode === "crash") process.exit(3);
  const { id, kind, params } = message;
  current = {
    id,
    timer: setTimeout(() => {
      if (mode === "cancel") finish(id, { type: "cancelled" });
      else if (mode === "error") finish(id, { type: "error", message: "mock error" });
      else finish(id, { type: "result", value: cannedValue(kind, params) });
    }, delayMs),
  };
});
