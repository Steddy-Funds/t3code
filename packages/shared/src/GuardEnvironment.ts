import * as Context from "effect/Context";

export const GUARD_ENV = "T3CODE_GUARD";
export const GUARD_CONFIG_ENV = "T3CODE_GUARD_CONFIG";

export interface GuardEnvironmentShape {
  /** `T3CODE_GUARD` and `T3CODE_GUARD_CONFIG` while load management is on; empty otherwise. Read at spawn. */
  readonly env: () => Readonly<Record<string, string>>;
}

/** Empty unless the server provides one, so provider packages can spread it unconditionally. */
export const GuardEnvironment = Context.Reference<GuardEnvironmentShape>(
  "@t3tools/shared/GuardEnvironment",
  { defaultValue: () => ({ env: () => ({}) }) },
);
