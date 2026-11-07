//! Intel through rc6 sysfs and DRM fdinfo (nr2-gpu), Linux only. Device util is
//! `1 − Δrc6/Δwall`. Per-process rows come from `/proc/*/fdinfo`, deduplicated by
//! `drm-client-id`, and the walk runs at most every 2 s. The `xe` driver's paths (gtidle
//! residency, cycle-based fdinfo) are unverified: written from the kernel docs, never seen live.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::pci::{self, PciDisplay};
use super::{Backend, GpuDeviceSample, GpuProcessSample, GpuStatus, GpuVendor};

const DRIVERS: [&str; 2] = ["i915", "xe"];
const NAME: &str = "Intel Graphics";
/// Reading rc6 takes a runtime-PM reference and restarts the autosuspend timer, so reads
/// closer than the device's autosuspend delay would keep an idle iGPU awake for good.
/// Calls in between reuse the last value.
const READ_INTERVAL_MARGIN: Duration = Duration::from_secs(2);
const MIN_READ_INTERVAL: Duration = Duration::from_millis(500);
const MIN_PROCESS_WALK_INTERVAL: Duration = Duration::from_secs(2);

/// Monotonic time since an arbitrary fixed point.
pub(super) type Clock = Box<dyn Fn() -> Duration>;

pub(super) fn available() -> bool {
    !intel_displays(Path::new("/")).is_empty()
}

struct Residency {
    total_ms: u64,
    gt_count: u32,
    at: Duration,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Counter {
    /// i915 `drm-engine-<name>`: busy nanoseconds.
    BusyNs,
    /// xe `drm-cycles-<name>` against `drm-total-cycles-<name>` (unverified).
    Cycles,
    TotalCycles,
}

#[derive(Default)]
struct Client {
    pid: u32,
    counters: HashMap<(Counter, String), u64>,
    local_bytes: Option<u64>,
}

struct Walk {
    at: Duration,
    clients: HashMap<(String, String), Client>,
    rows: Vec<GpuProcessSample>,
}

pub(super) struct Intel {
    root: PathBuf,
    clock: Clock,
    residency: HashMap<String, Residency>,
    last_util: HashMap<String, f64>,
    walk: Option<Walk>,
}

impl Default for Intel {
    fn default() -> Self {
        let epoch = Instant::now();
        Self::new(PathBuf::from("/"), Box::new(move || epoch.elapsed()))
    }
}

impl Intel {
    pub(super) fn new(root: PathBuf, clock: Clock) -> Self {
        Self {
            root,
            clock,
            residency: HashMap::new(),
            last_util: HashMap::new(),
            walk: None,
        }
    }

    fn device(&mut self, display: &PciDisplay, now: Duration) -> Result<GpuDeviceSample, String> {
        let mut sample = GpuDeviceSample {
            id: display.address.clone(),
            vendor: GpuVendor::Intel,
            name: NAME.to_owned(),
            status: GpuStatus::Suspended,
            util_percent: Some(0.0),
            vram_total_bytes: None,
            vram_used_bytes: None,
            shared_memory: !is_discrete(display),
        };
        if !display.awake() {
            self.residency.remove(&display.address);
            self.last_util.remove(&display.address);
            return Ok(sample);
        }
        if let Some(previous) = self.residency.get(&display.address)
            && now.saturating_sub(previous.at) < min_read_interval(display)
        {
            sample.status = GpuStatus::Active;
            sample.util_percent = self.last_util.get(&display.address).copied();
            return Ok(sample);
        }
        let files = residency_files(display);
        if files.is_empty() {
            sample.status = GpuStatus::Unavailable;
            sample.util_percent = None;
            return Ok(sample);
        }
        let mut total_ms = 0u64;
        for file in &files {
            total_ms = total_ms.saturating_add(read_u64(file)?);
        }
        sample.status = GpuStatus::Active;
        sample.util_percent = self.util(
            &display.address,
            Residency {
                total_ms,
                gt_count: u32::try_from(files.len()).unwrap_or(u32::MAX),
                at: now,
            },
        );
        Ok(sample)
    }

    fn util(&mut self, address: &str, current: Residency) -> Option<f64> {
        let Some(previous) = self.residency.get(address) else {
            self.residency.insert(address.to_owned(), current);
            return None;
        };
        let wall = current.at.saturating_sub(previous.at);
        let util = (previous.gt_count == current.gt_count)
            .then(|| current.total_ms.checked_sub(previous.total_ms))
            .flatten()
            .map(|idle_ms| {
                let wall_ms = wall.as_secs_f64() * 1000.0 * f64::from(current.gt_count);
                ((1.0 - idle_ms as f64 / wall_ms) * 100.0).clamp(0.0, 100.0)
            });
        self.residency.insert(address.to_owned(), current);
        match util {
            Some(value) => self.last_util.insert(address.to_owned(), value),
            None => self.last_util.remove(address),
        };
        util
    }

    fn walk_processes(&self, devices: &[String], now: Duration) -> Result<Walk, String> {
        let proc_dir = self.root.join("proc");
        let entries = fs::read_dir(&proc_dir).map_err(|error| format!("read /proc: {error}"))?;
        let mut clients: HashMap<(String, String), Client> = HashMap::new();
        for entry in entries.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
            else {
                continue;
            };
            for client in drm_clients(&entry.path(), pid) {
                if !devices.contains(&client.0.0) {
                    continue;
                }
                match clients.get(&client.0) {
                    Some(existing) if existing.pid <= pid => {}
                    _ => {
                        clients.insert(client.0, client.1);
                    }
                }
            }
        }

        let previous = self.walk.as_ref();
        let mut rows: HashMap<(u32, String), GpuProcessSample> = HashMap::new();
        for ((device, client_id), client) in &clients {
            let util = previous.and_then(|walk| {
                let before = walk.clients.get(&(device.clone(), client_id.clone()))?;
                client_util(before, client, now.saturating_sub(walk.at))
            });
            let row = rows
                .entry((client.pid, device.clone()))
                .or_insert(GpuProcessSample {
                    pid: client.pid,
                    start_time_ms: 0,
                    device_id: device.clone(),
                    util_percent: None,
                    vram_bytes: None,
                });
            if let Some(util) = util {
                row.util_percent = Some((row.util_percent.unwrap_or(0.0) + util).min(100.0));
            }
            if let Some(bytes) = client.local_bytes {
                row.vram_bytes = Some(row.vram_bytes.unwrap_or(0).saturating_add(bytes));
            }
        }
        let mut rows: Vec<GpuProcessSample> = rows.into_values().collect();
        rows.sort_by(|a, b| (a.pid, &a.device_id).cmp(&(b.pid, &b.device_id)));
        Ok(Walk {
            at: now,
            clients,
            rows,
        })
    }
}

impl Backend for Intel {
    fn devices(&mut self) -> Result<Vec<GpuDeviceSample>, String> {
        let now = (self.clock)();
        let displays = intel_displays(&self.root);
        displays
            .iter()
            .map(|display| self.device(display, now))
            .collect()
    }

    fn processes(&mut self) -> Result<Vec<GpuProcessSample>, String> {
        let now = (self.clock)();
        if let Some(walk) = &self.walk
            && now.saturating_sub(walk.at) < MIN_PROCESS_WALK_INTERVAL
        {
            return Ok(walk.rows.clone());
        }
        let devices: Vec<String> = intel_displays(&self.root)
            .into_iter()
            .filter(PciDisplay::awake)
            .map(|display| display.address)
            .collect();
        if devices.is_empty() {
            self.walk = None;
            return Ok(Vec::new());
        }
        let walk = self.walk_processes(&devices, now)?;
        let rows = walk.rows.clone();
        self.walk = Some(walk);
        Ok(rows)
    }
}

fn intel_displays(root: &Path) -> Vec<PciDisplay> {
    pci::displays(root, pci::INTEL_VENDOR, &DRIVERS)
}

fn min_read_interval(display: &PciDisplay) -> Duration {
    pci::read_trimmed(&display.path.join("power/autosuspend_delay_ms"))
        .and_then(|delay| delay.parse::<u64>().ok())
        .map_or(MIN_READ_INTERVAL, |delay| {
            Duration::from_millis(delay) + READ_INTERVAL_MARGIN
        })
        .max(MIN_READ_INTERVAL)
}

/// Discrete cards (Arc) report a `local` memory region in fdinfo; i915 exposes
/// `lmem_total_bytes` for them. Integrated parts share system memory.
fn is_discrete(display: &PciDisplay) -> bool {
    drm_cards(display)
        .iter()
        .any(|card| card.join("lmem_total_bytes").exists())
        || display.path.join("tile0/vram0").exists()
}

fn residency_files(display: &PciDisplay) -> Vec<PathBuf> {
    if display.driver == "xe" {
        // Unverified: xe exposes idle residency per tile and gt.
        return glob_dirs(&display.path, "tile")
            .iter()
            .flat_map(|tile| glob_dirs(tile, "gt"))
            .map(|gt| gt.join("gtidle/idle_residency_ms"))
            .filter(|file| file.is_file())
            .collect();
    }
    for card in drm_cards(display) {
        let per_gt: Vec<PathBuf> = glob_dirs(&card.join("gt"), "gt")
            .into_iter()
            .map(|gt| gt.join("rc6_residency_ms"))
            .filter(|file| file.is_file())
            .collect();
        if !per_gt.is_empty() {
            return per_gt;
        }
        let legacy = card.join("power/rc6_residency_ms");
        if legacy.is_file() {
            return vec![legacy];
        }
    }
    Vec::new()
}

fn drm_cards(display: &PciDisplay) -> Vec<PathBuf> {
    glob_dirs(&display.path.join("drm"), "card")
}

/// Subdirectories of `dir` named `<prefix><digits>`, sorted.
fn glob_dirs(dir: &Path, prefix: &str) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_prefix(prefix))
                .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
        })
        .map(|entry| entry.path())
        .collect();
    found.sort();
    found
}

fn read_u64(file: &Path) -> Result<u64, String> {
    let text = fs::read_to_string(file).map_err(|error| format!("{}: {error}", file.display()))?;
    text.trim()
        .parse()
        .map_err(|_| format!("{}: not a number", file.display()))
}

/// DRM clients a process holds open, keyed by `(drm-pdev, drm-client-id)`. Unreadable
/// processes (other users, already gone) have none.
fn drm_clients(process_dir: &Path, pid: u32) -> Vec<((String, String), Client)> {
    let Ok(fds) = fs::read_dir(process_dir.join("fd")) else {
        return Vec::new();
    };
    fds.flatten()
        .filter(|fd| fs::read_link(fd.path()).is_ok_and(|target| target.starts_with("/dev/dri/")))
        .filter_map(|fd| {
            let text = fs::read_to_string(process_dir.join("fdinfo").join(fd.file_name())).ok()?;
            parse_fdinfo(&text, pid)
        })
        .collect()
}

fn parse_fdinfo(text: &str, pid: u32) -> Option<((String, String), Client)> {
    let mut driver = None;
    let mut device = None;
    let mut client_id = None;
    let mut client = Client {
        pid,
        ..Client::default()
    };
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key {
            "drm-driver" => driver = Some(value),
            "drm-pdev" => device = Some(value.to_owned()),
            "drm-client-id" => client_id = Some(value.to_owned()),
            _ if key.starts_with("drm-resident-local") => {
                if let Some(bytes) = parse_bytes(value) {
                    client.local_bytes =
                        Some(client.local_bytes.unwrap_or(0).saturating_add(bytes));
                }
            }
            _ => {
                if let Some((counter, engine)) = engine_counter(key)
                    && let Some(count) =
                        value.split_whitespace().next().and_then(|n| n.parse().ok())
                {
                    client.counters.insert((counter, engine.to_owned()), count);
                }
            }
        }
    }
    if !DRIVERS.contains(&driver?) {
        return None;
    }
    Some(((device?, client_id?), client))
}

fn engine_counter(key: &str) -> Option<(Counter, &str)> {
    if let Some(engine) = key.strip_prefix("drm-engine-") {
        // `drm-engine-capacity-<name>` is an engine count, not a counter.
        return (!engine.starts_with("capacity-")).then_some((Counter::BusyNs, engine));
    }
    if let Some(engine) = key.strip_prefix("drm-total-cycles-") {
        return Some((Counter::TotalCycles, engine));
    }
    key.strip_prefix("drm-cycles-")
        .map(|engine| (Counter::Cycles, engine))
}

fn parse_bytes(value: &str) -> Option<u64> {
    let mut parts = value.split_whitespace();
    let number: u64 = parts.next()?.parse().ok()?;
    let scale = match parts.next() {
        None => 1,
        Some("KiB") => 1 << 10,
        Some("MiB") => 1 << 20,
        Some("GiB") => 1 << 30,
        Some(_) => return None,
    };
    number.checked_mul(scale)
}

/// The busiest engine's share of the window, in percent.
fn client_util(before: &Client, now: &Client, wall: Duration) -> Option<f64> {
    let delta = |counter: Counter, engine: &str| {
        let key = (counter, engine.to_owned());
        now.counters
            .get(&key)?
            .checked_sub(*before.counters.get(&key)?)
    };
    let wall_ns = wall.as_nanos() as f64;
    now.counters
        .keys()
        .filter_map(|(counter, engine)| match counter {
            Counter::BusyNs if wall_ns > 0.0 => {
                delta(Counter::BusyNs, engine).map(|busy| busy as f64 / wall_ns)
            }
            Counter::Cycles => match (
                delta(Counter::Cycles, engine),
                delta(Counter::TotalCycles, engine),
            ) {
                (Some(cycles), Some(total)) if total > 0 => Some(cycles as f64 / total as f64),
                _ => None,
            },
            Counter::BusyNs | Counter::TotalCycles => None,
        })
        .map(|share| (share * 100.0).clamp(0.0, 100.0))
        .reduce(f64::max)
}
