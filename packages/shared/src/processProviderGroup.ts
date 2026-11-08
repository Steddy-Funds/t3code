// A fixed set, so server metrics keep one series per provider and clients group the same way.
const PROVIDER_GROUPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/codex/, "codex"],
  [/claude/, "claude"],
  [/cursor/, "cursor"],
  [/opencode/, "opencode"],
  [/grok/, "grok"],
  [/antigravity|gemini/, "antigravity"],
  [/kiro/, "kiro"],
  [/muse/, "muse"],
  // Two-letter names match only as a whole executable or script name.
  [/(?:^|[/\\])pi(?:\.exe|\.[cm]?js)?(?:\s|$)/, "pi"],
  [/(?:^|[/\\])fx(?:\.exe|\.[cm]?js)?(?:\s|$)/, "fx"],
];
// A CLI shipped as a script runs under a JavaScript runtime, so its process name is the
// runtime's (older Claude packages run `node .../@anthropic-ai/claude-code/cli.js`). Only those
// are matched by command line; any other name is matched by name alone, so a shell or `git`
// whose arguments mention a provider stays out of the provider's group.
const SCRIPT_RUNTIME = /^(?:node|bun|deno)(?:\.exe)?$/;

/** The provider a process belongs to by its own name or script, such as "claude"; else undefined. */
export function processProviderGroup(name: string, command: string): string | undefined {
  const lowerName = name.toLowerCase();
  const text = SCRIPT_RUNTIME.test(lowerName) ? command.toLowerCase() : lowerName;
  return PROVIDER_GROUPS.find(([pattern]) => pattern.test(text))?.[1];
}
