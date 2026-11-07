use std::collections::{HashMap, HashSet, VecDeque};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{
    MINIMUM_CPU_UPDATE_INTERVAL, Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind,
};

use crate::protocol::{
    ExternalProcess, IoSemantics, PROTOCOL_VERSION, ProcessSample, SnapshotEvent,
};

const PROCESS_START_TIME_PRECISION_MS: u64 = 1_000;
pub(crate) const MAX_PROCESS_NAME_BYTES: usize = 1_024;
const MAX_PROCESS_COMMAND_BYTES: usize = 16 * 1_024;
const MAX_PROCESS_STATUS_BYTES: usize = 256;
const TWO_STAGE_PROCESS_REFRESH: bool = cfg!(any(target_os = "linux", target_os = "macos"));

#[derive(Debug, Clone)]
pub(crate) struct CollectorConfig {
    pub(crate) root_pid: u32,
    pub(crate) sample_interval: Option<Duration>,
    pub(crate) external_processes: HashMap<u32, Option<u64>>,
    pub(crate) claimed_processes: HashMap<u32, Option<u64>>,
}

/// Claims past this many are dropped, so a runaway claimer cannot grow every sample's walk.
pub(crate) const MAX_CLAIMED_PROCESSES: usize = 256;

/// Process identities keyed by pid; a later duplicate pid wins.
pub(crate) fn identity_map(processes: Vec<ExternalProcess>) -> HashMap<u32, Option<u64>> {
    processes
        .into_iter()
        .map(|process| (process.pid, process.start_time_ms))
        .collect()
}

/// The claimed set from a `setClaimedProcesses` command: the first 256, in the order sent.
pub(crate) fn claimed_identities(mut processes: Vec<ExternalProcess>) -> HashMap<u32, Option<u64>> {
    processes.truncate(MAX_CLAIMED_PROCESSES);
    identity_map(processes)
}

pub(crate) struct Collector {
    system: System,
    sequence: u64,
    cpu_baseline_refreshed_at: Option<Instant>,
}

impl Collector {
    pub(crate) fn new() -> Self {
        Self {
            system: System::new(),
            sequence: 0,
            cpu_baseline_refreshed_at: None,
        }
    }

    pub(crate) fn prime_cpu_usage(&mut self) {
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            process_discovery_refresh_kind(),
        );
        self.cpu_baseline_refreshed_at = Some(Instant::now());
    }

    pub(crate) fn sample(
        &mut self,
        config: &CollectorConfig,
        request_id: Option<String>,
    ) -> SnapshotEvent {
        if let Some(delay) =
            remaining_cpu_measurement_delay(self.cpu_baseline_refreshed_at.take(), Instant::now())
        {
            thread::sleep(delay);
        }
        let collection_started = Instant::now();
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            process_discovery_refresh_kind(),
        );
        self.cpu_baseline_refreshed_at = Some(Instant::now());

        let rows = self
            .system
            .processes()
            .iter()
            .map(|(pid, process)| {
                let pid = pid.as_u32();
                let ppid = process.parent().map(Pid::as_u32).unwrap_or(0);
                (pid, ppid, process.start_time().saturating_mul(1_000))
            })
            .collect::<Vec<_>>();
        let external_processes = live_external_processes(&rows, &config.external_processes);
        let claimed_processes = live_external_processes(&rows, &config.claimed_processes);
        let mut roots = external_processes
            .iter()
            .chain(&claimed_processes)
            .map(|process| process.pid)
            .collect::<HashSet<_>>();
        roots.insert(config.root_pid);
        let tracked = select_tracked_pids(&rows, &roots);
        let claimed_pids = (!config.claimed_processes.is_empty()).then(|| {
            let claimed_roots = claimed_processes
                .iter()
                .map(|process| process.pid)
                .collect();
            let mut pids = select_tracked_pids(&rows, &claimed_roots)
                .into_iter()
                .collect::<Vec<_>>();
            pids.sort_unstable();
            pids
        });
        let tracked_process_count = tracked.len();
        let process_details = if TWO_STAGE_PROCESS_REFRESH && !tracked.is_empty() {
            let monitor_pid = Pid::from_u32(std::process::id());
            let mut detail_pids = tracked
                .iter()
                .copied()
                .map(Pid::from_u32)
                .collect::<Vec<_>>();
            if !tracked.contains(&monitor_pid.as_u32()) {
                detail_pids.push(monitor_pid);
            }
            // Detail fields need no baseline. Drop command data and OS handles after each sample.
            let mut details = System::new();
            details.refresh_processes_specifics(
                ProcessesToUpdate::Some(&detail_pids),
                true,
                process_refresh_kind().without_cpu(),
            );
            // This process cannot be replaced during collection. Its start time
            // exposes any boot-epoch shift between the two System instances.
            let start_time_offset = self.system.process(monitor_pid).and_then(|process| {
                details.process(monitor_pid).map(|detail| {
                    i128::from(detail.start_time()) - i128::from(process.start_time())
                })
            });
            Some((details, start_time_offset))
        } else {
            None
        };
        let sample_details = process_details
            .as_ref()
            .map_or(&self.system, |(details, _)| details);
        let start_time_offset = process_details
            .as_ref()
            .map_or(Some(0), |(_, offset)| *offset);
        let mut processes = tracked
            .into_iter()
            .filter_map(|pid| {
                let process = self.system.process(Pid::from_u32(pid))?;
                let details = sample_details.process(Pid::from_u32(pid))?;
                if !matches_process_start_time(
                    process.start_time(),
                    details.start_time(),
                    start_time_offset?,
                ) {
                    return None;
                }
                let disk_usage = details.disk_usage();
                let command = if details.cmd().is_empty() {
                    process.name().to_string_lossy().into_owned()
                } else {
                    details
                        .cmd()
                        .iter()
                        .map(|part| part.to_string_lossy())
                        .collect::<Vec<_>>()
                        .join(" ")
                };

                Some(ProcessSample {
                    pid,
                    ppid: process.parent().map(Pid::as_u32).unwrap_or(0),
                    start_time_ms: process.start_time().saturating_mul(1_000),
                    run_time_ms: process.run_time().saturating_mul(1_000),
                    name: truncate_utf8(
                        process.name().to_string_lossy().into_owned(),
                        MAX_PROCESS_NAME_BYTES,
                    ),
                    command: truncate_utf8(command, MAX_PROCESS_COMMAND_BYTES),
                    status: truncate_utf8(
                        format!("{:?}", process.status()),
                        MAX_PROCESS_STATUS_BYTES,
                    ),
                    cpu_percent: process.cpu_usage(),
                    cpu_time_ms: process.accumulated_cpu_time(),
                    resident_bytes: details.memory(),
                    virtual_bytes: details.virtual_memory(),
                    io_read_bytes: disk_usage.total_read_bytes,
                    io_write_bytes: disk_usage.total_written_bytes,
                    io_semantics: io_semantics(),
                })
            })
            .collect::<Vec<_>>();
        drop(process_details);
        processes.sort_by_key(|process| process.pid);
        self.sequence = self.sequence.saturating_add(1);

        SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: self.sequence,
            sampled_at_unix_ms: unix_time_ms(),
            collection_duration_micros: collection_started.elapsed().as_micros() as u64,
            scanned_process_count: self.system.processes().len(),
            retained_process_count: processes.len(),
            inaccessible_process_count: inaccessible_process_count(
                tracked_process_count,
                processes.len(),
            ),
            request_id,
            external_processes,
            processes,
            claimed_processes: claimed_pids.is_some().then_some(claimed_processes),
            claimed_pids,
        }
    }
}

fn live_external_processes(
    rows: &[(u32, u32, u64)],
    expected: &HashMap<u32, Option<u64>>,
) -> Vec<ExternalProcess> {
    expected
        .iter()
        .filter_map(|(pid, expected_start_time_ms)| {
            let (_, _, actual_start_time_ms) = rows
                .iter()
                .find(|(candidate_pid, _, _)| candidate_pid == pid)?;
            matches_external_identity(*actual_start_time_ms, *expected_start_time_ms).then_some(
                ExternalProcess {
                    pid: *pid,
                    start_time_ms: Some(*actual_start_time_ms),
                },
            )
        })
        .collect()
}

// Keep CPU baselines separate. Even a metadata refresh resets Linux process times.
fn process_discovery_refresh_kind() -> ProcessRefreshKind {
    if TWO_STAGE_PROCESS_REFRESH {
        ProcessRefreshKind::nothing().with_cpu().without_tasks()
    } else {
        process_refresh_kind()
    }
}

fn process_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_memory()
        .with_cpu()
        .with_disk_usage()
        .with_cmd(UpdateKind::Always)
        .without_tasks()
}

fn inaccessible_process_count(selected: usize, materialized: usize) -> usize {
    selected.saturating_sub(materialized)
}

pub(crate) fn matches_process_start_time(discovered: u64, detail: u64, epoch_offset: i128) -> bool {
    i128::from(detail) - epoch_offset == i128::from(discovered)
}

fn remaining_cpu_measurement_delay(
    baseline_refreshed_at: Option<Instant>,
    now: Instant,
) -> Option<Duration> {
    baseline_refreshed_at
        .and_then(|baseline| MINIMUM_CPU_UPDATE_INTERVAL.checked_sub(now.duration_since(baseline)))
        .filter(|delay| !delay.is_zero())
}

fn matches_external_identity(
    actual_start_time_ms: u64,
    expected_start_time_ms: Option<u64>,
) -> bool {
    // Match sysinfo's whole-second precision without admitting reused PIDs from adjacent seconds.
    expected_start_time_ms.is_none_or(|expected| {
        actual_start_time_ms == expected - (expected % PROCESS_START_TIME_PRECISION_MS)
    })
}

fn select_tracked_pids(rows: &[(u32, u32, u64)], roots: &HashSet<u32>) -> HashSet<u32> {
    let mut children_by_parent = HashMap::<u32, Vec<(u32, u64)>>::new();
    let mut start_time_by_pid = HashMap::<u32, u64>::new();
    for (pid, ppid, start_time_ms) in rows {
        children_by_parent
            .entry(*ppid)
            .or_default()
            .push((*pid, *start_time_ms));
        start_time_by_pid.insert(*pid, *start_time_ms);
    }

    let mut tracked = HashSet::new();
    let mut visited_identities = HashSet::new();
    let mut queue = roots
        .iter()
        .filter_map(|pid| {
            start_time_by_pid
                .get(pid)
                .map(|start_time_ms| (*pid, *start_time_ms))
        })
        .collect::<VecDeque<_>>();

    while let Some((pid, start_time_ms)) = queue.pop_front() {
        if !visited_identities.insert((pid, start_time_ms)) {
            continue;
        }
        tracked.insert(pid);
        if let Some(children) = children_by_parent.get(&pid) {
            queue.extend(
                children
                    .iter()
                    .copied()
                    .filter(|(_, child_start_time_ms)| *child_start_time_ms >= start_time_ms),
            );
        }
    }

    tracked
}

pub(crate) fn truncate_utf8(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut boundary = max_bytes;
    while !value.is_char_boundary(boundary) {
        boundary = boundary.saturating_sub(1);
    }
    value.truncate(boundary);
    value
}

fn io_semantics() -> IoSemantics {
    if cfg!(target_os = "windows") {
        IoSemantics::AllIo
    } else {
        IoSemantics::Storage
    }
}

pub(crate) fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn external(pid: u32, start_time_ms: Option<u64>) -> ExternalProcess {
        ExternalProcess { pid, start_time_ms }
    }

    #[test]
    fn claims_keep_the_first_256_in_send_order() {
        let processes: Vec<_> = (1..=300)
            .map(|pid| external(pid, Some(u64::from(pid))))
            .collect();
        let claimed = claimed_identities(processes.clone());
        assert_eq!(claimed.len(), MAX_CLAIMED_PROCESSES);
        assert!(claimed.contains_key(&256));
        assert!(!claimed.contains_key(&257));
        assert_eq!(identity_map(processes).len(), 300);

        let reversed: Vec<_> = (1..=300).rev().map(|pid| external(pid, None)).collect();
        let claimed = claimed_identities(reversed);
        assert!(claimed.contains_key(&300));
        assert!(claimed.contains_key(&45));
        assert!(!claimed.contains_key(&44));
    }

    #[test]
    fn a_repeated_claim_keeps_its_later_start_time() {
        let claimed = claimed_identities(vec![
            external(7, Some(1_000)),
            external(8, None),
            external(7, Some(2_000)),
        ]);
        assert_eq!(claimed.len(), 2);
        assert_eq!(claimed[&7], Some(2_000));
        assert_eq!(claimed[&8], None);
    }

    #[test]
    fn selects_roots_and_all_descendants() {
        let rows = vec![
            (10, 1, 1_000),
            (11, 10, 1_100),
            (12, 11, 1_200),
            (20, 1, 2_000),
            (21, 20, 2_100),
            (30, 99, 3_000),
        ];
        let tracked = select_tracked_pids(&rows, &HashSet::from([10, 20]));

        assert_eq!(tracked, HashSet::from([10, 11, 12, 20, 21]));
    }

    #[test]
    fn rejects_descendants_older_than_a_reused_parent_pid() {
        let rows = vec![
            (20, 1, 5_000),
            (21, 20, 4_000),
            (22, 20, 5_100),
            (23, 21, 5_200),
        ];
        let tracked = select_tracked_pids(&rows, &HashSet::from([20]));

        assert_eq!(tracked, HashSet::from([20, 22]));
    }

    #[test]
    fn ignores_missing_roots() {
        let rows = vec![(10, 1, 1_000), (11, 10, 1_100)];
        let tracked = select_tracked_pids(&rows, &HashSet::from([99]));

        assert!(tracked.is_empty());
    }

    #[test]
    fn validates_external_process_start_identity() {
        assert!(matches_external_identity(10_000, None));
        assert!(matches_external_identity(10_000, Some(10_999)));
        assert!(!matches_external_identity(10_000, Some(11_000)));
        assert!(!matches_external_identity(10_000, Some(9_999)));
    }

    #[test]
    fn loads_details_when_an_existing_process_becomes_selected() {
        let mut collector = Collector::new();
        let mut config = CollectorConfig {
            root_pid: u32::MAX,
            sample_interval: None,
            external_processes: HashMap::new(),
            claimed_processes: HashMap::new(),
        };
        assert!(collector.sample(&config, None).processes.is_empty());

        config.root_pid = std::process::id();
        let snapshot = collector.sample(&config, None);
        let process = snapshot
            .processes
            .iter()
            .find(|process| process.pid == config.root_pid)
            .expect("selected process");

        assert!(!process.command.is_empty());
        assert!(process.resident_bytes > 0);
        assert!(process.cpu_percent.is_finite());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn keeps_command_lines_and_memory_out_of_the_discovery_table() {
        let mut collector = Collector::new();
        let mut config = CollectorConfig {
            root_pid: u32::MAX,
            sample_interval: None,
            external_processes: HashMap::new(),
            claimed_processes: HashMap::new(),
        };
        assert!(collector.sample(&config, None).processes.is_empty());

        let pid = Pid::from_u32(std::process::id());
        let unselected = collector.system.process(pid).expect("discovered process");
        assert!(unselected.cmd().is_empty());
        assert_eq!(unselected.memory(), 0);
        assert_eq!(unselected.virtual_memory(), 0);

        config.external_processes.insert(pid.as_u32(), None);
        let snapshot = collector.sample(&config, None);
        let selected = snapshot
            .processes
            .iter()
            .find(|process| process.pid == pid.as_u32())
            .expect("external process details");
        assert!(!selected.command.is_empty());
        assert!(selected.resident_bytes > 0);
        assert!(selected.start_time_ms > 0);

        let retained = collector
            .system
            .process(pid)
            .expect("retained CPU baseline");
        assert!(retained.cmd().is_empty());
        assert_eq!(retained.memory(), 0);
        assert_eq!(retained.virtual_memory(), 0);
    }

    #[test]
    fn accepts_clock_shifts_without_accepting_reused_process_starts() {
        assert!(matches_process_start_time(10_000, 13_600, 3_600));
        assert!(!matches_process_start_time(10_000, 13_601, 3_600));
        assert!(matches_process_start_time(10_000, 6_400, -3_600));
        assert!(!matches_process_start_time(10_000, 6_401, -3_600));
        assert!(matches_process_start_time(10_000, 10_000, 0));
        assert!(!matches_process_start_time(10_000, 10_001, 0));
    }

    #[test]
    fn counts_selected_processes_that_could_not_be_materialized() {
        assert_eq!(inaccessible_process_count(5, 3), 2);
        assert_eq!(inaccessible_process_count(3, 5), 0);
    }

    #[test]
    fn waits_for_a_cpu_measurement_window_after_priming() {
        let baseline = Instant::now();

        assert_eq!(
            remaining_cpu_measurement_delay(Some(baseline), baseline),
            Some(MINIMUM_CPU_UPDATE_INTERVAL)
        );
        assert_eq!(
            remaining_cpu_measurement_delay(Some(baseline), baseline + MINIMUM_CPU_UPDATE_INTERVAL),
            None
        );
        assert_eq!(remaining_cpu_measurement_delay(None, baseline), None);
    }

    #[test]
    fn truncates_process_strings_at_utf8_boundaries() {
        let value = "é".repeat(MAX_PROCESS_NAME_BYTES);
        let truncated = truncate_utf8(value, MAX_PROCESS_NAME_BYTES - 1);

        assert!(truncated.len() < MAX_PROCESS_NAME_BYTES);
        assert!(truncated.is_char_boundary(truncated.len()));
    }

    #[test]
    fn refreshes_commands_without_enumerating_linux_tasks() {
        let refresh_kind = process_refresh_kind();

        assert_eq!(refresh_kind.cmd(), UpdateKind::Always);
        assert!(!refresh_kind.tasks());
        assert!(refresh_kind.cpu());
        assert!(refresh_kind.memory());
        assert!(refresh_kind.disk_usage());
    }

    #[cfg(unix)]
    #[test]
    fn reports_the_whole_claimed_subtree_sorted() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn child");
        let own = std::process::id();
        let mut collector = Collector::new();
        let mut config = CollectorConfig {
            root_pid: u32::MAX,
            sample_interval: None,
            external_processes: HashMap::new(),
            claimed_processes: HashMap::new(),
        };

        let unclaimed = collector.sample(&config, None);
        assert!(unclaimed.claimed_pids.is_none());
        assert!(unclaimed.claimed_processes.is_none());

        config.claimed_processes.insert(own, None);
        let claimed = collector.sample(&config, None);
        let _ = child.kill();
        let _ = child.wait();

        let claimed_pids = claimed.claimed_pids.expect("claimed pids");
        assert!(claimed_pids.contains(&own));
        assert!(
            claimed_pids.contains(&child.id()),
            "descendants are claimed"
        );
        assert!(claimed_pids.windows(2).all(|pair| pair[0] < pair[1]));
        let roots = claimed.claimed_processes.expect("claimed roots");
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].pid, own);
        assert!(roots[0].start_time_ms.is_some_and(|start| start > 0));
        assert!(
            claimed.processes.iter().any(|process| process.pid == own),
            "claimed roots are sampled so the server can attribute them"
        );
    }

    #[test]
    fn keeps_claimed_fields_while_claims_are_set_even_when_none_are_alive() {
        let mut collector = Collector::new();
        let config = CollectorConfig {
            root_pid: u32::MAX,
            sample_interval: None,
            external_processes: HashMap::new(),
            claimed_processes: HashMap::from([
                (u32::MAX - 1, None),
                // Our own pid with a start time it never had: a reused pid, not a claim.
                (std::process::id(), Some(1_000)),
            ]),
        };
        let snapshot = collector.sample(&config, None);

        assert_eq!(snapshot.claimed_pids, Some(Vec::new()));
        assert!(
            snapshot
                .claimed_processes
                .is_some_and(|roots| roots.is_empty())
        );
        assert!(snapshot.processes.is_empty());
    }
}
