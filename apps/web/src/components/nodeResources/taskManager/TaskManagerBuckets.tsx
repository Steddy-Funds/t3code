import { useAtomValue } from "@effect/atom-react";
import {
  formatAge,
  formatPercent,
  formatProcessMemory,
} from "@t3tools/client-runtime/state/machineFormat";
import type { MachineProcessRow } from "@t3tools/client-runtime/state/machineProcessFrames";
import {
  AuthDiagnosticsReadScope,
  type Claim,
  type ClaimTarget,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, type Atom } from "effect/reactivity";

import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useNowMinute } from "~/hooks/useNowMinute";
import { machineResources } from "~/state/machineResources";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { type BucketLiveTotals, MachineBucketList } from "../buckets/MachineBucketList";
import { ownershipWrites } from "../buckets/ownershipWrites";
import { ownerNamesAtom } from "../ownership/ownerNames";
import { ownerPaletteAtom, type ProcessesResult } from "../ownership/ownerPalette";
import { type OwnerTotals, ownerBucketId, totalsBy } from "../ownership/processOwners";
import { MachineSection, MachineSectionMessage } from "../primitives/MachineSection";
import { OwnerChip } from "../primitives/OwnerChip";
import { ownerLabel } from "../primitives/OwnerLabel";
import { Unmeasured } from "../primitives/Unmeasured";

const NO_ROWS: ReadonlyArray<MachineProcessRow> = [];

const claimIdOf = (row: MachineProcessRow) =>
  row.owner?.type === "claimed" ? row.owner.claimId : null;

/** Buckets with live totals, and the machine's claims with release. */
export function TaskManagerBuckets({
  environmentId,
  processes,
}: {
  readonly environmentId: EnvironmentId;
  readonly processes: Atom.Atom<ProcessesResult>;
}) {
  const table = Option.getOrNull(AsyncResult.value(useAtomValue(processes)));
  const palette = useAtomValue(ownerPaletteAtom(processes));
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const rows = table?.rows ?? NO_ROWS;
  const showGpu = rows.some((row) => "gpuUtil" in row);
  // T3's own subtree can't show a bucket's host processes, so its totals would read as a false 0.
  const unmeasured = table === null || table.source !== "host";
  const live: BucketLiveTotals = {
    totals: totalsBy(rows, (row) => ownerBucketId(row.owner)),
    unmeasured,
    showGpu,
    colorOf: (bucketId) => palette.colorOf(`bucket:${bucketId}`),
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <MachineBucketList environmentId={environmentId} live={live} />
      {canReadDiagnostics ? (
        table?.claims === undefined ? null : (
          <ClaimList
            environmentId={environmentId}
            claims={table.claims}
            totals={totalsBy(rows, claimIdOf)}
            unmeasured={unmeasured}
            showGpu={showGpu}
            colorOf={(threadId) => palette.colorOf(`thread:${threadId}`)}
          />
        )
      ) : (
        <MachineSection title="Claims">
          <MachineSectionMessage>Claims need diagnostics access</MachineSectionMessage>
        </MachineSection>
      )}
    </div>
  );
}

function ClaimList({
  environmentId,
  claims,
  totals,
  unmeasured,
  showGpu,
  colorOf,
}: {
  readonly environmentId: EnvironmentId;
  readonly claims: ReadonlyArray<Claim>;
  readonly totals: ReadonlyMap<string, OwnerTotals>;
  readonly unmeasured: boolean;
  readonly showGpu: boolean;
  readonly colorOf: (threadId: Claim["threadId"]) => string | undefined;
}) {
  const names = useAtomValue(ownerNamesAtom(environmentId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const writes = ownershipWrites({
    config,
    canWrite: useAtomValue(machineResources.releaseClaim.permissionAtom(environmentId)),
  });
  const canRelease = writes === "allowed";
  const releaseClaim = useAtomCommand(machineResources.releaseClaim);
  // The tick is a UTC "YYYY-MM-DDTHH:mm"; without a zone Date.parse would read it as local time.
  const nowMs = Date.parse(`${useNowMinute()}:00Z`);
  return (
    <MachineSection title="Claims" detail={claims.length > 0 ? claims.length : undefined}>
      {claims.length === 0 ? null : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Target</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Thread</TableHead>
                <TableHead>Since</TableHead>
                <TableHead>Ends when</TableHead>
                <TableHead className="text-end">CPU</TableHead>
                <TableHead className="text-end">Mem</TableHead>
                {showGpu ? <TableHead className="text-end">GPU</TableHead> : null}
                {canRelease ? (
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {claims.map((claim) => {
                const color = colorOf(claim.threadId);
                const measured = !unmeasured && claim.measurable !== false;
                const claimTotals = totals.get(claim.id);
                const ageMs = nowMs - DateTime.toEpochMillis(claim.createdAt);
                return (
                  <TableRow key={claim.id}>
                    <TableCell>
                      <span className="block max-w-56 truncate font-mono">
                        {targetText(claim.target)}
                      </span>
                    </TableCell>
                    <TableCell>{claim.target.type}</TableCell>
                    <TableCell>
                      <OwnerChip
                        label={ownerLabel({ type: "thread", threadId: claim.threadId }, names)}
                        color={color === undefined ? undefined : `var(${color})`}
                      />
                    </TableCell>
                    <TableCell>
                      <span className="tabular-nums">
                        {ageMs < 60_000 ? "< 1 m" : formatAge(ageMs)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground">
                        {endsWhen(claim.target)} · or thread deleted
                      </span>
                    </TableCell>
                    <TableCell className="text-end">
                      <span className="tabular-nums">
                        {measured ? formatPercent(claimTotals?.cpu ?? 0) : <Unmeasured />}
                      </span>
                    </TableCell>
                    <TableCell className="text-end">
                      <span className="tabular-nums">
                        {measured ? formatProcessMemory(claimTotals?.rss ?? 0) : <Unmeasured />}
                      </span>
                    </TableCell>
                    {showGpu ? (
                      <TableCell className="text-end">
                        <span className="tabular-nums">
                          {!measured || claimTotals?.gpuUtil === null ? (
                            <Unmeasured />
                          ) : (
                            formatPercent(claimTotals?.gpuUtil ?? 0)
                          )}
                        </span>
                      </TableCell>
                    ) : null}
                    {canRelease ? (
                      <TableCell className="text-end">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            void releaseClaim({ environmentId, input: { claimId: claim.id } })
                          }
                        >
                          Remove
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {canRelease ? (
            <p className="text-xs text-muted-foreground">
              Removing a claim returns its load to Other; it doesn't stop the process.
            </p>
          ) : writes === "olderServer" ? (
            <p className="text-xs text-muted-foreground">
              This server is older and can't remove claims.
            </p>
          ) : null}
        </>
      )}
    </MachineSection>
  );
}

function targetText(target: ClaimTarget): string {
  switch (target.type) {
    case "process":
      return `PID ${target.pid} + descendants`;
    case "container":
      return target.id;
    case "cgroup":
      return target.path;
  }
}

function endsWhen(target: ClaimTarget): string {
  switch (target.type) {
    case "process":
      return "process exits";
    case "container":
      return "container is removed";
    case "cgroup":
      return "cgroup is removed";
  }
}
