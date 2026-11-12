import {
  getDescriptorStringValue,
  isReasoningSelect,
  replaceDescriptorCurrentValue,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { buildProviderOptionSelectionsFromDescriptors } from "@t3tools/shared/model";

import type { GlintModelParams, GlintModelSelection } from "../../lib/glint";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";
import { getTraitsSectionVisibility } from "./TraitsPicker";

type Traits = ReturnType<typeof getTraitsSectionVisibility>;
type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

/** The two speed controls the web picker's footer offers: a Fast switch, or a Fast service tier. */
function speedOf(traits: Traits) {
  if (traits.fastModeDescriptor) {
    return { kind: "toggle" as const, fast: traits.fastModeDescriptor.currentValue === true };
  }
  const tier = traits.selectDescriptors.find((descriptor) => descriptor.id === "serviceTier");
  const fastTier = tier?.options.find((option) => option.label === "Fast");
  const standardTier = tier?.options.find(
    (option) => option.label !== "Fast" && option.label !== "Ultrafast",
  );
  if (!tier || !fastTier || !standardTier) return null;
  return {
    kind: "tier" as const,
    descriptor: tier,
    fastId: fastTier.id,
    standardId: standardTier.id,
    fast: getDescriptorStringValue(tier) === fastTier.id,
  };
}

function effortOf(traits: Traits) {
  const descriptor: SelectDescriptor | null =
    traits.selectDescriptors.find(isReasoningSelect) ?? null;
  const efforts = descriptor ? selectableProviderOptionChoices(descriptor).map(({ id }) => id) : [];
  return { descriptor, efforts, current: getDescriptorStringValue(descriptor) };
}

/** What the native picker offers: the same instances and models as the web picker. */
export function buildGlintModelParams(input: {
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly lockedContinuationGroupKey: string | null;
  readonly getModelDisabledReason?: (
    instanceId: ProviderInstanceId,
    model: string,
  ) => string | null;
  readonly selection: { readonly instanceId: ProviderInstanceId; readonly model: string };
  /** The selected model's traits as the composer shows them. */
  readonly selectedTraits: Traits | null;
}): GlintModelParams | null {
  const providers = input.instanceEntries.flatMap((entry) => {
    if (!isProviderInstancePickerReady(entry)) return [];
    if (input.lockedProvider !== null) {
      if (entry.driverKind !== input.lockedProvider) return [];
      if (
        input.lockedContinuationGroupKey &&
        entry.continuationGroupKey !== input.lockedContinuationGroupKey
      ) {
        return [];
      }
    }
    const models = (input.modelOptionsByInstance.get(entry.instanceId) ?? []).flatMap((model) => {
      if (model.isUnavailable) return [];
      if (entry.driverKind === "antigravity" && model.slug === ANTIGRAVITY_DEFAULT_MODEL) return [];
      if (input.getModelDisabledReason?.(entry.instanceId, model.slug)) return [];
      const traits = getTraitsSectionVisibility({
        provider: entry.driverKind,
        models: entry.models,
        model: model.slug,
      });
      const effort = effortOf(traits);
      return [
        {
          id: model.slug,
          name: model.name,
          efforts: effort.efforts,
          ...(effort.current ? { defaultEffort: effort.current } : {}),
          supportsFast: speedOf(traits) !== null,
        },
      ];
    });
    return models.length > 0 ? [{ id: entry.instanceId, name: entry.displayName, models }] : [];
  });
  if (providers.length === 0) return null;
  const effort = input.selectedTraits ? effortOf(input.selectedTraits) : null;
  const speed = input.selectedTraits ? speedOf(input.selectedTraits) : null;
  return {
    providers,
    selection: {
      provider: input.selection.instanceId,
      model: input.selection.model,
      ...(effort?.current ? { effort: effort.current } : {}),
      ...(speed ? { fast: speed.fast } : {}),
    },
  };
}

/**
 * The model options a native pick writes for its model, given that model's current traits, or null
 * when they already match. Effort follows the web column's rules: a typed Ultrathink in the body
 * keeps it, and one in the prefix is dropped (`stripUltrathinkPrefix`).
 */
export function resolveGlintModelOptions(
  traits: Traits,
  pick: Pick<GlintModelSelection, "effort" | "fast">,
): {
  readonly modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  readonly stripUltrathinkPrefix: boolean;
} | null {
  let descriptors = traits.descriptors;
  let stripUltrathinkPrefix = false;
  const effort = effortOf(traits);
  if (
    pick.effort !== undefined &&
    effort.descriptor &&
    effort.efforts.includes(pick.effort) &&
    !(traits.ultrathinkInBodyText && effort.descriptor.id === traits.primarySelectDescriptor?.id)
  ) {
    const isPrimary = effort.descriptor.id === traits.primarySelectDescriptor?.id;
    const shown = isPrimary && traits.ultrathinkPromptControlled ? "ultrathink" : effort.current;
    if (pick.effort !== shown) {
      descriptors = replaceDescriptorCurrentValue(descriptors, effort.descriptor.id, pick.effort);
      stripUltrathinkPrefix = isPrimary && traits.ultrathinkPromptControlled;
    }
  }
  const speed = speedOf(traits);
  if (pick.fast !== undefined && speed && pick.fast !== speed.fast) {
    descriptors =
      speed.kind === "toggle"
        ? replaceDescriptorCurrentValue(descriptors, "fastMode", pick.fast)
        : replaceDescriptorCurrentValue(
            descriptors,
            speed.descriptor.id,
            pick.fast ? speed.fastId : speed.standardId,
          );
  }
  if (descriptors === traits.descriptors) return null;
  return {
    modelOptions: buildProviderOptionSelectionsFromDescriptors(descriptors),
    stripUltrathinkPrefix,
  };
}
