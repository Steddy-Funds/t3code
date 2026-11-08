import type { ThreadId } from "@t3tools/contracts";

// Stand-in for the nr3-ownership `BucketRule` (b3 shape); swap for the contract import once
// `machineResources.ts` carries it.
export const BUCKET_MATCH_FIELDS = [
  "command",
  "exe",
  "cwd",
  "user",
  "container",
  "parent",
] as const;
export const BUCKET_MATCH_OPS = ["equals", "contains", "glob"] as const;
export type BucketMatchField = (typeof BUCKET_MATCH_FIELDS)[number];
export type BucketMatchOp = (typeof BUCKET_MATCH_OPS)[number];

export type BucketRule =
  | { readonly field: BucketMatchField; readonly op: BucketMatchOp; readonly value: string }
  | { readonly field: "thread"; readonly threadId: ThreadId }
  | { readonly field: "pid"; readonly pid: number; readonly startTimeMs: number };

export type BucketRuleField = BucketRule["field"];
type MatchRule = Extract<BucketRule, { readonly op: BucketMatchOp }>;

export const MAX_BUCKET_RULES = 16;
export const MAX_RULE_VALUE_LENGTH = 1024;

export const FIELD_LABELS: Record<BucketRuleField, string> = {
  command: "command",
  exe: "exe",
  cwd: "cwd",
  user: "user",
  container: "container",
  parent: "parent",
  thread: "thread",
  pid: "PID",
};

export const OP_LABELS: Record<BucketMatchOp, string> = {
  equals: "=",
  contains: "contains",
  glob: "matches",
};

export const isMatchRule = (rule: BucketRule): rule is MatchRule => "op" in rule;

export const emptyMatchRule = (field: BucketMatchField = "exe"): MatchRule => ({
  field,
  op: "equals",
  value: "",
});

/**
 * The rule after the user picks another field. Match fields keep the op and value; switching to
 * `thread` needs a thread to point at, so it is `null` when there is none to offer.
 */
export function withField(
  rule: BucketRule,
  field: BucketMatchField | "thread",
  firstThread: ThreadId | undefined,
): BucketRule | null {
  if (field === "thread") {
    if (rule.field === "thread") return rule;
    return firstThread === undefined ? null : { field, threadId: firstThread };
  }
  return isMatchRule(rule) ? { ...rule, field } : emptyMatchRule(field);
}

/** Why the rule can't be saved, or null when it can. */
export function bucketRuleError(rule: BucketRule): string | null {
  if (!isMatchRule(rule)) return null;
  const value = rule.value.trim();
  if (value.length === 0) return "Enter a value";
  if (value.length > MAX_RULE_VALUE_LENGTH) return `At most ${MAX_RULE_VALUE_LENGTH} characters`;
  return null;
}

const ruleKey = (rule: BucketRule) =>
  isMatchRule(rule)
    ? `${rule.field}:${rule.op}:${rule.value.trim()}`
    : rule.field === "thread"
      ? `thread:${rule.threadId}`
      : `pid:${rule.pid}:${rule.startTimeMs}`;

/** The first problem with a bucket's rules as a whole, or null. Per-rule problems come first. */
export function bucketRulesError(rules: ReadonlyArray<BucketRule>): string | null {
  if (rules.length === 0) return "Add a rule";
  if (rules.length > MAX_BUCKET_RULES) return `At most ${MAX_BUCKET_RULES} rules`;
  for (const rule of rules) {
    const error = bucketRuleError(rule);
    if (error !== null) return error;
  }
  const keys = new Set(rules.map(ruleKey));
  return keys.size === rules.length ? null : "Remove the duplicate rule";
}

/** Values are saved trimmed, so `exe = cargo ` and `exe = cargo` are one rule. */
export const normalizedRules = (rules: ReadonlyArray<BucketRule>): BucketRule[] =>
  rules.map((rule) => (isMatchRule(rule) ? { ...rule, value: rule.value.trim() } : rule));

/** A rule in one line: `exe = cargo`, `thread Native monitor v4`, `PID 48190`. */
export function formatBucketRule(
  rule: BucketRule,
  threadTitle: (threadId: ThreadId) => string | undefined,
): string {
  if (isMatchRule(rule)) return `${FIELD_LABELS[rule.field]} ${OP_LABELS[rule.op]} ${rule.value}`;
  if (rule.field === "thread") return `thread ${threadTitle(rule.threadId) ?? rule.threadId}`;
  return `PID ${rule.pid}`;
}
