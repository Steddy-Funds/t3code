mod collector;
mod gpu;
mod history;
mod host;
mod io;
mod protocol;

use std::io::BufWriter;
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use crate::collector::{Collector, CollectorConfig, unix_time_ms};
use crate::history::HistoryRecorder;
use crate::io::{Input, spawn_input_reader, write_error, write_event, write_history};
use crate::protocol::{Capabilities, Command, HelloEvent, PROTOCOL_VERSION, ProcessTableEvent};

const MIN_SAMPLE_INTERVAL_MS: u64 = 250;
const MAX_SAMPLE_INTERVAL_MS: u64 = 60_000;

fn clamp_sample_interval(sample_interval_ms: u64) -> Option<Duration> {
    (sample_interval_ms > 0).then(|| {
        Duration::from_millis(
            sample_interval_ms.clamp(MIN_SAMPLE_INTERVAL_MS, MAX_SAMPLE_INTERVAL_MS),
        )
    })
}

fn sample_now_deadline(
    current: Option<Instant>,
    interval: Option<Duration>,
    now: Instant,
) -> Option<Instant> {
    current.or_else(|| interval.map(|duration| now + duration))
}

fn main() -> std::io::Result<()> {
    let mut writer = BufWriter::new(std::io::stdout().lock());
    write_event(
        &mut writer,
        &HelloEvent {
            version: PROTOCOL_VERSION,
            event_type: "hello",
            sidecar_version: env!("CARGO_PKG_VERSION"),
            sidecar_pid: std::process::id(),
            platform: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            capabilities: Capabilities {
                cumulative_cpu_time: true,
                current_cpu_percent: true,
                resident_memory: true,
                virtual_memory: true,
                io_bytes: true,
                process_start_time: true,
                process_tree: true,
            },
        },
    )?;

    let receiver = spawn_input_reader();
    let mut collector = Collector::new();
    let mut history = HistoryRecorder::default();
    let mut config: Option<CollectorConfig> = None;
    let mut next_sample_at: Option<Instant> = None;
    let mut streaming_enabled = false;

    loop {
        if next_sample_at.is_some_and(|deadline| deadline <= Instant::now()) {
            if let Some(current) = config.as_ref() {
                if let Some(interval) = current.sample_interval {
                    let event = collector.sample(current, None);
                    history.record(&event);
                    if streaming_enabled {
                        write_event(&mut writer, &event)?;
                    }
                    next_sample_at = Some(Instant::now() + interval);
                } else {
                    next_sample_at = None;
                }
            } else {
                next_sample_at = None;
            }
            continue;
        }

        let timeout = next_sample_at
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_secs(60));

        match receiver.recv_timeout(timeout) {
            Ok(Input::Invalid(message)) => {
                write_error(&mut writer, "invalid-command", message, true)?;
            }
            Ok(Input::Command(command)) => {
                if command.version() != PROTOCOL_VERSION {
                    write_error(
                        &mut writer,
                        "protocol-mismatch",
                        format!(
                            "unsupported protocol version {}; expected {PROTOCOL_VERSION}",
                            command.version()
                        ),
                        false,
                    )?;
                    continue;
                }

                match command {
                    Command::Configure {
                        root_pid,
                        sample_interval_ms,
                        external_processes,
                        ..
                    } => {
                        let sample_interval = clamp_sample_interval(sample_interval_ms);
                        config = Some(CollectorConfig {
                            root_pid,
                            sample_interval,
                            external_processes: external_processes
                                .into_iter()
                                .map(|process| (process.pid, process.start_time_ms))
                                .collect(),
                        });
                        collector.prime_cpu_usage();
                        next_sample_at = sample_interval.map(|_| Instant::now());
                    }
                    Command::SetExternalProcesses { processes, .. } => {
                        if let Some(current) = config.as_mut() {
                            current.external_processes = processes
                                .into_iter()
                                .map(|process| (process.pid, process.start_time_ms))
                                .collect();
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before external processes",
                                true,
                            )?;
                        }
                    }
                    Command::SetSampleInterval {
                        sample_interval_ms, ..
                    } => {
                        if let Some(current) = config.as_mut() {
                            current.sample_interval = clamp_sample_interval(sample_interval_ms);
                            next_sample_at = current
                                .sample_interval
                                .map(|interval| Instant::now() + interval);
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before changing the sample interval",
                                true,
                            )?;
                        }
                    }
                    Command::SetStreaming { enabled, .. } => {
                        streaming_enabled = enabled;
                    }
                    Command::SampleNow { request_id, .. } => {
                        if let Some(current) = config.as_ref() {
                            let event = collector.sample(current, Some(request_id));
                            history.record(&event);
                            write_event(&mut writer, &event)?;
                            next_sample_at = sample_now_deadline(
                                next_sample_at,
                                current.sample_interval,
                                Instant::now(),
                            );
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before sampling",
                                true,
                            )?;
                        }
                    }
                    Command::ProcessTable { request_id, .. } => {
                        let event = ProcessTableEvent {
                            version: PROTOCOL_VERSION,
                            event_type: "processTable",
                            request_id: &request_id,
                            processes: collector.process_table(),
                        };
                        write_event(&mut writer, &event)?;
                    }
                    Command::ReadHistory {
                        request_id,
                        window_ms,
                        ..
                    } => {
                        if config.is_some() {
                            let snapshots = history.read(window_ms, unix_time_ms());
                            write_history(&mut writer, &request_id, &snapshots)?;
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before reading history",
                                true,
                            )?;
                        }
                    }
                    Command::Shutdown { .. } => return Ok(()),
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_sample_interval() {
        assert_eq!(clamp_sample_interval(0), None);
        assert_eq!(clamp_sample_interval(1), Some(Duration::from_millis(250)));
        assert_eq!(
            clamp_sample_interval(100_000),
            Some(Duration::from_millis(60_000))
        );
    }

    #[test]
    fn sample_now_does_not_postpone_an_existing_periodic_deadline() {
        let now = Instant::now();
        let deadline = now + Duration::from_secs(1);

        assert_eq!(
            sample_now_deadline(
                Some(deadline),
                Some(Duration::from_secs(5)),
                now + Duration::from_millis(100)
            ),
            Some(deadline)
        );
    }
}
