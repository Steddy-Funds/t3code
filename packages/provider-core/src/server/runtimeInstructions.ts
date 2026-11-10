import type { ThreadAutonomy } from "@t3tools/contracts";

/** Session-invariant; harnesses with a native system-prompt append can carry it once per session. */
export const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: link_pull_request, or link_pull_requests for several, full URL, every stack layer, as your next call. Host tools do not link for you. If linking fails, say so. Skip PRs you only read or review, and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch.
</pull_request_linking>`;

/** Per-turn, not per-session: the flag can change between turns and must survive compaction. */
export function buildAutonomyInstructions(input: {
  readonly autonomy: ThreadAutonomy;
  /** A subagent or delegated task, whose questions go to its parent thread. */
  readonly delegated: boolean;
}): string {
  if (input.autonomy === "on") {
    const routing = input.delegated
      ? " This is a delegated thread: your decisions and questions go to your parent thread, not the user."
      : "";
    return `<autonomy>
Autonomy is on for this thread, an experimental flag the user set. Never ask the user to confirm an option you recommend that can be undone: take it, log it under "Deferred decisions" in your final report and in the body of any PR you open, and keep going. Never ask about a step of your own work cycle: tests, lint, review, commit, push, a draft PR, fixing its checks or conflicts. Stop and ask only for: money or live paid calls, production, destructive or irreversible actions, merging into a base branch the user merges, and a hold the user set. A load per core above 9.0 (1-minute load average divided by CPU cores; t3_machine_read shows it): wait and re-check before heavy work, don't ask. A real product question: keep building the reversible default meanwhile, and ask once, in one line, with that default. On hold: stay quiet, don't ask again. An answer or grant the user gave once holds for this thread and its children, also after compaction.${routing} Give these rules to native subagents you start; delegated tasks inherit them.
</autonomy>`;
  }
  if (input.autonomy === "off") {
    const askee = input.delegated ? "your parent thread" : "the user";
    return `<autonomy>
Autonomy is off for this thread: the user set it. Before a product or scope decision, even one that can be undone, ask ${askee} and wait. This overrides any instruction to take defaults on your own.
</autonomy>`;
  }
  return "";
}

/** Omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** False when the session's system prompt already carries the linking instructions. */
  readonly pullRequestLinking?: boolean;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const runtimeInfo = `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio in your response using Markdown image syntax with absolute file paths. Link any other file you produce using its absolute path so the user can open it in T3 Code's files viewer.</runtime_info>`;
  return runtime.pullRequestLinking === false
    ? runtimeInfo
    : `${runtimeInfo}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
