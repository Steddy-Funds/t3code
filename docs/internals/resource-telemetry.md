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
stays bounded as agents come and go. History therefore covers only time with a live
subscriber, plus on-demand and export samples. Consuming host power for background scheduling must not retain
live diagnostics. There is no telemetry database or recurring shell-probe fallback.

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
server's tree, so it runs only while a view streams it (`setHostStreaming`) or on one
request (`hostSampleNow`), and it frees its process table when streaming stops. Host samples
never enter history. Static fields (command, cwd, user, cgroup) are read once per process
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
