import { describe, expect, it } from "vite-plus/test";

import { processProviderGroup } from "./processProviderGroup.ts";

describe("processProviderGroup", () => {
  it.each([
    ["claude", "claude --resume", "claude"],
    ["Claude", "", "claude"],
    ["codex", "codex app-server", "codex"],
    ["cursor-agent", "cursor-agent", "cursor"],
    ["opencode", "opencode serve", "opencode"],
    ["grok", "grok", "grok"],
    ["antigravity", "antigravity", "antigravity"],
    ["gemini", "gemini --acp", "antigravity"],
  ])("matches %s by name", (name, command, group) => {
    expect(processProviderGroup(name, command)).toBe(group);
  });

  it.each([
    ["node", "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", "claude"],
    ["node.exe", "node.exe C:\\npm\\codex\\bin\\codex.js", "codex"],
    ["bun", "bun run /home/u/.bun/bin/opencode", "opencode"],
    ["deno", "deno run gemini-cli.ts", "antigravity"],
    ["node", "node /srv/app/server.js", undefined],
  ])("matches a script runtime %s by its command", (name, command, group) => {
    expect(processProviderGroup(name, command)).toBe(group);
  });

  it.each([
    ["zsh", "zsh -c claude --resume"],
    ["git", "git -C /work/codex status"],
    ["nodemon", "nodemon claude.js"],
  ])("ignores a provider named only in %s's arguments", (name, command) => {
    expect(processProviderGroup(name, command)).toBeUndefined();
  });
});
