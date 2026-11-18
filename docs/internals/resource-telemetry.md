# Resource telemetry

Process counters come from a [standalone Rust monitor](../../native/resource-monitor/src/main.rs)
using `sysinfo`. Electron main supplies host power and Electron process metrics.
Keeping native collection outside Node isolates collector crashes and avoids a
Node/Electron addon ABI matrix. Desktop and CLI servers use the same child-process
protocol. A missing or failed collector leaves the server running.

## Collection cost

The native child owns sampling and bounded in-memory history. It samples on a timer
only while diagnostics has live subscribers. With none, the server sends a sample
interval of 0 and the child samples only on request, so an idle server never walks
the process table. The exception is OTLP metrics export: a server exporting metrics
requests one sample a minute and exports process totals by group
([`ProcessGroupMetrics`](../../apps/server/src/resourceTelemetry/ProcessGroupMetrics.ts)),
because the user asked for continuous telemetry. Groups are a fixed set named after
the server's direct children, never process IDs or threads, so the series count
stays bounded as agents come and go. Diagnostics history therefore covers only time with a live
subscriber, plus on-demand and export samples. Consuming host power for background scheduling must not retain
live diagnostics. There is no telemetry database or recurring shell-probe fallback.

The one always-on process walk is the
[`ResourceSampler`](../../apps/server/src/resourceTelemetry/ResourceSampler.ts): a host-mode
stream of every process on the machine, every 5 s for the server's lifetime, each sample
attributed once by
[`ProcessOwnership`](../../apps/server/src/resourceTelemetry/ProcessOwnership.ts). Every
reader takes its latest sample: per-thread totals, process tables (a live view only raises the
stream's rate and fields while it is open), the MCP machine tools and the load monitor. None of
them walks the host or attributes on its own, so the cost does not grow with readers. On a host
with about 11k processes, 250 owning threads and 3.5k threads with 3.2k subagent links, one
sample costs about 14 ms of the server's main thread (decode about 3 ms, attribution about 9 ms,
per-thread sums about 2 ms). Attribution looks cgroups and containers up by path, never by
scanning every root or claim. Claims stay in memory and end with the process, the container or
the thread.

Per-thread totals
([`ThreadResources`](../../apps/server/src/resourceTelemetry/ThreadResources.ts)) sum each
sample's processes by owning thread once, then add each owning thread into its subagent
ancestors, so a lineage read is a lookup. Members of shared roots are split by the
`T3CODE_THREAD_ID` in their environment. CPU is the monitor's per-process figure and memory is
resident bytes, so `source` is always `sample`. History
([`ThreadResourceHistory`](../../apps/server/src/resourceTelemetry/ResourceTelemetryHistory.ts))
averages each 30 s window into one point for every lineage holding a running turn, so idle time
shows as a gap rather than filler. It is in memory only, in fixed rings: 240 points for each of
at most 200 threads. A window's close drops archived and deleted threads. No state is kept per
process outside attribution, whose memos are pruned to the live processes on every sample.

## Machine verdict

The machine verdict (ok, stressed, unknown) is always on, so it must stay cheap.
[`HostResources`](../../apps/server/src/resourceTelemetry/HostResources.ts) reads host totals
on the shared 5 s `Scheduler` tick: CPU counters, load average, memory and swap, never the
process table. [`stepVerdict`](../../packages/shared/src/nodeVerdict.ts) folds each tick
with hysteresis, and the server pushes a snapshot only when the verdict or its rule changes,
plus a 30 s heartbeat. Clients judge staleness by their own receipt time, so the heartbeat
must stay well inside the client's 75 s expiry. Per-core samples run on their own fiber only
while a view subscribes with an interval.

On macOS the RAM rule needs the memory-pressure level, which Node cannot read, so each tick
asks the native monitor for `hostTotals`. Without a monitor, or while it restarts, memory reads
unknown and the load rule still works; there is no shell fallback. Each tick also asks for
`gpuTotals`, merged into the totals for the GPU rules; without a monitor they skip.

The same tick feeds a one-hour ring of Float32Array columns (totals, per-core, GPU devices),
bounded at 512 KB. Only the first snapshot of a subscription that asks for `historyMs`
carries it, quantised to permille, so a heartbeat never repeats it.

The monitor's host mode (protocol 4) walks every process on the machine, not just the
server's tree. The sampler keeps it streaming (`setHostStreaming`) at 5 s; views raise the rate
and add GPU fields while they are open. Host samples never enter the native history. Static fields (command, cwd, user, cgroup) are read once per process
identity, and the client keeps that table per monitor generation. `gpuTotals` reads device
totals only, so it rides the always-on 5 s tick, and live views reuse that tick's reading
rather than querying at their own rate; a suspended GPU is never woken to read it. Each vendor
backend counts its own failures and turns off alone after three in a row; the monitor sends
`gpu-unavailable` only when the last one does. GPU code runs inside the monitor, so a crash
while GPU work was in flight (a pending GPU request, or host streaming with GPUs) also blames
the GPUs. After either, GPUs stay off until the server restarts; a crash with no GPU work in
flight restarts the monitor with GPUs on. A protocol 3 binary still works without the host
features.

History has independent bounds for age, snapshot count, process rows, and retained
bytes. A count limit alone cannot bound memory when command lines vary in size.
Large process trees therefore shorten the available history window. Linux task
enumeration is disabled because walking every `/proc/<pid>/task/<tid>` directory
makes sampling itself expensive.

Electron power updates travel over private inherited pipes, independent of the
renderer connection. Power events and slow heartbeats continue with diagnostics
closed; `app.getAppMetrics()` runs only on live demand. The receiver's stale deadline
must exceed the slowest configured heartbeat plus scheduling grace, or intentional
idle polling makes background policy oscillate between constrained and
unconstrained states. Headless servers leave unavailable power data unknown.

## Measurement traps

- Process identity includes start time because operating systems reuse PIDs.
  Electron and native start times have different precision, so merging allows a
  small tolerance. Process signaling rechecks the native identity with a fresh
  sample.
- Kill sends SIGTERM and Force kill sends SIGKILL. Servers older than host mode accept
  only INT and KILL, so clients offer those there. On Windows every signal is
  TerminateProcess, so there is a single Kill. The server refuses pid 1 and below, itself
  and its ancestors, the monitor, and any process whose start time no longer matches the
  fresh sample, so a reused PID is never signalled.
- Snapshot sequence numbers belong to a monitor generation. Comparing them across
  restarts would discard the new monitor's samples until its sequence caught up.
- Sampling can miss a process that starts and exits between samples. Cumulative
  counters still yield deltas for processes observed across samples.
- Windows process I/O includes more than disk traffic. Unix counters report storage
  I/O, which can differ from logical application reads and writes because of OS
  caching. Keep instrumented logical I/O separate from these counters.
- Group totals accumulate observed deltas since telemetry started. Per-process
  cumulative counters cover the operating system's lifetime for that process.
- Historical replay uses native samples without current Electron CPU or memory
  metrics. Merging the latest Electron values would overwrite the past.

A WSL backend needs a Linux monitor even though Electron runs on Windows. Windows
desktop packages currently supply only the Windows executable, so native process
telemetry for the WSL backend is unavailable. The inherited Electron power feed
still works.

## Load management

Off unless `machineResources.loadManagement.enabled`. Two independent halves act on the verdict.

**`t3 guard`** ([`cli/guard.ts`](../../apps/server/src/cli/guard.ts)) runs inside provider
sandboxes and pod containers, often with no access to the server's `node_modules`. It is
therefore its own `guard.mjs` bundle of `node:*` plus our packages only
([`vite.config.ts`](../../apps/server/vite.config.ts) fails the build if a dependency sneaks in),
and reads a resolved `guard.json` rather than calling the server
([`LoadGuard`](../../apps/server/src/resourceTelemetry/LoadGuard.ts)). The command stays in the guard's
process group, so a provider or a thread interrupt that kills that group stops both; a detached
command would outlive the guard and keep loading the machine. Sharing the group means a group
signal already reached the command, and Node cannot tell it from a `kill <guard pid>`: the guard
forwards SIGTERM only to a command still running 1 s later (a slower graceful shutdown still sees
a second SIGTERM), and never forwards SIGINT, which the tty sends to the whole group. At kill time the guard walks the
command's descendants by ppid and rechecks each start time right before signalling, never itself,
its ancestors or pid 1, and still SIGKILLs stragglers after the command exits on SIGTERM. The
limit follows: a double-forked daemon reparented to init, or a process in another container
(`docker exec`), escapes the kill.

**Pauses** ([`LoadPauseWorker`](../../apps/server/src/orchestration-v2/LoadPauseWorker.ts),
policy in [`LoadPausePolicy`](../../apps/server/src/orchestration-v2/LoadPausePolicy.ts)) interrupt
and later continue a thread, never SIGSTOP it. The traps:

- **Record before acting.** The `thread.load-pause.set` command, carrying the containers it will
  pause, commits before any `docker pause`. Every path that clears the pause (resume, archive,
  delete, lane off) unpauses from that record, so a crash between the two leaves at worst an
  unpause that finds nothing to do, never a container frozen with no owner.
- **Startup reconcile.** The first sweep after start, and every switch from on to off, clears
  every recorded pause, archived threads included. Pauses never survive a restart, so no
  in-memory state needs persisting.
- **Never act on:** a container any non-victim still claims, a container whose cgroup holds the
  server itself, and, after a fresh `docker inspect` under the claim's `DOCKER_HOST`, one whose
  full id or state no longer matches or whose pid is 1 or the server's
  ([`LoadPauseDocker`](../../apps/server/src/orchestration-v2/LoadPauseDocker.ts)). Claims and
  the pause episode are re-read just before each `docker pause`, since a claim or a user resume
  can land between selection and action. Unpause gets the same identity check, so a container recreated since is left alone.
- **Never pause** a thread the user can see or is needed by: see `isPausable` in the policy. The
  focus lease is the `thread` `BackgroundScope` that fork clients report.
