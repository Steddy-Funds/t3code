use std::collections::VecDeque;

use crate::protocol::SnapshotEvent;

const HISTORY_RETENTION_MS: u64 = 60 * 60_000;
const MAX_HISTORY_SNAPSHOTS: usize = 3_600;
const MAX_HISTORY_RETAINED_ENTRIES: usize = 20_000;
const MAX_HISTORY_RETAINED_BYTES: usize = 64 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct HistoryRecorder {
    snapshots: VecDeque<SnapshotEvent>,
    retained_entry_count: usize,
    retained_bytes: usize,
}

impl HistoryRecorder {
    pub(crate) fn record(&mut self, snapshot: &SnapshotEvent) {
        self.record_with_limits(
            snapshot,
            MAX_HISTORY_SNAPSHOTS,
            MAX_HISTORY_RETAINED_ENTRIES,
            MAX_HISTORY_RETAINED_BYTES,
        );
    }

    fn record_with_limits(
        &mut self,
        snapshot: &SnapshotEvent,
        max_snapshots: usize,
        max_retained_entries: usize,
        max_retained_bytes: usize,
    ) {
        let clock_moved_backward = self
            .snapshots
            .back()
            .is_some_and(|previous| previous.sampled_at_unix_ms > snapshot.sampled_at_unix_ms);
        let mut retained = snapshot.clone();
        retained.request_id = None;
        // Claimed subtrees belong to their claimants, not to T3's own history.
        retained.claimed_processes = None;
        if let Some(claimed_pids) = retained.claimed_pids.take() {
            retained
                .processes
                .retain(|process| claimed_pids.binary_search(&process.pid).is_err());
        }
        self.retained_entry_count = self
            .retained_entry_count
            .saturating_add(retained.retained_entry_count());
        self.retained_bytes = self
            .retained_bytes
            .saturating_add(retained.estimated_history_bytes());
        self.snapshots.push_back(retained);
        self.trim_to_limits(
            snapshot.sampled_at_unix_ms,
            max_snapshots,
            max_retained_entries,
            max_retained_bytes,
            clock_moved_backward,
        );
    }

    fn trim_to_limits(
        &mut self,
        now_ms: u64,
        max_snapshots: usize,
        max_retained_entries: usize,
        max_retained_bytes: usize,
        clock_moved_backward: bool,
    ) {
        if clock_moved_backward {
            let mut future_entry_count = 0usize;
            let mut future_bytes = 0usize;
            self.snapshots.retain(|snapshot| {
                let keep = snapshot.sampled_at_unix_ms <= now_ms;
                if !keep {
                    future_entry_count =
                        future_entry_count.saturating_add(snapshot.retained_entry_count());
                    future_bytes = future_bytes.saturating_add(snapshot.estimated_history_bytes());
                }
                keep
            });
            self.retained_entry_count =
                self.retained_entry_count.saturating_sub(future_entry_count);
            self.retained_bytes = self.retained_bytes.saturating_sub(future_bytes);
        }

        while self.snapshots.front().is_some_and(|snapshot| {
            snapshot.sampled_at_unix_ms < now_ms.saturating_sub(HISTORY_RETENTION_MS)
                || self.snapshots.len() > max_snapshots
                || self.retained_entry_count > max_retained_entries
                || self.retained_bytes > max_retained_bytes
        }) {
            if let Some(removed) = self.snapshots.pop_front() {
                self.retained_entry_count = self
                    .retained_entry_count
                    .saturating_sub(removed.retained_entry_count());
                self.retained_bytes = self
                    .retained_bytes
                    .saturating_sub(removed.estimated_history_bytes());
            }
        }
    }

    pub(crate) fn read(&self, window_ms: u64, now_ms: u64) -> Vec<SnapshotEvent> {
        let started_at_ms = now_ms.saturating_sub(window_ms.min(HISTORY_RETENTION_MS));
        self.snapshots
            .iter()
            .filter(|snapshot| {
                snapshot.sampled_at_unix_ms >= started_at_ms
                    && snapshot.sampled_at_unix_ms <= now_ms
            })
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{ExternalProcess, IoSemantics, PROTOCOL_VERSION, ProcessSample};

    #[test]
    fn retains_bounded_history_without_request_ids() {
        let mut history = HistoryRecorder::default();
        for sequence in 0..=MAX_HISTORY_SNAPSHOTS {
            history.record(&SnapshotEvent {
                version: PROTOCOL_VERSION,
                event_type: "snapshot",
                sequence: sequence as u64,
                sampled_at_unix_ms: sequence as u64 * 1_000,
                collection_duration_micros: 1,
                scanned_process_count: 0,
                retained_process_count: 0,
                inaccessible_process_count: 0,
                request_id: Some("request".to_owned()),
                external_processes: vec![ExternalProcess {
                    pid: 7,
                    start_time_ms: Some(1_000),
                }],
                processes: Vec::new(),
                claimed_processes: None,
                claimed_pids: None,
            });
        }

        assert_eq!(history.snapshots.len(), MAX_HISTORY_SNAPSHOTS);
        assert!(
            history
                .snapshots
                .iter()
                .all(|snapshot| snapshot.request_id.is_none())
        );
        assert!(history.snapshots.iter().all(|snapshot| {
            snapshot.external_processes.len() == 1
                && snapshot.external_processes[0].pid == 7
                && snapshot.external_processes[0].start_time_ms == Some(1_000)
        }));
        assert_eq!(
            history
                .read(10_000, MAX_HISTORY_SNAPSHOTS as u64 * 1_000)
                .len(),
            11
        );
    }

    #[test]
    fn excludes_and_trims_future_history_after_the_clock_moves_backward() {
        let mut history = HistoryRecorder::default();
        let snapshot = SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: 1,
            sampled_at_unix_ms: 2_000,
            collection_duration_micros: 1,
            scanned_process_count: 0,
            retained_process_count: 0,
            inaccessible_process_count: 0,
            request_id: None,
            external_processes: Vec::new(),
            processes: Vec::new(),
            claimed_processes: None,
            claimed_pids: None,
        };
        history.record(&snapshot);

        assert!(history.read(0, 1_000).is_empty());

        history.record(&SnapshotEvent {
            sequence: 2,
            sampled_at_unix_ms: 1_000,
            ..snapshot
        });
        assert_eq!(history.snapshots.len(), 1);
        assert_eq!(
            history.snapshots.front().map(|entry| entry.sequence),
            Some(2)
        );
    }

    #[test]
    fn bounds_history_by_estimated_process_bytes() {
        let mut history = HistoryRecorder::default();
        let command = "x".repeat(128);
        let process = ProcessSample {
            pid: 1,
            ppid: 0,
            start_time_ms: 0,
            run_time_ms: 0,
            name: "process".to_owned(),
            command,
            status: "Run".to_owned(),
            cpu_percent: 0.0,
            cpu_time_ms: 0,
            resident_bytes: 0,
            virtual_bytes: 0,
            io_read_bytes: 0,
            io_write_bytes: 0,
            io_semantics: IoSemantics::Storage,
        };
        let snapshot_bytes =
            std::mem::size_of::<SnapshotEvent>() + process.estimated_history_bytes();
        for sequence in 0..3 {
            history.record_with_limits(
                &SnapshotEvent {
                    version: PROTOCOL_VERSION,
                    event_type: "snapshot",
                    sequence,
                    sampled_at_unix_ms: sequence * 1_000,
                    collection_duration_micros: 1,
                    scanned_process_count: 1,
                    retained_process_count: 1,
                    inaccessible_process_count: 0,
                    request_id: None,
                    external_processes: Vec::new(),
                    processes: vec![ProcessSample {
                        pid: sequence as u32 + 1,
                        start_time_ms: sequence * 1_000,
                        ..process.clone()
                    }],
                    claimed_processes: None,
                    claimed_pids: None,
                },
                3,
                3,
                snapshot_bytes * 2,
            );
        }

        assert!(history.retained_bytes <= snapshot_bytes * 2);
        assert_eq!(history.snapshots.len(), 2);
        assert_eq!(
            history.snapshots.front().map(|snapshot| snapshot.sequence),
            Some(1)
        );
    }

    #[test]
    fn counts_external_processes_toward_history_limits() {
        let mut history = HistoryRecorder::default();
        let external_processes = (1..=128)
            .map(|pid| ExternalProcess {
                pid,
                start_time_ms: Some(u64::from(pid) * 1_000),
            })
            .collect::<Vec<_>>();
        let snapshot = SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: 0,
            sampled_at_unix_ms: 0,
            collection_duration_micros: 1,
            scanned_process_count: 0,
            retained_process_count: 0,
            inaccessible_process_count: 0,
            request_id: None,
            external_processes,
            processes: Vec::new(),
            claimed_processes: None,
            claimed_pids: None,
        };
        let snapshot_bytes = snapshot.estimated_history_bytes();
        let snapshot_entries = snapshot.retained_entry_count();

        for sequence in 0..3 {
            history.record_with_limits(
                &SnapshotEvent {
                    sequence,
                    sampled_at_unix_ms: sequence * 1_000,
                    ..snapshot.clone()
                },
                3,
                snapshot_entries * 2,
                snapshot_bytes * 2,
            );
        }

        assert_eq!(history.retained_entry_count, snapshot_entries * 2);
        assert!(history.retained_bytes <= snapshot_bytes * 2);
        assert_eq!(history.snapshots.len(), 2);
        assert_eq!(
            history.snapshots.front().map(|snapshot| snapshot.sequence),
            Some(1)
        );
    }

    #[test]
    fn keeps_claimed_subtrees_out_of_history() {
        let mut history = HistoryRecorder::default();
        let process = |pid: u32| ProcessSample {
            pid,
            ppid: 1,
            start_time_ms: 0,
            run_time_ms: 0,
            name: "process".to_owned(),
            command: String::new(),
            status: "Run".to_owned(),
            cpu_percent: 0.0,
            cpu_time_ms: 0,
            resident_bytes: 0,
            virtual_bytes: 0,
            io_read_bytes: 0,
            io_write_bytes: 0,
            io_semantics: IoSemantics::Storage,
        };
        history.record(&SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: 1,
            sampled_at_unix_ms: 1_000,
            collection_duration_micros: 1,
            scanned_process_count: 5,
            retained_process_count: 5,
            inaccessible_process_count: 0,
            request_id: None,
            external_processes: Vec::new(),
            processes: [3, 5, 8, 13, 21].map(process).to_vec(),
            claimed_processes: Some(vec![ExternalProcess {
                pid: 5,
                start_time_ms: Some(0),
            }]),
            claimed_pids: Some(vec![5, 13, 99]),
        });

        let retained = history.read(10_000, 1_000);
        assert_eq!(retained.len(), 1);
        assert!(retained[0].claimed_processes.is_none());
        assert!(retained[0].claimed_pids.is_none());
        assert_eq!(
            retained[0]
                .processes
                .iter()
                .map(|process| process.pid)
                .collect::<Vec<_>>(),
            vec![3, 8, 21]
        );
        assert_eq!(history.retained_entry_count, 3);
    }
}
