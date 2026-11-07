//! NVIDIA through NVML (nr2-gpu). NVML is loaded at runtime on first use and kept; a host
//! without it reports its NVIDIA devices as `unavailable`. On Linux a device is queried only
//! while its PCI `runtime_status` says it is awake, so a suspended dGPU is never woken.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::pci::{self, PciDisplay};
use super::{Backend, GpuDeviceSample, GpuProcessSample, GpuStatus, GpuVendor};

const FALLBACK_NAME: &str = "NVIDIA GPU";

pub(super) struct NvidiaReading {
    pub(super) name: String,
    pub(super) util_percent: Option<f64>,
    pub(super) vram_total_bytes: Option<u64>,
    pub(super) vram_used_bytes: Option<u64>,
}

pub(super) struct NvidiaProcess {
    pub(super) pid: u32,
    pub(super) util_percent: Option<f64>,
    pub(super) vram_bytes: Option<u64>,
}

/// The NVML calls this backend makes, keyed by sysfs-style PCI address (`0000:01:00.0`).
pub(super) trait NvmlApi {
    /// Every device NVML sees. Used only where there is no sysfs to list devices (Windows).
    fn addresses(&self) -> Result<Vec<String>, String>;
    fn device(&self, address: &str) -> Result<NvidiaReading, String>;
    /// Per-process util covers the time since the previous call for the same device.
    fn processes(&mut self, address: &str) -> Result<Vec<NvidiaProcess>, String>;
}

pub(super) type NvmlLoader = Box<dyn Fn() -> Result<Box<dyn NvmlApi>, String>>;

enum Nvml {
    NotLoaded,
    Loaded(Box<dyn NvmlApi>),
    Unavailable,
}

struct Listed {
    address: String,
    awake: bool,
}

pub(super) fn available() -> bool {
    if cfg!(windows) {
        return windows_dll_path().is_file();
    }
    !nvidia_displays(Path::new("/")).is_empty()
}

pub(super) struct Nvidia {
    root: PathBuf,
    load: NvmlLoader,
    nvml: Nvml,
    names: HashMap<String, String>,
}

impl Default for Nvidia {
    fn default() -> Self {
        Self::new(PathBuf::from("/"), Box::new(load_nvml))
    }
}

impl Nvidia {
    pub(super) fn new(root: PathBuf, load: NvmlLoader) -> Self {
        Self {
            root,
            load,
            nvml: Nvml::NotLoaded,
            names: HashMap::new(),
        }
    }

    fn nvml(&mut self) -> Option<&mut Box<dyn NvmlApi>> {
        if matches!(self.nvml, Nvml::NotLoaded) {
            self.nvml = match (self.load)() {
                Ok(api) => Nvml::Loaded(api),
                Err(_) => Nvml::Unavailable,
            };
        }
        match &mut self.nvml {
            Nvml::Loaded(api) => Some(api),
            Nvml::NotLoaded | Nvml::Unavailable => None,
        }
    }

    fn list(&mut self) -> Result<Vec<Listed>, String> {
        if cfg!(windows) {
            let Some(api) = self.nvml() else {
                return Ok(Vec::new());
            };
            return Ok(api
                .addresses()?
                .into_iter()
                .map(|address| Listed {
                    address,
                    awake: true,
                })
                .collect());
        }
        Ok(nvidia_displays(&self.root)
            .iter()
            .map(|display| Listed {
                address: display.address.clone(),
                awake: display.awake(),
            })
            .collect())
    }

    fn device(&mut self, listed: &Listed) -> Result<GpuDeviceSample, String> {
        let mut sample = GpuDeviceSample {
            id: listed.address.clone(),
            vendor: GpuVendor::Nvidia,
            name: self
                .names
                .get(&listed.address)
                .cloned()
                .unwrap_or_else(|| FALLBACK_NAME.to_owned()),
            status: GpuStatus::Suspended,
            util_percent: Some(0.0),
            vram_total_bytes: None,
            vram_used_bytes: None,
            shared_memory: false,
        };
        if !listed.awake {
            return Ok(sample);
        }
        let Some(api) = self.nvml() else {
            sample.status = GpuStatus::Unavailable;
            sample.util_percent = None;
            return Ok(sample);
        };
        let reading = api.device(&listed.address)?;
        self.names
            .insert(listed.address.clone(), reading.name.clone());
        Ok(GpuDeviceSample {
            name: reading.name,
            status: GpuStatus::Active,
            util_percent: reading.util_percent,
            vram_total_bytes: reading.vram_total_bytes,
            vram_used_bytes: reading.vram_used_bytes,
            ..sample
        })
    }
}

impl Backend for Nvidia {
    fn devices(&mut self) -> Result<Vec<GpuDeviceSample>, String> {
        let listed = self.list()?;
        listed.iter().map(|device| self.device(device)).collect()
    }

    fn processes(&mut self) -> Result<Vec<GpuProcessSample>, String> {
        let awake: Vec<String> = self
            .list()?
            .into_iter()
            .filter(|device| device.awake)
            .map(|device| device.address)
            .collect();
        let mut rows = Vec::new();
        if awake.is_empty() {
            return Ok(rows);
        }
        let Some(api) = self.nvml() else {
            return Ok(rows);
        };
        for address in awake {
            rows.extend(
                api.processes(&address)?
                    .into_iter()
                    .map(|process| GpuProcessSample {
                        pid: process.pid,
                        start_time_ms: 0,
                        device_id: address.clone(),
                        util_percent: process.util_percent,
                        vram_bytes: process.vram_bytes,
                    }),
            );
        }
        Ok(rows)
    }
}

fn nvidia_displays(root: &Path) -> Vec<PciDisplay> {
    pci::displays(root, pci::NVIDIA_VENDOR, &["nvidia"])
}

fn windows_dll_path() -> PathBuf {
    let system_root =
        std::env::var_os("SystemRoot").unwrap_or_else(|| std::ffi::OsString::from(r"C:\Windows"));
    PathBuf::from(system_root).join("System32").join("nvml.dll")
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn load_nvml() -> Result<Box<dyn NvmlApi>, String> {
    real::RealNvml::load().map(|nvml| Box::new(nvml) as Box<dyn NvmlApi>)
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn load_nvml() -> Result<Box<dyn NvmlApi>, String> {
    Err("NVML is not supported on this platform".to_owned())
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
mod real {
    use std::collections::{BTreeMap, HashMap};

    use nvml_wrapper::Nvml;
    use nvml_wrapper::enums::device::UsedGpuMemory;
    use nvml_wrapper::error::NvmlError;
    use nvml_wrapper::struct_wrappers::device::ProcessInfo;

    use super::{NvidiaProcess, NvidiaReading, NvmlApi};

    pub(super) struct RealNvml {
        nvml: Nvml,
        last_seen_micros: HashMap<String, u64>,
    }

    impl RealNvml {
        pub(super) fn load() -> Result<Self, String> {
            #[cfg(windows)]
            let path = super::windows_dll_path().into_os_string();
            // The versioned soname: the unversioned `.so` ships only with dev packages.
            #[cfg(not(windows))]
            let path = std::ffi::OsString::from("libnvidia-ml.so.1");
            let nvml = Nvml::builder()
                .lib_path(&path)
                .init()
                .map_err(|error| format!("NVML init: {error}"))?;
            Ok(Self {
                nvml,
                last_seen_micros: HashMap::new(),
            })
        }
    }

    impl NvmlApi for RealNvml {
        fn addresses(&self) -> Result<Vec<String>, String> {
            let count = self.nvml.device_count().map_err(describe)?;
            (0..count)
                .map(|index| {
                    let device = self.nvml.device_by_index(index).map_err(describe)?;
                    let info = device.pci_info().map_err(describe)?;
                    Ok(sysfs_address(&info.bus_id))
                })
                .collect()
        }

        fn device(&self, address: &str) -> Result<NvidiaReading, String> {
            let device = self.nvml.device_by_pci_bus_id(address).map_err(describe)?;
            let memory = supported(device.memory_info())?;
            Ok(NvidiaReading {
                name: device.name().map_err(describe)?,
                util_percent: supported(device.utilization_rates())?
                    .map(|rates| f64::from(rates.gpu)),
                vram_total_bytes: memory.as_ref().map(|memory| memory.total),
                vram_used_bytes: memory.as_ref().map(|memory| memory.used),
            })
        }

        fn processes(&mut self, address: &str) -> Result<Vec<NvidiaProcess>, String> {
            let device = self.nvml.device_by_pci_bus_id(address).map_err(describe)?;
            let mut rows: BTreeMap<u32, NvidiaProcess> = BTreeMap::new();
            let compute = supported(device.running_compute_processes())?.unwrap_or_default();
            let graphics = supported(device.running_graphics_processes())?.unwrap_or_default();
            for info in compute.into_iter().chain(graphics) {
                let vram = used_bytes(&info);
                let row = rows.entry(info.pid).or_insert(NvidiaProcess {
                    pid: info.pid,
                    util_percent: None,
                    vram_bytes: None,
                });
                row.vram_bytes = row.vram_bytes.max(vram);
            }

            let last_seen = self.last_seen_micros.get(address).copied();
            let samples = match device.process_utilization_stats(last_seen) {
                Ok(samples) => Some(samples),
                // NotFound: no process used the device since `last_seen`.
                Err(NvmlError::NotFound) => Some(Vec::new()),
                Err(NvmlError::NotSupported) => None,
                Err(error) => return Err(describe(error)),
            };
            if let Some(samples) = samples {
                for row in rows.values_mut() {
                    row.util_percent = Some(0.0);
                }
                let mut newest: HashMap<u32, (u64, u32)> = HashMap::new();
                for sample in samples {
                    let entry = newest.entry(sample.pid).or_insert((0, 0));
                    if sample.timestamp >= entry.0 {
                        *entry = (sample.timestamp, sample.sm_util);
                    }
                }
                for (pid, (timestamp, sm_util)) in newest {
                    let seen = self.last_seen_micros.entry(address.to_owned()).or_insert(0);
                    *seen = (*seen).max(timestamp);
                    rows.entry(pid)
                        .or_insert(NvidiaProcess {
                            pid,
                            util_percent: None,
                            vram_bytes: None,
                        })
                        .util_percent = Some(f64::from(sm_util));
                }
            }
            Ok(rows.into_values().collect())
        }
    }

    fn used_bytes(info: &ProcessInfo) -> Option<u64> {
        match info.used_gpu_memory {
            UsedGpuMemory::Used(bytes) => Some(bytes),
            UsedGpuMemory::Unavailable => None,
        }
    }

    fn supported<T>(result: Result<T, NvmlError>) -> Result<Option<T>, String> {
        match result {
            Ok(value) => Ok(Some(value)),
            Err(NvmlError::NotSupported) => Ok(None),
            Err(error) => Err(describe(error)),
        }
    }

    fn describe(error: NvmlError) -> String {
        format!("NVML: {error}")
    }

    /// NVML's `00000000:01:00.0` as sysfs's `0000:01:00.0`, so ids match on every platform.
    fn sysfs_address(bus_id: &str) -> String {
        let lower = bus_id.to_ascii_lowercase();
        match lower.split_once(':') {
            Some((domain, rest)) if domain.len() > 4 => {
                format!("{}:{rest}", &domain[domain.len() - 4..])
            }
            _ => lower,
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    use super::super::tests::Tree;
    use super::super::{Backend, GpuStatus, GpuVendor};
    use super::{Nvidia, NvidiaProcess, NvidiaReading, NvmlApi, NvmlLoader};

    const DGPU: &str = "0000:01:00.0";
    const DGPU2: &str = "0000:02:00.0";

    #[derive(Default)]
    struct State {
        loads: Cell<u32>,
        device_calls: RefCell<Vec<String>>,
        process_calls: RefCell<Vec<String>>,
        fail_device: Cell<bool>,
        fail_processes: Cell<bool>,
    }

    struct FakeNvml(Rc<State>);

    impl NvmlApi for FakeNvml {
        fn addresses(&self) -> Result<Vec<String>, String> {
            Ok(vec![DGPU.to_owned()])
        }

        fn device(&self, address: &str) -> Result<NvidiaReading, String> {
            self.0.device_calls.borrow_mut().push(address.to_owned());
            if self.0.fail_device.get() {
                return Err("NVML: GPU is lost".to_owned());
            }
            Ok(NvidiaReading {
                name: format!("RTX {address}"),
                util_percent: Some(42.0),
                vram_total_bytes: Some(8 << 30),
                vram_used_bytes: Some(1 << 30),
            })
        }

        fn processes(&mut self, address: &str) -> Result<Vec<NvidiaProcess>, String> {
            self.0.process_calls.borrow_mut().push(address.to_owned());
            if self.0.fail_processes.get() {
                return Err("NVML: unknown error".to_owned());
            }
            Ok(vec![NvidiaProcess {
                pid: 100,
                util_percent: Some(5.0),
                vram_bytes: Some(256 << 20),
            }])
        }
    }

    fn loader(state: &Rc<State>, loads: bool) -> NvmlLoader {
        let state = state.clone();
        Box::new(move || {
            state.loads.set(state.loads.get() + 1);
            if loads {
                Ok(Box::new(FakeNvml(state.clone())) as Box<dyn NvmlApi>)
            } else {
                Err("NVML init: libnvidia-ml.so.1: cannot open shared object file".to_owned())
            }
        })
    }

    fn nvidia_gpu(tree: &Tree, address: &str, runtime_status: &str) {
        tree.pci(
            address,
            "0x10de",
            "0x030000",
            Some("nvidia"),
            Some(runtime_status),
        );
    }

    fn nvidia(tree: &Tree, state: &Rc<State>, loads: bool) -> Nvidia {
        Nvidia::new(tree.root(), loader(state, loads))
    }

    #[test]
    fn suspended_dgpu_is_reported_without_loading_nvml() {
        let tree = Tree::new();
        nvidia_gpu(&tree, DGPU, "suspended");
        let state = Rc::new(State::default());
        let mut backend = nvidia(&tree, &state, true);
        for _ in 0..3 {
            let devices = backend.devices().expect("ok");
            assert_eq!(devices.len(), 1);
            let device = &devices[0];
            assert_eq!(device.id, DGPU);
            assert_eq!(device.vendor, GpuVendor::Nvidia);
            assert_eq!(device.status, GpuStatus::Suspended);
            assert_eq!(device.util_percent, Some(0.0));
            assert_eq!(device.name, "NVIDIA GPU");
            assert_eq!(device.vram_used_bytes, None);
            assert!(!device.shared_memory);
            assert!(backend.processes().expect("ok").is_empty());
        }
        assert_eq!(state.loads.get(), 0);
    }

    #[test]
    fn missing_runtime_status_is_treated_as_asleep() {
        let tree = Tree::new();
        tree.pci(DGPU, "0x10de", "0x030000", Some("nvidia"), None);
        let state = Rc::new(State::default());
        let mut backend = nvidia(&tree, &state, true);
        assert_eq!(
            backend.devices().expect("ok")[0].status,
            GpuStatus::Suspended
        );
        assert_eq!(state.loads.get(), 0);
    }

    #[test]
    fn awake_dgpu_loads_nvml_once_and_reports_values() {
        let tree = Tree::new();
        nvidia_gpu(&tree, DGPU, "active");
        let state = Rc::new(State::default());
        let mut backend = nvidia(&tree, &state, true);
        for _ in 0..4 {
            let devices = backend.devices().expect("ok");
            let device = &devices[0];
            assert_eq!(device.status, GpuStatus::Active);
            assert_eq!(device.name, format!("RTX {DGPU}"));
            assert_eq!(device.util_percent, Some(42.0));
            assert_eq!(device.vram_total_bytes, Some(8 << 30));
            assert_eq!(device.vram_used_bytes, Some(1 << 30));
            backend.processes().expect("ok");
        }
        assert_eq!(state.loads.get(), 1);
    }

    #[test]
    fn runtime_pm_unsupported_counts_as_awake() {
        let tree = Tree::new();
        nvidia_gpu(&tree, DGPU, "unsupported");
        let state = Rc::new(State::default());
        let mut backend = nvidia(&tree, &state, true);
        assert_eq!(backend.devices().expect("ok")[0].status, GpuStatus::Active);
        assert_eq!(*state.device_calls.borrow(), [DGPU]);
    }

    #[test]
    fn missing_nvml_is_unavailable_and_never_retried() {
        let tree = Tree::new();
        nvidia_gpu(&tree, DGPU, "active");
        let state = Rc::new(State::default());
        let mut backend = nvidia(&tree, &state, false);
        for _ in 0..3 {
            let devices = backend
                .devices()
                .expect("a missing library is not an error");
            assert_eq!(devices[0].status, GpuStatus::Unavailable);
            assert_eq!(devices[0].util_percent, None);
            assert!(backend.processes().expect("ok").is_empty());
        }
        assert_eq!(state.loads.get(), 1);
    }

    #[test]
    fn device_query_error_is_an_error() {
        let tree = Tree::new();
        nvidia_gpu(&tree, DGPU, "active");
        let state = Rc::new(State::default());
        state.fail_device.set(true);
        let mut backend = nvidia(&tree, &state, true);
        assert!(backend.devices().is_err());
        state.fail_device.set(false);
        assert_eq!(
            backend.devices().expect("recovers")[0].status,
            GpuStatus::Active
        );
    }

    #[test]
    fn process_query_error_is_an_error() {
        let tree = Tree::new();
        nvidia_gpu(&tree, DGPU, "active");
        let state = Rc::new(State::default());
        state.fail_processes.set(true);
        let mut backend = nvidia(&tree, &state, true);
        assert!(backend.processes().is_err());
    }

    #[test]
    fn name_learned_while_awake_is_kept_while_suspended() {
        let tree = Tree::new();
        nvidia_gpu(&tree, DGPU, "active");
        let state = Rc::new(State::default());
        let mut backend = nvidia(&tree, &state, true);
        backend.devices().expect("ok");
        tree.set_runtime_status(DGPU, "suspended");
        let device = &backend.devices().expect("ok")[0];
        assert_eq!(device.status, GpuStatus::Suspended);
        assert_eq!(device.name, format!("RTX {DGPU}"));
        assert_eq!(state.device_calls.borrow().len(), 1);
    }

    #[test]
    fn only_nvidia_driver_display_functions_are_listed() {
        let tree = Tree::new();
        tree.pci(
            "0000:01:00.0",
            "0x10de",
            "0x030000",
            Some("nouveau"),
            Some("active"),
        );
        tree.pci(
            "0000:01:00.1",
            "0x10de",
            "0x040300",
            Some("snd_hda_intel"),
            Some("active"),
        );
        tree.pci(
            "0000:03:00.0",
            "0x10de",
            "0x0c0330",
            Some("nvidia"),
            Some("active"),
        );
        tree.pci("0000:04:00.0", "0x10de", "0x030000", None, Some("active"));
        tree.pci(
            "0000:00:02.0",
            "0x8086",
            "0x030000",
            Some("i915"),
            Some("active"),
        );
        tree.pci(
            "0000:05:00.0",
            "0x10de",
            "0x030200",
            Some("nvidia"),
            Some("active"),
        );
        let state = Rc::new(State::default());
        let mut backend = nvidia(&tree, &state, true);
        let ids: Vec<String> = backend
            .devices()
            .expect("ok")
            .into_iter()
            .map(|device| device.id)
            .collect();
        assert_eq!(ids, ["0000:05:00.0"]);
    }

    #[test]
    fn devices_are_sorted_by_address() {
        let tree = Tree::new();
        nvidia_gpu(&tree, DGPU2, "active");
        nvidia_gpu(&tree, DGPU, "suspended");
        let state = Rc::new(State::default());
        let mut backend = nvidia(&tree, &state, true);
        let devices = backend.devices().expect("ok");
        let ids: Vec<&str> = devices.iter().map(|device| device.id.as_str()).collect();
        assert_eq!(ids, [DGPU, DGPU2]);
        assert_eq!(devices[0].status, GpuStatus::Suspended);
        assert_eq!(devices[1].status, GpuStatus::Active);
        assert_eq!(*state.device_calls.borrow(), [DGPU2]);
    }

    #[test]
    fn processes_query_only_awake_devices() {
        let tree = Tree::new();
        nvidia_gpu(&tree, DGPU, "suspended");
        nvidia_gpu(&tree, DGPU2, "active");
        let state = Rc::new(State::default());
        let mut backend = nvidia(&tree, &state, true);
        let rows = backend.processes().expect("ok");
        assert_eq!(*state.process_calls.borrow(), [DGPU2]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, 100);
        assert_eq!(rows[0].device_id, DGPU2);
        assert_eq!(rows[0].start_time_ms, 0);
        assert_eq!(rows[0].util_percent, Some(5.0));
        assert_eq!(rows[0].vram_bytes, Some(256 << 20));
    }

    #[test]
    fn no_sysfs_tree_is_no_devices_and_no_load() {
        let tree = Tree::new();
        let state = Rc::new(State::default());
        let mut backend = nvidia(&tree, &state, true);
        assert!(backend.devices().expect("ok").is_empty());
        assert!(backend.processes().expect("ok").is_empty());
        assert_eq!(state.loads.get(), 0);
    }
}
