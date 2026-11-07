use serde::{Deserialize, Serialize};

use crate::gpu::{GpuDeviceSample, GpuError, GpuProcessSample};

pub(crate) const PROTOCOL_VERSION: u32 = 4;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalProcess {
    pub(crate) pid: u32,
    #[serde(default)]
    pub(crate) start_time_ms: Option<u64>,
}

impl ExternalProcess {
    pub(crate) fn estimated_history_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Command {
    Configure {
        version: u32,
        root_pid: u32,
        sample_interval_ms: u64,
        #[serde(default)]
        external_processes: Vec<ExternalProcess>,
    },
    SetExternalProcesses {
        version: u32,
        processes: Vec<ExternalProcess>,
    },
    SetSampleInterval {
        version: u32,
        sample_interval_ms: u64,
    },
    SetStreaming {
        version: u32,
        enabled: bool,
    },
    SampleNow {
        version: u32,
        request_id: String,
    },
    ProcessTable {
        version: u32,
        request_id: String,
    },
    ReadHistory {
        version: u32,
        request_id: String,
        window_ms: u64,
    },
    SetClaimedProcesses {
        version: u32,
        processes: Vec<ExternalProcess>,
    },
    SetHostStreaming {
        version: u32,
        interval_ms: u64,
        #[serde(flatten)]
        options: HostSampleOptions,
    },
    HostSampleNow {
        version: u32,
        request_id: String,
        #[serde(flatten)]
        options: HostSampleOptions,
    },
    HostTotals {
        version: u32,
        request_id: String,
    },
    GpuTotals {
        version: u32,
        request_id: String,
    },
    Shutdown {
        version: u32,
    },
}

/// What one `hostSample` carries.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostSampleOptions {
    #[serde(default)]
    pub(crate) processes: bool,
    #[serde(default)]
    pub(crate) gpus: bool,
    #[serde(default)]
    pub(crate) gpu_processes: bool,
}

impl Command {
    pub(crate) fn version(&self) -> u32 {
        match self {
            Self::Configure { version, .. }
            | Self::SetExternalProcesses { version, .. }
            | Self::SetSampleInterval { version, .. }
            | Self::SetStreaming { version, .. }
            | Self::SampleNow { version, .. }
            | Self::ProcessTable { version, .. }
            | Self::ReadHistory { version, .. }
            | Self::SetClaimedProcesses { version, .. }
            | Self::SetHostStreaming { version, .. }
            | Self::HostSampleNow { version, .. }
            | Self::HostTotals { version, .. }
            | Self::GpuTotals { version, .. }
            | Self::Shutdown { version } => *version,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Capabilities {
    pub(crate) cumulative_cpu_time: bool,
    pub(crate) current_cpu_percent: bool,
    pub(crate) resident_memory: bool,
    pub(crate) virtual_memory: bool,
    pub(crate) io_bytes: bool,
    pub(crate) process_start_time: bool,
    pub(crate) process_tree: bool,
    pub(crate) host_processes: bool,
    pub(crate) gpu_nvidia: bool,
    pub(crate) gpu_intel: bool,
    pub(crate) host_totals: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HelloEvent {
    pub(crate) version: u32,
    #[serde(rename = "type")]
    pub(crate) event_type: &'static str,
    pub(crate) sidecar_version: &'static str,
    pub(crate) sidecar_pid: u32,
    pub(crate) platform: &'static str,
    pub(crate) arch: &'static str,
    pub(crate) capabilities: Capabilities,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum IoSemantics {
    Storage,
    AllIo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessSample {
    pub(crate) pid: u32,
    pub(crate) ppid: u32,
    pub(crate) start_time_ms: u64,
    pub(crate) run_time_ms: u64,
    pub(crate) name: String,
    pub(crate) command: String,
    pub(crate) status: String,
    pub(crate) cpu_percent: f32,
    pub(crate) cpu_time_ms: u64,
    pub(crate) resident_bytes: u64,
    pub(crate) virtual_bytes: u64,
    pub(crate) io_read_bytes: u64,
    pub(crate) io_write_bytes: u64,
    pub(crate) io_semantics: IoSemantics,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessTableEntry {
    pub(crate) pid: u32,
    pub(crate) ppid: u32,
    pub(crate) name: String,
    pub(crate) start_time_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessTableEvent<'a> {
    pub(crate) version: u32,
    #[serde(rename = "type")]
    pub(crate) event_type: &'static str,
    pub(crate) request_id: &'a str,
    pub(crate) processes: Vec<ProcessTableEntry>,
}

impl ProcessSample {
    pub(crate) fn estimated_history_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            .saturating_add(self.name.len())
            .saturating_add(self.command.len())
            .saturating_add(self.status.len())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotEvent {
    pub(crate) version: u32,
    #[serde(rename = "type")]
    pub(crate) event_type: &'static str,
    pub(crate) sequence: u64,
    pub(crate) sampled_at_unix_ms: u64,
    pub(crate) collection_duration_micros: u64,
    pub(crate) scanned_process_count: usize,
    pub(crate) retained_process_count: usize,
    pub(crate) inaccessible_process_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) request_id: Option<String>,
    pub(crate) external_processes: Vec<ExternalProcess>,
    pub(crate) processes: Vec<ProcessSample>,
    /// Present while claims are set; the claimed roots that are still alive.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) claimed_processes: Option<Vec<ExternalProcess>>,
    /// Every pid in a claimed subtree, so the server can keep those rows out of T3 totals.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) claimed_pids: Option<Vec<u32>>,
}

impl SnapshotEvent {
    pub(crate) fn retained_entry_count(&self) -> usize {
        self.processes
            .len()
            .saturating_add(self.external_processes.len())
    }

    pub(crate) fn estimated_history_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            .saturating_add(
                self.processes
                    .iter()
                    .map(ProcessSample::estimated_history_bytes)
                    .sum::<usize>(),
            )
            .saturating_add(
                self.external_processes
                    .iter()
                    .map(ExternalProcess::estimated_history_bytes)
                    .sum::<usize>(),
            )
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryChunkEvent<'a> {
    pub(crate) version: u32,
    #[serde(rename = "type")]
    pub(crate) event_type: &'static str,
    pub(crate) request_id: &'a str,
    pub(crate) done: bool,
    pub(crate) snapshots: &'a [SnapshotEvent],
}

/// Index-aligned columns, one entry per sampled process.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostProcessColumns {
    pub(crate) pid: Vec<u32>,
    pub(crate) ppid: Vec<u32>,
    pub(crate) start_time_ms: Vec<u64>,
    pub(crate) cpu_percent: Vec<f32>,
    pub(crate) resident_bytes: Vec<u64>,
}

/// Static fields, sent once per process identity until the next `staticReset`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostProcessAdded {
    pub(crate) pid: u32,
    pub(crate) start_time_ms: u64,
    pub(crate) name: String,
    pub(crate) user: String,
    pub(crate) command: String,
    pub(crate) exe: String,
    pub(crate) cwd: String,
    pub(crate) cgroup: String,
    pub(crate) container_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostSampleEvent {
    pub(crate) version: u32,
    #[serde(rename = "type")]
    pub(crate) event_type: &'static str,
    pub(crate) sequence: u64,
    pub(crate) sampled_at_unix_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) request_id: Option<String>,
    pub(crate) collection_duration_micros: u64,
    pub(crate) scanned_process_count: usize,
    pub(crate) inaccessible_process_count: usize,
    /// The receiver drops every static field it holds before applying `added`.
    pub(crate) static_reset: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) processes: Option<HostProcessColumns>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) added: Option<Vec<HostProcessAdded>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) gpus: Option<Vec<GpuDeviceSample>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) gpu_processes: Option<Vec<GpuProcessSample>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostTotalsEvent<'a> {
    pub(crate) version: u32,
    #[serde(rename = "type")]
    pub(crate) event_type: &'static str,
    pub(crate) request_id: &'a str,
    /// "normal", "warn" or "critical".
    pub(crate) memory_pressure: Option<&'static str>,
    pub(crate) memory_available_bytes: Option<u64>,
    pub(crate) swap_total_bytes: Option<u64>,
    pub(crate) swap_used_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GpuTotalsEvent<'a> {
    pub(crate) version: u32,
    #[serde(rename = "type")]
    pub(crate) event_type: &'static str,
    pub(crate) request_id: &'a str,
    /// None when this one query failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) gpus: Option<Vec<GpuDeviceSample>>,
}

impl<'a> GpuTotalsEvent<'a> {
    /// The reply to `gpuTotals`, plus the `gpu-unavailable` message to send after it, if any.
    /// A failed query omits `gpus`; disabled GPUs answer empty once and say why.
    pub(crate) fn reply(
        request_id: &'a str,
        result: Result<Vec<GpuDeviceSample>, GpuError>,
    ) -> (Self, Option<String>) {
        let (gpus, disabled) = match result {
            Ok(devices) => (Some(devices), None),
            Err(GpuError::Failed(_)) => (None, None),
            Err(GpuError::Disabled(message)) => (Some(Vec::new()), Some(message)),
        };
        let event = GpuTotalsEvent {
            version: PROTOCOL_VERSION,
            event_type: "gpuTotals",
            request_id,
            gpus,
        };
        (event, disabled)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErrorEvent {
    pub(crate) version: u32,
    #[serde(rename = "type")]
    pub(crate) event_type: &'static str,
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) recoverable: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_protocol_commands() {
        let configure = serde_json::from_str::<Command>(
            r#"{"version":3,"type":"configure","rootPid":42,"sampleIntervalMs":1000,"externalProcesses":[{"pid":7}]}"#,
        )
        .expect("configure command");

        match configure {
            Command::Configure {
                root_pid,
                sample_interval_ms,
                external_processes,
                ..
            } => {
                assert_eq!(root_pid, 42);
                assert_eq!(sample_interval_ms, 1_000);
                assert_eq!(external_processes[0].pid, 7);
                assert_eq!(external_processes[0].start_time_ms, None);
            }
            _ => panic!("unexpected command"),
        }

        let read_history = serde_json::from_str::<Command>(
            r#"{"version":3,"type":"readHistory","requestId":"history-1","windowMs":60000}"#,
        )
        .expect("read history command");
        assert!(matches!(
            read_history,
            Command::ReadHistory {
                request_id,
                window_ms: 60_000,
                ..
            } if request_id == "history-1"
        ));

        let process_table = serde_json::from_str::<Command>(
            r#"{"version":3,"type":"processTable","requestId":"processes-1"}"#,
        )
        .expect("process table command");
        assert!(matches!(
            process_table,
            Command::ProcessTable { request_id, .. } if request_id == "processes-1"
        ));
    }

    #[test]
    fn decodes_v4_host_commands_with_default_options() {
        let claims = serde_json::from_str::<Command>(
            r#"{"version":4,"type":"setClaimedProcesses","processes":[{"pid":9,"startTimeMs":5000},{"pid":10}]}"#,
        )
        .expect("set claimed processes");
        match claims {
            Command::SetClaimedProcesses { version, processes } => {
                assert_eq!(version, 4);
                assert_eq!(processes.len(), 2);
                assert_eq!(processes[0].start_time_ms, Some(5_000));
                assert_eq!(processes[1].start_time_ms, None);
            }
            _ => panic!("unexpected command"),
        }

        let streaming = serde_json::from_str::<Command>(
            r#"{"version":4,"type":"setHostStreaming","intervalMs":2000,"processes":true}"#,
        )
        .expect("set host streaming");
        assert!(matches!(
            streaming,
            Command::SetHostStreaming {
                version: 4,
                interval_ms: 2_000,
                options: HostSampleOptions {
                    processes: true,
                    gpus: false,
                    gpu_processes: false
                },
            }
        ));

        let off = serde_json::from_str::<Command>(
            r#"{"version":4,"type":"setHostStreaming","intervalMs":0}"#,
        )
        .expect("host streaming off");
        assert!(matches!(
            off,
            Command::SetHostStreaming { interval_ms: 0, options, .. } if options == HostSampleOptions::default()
        ));

        let sample_now = serde_json::from_str::<Command>(
            r#"{"version":4,"type":"hostSampleNow","requestId":"host-1","gpus":true,"gpuProcesses":true}"#,
        )
        .expect("host sample now");
        assert!(matches!(
            sample_now,
            Command::HostSampleNow {
                request_id,
                options: HostSampleOptions { processes: false, gpus: true, gpu_processes: true },
                ..
            } if request_id == "host-1"
        ));

        let totals = serde_json::from_str::<Command>(
            r#"{"version":4,"type":"hostTotals","requestId":"totals-1"}"#,
        )
        .expect("host totals");
        assert!(
            matches!(totals, Command::HostTotals { request_id, .. } if request_id == "totals-1")
        );

        let gpu_totals = serde_json::from_str::<Command>(
            r#"{"version":4,"type":"gpuTotals","requestId":"gpu-1"}"#,
        )
        .expect("gpu totals");
        assert_eq!(gpu_totals.version(), 4);
        assert!(
            matches!(gpu_totals, Command::GpuTotals { request_id, .. } if request_id == "gpu-1")
        );

        assert!(
            serde_json::from_str::<Command>(r#"{"version":4,"type":"hostTotals"}"#).is_err(),
            "requests need a requestId"
        );
        assert!(
            serde_json::from_str::<Command>(r#"{"version":4,"type":"setHostStreaming"}"#).is_err(),
            "setHostStreaming needs an interval"
        );
    }

    fn snapshot() -> SnapshotEvent {
        SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: 1,
            sampled_at_unix_ms: 1_000,
            collection_duration_micros: 1,
            scanned_process_count: 0,
            retained_process_count: 0,
            inaccessible_process_count: 0,
            request_id: None,
            external_processes: Vec::new(),
            processes: Vec::new(),
            claimed_processes: None,
            claimed_pids: None,
        }
    }

    #[test]
    fn snapshots_carry_claimed_fields_only_while_claims_are_set() {
        let unclaimed = serde_json::to_value(snapshot()).expect("snapshot json");
        assert!(unclaimed.get("claimedProcesses").is_none());
        assert!(unclaimed.get("claimedPids").is_none());

        let claimed = serde_json::to_value(SnapshotEvent {
            claimed_processes: Some(vec![ExternalProcess {
                pid: 9,
                start_time_ms: Some(5_000),
            }]),
            claimed_pids: Some(vec![9, 12]),
            ..snapshot()
        })
        .expect("claimed snapshot json");
        assert_eq!(
            claimed["claimedProcesses"],
            serde_json::json!([{ "pid": 9, "startTimeMs": 5000 }])
        );
        assert_eq!(claimed["claimedPids"], serde_json::json!([9, 12]));

        let none_alive = serde_json::to_value(SnapshotEvent {
            claimed_processes: Some(Vec::new()),
            claimed_pids: Some(Vec::new()),
            ..snapshot()
        })
        .expect("empty claims json");
        assert_eq!(none_alive["claimedPids"], serde_json::json!([]));
    }

    #[test]
    fn serializes_host_events_in_camel_case() {
        let entry = serde_json::to_value(ProcessTableEntry {
            pid: 7,
            ppid: 1,
            name: "node".to_owned(),
            start_time_ms: 3_000,
        })
        .expect("process table entry");
        assert_eq!(
            entry,
            serde_json::json!({ "pid": 7, "ppid": 1, "name": "node", "startTimeMs": 3000 })
        );

        let bare = serde_json::to_value(HostSampleEvent {
            version: PROTOCOL_VERSION,
            event_type: "hostSample",
            sequence: 3,
            sampled_at_unix_ms: 9,
            request_id: None,
            collection_duration_micros: 1,
            scanned_process_count: 0,
            inaccessible_process_count: 0,
            static_reset: false,
            processes: None,
            added: None,
            gpus: None,
            gpu_processes: None,
        })
        .expect("bare host sample");
        assert_eq!(
            bare,
            serde_json::json!({
                "version": 4,
                "type": "hostSample",
                "sequence": 3,
                "sampledAtUnixMs": 9,
                "collectionDurationMicros": 1,
                "scannedProcessCount": 0,
                "inaccessibleProcessCount": 0,
                "staticReset": false,
            })
        );

        let full = serde_json::to_value(HostSampleEvent {
            version: PROTOCOL_VERSION,
            event_type: "hostSample",
            sequence: 4,
            sampled_at_unix_ms: 9,
            request_id: Some("host-1".to_owned()),
            collection_duration_micros: 1,
            scanned_process_count: 1,
            inaccessible_process_count: 0,
            static_reset: true,
            processes: Some(HostProcessColumns {
                pid: vec![7],
                ppid: vec![1],
                start_time_ms: vec![3_000],
                cpu_percent: vec![12.5],
                resident_bytes: vec![4_096],
            }),
            added: Some(vec![HostProcessAdded {
                pid: 7,
                start_time_ms: 3_000,
                name: "node".to_owned(),
                user: "dev".to_owned(),
                command: "node server.js".to_owned(),
                exe: "/usr/bin/node".to_owned(),
                cwd: "/srv".to_owned(),
                cgroup: "/user.slice".to_owned(),
                container_id: String::new(),
            }]),
            gpus: Some(Vec::new()),
            gpu_processes: Some(Vec::new()),
        })
        .expect("full host sample");
        assert_eq!(full["requestId"], "host-1");
        assert_eq!(full["staticReset"], true);
        assert_eq!(
            full["processes"],
            serde_json::json!({
                "pid": [7],
                "ppid": [1],
                "startTimeMs": [3000],
                "cpuPercent": [12.5],
                "residentBytes": [4096],
            })
        );
        assert_eq!(full["added"][0]["containerId"], "");
        assert_eq!(full["added"][0]["startTimeMs"], 3000);
        assert_eq!(full["gpus"], serde_json::json!([]));
        assert_eq!(full["gpuProcesses"], serde_json::json!([]));
    }

    #[test]
    fn totals_replies_distinguish_unknown_from_failed() {
        let host = serde_json::to_value(HostTotalsEvent {
            version: PROTOCOL_VERSION,
            event_type: "hostTotals",
            request_id: "totals-1",
            memory_pressure: None,
            memory_available_bytes: None,
            swap_total_bytes: None,
            swap_used_bytes: None,
        })
        .expect("host totals");
        assert_eq!(
            host,
            serde_json::json!({
                "version": 4,
                "type": "hostTotals",
                "requestId": "totals-1",
                "memoryPressure": null,
                "memoryAvailableBytes": null,
                "swapTotalBytes": null,
                "swapUsedBytes": null,
            })
        );

        let failed = serde_json::to_value(GpuTotalsEvent {
            version: PROTOCOL_VERSION,
            event_type: "gpuTotals",
            request_id: "gpu-1",
            gpus: None,
        })
        .expect("failed gpu totals");
        assert!(failed.get("gpus").is_none());

        let empty = serde_json::to_value(GpuTotalsEvent {
            version: PROTOCOL_VERSION,
            event_type: "gpuTotals",
            request_id: "gpu-1",
            gpus: Some(Vec::new()),
        })
        .expect("empty gpu totals");
        assert_eq!(empty["gpus"], serde_json::json!([]));
    }

    #[test]
    fn capabilities_name_the_host_features() {
        let capabilities = serde_json::to_value(Capabilities {
            cumulative_cpu_time: true,
            current_cpu_percent: true,
            resident_memory: true,
            virtual_memory: true,
            io_bytes: true,
            process_start_time: true,
            process_tree: true,
            host_processes: true,
            gpu_nvidia: false,
            gpu_intel: true,
            host_totals: false,
        })
        .expect("capabilities");
        assert_eq!(capabilities["hostProcesses"], true);
        assert_eq!(capabilities["gpuNvidia"], false);
        assert_eq!(capabilities["gpuIntel"], true);
        assert_eq!(capabilities["hostTotals"], false);
    }
}
