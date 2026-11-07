//! Host-wide collection (native v4): every process on the machine, not only T3's subtree.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::{
    MINIMUM_CPU_UPDATE_INTERVAL, Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System,
    UpdateKind, Users,
};

use crate::collector::{
    MAX_PROCESS_NAME_BYTES, matches_process_start_time, truncate_utf8, unix_time_ms,
};
use crate::gpu::{GpuError, Gpus};
use crate::protocol::{
    HostProcessAdded, HostProcessColumns, HostSampleEvent, HostSampleOptions, PROTOCOL_VERSION,
    ProcessTableEntry,
};

const MIN_HOST_INTERVAL_MS: u64 = 1_000;
const MAX_HOST_INTERVAL_MS: u64 = 60_000;
const MAX_STATIC_FIELD_BYTES: usize = 4 * 1_024;

/// The one refresh kind for host samples. Linux tasks stay off: walking every
/// `/proc/<pid>/task` would make each sample cost more than the processes it measures.
pub(crate) fn host_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .without_tasks()
}

fn static_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_cmd(UpdateKind::Always)
        .with_exe(UpdateKind::Always)
        .with_cwd(UpdateKind::Always)
        .with_user(UpdateKind::Always)
        .without_tasks()
}

pub(crate) fn clamp_host_interval(interval_ms: u64) -> Option<Duration> {
    (interval_ms > 0).then(|| {
        Duration::from_millis(interval_ms.clamp(MIN_HOST_INTERVAL_MS, MAX_HOST_INTERVAL_MS))
    })
}

/// A host sample, plus the message to send as `gpu-unavailable` when GPUs just turned off.
pub(crate) struct HostSampleOutcome {
    pub(crate) event: HostSampleEvent,
    pub(crate) gpus_disabled: Option<String>,
}

pub(crate) struct HostCollector {
    /// Long-lived and CPU-less: answers `processTable` and is the start-time reference for
    /// every host sample, so kill identity checks never disturb host CPU baselines.
    identity: System,
    session: Option<HostSession>,
    interval: Option<Duration>,
    options: HostSampleOptions,
    sequence: u64,
}

/// Lives while host streaming is on (or for one `hostSampleNow`), then is freed.
struct HostSession {
    system: System,
    baseline_refreshed_at: Instant,
    /// Identities whose static fields the receiver already holds: pid → start time.
    sent_statics: HashMap<u32, u64>,
    static_reset_pending: bool,
    users: Users,
}

impl HostSession {
    fn start() -> Self {
        let mut system = System::new();
        system.refresh_processes_specifics(ProcessesToUpdate::All, true, host_refresh_kind());
        Self {
            system,
            baseline_refreshed_at: Instant::now(),
            sent_statics: HashMap::new(),
            static_reset_pending: true,
            users: Users::new_with_refreshed_list(),
        }
    }
}

impl HostCollector {
    pub(crate) fn new() -> Self {
        let mut identity = System::new();
        identity.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[monitor_pid()]),
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
        Self {
            identity,
            session: None,
            interval: None,
            options: HostSampleOptions::default(),
            sequence: 0,
        }
    }

    pub(crate) fn interval(&self) -> Option<Duration> {
        self.interval
    }

    pub(crate) fn streaming_options(&self) -> HostSampleOptions {
        self.options
    }

    /// Interval 0 stops streaming and frees the host `System`.
    pub(crate) fn set_streaming(&mut self, interval_ms: u64, options: HostSampleOptions) {
        self.interval = clamp_host_interval(interval_ms);
        self.options = options;
        if self.interval.is_none() {
            self.session = None;
        }
    }

    pub(crate) fn process_table(&mut self) -> Vec<ProcessTableEntry> {
        self.identity.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
        let mut processes = self
            .identity
            .processes()
            .iter()
            .filter_map(|(pid, process)| {
                let pid = pid.as_u32();
                // Kernel idle PID 0 would fail the server's positive-PID event schema.
                if pid == 0 {
                    return None;
                }
                Some(ProcessTableEntry {
                    pid,
                    ppid: process.parent().map(Pid::as_u32).unwrap_or(0),
                    name: truncate_utf8(
                        process.name().to_string_lossy().into_owned(),
                        MAX_PROCESS_NAME_BYTES,
                    ),
                    start_time_ms: process.start_time().saturating_mul(1_000),
                })
            })
            .collect::<Vec<_>>();
        processes.sort_by_key(|process| process.pid);
        processes
    }

    pub(crate) fn sample(
        &mut self,
        options: HostSampleOptions,
        request_id: Option<String>,
        gpus: &mut Gpus,
    ) -> HostSampleOutcome {
        let needs_processes = options.processes || options.gpu_processes;
        let one_shot = needs_processes && self.session.is_none();
        let collection_started = Instant::now();
        let mut columns = None;
        let mut added = None;
        let mut scanned_process_count = 0;
        let mut inaccessible_process_count = 0;
        let mut static_reset = false;

        if needs_processes {
            let session = self.session.get_or_insert_with(HostSession::start);
            if let Some(delay) =
                MINIMUM_CPU_UPDATE_INTERVAL.checked_sub(session.baseline_refreshed_at.elapsed())
            {
                thread::sleep(delay);
            }
            session.system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                host_refresh_kind(),
            );
            session.baseline_refreshed_at = Instant::now();
            scanned_process_count = session.system.processes().len();
            if options.processes {
                let offset = epoch_offset(&session.system, &self.identity).unwrap_or(0);
                let (sampled, new_statics, inaccessible) = sample_processes(session, offset);
                static_reset = std::mem::take(&mut session.static_reset_pending);
                columns = Some(sampled);
                added = Some(new_statics);
                inaccessible_process_count = inaccessible;
            }
        }

        let mut gpus_disabled = None;
        let mut gpu_devices = None;
        let mut gpu_processes = None;
        if options.gpus || options.gpu_processes {
            let system = self.session.as_ref().map(|session| &session.system);
            let offset = system
                .and_then(|system| epoch_offset(system, &self.identity))
                .unwrap_or(0);
            let start_time_ms = |pid: u32| {
                system?
                    .process(Pid::from_u32(pid))
                    .map(|process| normalized_start_time_ms(process, offset))
            };
            match gpus.sample(options.gpu_processes, &start_time_ms) {
                Ok(sample) => {
                    gpu_devices = options.gpus.then_some(sample.devices);
                    gpu_processes = options.gpu_processes.then_some(sample.processes);
                }
                Err(GpuError::Failed(_)) => {}
                Err(GpuError::Disabled(message)) => gpus_disabled = Some(message),
            }
        }

        if one_shot && self.interval.is_none() {
            self.session = None;
        }
        self.sequence = self.sequence.saturating_add(1);
        HostSampleOutcome {
            event: HostSampleEvent {
                version: PROTOCOL_VERSION,
                event_type: "hostSample",
                sequence: self.sequence,
                sampled_at_unix_ms: unix_time_ms(),
                request_id,
                collection_duration_micros: collection_started.elapsed().as_micros() as u64,
                scanned_process_count,
                inaccessible_process_count,
                static_reset,
                processes: columns,
                added,
                gpus: gpu_devices,
                gpu_processes,
            },
            gpus_disabled,
        }
    }
}

/// Columns for every process, static fields for identities the receiver has not seen,
/// and how many new identities could not be read.
fn sample_processes(
    session: &mut HostSession,
    epoch_offset: i128,
) -> (HostProcessColumns, Vec<HostProcessAdded>, usize) {
    let mut entries = session
        .system
        .processes()
        .iter()
        .filter(|(pid, _)| pid.as_u32() != 0)
        .map(|(pid, process)| (pid.as_u32(), process))
        .collect::<Vec<_>>();
    entries.sort_by_key(|(pid, _)| *pid);

    let mut columns = HostProcessColumns::default();
    let mut new_identities = Vec::new();
    for (pid, process) in &entries {
        let start_time_ms = normalized_start_time_ms(process, epoch_offset);
        columns.pid.push(*pid);
        columns
            .ppid
            .push(process.parent().map(Pid::as_u32).unwrap_or(0));
        columns.start_time_ms.push(start_time_ms);
        columns.cpu_percent.push(process.cpu_usage());
        columns.resident_bytes.push(process.memory());
        if session.sent_statics.get(pid) != Some(&start_time_ms) {
            new_identities.push((*pid, start_time_ms));
        }
    }
    let live = columns.pid.iter().copied().collect::<HashSet<_>>();
    session.sent_statics.retain(|pid, _| live.contains(pid));

    let (added, inaccessible) = read_statics(session, &new_identities);
    for entry in &added {
        session.sent_statics.insert(entry.pid, entry.start_time_ms);
    }
    (columns, added, inaccessible)
}

fn read_statics(
    session: &HostSession,
    identities: &[(u32, u64)],
) -> (Vec<HostProcessAdded>, usize) {
    if identities.is_empty() {
        return (Vec::new(), 0);
    }
    let monitor = monitor_pid();
    let mut pids = identities
        .iter()
        .map(|(pid, _)| Pid::from_u32(*pid))
        .collect::<Vec<_>>();
    // sysinfo returns nothing at all when a pid is listed twice.
    if !pids.contains(&monitor) {
        pids.push(monitor);
    }
    // A metadata refresh resets Linux CPU times, so static fields use a throwaway System.
    let mut details = System::new();
    details.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        static_refresh_kind(),
    );
    let details_offset = epoch_offset_between(&details, &session.system, monitor);

    let added = identities
        .iter()
        .filter_map(|(pid, start_time_ms)| {
            let process = session.system.process(Pid::from_u32(*pid))?;
            let detail = details.process(Pid::from_u32(*pid))?;
            if !matches_process_start_time(
                process.start_time(),
                detail.start_time(),
                details_offset?,
            ) {
                return None;
            }
            let cgroup = read_cgroup(*pid);
            Some(HostProcessAdded {
                pid: *pid,
                start_time_ms: *start_time_ms,
                name: truncate_utf8(
                    process.name().to_string_lossy().into_owned(),
                    MAX_PROCESS_NAME_BYTES,
                ),
                user: detail
                    .user_id()
                    .and_then(|uid| session.users.get_user_by_id(uid))
                    .map(|user| user.name().to_owned())
                    .unwrap_or_default(),
                command: truncate_utf8(command_line(detail), MAX_STATIC_FIELD_BYTES),
                exe: path_field(detail.exe()),
                cwd: path_field(detail.cwd()),
                container_id: container_id(&cgroup).unwrap_or_default().to_owned(),
                cgroup: truncate_utf8(cgroup, MAX_STATIC_FIELD_BYTES),
            })
        })
        .collect::<Vec<_>>();
    // An identity left out here is retried on the next sample.
    let inaccessible = identities.len().saturating_sub(added.len());
    (added, inaccessible)
}

fn command_line(process: &Process) -> String {
    process
        .cmd()
        .iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ")
}

fn path_field(path: Option<&Path>) -> String {
    path.map(|path| truncate_utf8(path.to_string_lossy().into_owned(), MAX_STATIC_FIELD_BYTES))
        .unwrap_or_default()
}

fn monitor_pid() -> Pid {
    Pid::from_u32(std::process::id())
}

/// Seconds to subtract from `system`'s start times to land on `identity`'s epoch.
fn epoch_offset(system: &System, identity: &System) -> Option<i128> {
    epoch_offset_between(system, identity, monitor_pid())
}

// The monitor cannot be replaced while it runs, so its start time exposes any
// boot-epoch shift between two System instances.
fn epoch_offset_between(system: &System, reference: &System, monitor: Pid) -> Option<i128> {
    let observed = system.process(monitor)?.start_time();
    let expected = reference.process(monitor)?.start_time();
    Some(i128::from(observed) - i128::from(expected))
}

fn normalized_start_time_ms(process: &Process, epoch_offset: i128) -> u64 {
    let seconds = (i128::from(process.start_time()) - epoch_offset).max(0);
    u64::try_from(seconds)
        .unwrap_or(u64::MAX)
        .saturating_mul(1_000)
}

#[cfg(target_os = "linux")]
fn read_cgroup(pid: u32) -> String {
    let Ok(contents) = std::fs::read_to_string(format!("/proc/{pid}/cgroup")) else {
        return String::new();
    };
    let lines = contents.lines().collect::<Vec<_>>();
    lines
        .iter()
        .filter_map(|line| cgroup_path(line))
        .find(|path| container_id(path).is_some())
        .or_else(|| lines.iter().find_map(|line| line.strip_prefix("0::")))
        .or_else(|| lines.first().and_then(|line| cgroup_path(line)))
        .unwrap_or_default()
        .to_owned()
}

/// `hierarchy-id:controllers:path` → path.
#[cfg(target_os = "linux")]
fn cgroup_path(line: &str) -> Option<&str> {
    line.splitn(3, ':').nth(2)
}

#[cfg(not(target_os = "linux"))]
fn read_cgroup(_pid: u32) -> String {
    String::new()
}

/// Docker, Podman, containerd and CRI-O all put the 64-hex container id in the cgroup path.
pub(crate) fn container_id(cgroup: &str) -> Option<&str> {
    cgroup
        .split(|character: char| !character.is_ascii_alphanumeric())
        .find(|segment| segment.len() == 64 && segment.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// The `hostTotals` reply fields: pressure, available memory and swap.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct HostTotals {
    pub(crate) memory_pressure: Option<&'static str>,
    pub(crate) memory_available_bytes: Option<u64>,
    pub(crate) swap_total_bytes: Option<u64>,
    pub(crate) swap_used_bytes: Option<u64>,
}

pub(crate) const HOST_TOTALS_SUPPORTED: bool = cfg!(target_os = "macos");

#[cfg(target_os = "macos")]
pub(crate) fn host_totals() -> HostTotals {
    darwin::host_totals()
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn host_totals() -> HostTotals {
    HostTotals::default()
}

#[cfg(target_os = "macos")]
mod darwin {
    use std::ffi::{CStr, c_char, c_int, c_uint, c_void};

    use super::HostTotals;

    #[repr(C)]
    #[derive(Default)]
    struct XswUsage {
        total: u64,
        available: u64,
        used: u64,
        page_size: u32,
        encrypted: u32,
    }

    // `vm_statistics64` from <mach/vm_statistics.h>.
    #[repr(C, align(8))]
    #[derive(Default)]
    struct VmStatistics64 {
        free_count: u32,
        active_count: u32,
        inactive_count: u32,
        wire_count: u32,
        zero_fill_count: u64,
        reactivations: u64,
        pageins: u64,
        pageouts: u64,
        faults: u64,
        cow_faults: u64,
        lookups: u64,
        hits: u64,
        purges: u64,
        purgeable_count: u32,
        speculative_count: u32,
        decompressions: u64,
        compressions: u64,
        swapins: u64,
        swapouts: u64,
        compressor_page_count: u32,
        throttled_count: u32,
        external_page_count: u32,
        internal_page_count: u32,
        total_uncompressed_pages_in_compressor: u64,
    }

    const HOST_VM_INFO64: c_int = 4;
    const KERN_SUCCESS: c_int = 0;

    unsafe extern "C" {
        fn sysctlbyname(
            name: *const c_char,
            oldp: *mut c_void,
            oldlenp: *mut usize,
            newp: *mut c_void,
            newlen: usize,
        ) -> c_int;
        fn mach_host_self() -> c_uint;
        fn host_statistics64(
            host: c_uint,
            flavor: c_int,
            info: *mut c_int,
            count: *mut c_uint,
        ) -> c_int;
    }

    fn sysctl<T: Default>(name: &CStr) -> Option<T> {
        let mut value = T::default();
        let mut size = std::mem::size_of::<T>();
        sysctl_into(name, &mut value, &mut size)?;
        (size == std::mem::size_of::<T>()).then_some(value)
    }

    /// An integer sysctl, whether the kernel stores it in 4 or 8 bytes.
    fn sysctl_integer(name: &CStr) -> Option<u64> {
        let mut value = 0u64;
        let mut size = std::mem::size_of::<u64>();
        sysctl_into(name, &mut value, &mut size)?;
        match size {
            4 => Some(value & u64::from(u32::MAX)),
            8 => Some(value),
            _ => None,
        }
    }

    fn sysctl_into<T>(name: &CStr, value: &mut T, size: &mut usize) -> Option<()> {
        // SAFETY: `value` is a plain-old-data out-buffer of `size` bytes and `name` is NUL-terminated.
        let status = unsafe {
            sysctlbyname(
                name.as_ptr(),
                (value as *mut T).cast(),
                size,
                std::ptr::null_mut(),
                0,
            )
        };
        (status == 0).then_some(())
    }

    /// Matches the PR1 `vm_stat` reading: free (speculative included) plus inactive pages.
    fn memory_available_bytes() -> Option<u64> {
        let page_size = sysctl_integer(c"hw.pagesize")?;
        let mut statistics = VmStatistics64::default();
        let mut count =
            (std::mem::size_of::<VmStatistics64>() / std::mem::size_of::<c_int>()) as c_uint;
        // SAFETY: `statistics` is a `vm_statistics64` buffer and `count` is its size in integers.
        let status = unsafe {
            host_statistics64(
                mach_host_self(),
                HOST_VM_INFO64,
                (&mut statistics as *mut VmStatistics64).cast(),
                &mut count,
            )
        };
        (status == KERN_SUCCESS).then(|| {
            (u64::from(statistics.free_count) + u64::from(statistics.inactive_count))
                .saturating_mul(page_size)
        })
    }

    /// `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical.
    fn memory_pressure_from_level(level: u64) -> Option<&'static str> {
        match level {
            1 => Some("normal"),
            2 => Some("warn"),
            4 => Some("critical"),
            _ => None,
        }
    }

    pub(super) fn host_totals() -> HostTotals {
        let swap = sysctl::<XswUsage>(c"vm.swapusage");
        HostTotals {
            memory_pressure: sysctl_integer(c"kern.memorystatus_vm_pressure_level")
                .and_then(memory_pressure_from_level),
            memory_available_bytes: memory_available_bytes(),
            swap_total_bytes: swap.as_ref().map(|swap| swap.total),
            swap_used_bytes: swap.as_ref().map(|swap| swap.used),
        }
    }
}
