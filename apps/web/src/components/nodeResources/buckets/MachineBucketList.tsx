import { useAtomValue } from "@effect/atom-react";
import { formatPercent, formatProcessMemory } from "@t3tools/client-runtime/state/machineFormat";
import {
  AuthSettingsWriteScope,
  type BucketRule,
  type EnvironmentId,
  MACHINE_BUCKET_NAME_MAX,
  MACHINE_BUCKETS_MAX,
  type MachineActor,
  type MachineBucket,
  MachineBucketId,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";

import { type MachineOwnerNames, ownerNamesAtom, ruleThreadsAtom } from "../ownership/ownerNames";
import type { OwnerTotals } from "../ownership/processOwners";
import {
  bucketRulesError,
  emptyMatchRule,
  formatBucketRule,
  normalizedRules,
} from "../primitives/BucketRuleLogic";
import { BucketRuleList } from "../primitives/BucketRuleFields";
import { MachineSection, MachineSectionMessage } from "../primitives/MachineSection";
import { OwnerChip } from "../primitives/OwnerChip";
import { ownerLabel } from "../primitives/OwnerLabel";
import { Unmeasured } from "../primitives/Unmeasured";
import { ownershipWrites } from "./ownershipWrites";

/** Live totals per bucket, from the task manager's process stream. */
export interface BucketLiveTotals {
  readonly totals: ReadonlyMap<string, OwnerTotals>;
  /** The stream has no host-wide rows (T3's own subtree only), so bucket totals can't be known. */
  readonly unmeasured: boolean;
  readonly showGpu: boolean;
  readonly colorOf: (bucketId: MachineBucketId) => string | undefined;
}

interface Draft {
  readonly id: MachineBucketId;
  readonly isNew: boolean;
  readonly name: string;
  readonly rules: ReadonlyArray<BucketRule>;
}

const newDraft = (): Draft => ({
  id: MachineBucketId.make(`bucket_${randomUUID()}`),
  isNew: true,
  name: "",
  rules: [emptyMatchRule()],
});

const editDraft = (bucket: MachineBucket): Draft => ({
  id: bucket.id,
  isNew: false,
  name: bucket.name,
  rules: bucket.rules,
});

function draftError(draft: Draft): string | null {
  const name = draft.name.trim();
  if (name.length === 0) return "Enter a name";
  if (name.length > MACHINE_BUCKET_NAME_MAX) return `At most ${MACHINE_BUCKET_NAME_MAX} characters`;
  return bucketRulesError(draft.rules);
}

/**
 * A machine's buckets: named match rules over its processes, saved to that machine's server
 * settings one entry at a time. The server stamps who made each one. Shared by the task manager
 * (with live totals) and Connections settings.
 */
export function MachineBucketList({
  environmentId,
  live,
}: {
  readonly environmentId: EnvironmentId;
  readonly live?: BucketLiveTotals;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const writes = ownershipWrites({
    config,
    canWrite: useEnvironmentScope(environmentId, AuthSettingsWriteScope),
  });
  const canWrite = writes === "allowed";
  const names = useAtomValue(ownerNamesAtom(environmentId));
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<MachineBucket | null>(null);
  const buckets = Object.values(config?.settings.machineResources.buckets ?? {}).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
  const full = buckets.length >= MACHINE_BUCKETS_MAX;

  const save = (next: Draft) => {
    setDraft(null);
    updateSettings(
      {
        machineResources: {
          buckets: {
            [next.id]: { id: next.id, name: next.name.trim(), rules: normalizedRules(next.rules) },
          },
        },
      },
      // The settings write toasts the failure; the draft comes back so nothing typed is lost.
      { onFailed: () => setDraft(next) },
    );
  };
  const remove = (bucket: MachineBucket) => {
    setDeleting(null);
    if (draft?.id === bucket.id) setDraft(null);
    updateSettings({ machineResources: { buckets: { [bucket.id]: null } } });
  };

  return (
    <MachineSection
      title="Buckets"
      detail={buckets.length > 0 ? buckets.length : undefined}
      actions={
        canWrite ? (
          <Button
            size="xs"
            variant="outline"
            disabled={full || draft?.isNew === true}
            onClick={() => setDraft(newDraft())}
          >
            <PlusIcon />
            New bucket
          </Button>
        ) : undefined
      }
    >
      {writes === "olderServer" ? (
        <MachineSectionMessage>This server is older and can't save buckets.</MachineSectionMessage>
      ) : null}
      {buckets.length === 0 ? null : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Rules</TableHead>
              <TableHead>Pins</TableHead>
              <TableHead>Made by</TableHead>
              {live ? (
                <>
                  <TableHead className="text-end">Proc</TableHead>
                  <TableHead className="text-end">CPU</TableHead>
                  <TableHead className="text-end">Mem</TableHead>
                  {live.showGpu ? <TableHead className="text-end">GPU</TableHead> : null}
                </>
              ) : null}
              {canWrite ? (
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {buckets.map((bucket) => (
              <TableRow key={bucket.id}>
                <TableCell>
                  <OwnerChip
                    label={{ kind: "bucket", text: bucket.name }}
                    color={cssVar(live?.colorOf(bucket.id))}
                  />
                </TableCell>
                <TableCell>
                  <span className="block max-w-64 truncate">{rulesText(bucket, names)}</span>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-muted-foreground">{pinsText(bucket)}</span>
                </TableCell>
                <TableCell>
                  <ActorLabel actor={bucket.provenance.createdBy} names={names} />
                </TableCell>
                {live ? <BucketTotalsCells live={live} bucketId={bucket.id} /> : null}
                {canWrite ? (
                  <TableCell className="text-end">
                    <Button size="xs" variant="ghost" onClick={() => setDraft(editDraft(bucket))}>
                      Edit
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost-destructive"
                      onClick={() => setDeleting(bucket)}
                    >
                      Delete
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {draft && canWrite ? (
        <BucketEditor
          // A fresh editor per bucket, so switching buckets drops the other's unsaved edits.
          key={draft.id}
          environmentId={environmentId}
          draft={draft}
          onSave={save}
          onCancel={() => setDraft(null)}
        />
      ) : null}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete bucket {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its processes count toward their next owner, or Other. Nothing is stopped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => deleting && remove(deleting)}>
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </MachineSection>
  );
}

const cssVar = (name: string | undefined) => (name === undefined ? undefined : `var(${name})`);

function rulesText(bucket: MachineBucket, names: MachineOwnerNames): string {
  const rules = bucket.rules.filter((rule) => rule.field !== "pid");
  return rules.map((rule) => formatBucketRule(rule, names.threadTitle)).join(" or ");
}

function pinsText(bucket: MachineBucket): string | null {
  const pins = bucket.rules.flatMap((rule) => (rule.field === "pid" ? [String(rule.pid)] : []));
  return pins.length === 0 ? null : pins.join(", ");
}

function ActorLabel({
  actor,
  names,
}: {
  readonly actor: MachineActor;
  readonly names: MachineOwnerNames;
}) {
  if (actor.type === "user") return <span>You</span>;
  const chip = (
    <OwnerChip label={ownerLabel({ type: "thread", threadId: actor.threadId }, names)} />
  );
  if (actor.type === "agent") return chip;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="text-muted-foreground">Auto</span>
      {chip}
    </span>
  );
}

function BucketTotalsCells({
  live,
  bucketId,
}: {
  readonly live: BucketLiveTotals;
  readonly bucketId: MachineBucketId;
}) {
  const totals = live.totals.get(bucketId);
  const cell = (value: ReactNode) => (
    <TableCell className="text-end">
      <span className="tabular-nums">{value}</span>
    </TableCell>
  );
  if (live.unmeasured) {
    return (
      <>
        {cell(<Unmeasured />)}
        {cell(<Unmeasured />)}
        {cell(<Unmeasured />)}
        {live.showGpu ? cell(<Unmeasured />) : null}
      </>
    );
  }
  return (
    <>
      {cell(String(totals?.count ?? 0))}
      {cell(formatPercent(totals?.cpu ?? 0))}
      {cell(formatProcessMemory(totals?.rss ?? 0))}
      {live.showGpu
        ? cell(totals?.gpuUtil === null ? <Unmeasured /> : formatPercent(totals?.gpuUtil ?? 0))
        : null}
    </>
  );
}

function BucketEditor({
  environmentId,
  draft: initial,
  onSave,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly draft: Draft;
  readonly onSave: (draft: Draft) => void;
  readonly onCancel: () => void;
}) {
  const threads = useAtomValue(ruleThreadsAtom(environmentId));
  const [draft, setDraft] = useState(initial);
  const [showError, setShowError] = useState(false);
  const error = draftError(draft);
  return (
    <form
      aria-label={initial.isNew ? "New bucket" : `Edit ${initial.name}`}
      className="flex max-w-2xl flex-col gap-2 rounded-lg border p-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        if (error !== null) return setShowError(true);
        onSave(draft);
      }}
    >
      <Input
        size="compact"
        aria-label="Bucket name"
        placeholder="Name"
        value={draft.name}
        onChange={(event) => {
          const name = event.currentTarget.value;
          setDraft((current) => ({ ...current, name }));
        }}
      />
      <span className="text-muted-foreground">Match any</span>
      <BucketRuleList
        rules={draft.rules}
        threads={threads}
        onChange={(rules) => setDraft((current) => ({ ...current, rules }))}
      />
      <div className="flex items-center justify-end gap-2">
        {showError && error !== null ? (
          <span role="alert" className="me-auto text-error-foreground">
            {error}
          </span>
        ) : null}
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="xs">
          Save
        </Button>
      </div>
    </form>
  );
}
