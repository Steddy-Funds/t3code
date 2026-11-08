import {
  type ModelSelection,
  resolveProviderInstanceEnabled,
  type ServerSettings,
} from "@t3tools/contracts";

import {
  fallbackTextGenerationModelSelection,
  isModelSelectionProviderEnabled,
} from "./serverSettings.ts";

/** The built-in auto-buckets task's prompt. Model-facing: change it with its eval (`evals/`). */
export const MACHINE_BUCKETS_PROMPT = `Group this machine's unbucketed processes into buckets, so its task manager shows what is using it. Nobody is watching this run: never ask a question or wait for input, and stop when done.

1. Call \`t3_machine_read\` with \`processes: { unbucketed: true, limit: 50 }\`: the busiest processes no thread, claim or bucket owns, and their share of the machine.
2. Call \`t3_machine_buckets\` with \`action: "list"\`.
3. Create or update at most 5 buckets with \`t3_machine_buckets\` \`upsert\`, one per program or stack that accounts for real CPU or memory:
   - Name each after what it is, such as "Postgres" or "Docker: web stack".
   - Use general rules that keep matching after a restart: \`exe\` equals, \`command\` glob on its stable prefix (\`node */next dev*\`), \`container\`, or \`cwd\`. Never \`pid\` or \`thread\` rules.
   - Update only buckets whose \`provenance.updatedBy.type\` is \`auto\`. Leave every other bucket alone, even if it looks wrong; to cover more, create a new bucket.
   - Skip one-off and short-lived processes.
4. If nothing groups sensibly, change nothing. Reply with one line saying what you created or updated.`;

/**
 * The auto-buckets model: the chosen one while its provider is enabled, else the cheap
 * text-generation model of the first enabled provider (Haiku for Claude). Null when none is.
 */
export function resolveMachineBucketsModel(settings: ServerSettings): ModelSelection | null {
  const chosen = settings.machineResources.autoBuckets.modelSelection;
  if (chosen !== null && isModelSelectionProviderEnabled(settings, chosen)) return chosen;
  return fallbackTextGenerationModelSelection(settings.providerInstances, (instanceId, driver) =>
    resolveProviderInstanceEnabled(
      settings.providerInstances[instanceId] ?? { driver, config: {} },
    ),
  );
}
