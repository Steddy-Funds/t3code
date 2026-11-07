use serde::{Deserialize, Serialize};

use crate::gpu::{GpuDeviceSample, GpuProcessSample};

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
}
