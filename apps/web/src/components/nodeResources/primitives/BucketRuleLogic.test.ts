import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type BucketRule,
  MAX_BUCKET_RULES,
  MAX_RULE_VALUE_LENGTH,
  bucketRuleError,
  bucketRulesError,
  formatBucketRule,
  normalizedRules,
  withField,
} from "./BucketRuleLogic";

const THREAD = ThreadId.make("thread-a");
const OTHER_THREAD = ThreadId.make("thread-b");

const exe = (value: string): BucketRule => ({ field: "exe", op: "equals", value });
const threadRule = (threadId = THREAD): BucketRule => ({ field: "thread", threadId });
const pinRule = (pid: number, startTimeMs: number): BucketRule => ({
  field: "pid",
  pid,
  startTimeMs,
});

describe("bucketRuleError", () => {
  it.each<[string, BucketRule, string | null]>([
    ["a value", exe("cargo"), null],
    ["empty", exe(""), "Enter a value"],
    ["whitespace only", exe("  \t\n "), "Enter a value"],
    ["exactly the cap", exe("x".repeat(MAX_RULE_VALUE_LENGTH)), null],
    ["the cap once trimmed", exe(`  ${"x".repeat(MAX_RULE_VALUE_LENGTH)}  `), null],
    ["over the cap", exe("x".repeat(MAX_RULE_VALUE_LENGTH + 1)), "At most 1024 characters"],
    ["thread rule", threadRule(), null],
    ["pid rule", pinRule(1, 0), null],
  ])("%s", (_name, rule, expected) => {
    expect(bucketRuleError(rule)).toBe(expected);
  });
});

describe("bucketRulesError", () => {
  const sixteen = Array.from({ length: MAX_BUCKET_RULES }, (_, index) => exe(`bin-${index}`));

  it.each<[string, ReadonlyArray<BucketRule>, string | null]>([
    ["no rules", [], "Add a rule"],
    ["one valid rule", [exe("cargo")], null],
    ["exactly the rule cap", sixteen, null],
    ["over the rule cap", [...sixteen, exe("bin-16")], "At most 16 rules"],
    ["over the cap wins over an empty value", [...sixteen, exe("")], "At most 16 rules"],
    ["first per-rule error", [exe("cargo"), exe(" "), exe("x".repeat(2000))], "Enter a value"],
    [
      "per-rule error wins over a duplicate",
      [exe("cargo"), exe("cargo"), exe("")],
      "Enter a value",
    ],
    ["exact duplicate", [exe("cargo"), exe("cargo")], "Remove the duplicate rule"],
    ["duplicate once trimmed", [exe("cargo"), exe(" cargo ")], "Remove the duplicate rule"],
    [
      "same value on another op",
      [exe("cargo"), { field: "exe", op: "contains", value: "cargo" }],
      null,
    ],
    [
      "same value on another field",
      [exe("cargo"), { field: "command", op: "equals", value: "cargo" }],
      null,
    ],
    ["values differ only in case", [exe("cargo"), exe("Cargo")], null],
    ["same thread twice", [threadRule(), threadRule()], "Remove the duplicate rule"],
    ["two threads", [threadRule(), threadRule(OTHER_THREAD)], null],
    ["same pin twice", [pinRule(42, 1000), pinRule(42, 1000)], "Remove the duplicate rule"],
    ["reused pid, another start time", [pinRule(42, 1000), pinRule(42, 2000)], null],
  ])("%s", (_name, rules, expected) => {
    expect(bucketRulesError(rules)).toBe(expected);
  });
});

describe("withField", () => {
  const glob: BucketRule = { field: "command", op: "glob", value: "cargo *" };

  it("keeps op and value between match fields", () => {
    expect(withField(glob, "cwd", THREAD)).toEqual({ field: "cwd", op: "glob", value: "cargo *" });
  });

  it("points a switch to thread at the first thread offered", () => {
    expect(withField(glob, "thread", THREAD)).toEqual({ field: "thread", threadId: THREAD });
  });

  it("refuses a switch to thread with no thread to offer", () => {
    expect(withField(glob, "thread", undefined)).toBeNull();
    expect(withField(pinRule(1, 0), "thread", undefined)).toBeNull();
  });

  it("keeps a thread rule's thread when thread is picked again", () => {
    const rule = threadRule(OTHER_THREAD);
    expect(withField(rule, "thread", THREAD)).toBe(rule);
    expect(withField(rule, "thread", undefined)).toBe(rule);
  });

  it.each<[string, BucketRule]>([
    ["thread", threadRule()],
    ["pid", pinRule(42, 1000)],
  ])("turns a %s rule into an empty equals rule on a match field", (_name, rule) => {
    expect(withField(rule, "user", THREAD)).toEqual({ field: "user", op: "equals", value: "" });
  });
});

describe("normalizedRules", () => {
  it("trims match values and leaves thread and pid rules as they are", () => {
    const thread = threadRule();
    const pin = pinRule(42, 1000);
    expect(
      normalizedRules([
        exe("  cargo "),
        { field: "cwd", op: "contains", value: "/srv/app\n" },
        thread,
        pin,
      ]),
    ).toEqual([exe("cargo"), { field: "cwd", op: "contains", value: "/srv/app" }, thread, pin]);
  });

  it("keeps interior whitespace", () => {
    expect(normalizedRules([exe(" cargo  build ")])).toEqual([exe("cargo  build")]);
  });
});

describe("formatBucketRule", () => {
  const title = (threadId: ThreadId) => (threadId === THREAD ? "Native monitor v4" : undefined);

  it.each<[BucketRule, string]>([
    [exe("cargo"), "exe = cargo"],
    [{ field: "command", op: "contains", value: "vite" }, "command contains vite"],
    [{ field: "cwd", op: "glob", value: "/srv/*" }, "cwd matches /srv/*"],
    [threadRule(), "thread Native monitor v4"],
    [threadRule(OTHER_THREAD), "thread thread-b"],
    [pinRule(48190, 1000), "PID 48190"],
  ])("%j → %s", (rule, expected) => {
    expect(formatBucketRule(rule, title)).toBe(expected);
  });
});
