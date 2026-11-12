import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMachineBucketsModel } from "./machineBuckets.ts";
import { createModelSelection } from "./model.ts";

const DRIVERS = ["codex", "claudeAgent", "cursor", "grok", "muse", "pi", "opencode", "antigravity"];

/** Settings with exactly the named default instances enabled. */
const withEnabled = (
  enabled: ReadonlyArray<string>,
  modelSelection: ServerSettings["machineResources"]["autoBuckets"]["modelSelection"] = null,
): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: Object.fromEntries(
    DRIVERS.map((driver) => [
      ProviderInstanceId.make(driver),
      { driver: ProviderDriverKind.make(driver), enabled: enabled.includes(driver), config: {} },
    ]),
  ),
  machineResources: {
    ...DEFAULT_SERVER_SETTINGS.machineResources,
    autoBuckets: { ...DEFAULT_SERVER_SETTINGS.machineResources.autoBuckets, modelSelection },
  },
});

describe("resolveMachineBucketsModel", () => {
  it("uses the chosen model while its provider is enabled", () => {
    const chosen = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4-mini", [
      { id: "effort", value: "low" },
    ]);
    expect(resolveMachineBucketsModel(withEnabled(["codex", "claudeAgent"], chosen))).toBe(chosen);
  });

  it("falls back to the cheap model of an enabled provider when the chosen one is off", () => {
    const chosen = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4-mini");
    for (const settings of [withEnabled(["claudeAgent"], chosen), withEnabled(["claudeAgent"])]) {
      const model = resolveMachineBucketsModel(settings);
      expect(model?.instanceId).toBe("claudeAgent");
      expect(model?.model).toMatch(/haiku/i);
    }
  });

  it("gives no model when no provider is enabled", () => {
    const chosen = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4-mini");
    expect(resolveMachineBucketsModel(withEnabled([], chosen))).toBeNull();
    expect(resolveMachineBucketsModel(withEnabled([]))).toBeNull();
  });
});
