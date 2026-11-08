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
            // A suspended GPU is idle; holding 0 keeps the first read after a wake (a bare
            // baseline) from blanking a GPU that wakes and sleeps every few seconds.
            self.residency.remove(&display.address);
            self.last_util.insert(display.address.clone(), 0.0);
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
            return self.last_util.get(address).copied();
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

#[cfg(all(test, unix))]
mod tests {
    use std::cell::Cell;
    use std::rc::Rc;
    use std::time::Duration;

    use super::super::tests::Tree;
    use super::super::{Backend, GpuError, GpuStatus, GpuVendor, Gpus};
    use super::Intel;

    const IGPU: &str = "0000:00:02.0";
    const ARC: &str = "0000:03:00.0";

    struct Rig {
        tree: Tree,
        now: Rc<Cell<Duration>>,
        intel: Intel,
    }

    impl Rig {
        fn new() -> Self {
            let tree = Tree::new();
            let now = Rc::new(Cell::new(Duration::from_secs(1000)));
            let clock = now.clone();
            let intel = Intel::new(tree.root(), Box::new(move || clock.get()));
            Self { tree, now, intel }
        }

        fn advance(&self, by: Duration) {
            self.now.set(self.now.get() + by);
        }

        fn gpu(&self, address: &str, driver: &str, status: &str, autosuspend_ms: Option<u64>) {
            self.tree
                .pci(address, "0x8086", "0x030000", Some(driver), Some(status));
            if let Some(delay) = autosuspend_ms {
                self.tree.write(
                    &format!("sys/bus/pci/devices/{address}/power/autosuspend_delay_ms"),
                    &format!("{delay}\n"),
                );
            }
        }

        fn rc6(&self, address: &str, gt: u32, ms: u64) {
            self.tree.write(
                &format!("sys/bus/pci/devices/{address}/drm/card0/gt/gt{gt}/rc6_residency_ms"),
                &format!("{ms}\n"),
            );
        }

        fn util(&mut self) -> Option<f64> {
            let devices = self.intel.devices().expect("ok");
            assert_eq!(devices.len(), 1);
            assert_eq!(devices[0].status, GpuStatus::Active);
            devices[0].util_percent
        }

        /// `proc/<pid>/fd/<fd>` pointing at `target`, with `fdinfo` beside it.
        fn fd(&self, pid: u32, fd: u32, target: &str, fdinfo: &str) {
            self.tree.symlink(&format!("proc/{pid}/fd/{fd}"), target);
            self.tree.write(&format!("proc/{pid}/fdinfo/{fd}"), fdinfo);
        }

        fn rows(&mut self) -> Vec<(u32, String, Option<f64>, Option<u64>)> {
            self.intel
                .processes()
                .expect("ok")
                .into_iter()
                .map(|row| {
                    assert_eq!(row.start_time_ms, 0);
                    (row.pid, row.device_id, row.util_percent, row.vram_bytes)
                })
                .collect()
        }
    }

    /// The real i915 layout (Linux 6.x), counters filled in.
    fn i915(client: u32, pdev: &str, render_ns: u64, video_ns: u64) -> String {
        format!(
            "pos:\t0\nflags:\t02100002\nmnt_id:\t26\nino:\t1047\n\
             drm-driver:\ti915\ndrm-client-id:\t{client}\ndrm-pdev:\t{pdev}\n\
             drm-total-system0:\t4 MiB\ndrm-shared-system0:\t0\ndrm-active-system0:\t0\n\
             drm-resident-system0:\t4 MiB\ndrm-purgeable-system0:\t0\n\
             drm-total-stolen-system0:\t0\ndrm-resident-stolen-system0:\t0\n\
             drm-engine-render:\t{render_ns} ns\ndrm-engine-copy:\t0 ns\n\
             drm-engine-video:\t{video_ns} ns\ndrm-engine-capacity-video:\t2\n\
             drm-engine-video-enhance:\t0 ns\n"
        )
    }

    const RENDER: &str = "/dev/dri/renderD129";
    const SECOND: u64 = 1_000_000_000;

    // ---- device util from rc6 ----

    #[test]
    fn util_is_one_minus_rc6_share_of_wall_time() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", Some(10_000));
        rig.rc6(IGPU, 0, 50_000);
        assert_eq!(rig.util(), None, "first read is a baseline");
        rig.advance(Duration::from_secs(12));
        rig.rc6(IGPU, 0, 56_000);
        assert_eq!(rig.util(), Some(50.0));
    }

    #[test]
    fn integrated_shares_memory_and_discrete_does_not() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        rig.rc6(IGPU, 0, 0);
        rig.gpu(ARC, "i915", "active", None);
        rig.rc6(ARC, 0, 0);
        rig.tree.write(
            &format!("sys/bus/pci/devices/{ARC}/drm/card0/lmem_total_bytes"),
            "8589934592\n",
        );
        let devices = rig.intel.devices().expect("ok");
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].id, IGPU);
        assert_eq!(devices[0].vendor, GpuVendor::Intel);
        assert_eq!(devices[0].name, "Intel Graphics");
        assert!(devices[0].shared_memory);
        assert_eq!(devices[0].vram_total_bytes, None);
        assert_eq!(devices[1].id, ARC);
        assert!(!devices[1].shared_memory);
    }

    #[test]
    fn reads_closer_than_autosuspend_delay_reuse_the_last_value() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", Some(10_000));
        rig.rc6(IGPU, 0, 0);
        rig.util();
        rig.advance(Duration::from_secs(12));
        rig.rc6(IGPU, 0, 6_000);
        assert_eq!(rig.util(), Some(50.0));

        // Inside delay + 2 s: rewrite rc6 (and then remove it); the file is not read.
        rig.advance(Duration::from_secs(5));
        rig.rc6(IGPU, 0, 6_000);
        assert_eq!(rig.util(), Some(50.0));
        rig.tree.remove(&format!(
            "sys/bus/pci/devices/{IGPU}/drm/card0/gt/gt0/rc6_residency_ms"
        ));
        rig.advance(Duration::from_secs(6));
        assert_eq!(rig.util(), Some(50.0));

        // 12 s after the last real read, it reads again (the file is gone: unavailable).
        rig.advance(Duration::from_secs(1));
        let devices = rig.intel.devices().expect("ok");
        assert_eq!(devices[0].status, GpuStatus::Unavailable);
    }

    #[test]
    fn without_autosuspend_delay_reads_are_at_least_half_a_second_apart() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        rig.rc6(IGPU, 0, 0);
        rig.util();
        rig.advance(Duration::from_millis(400));
        rig.rc6(IGPU, 0, 400);
        assert_eq!(rig.util(), None, "reused: no value yet");
        rig.advance(Duration::from_millis(600));
        rig.rc6(IGPU, 0, 250);
        assert_eq!(rig.util(), Some(75.0));
    }

    #[test]
    fn suspended_igpu_reads_nothing_and_holds_zero_through_the_wake() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", Some(10_000));
        rig.rc6(IGPU, 0, 0);
        assert_eq!(rig.util(), None, "the first read ever is a bare baseline");
        rig.advance(Duration::from_secs(12));
        rig.rc6(IGPU, 0, 6_000);
        assert_eq!(rig.util(), Some(50.0));

        rig.tree.set_runtime_status(IGPU, "suspended");
        // A garbage counter proves the file is not read while suspended.
        rig.tree.write(
            &format!("sys/bus/pci/devices/{IGPU}/drm/card0/gt/gt0/rc6_residency_ms"),
            "garbage\n",
        );
        rig.advance(Duration::from_secs(12));
        let devices = rig.intel.devices().expect("ok");
        assert_eq!(devices[0].status, GpuStatus::Suspended);
        assert_eq!(devices[0].util_percent, Some(0.0));

        rig.tree.set_runtime_status(IGPU, "active");
        rig.rc6(IGPU, 0, 90_000);
        rig.advance(Duration::from_secs(1));
        assert_eq!(
            rig.util(),
            Some(0.0),
            "the wake read is a baseline that holds 0"
        );

        // Inside delay + 2 s of that baseline the counter is not read again.
        rig.advance(Duration::from_secs(5));
        rig.tree.write(
            &format!("sys/bus/pci/devices/{IGPU}/drm/card0/gt/gt0/rc6_residency_ms"),
            "garbage\n",
        );
        assert_eq!(rig.util(), Some(0.0), "held through the read window");

        rig.advance(Duration::from_secs(7));
        rig.rc6(IGPU, 0, 96_000);
        assert_eq!(rig.util(), Some(50.0));
    }

    #[test]
    fn several_gts_are_averaged() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        rig.rc6(IGPU, 0, 0);
        rig.rc6(IGPU, 1, 0);
        rig.util();
        rig.advance(Duration::from_secs(10));
        rig.rc6(IGPU, 0, 10_000);
        rig.rc6(IGPU, 1, 0);
        assert_eq!(rig.util(), Some(50.0));
    }

    #[test]
    fn a_changed_gt_count_restarts_without_a_value() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        rig.rc6(IGPU, 0, 0);
        rig.util();
        rig.advance(Duration::from_secs(10));
        rig.rc6(IGPU, 1, 0);
        assert_eq!(rig.util(), None);
    }

    #[test]
    fn rc6_going_backwards_gives_no_value_then_recovers() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        rig.rc6(IGPU, 0, 80_000);
        rig.util();
        rig.advance(Duration::from_secs(10));
        rig.rc6(IGPU, 0, 1_000);
        assert_eq!(rig.util(), None);
        rig.advance(Duration::from_secs(10));
        rig.rc6(IGPU, 0, 3_500);
        assert_eq!(rig.util(), Some(75.0));
    }

    #[test]
    fn util_is_clamped_to_0_100() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        rig.rc6(IGPU, 0, 0);
        rig.util();
        rig.advance(Duration::from_secs(10));
        // More idle than wall time (counter granularity) reads as 0, not negative.
        rig.rc6(IGPU, 0, 10_400);
        assert_eq!(rig.util(), Some(0.0));
    }

    #[test]
    fn legacy_card_power_rc6_is_read_when_there_is_no_per_gt_file() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        let legacy = format!("sys/bus/pci/devices/{IGPU}/drm/card0/power/rc6_residency_ms");
        rig.tree.write(&legacy, "0\n");
        rig.util();
        rig.advance(Duration::from_secs(4));
        rig.tree.write(&legacy, "1000\n");
        assert_eq!(rig.util(), Some(75.0));
    }

    #[test]
    fn xe_reads_gtidle_residency_per_tile_and_gt() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "xe", "active", None);
        let file = format!("sys/bus/pci/devices/{IGPU}/tile0/gt0/gtidle/idle_residency_ms");
        rig.tree.write(&file, "0\n");
        rig.util();
        rig.advance(Duration::from_secs(10));
        rig.tree.write(&file, "9000\n");
        let util = rig.util().expect("value");
        assert!((util - 10.0).abs() < 1e-9, "{util}");
    }

    #[test]
    fn unreadable_rc6_is_an_error_and_three_disable_gpus() {
        let rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        rig.tree.write(
            &format!("sys/bus/pci/devices/{IGPU}/drm/card0/gt/gt0/rc6_residency_ms"),
            "not-a-number\n",
        );
        let Rig { tree, now, intel } = rig;
        let mut gpus = Gpus::with_backends(vec![Box::new(intel)]);
        for _ in 0..2 {
            assert!(matches!(gpus.totals(), Err(GpuError::Failed(_))));
            now.set(now.get() + Duration::from_secs(1));
        }
        assert!(matches!(gpus.totals(), Err(GpuError::Disabled(_))));
        assert!(gpus.totals().expect("disabled").is_empty());
        drop(tree);
    }

    #[test]
    fn no_residency_files_is_unavailable() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        let devices = rig.intel.devices().expect("ok");
        assert_eq!(devices[0].status, GpuStatus::Unavailable);
        assert_eq!(devices[0].util_percent, None);
    }

    #[test]
    fn no_sysfs_or_other_drivers_is_no_devices() {
        let mut rig = Rig::new();
        assert!(rig.intel.devices().expect("ok").is_empty());
        assert!(rig.intel.processes().expect("ok").is_empty());
        rig.tree
            .pci(IGPU, "0x8086", "0x030000", Some("vfio-pci"), Some("active"));
        rig.tree.pci(
            "0000:00:1f.3",
            "0x8086",
            "0x040380",
            Some("i915"),
            Some("active"),
        );
        assert!(rig.intel.devices().expect("ok").is_empty());
        assert!(rig.intel.processes().expect("ok").is_empty());
    }

    // ---- per-process rows from fdinfo ----

    #[test]
    fn util_is_busiest_engine_over_the_walk_window() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        rig.fd(300, 5, RENDER, &i915(7, IGPU, 0, 0));
        assert_eq!(rig.rows(), [(300, IGPU.to_owned(), None, None)]);
        rig.advance(Duration::from_secs(2));
        rig.fd(300, 5, RENDER, &i915(7, IGPU, SECOND / 2, 3 * SECOND / 2));
        assert_eq!(rig.rows(), [(300, IGPU.to_owned(), Some(75.0), None)]);
    }

    #[test]
    fn engine_capacity_is_not_a_counter() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        rig.fd(300, 5, RENDER, &i915(7, IGPU, 0, 0));
        rig.rows();
        rig.advance(Duration::from_secs(2));
        let jumped = i915(7, IGPU, SECOND / 5, 0).replace(
            "drm-engine-capacity-video:\t2",
            "drm-engine-capacity-video:\t9000000000",
        );
        rig.fd(300, 5, RENDER, &jumped);
        assert_eq!(rig.rows(), [(300, IGPU.to_owned(), Some(10.0), None)]);
    }

    #[test]
    fn a_client_shared_by_two_pids_is_one_row_on_the_lower_pid() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        rig.fd(410, 3, RENDER, &i915(9, IGPU, 0, 0));
        rig.fd(400, 8, RENDER, &i915(9, IGPU, 0, 0));
        rig.fd(420, 4, RENDER, &i915(9, IGPU, 0, 0));
        let rows = rig.rows();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, 400);
    }

    #[test]
    fn one_pid_with_two_clients_sums_util_capped_at_100() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        rig.fd(500, 3, RENDER, &i915(1, IGPU, 0, 0));
        rig.fd(500, 4, "/dev/dri/card1", &i915(2, IGPU, 0, 0));
        rig.rows();
        rig.advance(Duration::from_secs(2));
        rig.fd(500, 3, RENDER, &i915(1, IGPU, 8 * SECOND / 5, 0));
        rig.fd(500, 4, "/dev/dri/card1", &i915(2, IGPU, 7 * SECOND / 5, 0));
        assert_eq!(rig.rows(), [(500, IGPU.to_owned(), Some(100.0), None)]);
    }

    #[test]
    fn two_clients_under_the_limit_add_up() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        rig.fd(500, 3, RENDER, &i915(1, IGPU, 0, 0));
        rig.fd(500, 4, RENDER, &i915(2, IGPU, 0, 0));
        rig.rows();
        rig.advance(Duration::from_secs(2));
        rig.fd(500, 3, RENDER, &i915(1, IGPU, SECOND / 5, 0));
        rig.fd(500, 4, RENDER, &i915(2, IGPU, 0, SECOND / 2));
        let rows = rig.rows();
        let util = rows[0].2.expect("value");
        assert!((util - 35.0).abs() < 1e-9, "{util}");
    }

    #[test]
    fn resident_local_memory_is_vram_and_system_regions_are_not() {
        let mut rig = Rig::new();
        rig.gpu(ARC, "i915", "active", None);
        let with_local =
            i915(3, ARC, 0, 0) + "drm-total-local0:\t8 MiB\ndrm-resident-local0:\t2 MiB\n";
        rig.fd(600, 3, RENDER, &with_local);
        rig.fd(601, 3, RENDER, &i915(4, ARC, 0, 0));
        rig.fd(
            602,
            3,
            RENDER,
            &(i915(5, ARC, 0, 0) + "drm-resident-local0:\t3 KiB\ndrm-resident-local1:\t512\n"),
        );
        let rows = rig.rows();
        assert_eq!(rows[0], (600, ARC.to_owned(), None, Some(2_097_152)));
        assert_eq!(rows[1], (601, ARC.to_owned(), None, None));
        assert_eq!(rows[2], (602, ARC.to_owned(), None, Some(3 * 1024 + 512)));
    }

    #[test]
    fn non_drm_fds_other_drivers_and_unknown_devices_are_ignored() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        // fd not under /dev/dri, even with i915-looking fdinfo
        rig.fd(700, 3, "/tmp/fake", &i915(1, IGPU, 0, 0));
        // another driver
        rig.fd(
            701,
            3,
            RENDER,
            &i915(2, IGPU, 0, 0).replace("i915", "amdgpu"),
        );
        // a device that is not in sysfs
        rig.fd(702, 3, RENDER, &i915(3, "0000:09:00.0", 0, 0));
        // no client id, no pdev
        rig.fd(
            703,
            3,
            RENDER,
            "drm-driver:\ti915\ndrm-pdev:\t0000:00:02.0\n",
        );
        rig.fd(704, 3, RENDER, "drm-driver:\ti915\ndrm-client-id:\t4\n");
        // fd without fdinfo, and a non-pid entry
        rig.tree.symlink("proc/705/fd/3", RENDER);
        rig.fd(1, 3, "socket:[1234]", "pos:\t0\n");
        rig.tree.write("proc/self/fdinfo/3", &i915(6, IGPU, 0, 0));
        rig.tree.write("proc/meminfo", "MemTotal: 1 kB\n");
        // the one real client
        rig.fd(706, 3, RENDER, &i915(7, IGPU, 0, 0));
        assert_eq!(rig.rows(), [(706, IGPU.to_owned(), None, None)]);
    }

    #[test]
    fn a_second_walk_within_2s_is_cached_without_reading_proc() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        rig.fd(300, 5, RENDER, &i915(7, IGPU, 0, 0));
        let first = rig.rows();
        rig.tree.remove("proc");
        rig.advance(Duration::from_millis(1999));
        assert_eq!(rig.rows(), first);
        rig.advance(Duration::from_millis(1));
        assert!(
            rig.intel.processes().is_err(),
            "past 2 s it walks /proc again"
        );
    }

    #[test]
    fn a_reused_client_id_with_lower_counters_neither_underflows_nor_sticks() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        rig.fd(300, 5, RENDER, &i915(7, IGPU, 9 * SECOND, 0));
        rig.rows();
        rig.advance(Duration::from_secs(2));
        // The backwards engine is skipped; the idle engines still give a 0 for this window.
        rig.fd(300, 5, RENDER, &i915(7, IGPU, SECOND, 0));
        assert_eq!(rig.rows(), [(300, IGPU.to_owned(), Some(0.0), None)]);
        rig.advance(Duration::from_secs(2));
        rig.fd(300, 5, RENDER, &i915(7, IGPU, 2 * SECOND, 0));
        assert_eq!(rig.rows(), [(300, IGPU.to_owned(), Some(50.0), None)]);
    }

    #[test]
    fn a_client_new_since_the_last_walk_has_no_util_yet() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "active", None);
        rig.fd(300, 5, RENDER, &i915(7, IGPU, 0, 0));
        rig.rows();
        rig.advance(Duration::from_secs(2));
        rig.fd(300, 5, RENDER, &i915(7, IGPU, SECOND, 0));
        rig.fd(301, 5, RENDER, &i915(8, IGPU, SECOND, 0));
        assert_eq!(
            rig.rows(),
            [
                (300, IGPU.to_owned(), Some(50.0), None),
                (301, IGPU.to_owned(), None, None),
            ]
        );
    }

    #[test]
    fn xe_util_is_cycles_over_total_cycles() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "xe", "active", None);
        let xe = |cycles: u64, total: u64| {
            format!(
                "pos:\t0\nflags:\t02100002\ndrm-driver:\txe\ndrm-client-id:\t11\n\
                 drm-pdev:\t{IGPU}\ndrm-total-system:\t4 MiB\ndrm-resident-system:\t4 MiB\n\
                 drm-cycles-rcs:\t{cycles}\ndrm-total-cycles-rcs:\t{total}\n\
                 drm-cycles-bcs:\t0\ndrm-total-cycles-bcs:\t{total}\n\
                 drm-engine-capacity-vcs:\t2\n"
            )
        };
        rig.fd(800, 3, RENDER, &xe(1_000, 10_000));
        rig.rows();
        rig.advance(Duration::from_secs(2));
        rig.fd(800, 3, RENDER, &xe(4_000, 30_000));
        let rows = rig.rows();
        let util = rows[0].2.expect("value");
        assert!((util - 15.0).abs() < 1e-9, "{util}");
    }

    #[test]
    fn suspended_or_missing_device_yields_no_rows() {
        let mut rig = Rig::new();
        rig.gpu(IGPU, "i915", "suspended", None);
        rig.fd(300, 5, RENDER, &i915(7, IGPU, 0, 0));
        assert!(rig.rows().is_empty());

        rig.tree.set_runtime_status(IGPU, "active");
        rig.advance(Duration::from_secs(2));
        assert_eq!(rig.rows().len(), 1);

        rig.tree.set_runtime_status(IGPU, "suspended");
        rig.advance(Duration::from_secs(2));
        assert!(rig.rows().is_empty());

        // After waking, the previous walk is gone: no util from a pre-suspend baseline.
        rig.tree.set_runtime_status(IGPU, "active");
        rig.fd(300, 5, RENDER, &i915(7, IGPU, SECOND, 0));
        rig.advance(Duration::from_secs(2));
        assert_eq!(rig.rows(), [(300, IGPU.to_owned(), None, None)]);

        rig.tree.remove("sys");
        rig.advance(Duration::from_secs(2));
        assert!(rig.rows().is_empty());
    }
}
