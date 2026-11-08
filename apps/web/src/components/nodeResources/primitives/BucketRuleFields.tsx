import type { ThreadId } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import {
  BUCKET_MATCH_FIELDS,
  BUCKET_MATCH_OPS,
  type BucketRule,
  bucketRuleError,
  emptyMatchRule,
  FIELD_LABELS,
  isMatchRule,
  MAX_BUCKET_RULES,
  OP_LABELS,
  withField,
} from "./BucketRuleLogic";

export interface RuleThread {
  readonly id: ThreadId;
  readonly title: string;
}

const EDITABLE_FIELDS = [...BUCKET_MATCH_FIELDS, "thread"] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];
const isEditableField = (value: unknown): value is EditableField =>
  EDITABLE_FIELDS.some((field) => field === value);

/** One match rule: field, op and value, or a thread. Pins are not edited here (see `BucketRuleList`). */
export function BucketRuleField({
  rule,
  threads,
  onChange,
  onRemove,
}: {
  readonly rule: Exclude<BucketRule, { readonly field: "pid" }>;
  /** Threads a `thread` rule may point at; with none, the thread field is not offered. */
  readonly threads: ReadonlyArray<RuleThread>;
  readonly onChange: (rule: BucketRule) => void;
  readonly onRemove: () => void;
}) {
  const error = bucketRuleError(rule);
  const fields =
    threads.length > 0 || rule.field === "thread" ? EDITABLE_FIELDS : BUCKET_MATCH_FIELDS;
  const selectField = (value: unknown) => {
    if (!isEditableField(value)) return;
    const next = withField(rule, value, threads[0]?.id);
    if (next) onChange(next);
  };
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Select value={rule.field} onValueChange={selectField}>
        <SelectTrigger size="xs" className="w-24 shrink-0" aria-label="Rule field">
          <SelectValue>{FIELD_LABELS[rule.field]}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {fields.map((field) => (
            <SelectItem key={field} value={field}>
              {FIELD_LABELS[field]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {isMatchRule(rule) ? (
        <>
          <Select
            value={rule.op}
            onValueChange={(op) => {
              const next = BUCKET_MATCH_OPS.find((candidate) => candidate === op);
              if (next) onChange({ ...rule, op: next });
            }}
          >
            <SelectTrigger size="xs" className="w-24 shrink-0" aria-label="Rule match">
              <SelectValue>{OP_LABELS[rule.op]}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {BUCKET_MATCH_OPS.map((op) => (
                <SelectItem key={op} value={op}>
                  {OP_LABELS[op]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Input
            size="compact"
            className="min-w-0 flex-1"
            aria-label="Rule value"
            aria-invalid={error !== null && rule.value.length > 0}
            placeholder={rule.op === "glob" ? "pod-*" : "cargo"}
            value={rule.value}
            onChange={(event) => onChange({ ...rule, value: event.currentTarget.value })}
          />
        </>
      ) : (
        <Select
          value={rule.threadId}
          onValueChange={(threadId) => {
            const thread = threads.find((candidate) => candidate.id === threadId);
            if (thread) onChange({ field: "thread", threadId: thread.id });
          }}
        >
          <SelectTrigger size="xs" className="min-w-0 flex-1" aria-label="Rule thread">
            <SelectValue>
              {threads.find((thread) => thread.id === rule.threadId)?.title ?? rule.threadId}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {threads.map((thread) => (
              <SelectItem key={thread.id} value={thread.id}>
                {thread.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
      <Button variant="ghost" size="icon-xs" aria-label="Remove rule" onClick={onRemove}>
        <XIcon />
      </Button>
    </div>
  );
}

/**
 * A bucket's rules, matched as "any": editable match rules, then pins (PID rules, added from the
 * process list and dropped when the process exits), which can only be removed.
 */
export function BucketRuleList({
  rules,
  threads,
  onChange,
}: {
  readonly rules: ReadonlyArray<BucketRule>;
  readonly threads: ReadonlyArray<RuleThread>;
  readonly onChange: (rules: ReadonlyArray<BucketRule>) => void;
}) {
  const replace = (index: number, rule: BucketRule | null) =>
    onChange(
      rule === null
        ? rules.filter((_, at) => at !== index)
        : rules.map((current, at) => (at === index ? rule : current)),
    );
  const pins = rules.flatMap((rule, index) => (rule.field === "pid" ? [{ rule, index }] : []));
  const full = rules.length >= MAX_BUCKET_RULES;
  return (
    <div className="flex flex-col gap-1.5">
      {rules.map((rule, index) =>
        rule.field === "pid" ? null : (
          <BucketRuleField
            // oxlint-disable-next-line react/no-array-index-key -- rules have no id; edits replace a row in place
            key={index}
            rule={rule}
            threads={threads}
            onChange={(next) => replace(index, next)}
            onRemove={() => replace(index, null)}
          />
        ),
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="ghost"
          size="xs"
          disabled={full}
          onClick={() => onChange([...rules, emptyMatchRule()])}
        >
          <PlusIcon />
          Rule
        </Button>
        {pins.map(({ rule, index }) => (
          <Badge key={`${rule.pid}:${rule.startTimeMs}`} variant="outline">
            <span className="font-mono">PID {rule.pid}</span>
            <Button
              variant="ghost"
              size="icon-tiny"
              aria-label={`Unpin PID ${rule.pid}`}
              onClick={() => replace(index, null)}
            >
              <XIcon />
            </Button>
          </Badge>
        ))}
      </div>
    </div>
  );
}
