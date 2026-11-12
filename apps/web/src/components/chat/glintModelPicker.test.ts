import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { buildGlintModelParams, resolveGlintModelOptions } from "./glintModelPicker";
import { getTraitsSectionVisibility } from "./TraitsPicker";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const effort: ProviderOptionDescriptor = {
  id: "effort",
  label: "Effort",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
    { id: "ultrathink", label: "Ultrathink" },
  ],
  currentValue: "high",
  promptInjectedValues: ["ultrathink"],
};
const fastMode: ProviderOptionDescriptor = { id: "fastMode", label: "Fast", type: "boolean" };
const models: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "opus",
    name: "Opus",
    isCustom: false,
    capabilities: { optionDescriptors: [effort, fastMode] },
  },
  { slug: "haiku", name: "Haiku", isCustom: false, capabilities: { optionDescriptors: [] } },
];

function entry(id: string, ready: boolean): ProviderInstanceEntry {
  return {
    instanceId: ProviderInstanceId.make(id),
    driverKind: CLAUDE,
    displayName: id,
    enabled: true,
    isAvailable: ready,
    status: "ready",
    models,
  } as unknown as ProviderInstanceEntry;
}

const traits = (
  modelOptions?: ReadonlyArray<{ id: string; value: string | boolean }>,
  prompt?: "prefix",
) =>
  getTraitsSectionVisibility({
    provider: CLAUDE,
    models,
    model: "opus",
    modelOptions,
    ...(prompt ? { promptUltrathink: prompt } : {}),
  });

describe("buildGlintModelParams", () => {
  it("offers the ready instances' models with their pickable efforts and speed", () => {
    const params = buildGlintModelParams({
      instanceEntries: [entry("claude", true), entry("claude-work", false)],
      modelOptionsByInstance: new Map(
        ["claude", "claude-work"].map((id) => [ProviderInstanceId.make(id), models]),
      ),
      lockedProvider: null,
      lockedContinuationGroupKey: null,
      getModelDisabledReason: (_instanceId, model) => (model === "haiku" ? "Not here" : null),
      selection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
      selectedTraits: traits([{ id: "fastMode", value: true }]),
    });
    expect(params).toEqual({
      providers: [
        {
          id: "claude",
          name: "claude",
          models: [
            {
              id: "opus",
              name: "Opus",
              efforts: ["low", "high"],
              defaultEffort: "high",
              supportsFast: true,
            },
          ],
        },
      ],
      selection: { provider: "claude", model: "opus", effort: "high", fast: true },
    });
  });
});

describe("resolveGlintModelOptions", () => {
  it("writes a changed effort and speed, and nothing for an unchanged pick", () => {
    expect(resolveGlintModelOptions(traits(), { effort: "low", fast: true })).toEqual({
      modelOptions: [
        { id: "effort", value: "low" },
        { id: "fastMode", value: true },
      ],
      stripUltrathinkPrefix: false,
    });
    expect(resolveGlintModelOptions(traits(), { effort: "high", fast: false })).toBeNull();
    expect(resolveGlintModelOptions(traits(), { effort: "ultrathink" })).toBeNull();
  });

  it("drops an Ultrathink prefix when the pick sets another effort", () => {
    expect(resolveGlintModelOptions(traits(undefined, "prefix"), { effort: "high" })).toEqual({
      modelOptions: [{ id: "effort", value: "high" }],
      stripUltrathinkPrefix: true,
    });
  });
});
