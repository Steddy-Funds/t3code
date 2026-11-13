#!/usr/bin/env node
// Stands in for Glint's helper. GLINT_MOCK_MODE: result | cancel | error | crash | silent.
// GLINT_MOCK_DELAY_MS: dialog time (800). GLINT_MOCK_LOG: a file for one line per request.
// GLINT_MOCK_VERSION=2 takes input: Return accepts, Escape cancels, a click answers `clicked`.
// GLINT_MOCK_DEAF=1 hears that input and never answers.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const mode = process.env.GLINT_MOCK_MODE ?? "result";
const delayMs = Number(process.env.GLINT_MOCK_DELAY_MS ?? 800);
const logPath = process.env.GLINT_MOCK_LOG;
const version = Number(process.env.GLINT_MOCK_VERSION ?? 1);
const deaf = process.env.GLINT_MOCK_DEAF === "1";

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

if (mode !== "silent") {
  send(
    version === 2
      ? { type: "ready", version, input: ["key", "click"] }
      : { type: "ready", version },
  );
}

NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log(message);
  if (message.type === "dismiss") {
    finish(message.id, { type: "cancelled" });
    return;
  }
  if (version === 2 && message.type === "key" && typeof message.key !== "string") {
    send({ type: "error", id: null, message: "key needs a key" });
    return;
  }
  if (
    version === 2 &&
    current?.id === message.id &&
    (message.type === "key" || message.type === "click")
  ) {
    if (deaf) return;
    if (message.key === "return") {
      finish(message.id, { type: "result", value: cannedValue(current.kind, current.params) });
      return;
    }
    if (message.key === "escape") {
      finish(message.id, { type: "cancelled" });
      return;
    }
    if (message.type === "click") {
      send({ type: "clicked", id: message.id });
      return;
    }
  }
  // Live input on an open dialog answers with a `changed`, as the palette's would.
  if ((message.type === "input" || message.type === "key") && current?.id === message.id) {
    send({
      type: "changed",
      id: message.id,
      path: [],
      highlighted: message.key ?? null,
      text: message.text,
    });
    return;
  }
  if (message.type !== "present") return;
  if (current) finish(current.id, { type: "cancelled" });
  if (mode === "crash") process.exit(3);
  const { id, kind, params } = message;
  current = {
    id,
    kind,
    params,
    timer: setTimeout(() => {
      if (mode === "cancel") finish(id, { type: "cancelled" });
      else if (mode === "error") finish(id, { type: "error", message: "mock error" });
      else finish(id, { type: "result", value: cannedValue(kind, params) });
    }, delayMs),
  };
});
