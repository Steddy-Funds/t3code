//! GPU sampling (nr2-gpu). Errors are contained: nothing here panics or ends the monitor.

mod intel;
mod nvidia;
mod pci;

use serde::Serialize;

const MAX_CONSECUTIVE_ERRORS: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GpuVendor {
    Nvidia,
    Intel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GpuStatus {
    Active,
    Suspended,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GpuDeviceSample {
    pub(crate) id: String,
    pub(crate) vendor: GpuVendor,
    pub(crate) name: String,
    pub(crate) status: GpuStatus,
    pub(crate) util_percent: Option<f64>,
    pub(crate) vram_total_bytes: Option<u64>,
    pub(crate) vram_used_bytes: Option<u64>,
    pub(crate) shared_memory: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GpuProcessSample {
    pub(crate) pid: u32,
    pub(crate) start_time_ms: u64,
    pub(crate) device_id: String,
    pub(crate) util_percent: Option<f64>,
    pub(crate) vram_bytes: Option<u64>,
}

#[derive(Debug, Default)]
pub(crate) struct GpuSample {
    pub(crate) devices: Vec<GpuDeviceSample>,
    pub(crate) processes: Vec<GpuProcessSample>,
}

/// What `hello` advertises: "can try", decided without initialising NVML.
#[derive(Debug, Clone, Copy)]
pub(crate) struct GpuCapabilities {
    pub(crate) nvidia: bool,
    pub(crate) intel: bool,
}

#[derive(Debug)]
pub(crate) enum GpuError {
    /// One query failed. GPUs stay on; the caller omits GPU fields for this reply.
    Failed(#[allow(dead_code, reason = "a reason for logs; the host may drop it")] String),
    /// The third failure in a row. GPUs are off for the rest of this monitor run and later
    /// calls answer empty without querying; the caller sends `gpu-unavailable` once.
    Disabled(String),
}

pub(crate) fn capabilities() -> GpuCapabilities {
    GpuCapabilities {
        nvidia: nvidia::available(),
        intel: intel::available(),
    }
}

/// One vendor. `processes` rows carry `start_time_ms: 0`; `Gpus` resolves identity.
trait Backend {
    fn devices(&mut self) -> Result<Vec<GpuDeviceSample>, String>;
    fn processes(&mut self) -> Result<Vec<GpuProcessSample>, String>;
}

/// Lives for the monitor's lifetime. Vendor backends initialise lazily on first use.
pub(crate) struct Gpus {
    backends: Vec<Box<dyn Backend>>,
    consecutive_errors: u32,
    disabled: bool,
}

impl Default for Gpus {
    fn default() -> Self {
        Self::with_backends(vec![
            Box::new(nvidia::Nvidia::default()),
            Box::new(intel::Intel::default()),
        ])
    }
}

impl Gpus {
    fn with_backends(backends: Vec<Box<dyn Backend>>) -> Self {
        Self {
            backends,
            consecutive_errors: 0,
            disabled: false,
        }
    }

    /// Device totals only, no process walk (the always-on 5 s `gpuTotals`). Suspended devices
    /// are reported as `suspended` and never woken.
    pub(crate) fn totals(&mut self) -> Result<Vec<GpuDeviceSample>, GpuError> {
        Ok(self.sample(false, &|_| None)?.devices)
    }

    /// Devices, plus per-process rows when `processes` is set. `start_time_ms` resolves a pid to
    /// the caller's process identity; rows whose pid it does not know are dropped.
    pub(crate) fn sample(
        &mut self,
        processes: bool,
        start_time_ms: &dyn Fn(u32) -> Option<u64>,
    ) -> Result<GpuSample, GpuError> {
        if self.disabled {
            return Ok(GpuSample::default());
        }
        match self.query(processes) {
            Ok(mut sample) => {
                self.consecutive_errors = 0;
                sample
                    .processes
                    .retain_mut(|row| match start_time_ms(row.pid) {
                        Some(start) => {
                            row.start_time_ms = start;
                            true
                        }
                        None => false,
                    });
                Ok(sample)
            }
            Err(message) => {
                self.consecutive_errors += 1;
                if self.consecutive_errors < MAX_CONSECUTIVE_ERRORS {
                    return Err(GpuError::Failed(message));
                }
                self.disabled = true;
                self.backends.clear();
                Err(GpuError::Disabled(message))
            }
        }
    }

    fn query(&mut self, processes: bool) -> Result<GpuSample, String> {
        let mut sample = GpuSample::default();
        for backend in &mut self.backends {
            sample.devices.extend(backend.devices()?);
            if processes {
                sample.processes.extend(backend.processes()?);
            }
        }
        Ok(sample)
    }
}

#[cfg(test)]
mod live {
    use super::Gpus;

    /// `cargo test gpu_live -- --ignored --nocapture` on a host with GPUs. Read-only: it reads
    /// `runtime_status` first and never wakes a suspended device.
    #[test]
    #[ignore = "reads this host's GPUs"]
    fn gpu_live() {
        for entry in std::fs::read_dir("/sys/bus/pci/devices")
            .into_iter()
            .flatten()
            .flatten()
        {
            let path = entry.path();
            let class = std::fs::read_to_string(path.join("class")).unwrap_or_default();
            if class.starts_with("0x03") {
                let status = std::fs::read_to_string(path.join("power/runtime_status"));
                println!(
                    "{}: runtime_status {:?}",
                    entry.file_name().display(),
                    status
                );
            }
        }
        let mut gpus = Gpus::default();
        println!("capabilities {:?}", super::capabilities());
        println!("totals 1 {:#?}", gpus.totals());
        std::thread::sleep(std::time::Duration::from_secs(2));
        println!("totals 2 {:#?}", gpus.totals());
        let first = gpus.sample(true, &|_| Some(0));
        println!("sample 1 {first:#?}");
        std::thread::sleep(std::time::Duration::from_secs(2));
        println!("sample 2 {:#?}", gpus.sample(true, &|_| Some(0)));
    }

    /// The 5 s `gpuTotals` cadence must still let an idle iGPU runtime-suspend.
    #[test]
    #[ignore = "reads this host's GPUs for 50 s"]
    fn gpu_live_poll() {
        let mut gpus = Gpus::default();
        for _ in 0..10 {
            let statuses: Vec<String> = gpus
                .totals()
                .map(|devices| {
                    devices
                        .iter()
                        .map(|device| {
                            format!(
                                "{} {:?} {:?}",
                                device.id, device.status, device.util_percent
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            println!("{statuses:?}");
            std::thread::sleep(std::time::Duration::from_secs(5));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;
    use std::path::{Path, PathBuf};
    use std::rc::Rc;
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::{Backend, GpuDeviceSample, GpuError, GpuProcessSample, GpuStatus, GpuVendor, Gpus};

    /// A throwaway directory standing in for `/` (fake sysfs and procfs), removed on drop.
    pub(in crate::gpu) struct Tree {
        root: PathBuf,
    }

    impl Tree {
        pub(in crate::gpu) fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let root = std::env::temp_dir().join(format!(
                "t3-resource-monitor-gpu-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).expect("create tempdir");
            Self { root }
        }

        pub(in crate::gpu) fn root(&self) -> PathBuf {
            self.root.clone()
        }

        pub(in crate::gpu) fn write(&self, relative: &str, contents: &str) {
            let path = self.root.join(relative);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            std::fs::write(path, contents).expect("write");
        }

        #[cfg(unix)]
        pub(in crate::gpu) fn symlink(&self, relative: &str, target: &str) {
            let path = self.root.join(relative);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            let _ = std::fs::remove_file(&path);
            std::os::unix::fs::symlink(Path::new(target), path).expect("symlink");
        }

        pub(in crate::gpu) fn remove(&self, relative: &str) {
            let path = self.root.join(relative);
            if path.is_dir() {
                std::fs::remove_dir_all(path).expect("remove dir");
            } else {
                std::fs::remove_file(path).expect("remove file");
            }
        }

        /// A PCI function under `sys/bus/pci/devices/<address>` bound to `driver`.
        #[cfg(unix)]
        pub(in crate::gpu) fn pci(
            &self,
            address: &str,
            vendor: &str,
            class: &str,
            driver: Option<&str>,
            runtime_status: Option<&str>,
        ) {
            let base = format!("sys/bus/pci/devices/{address}");
            self.write(&format!("{base}/vendor"), &format!("{vendor}\n"));
            self.write(&format!("{base}/class"), &format!("{class}\n"));
            if let Some(driver) = driver {
                self.symlink(
                    &format!("{base}/driver"),
                    &format!("../../../../bus/pci/drivers/{driver}"),
                );
            }
            if let Some(status) = runtime_status {
                self.set_runtime_status(address, status);
            }
        }

        pub(in crate::gpu) fn set_runtime_status(&self, address: &str, status: &str) {
            self.write(
                &format!("sys/bus/pci/devices/{address}/power/runtime_status"),
                &format!("{status}\n"),
            );
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[derive(Default)]
    struct Script {
        devices: RefCell<VecDeque<Result<Vec<GpuDeviceSample>, String>>>,
        processes: RefCell<VecDeque<Result<Vec<GpuProcessSample>, String>>>,
        device_calls: Cell<u32>,
        process_calls: Cell<u32>,
    }

    /// Answers from the script; an exhausted script answers `Ok(empty)`.
    struct Fake(Rc<Script>);

    impl Backend for Fake {
        fn devices(&mut self) -> Result<Vec<GpuDeviceSample>, String> {
            self.0.device_calls.set(self.0.device_calls.get() + 1);
            self.0
                .devices
                .borrow_mut()
                .pop_front()
                .unwrap_or_else(|| Ok(Vec::new()))
        }

        fn processes(&mut self) -> Result<Vec<GpuProcessSample>, String> {
            self.0.process_calls.set(self.0.process_calls.get() + 1);
            self.0
                .processes
                .borrow_mut()
                .pop_front()
                .unwrap_or_else(|| Ok(Vec::new()))
        }
    }

    fn gpus_with(scripts: &[Rc<Script>]) -> Gpus {
        Gpus::with_backends(
            scripts
                .iter()
                .map(|script| Box::new(Fake(script.clone())) as Box<dyn Backend>)
                .collect(),
        )
    }

    fn script(devices: Vec<Result<Vec<GpuDeviceSample>, String>>) -> Rc<Script> {
        let script = Script::default();
        *script.devices.borrow_mut() = devices.into();
        Rc::new(script)
    }

    fn device(id: &str) -> GpuDeviceSample {
        GpuDeviceSample {
            id: id.to_owned(),
            vendor: GpuVendor::Nvidia,
            name: "GPU".to_owned(),
            status: GpuStatus::Active,
            util_percent: Some(10.0),
            vram_total_bytes: Some(100),
            vram_used_bytes: Some(10),
            shared_memory: false,
        }
    }

    fn process(pid: u32) -> GpuProcessSample {
        GpuProcessSample {
            pid,
            start_time_ms: 0,
            device_id: "0000:01:00.0".to_owned(),
            util_percent: Some(1.0),
            vram_bytes: Some(1),
        }
    }

    fn err(message: &str) -> Result<Vec<GpuDeviceSample>, String> {
        Err(message.to_owned())
    }

    #[test]
    fn third_consecutive_error_disables_and_later_calls_never_query() {
        let fake = script(vec![err("one"), err("two"), err("three")]);
        let mut gpus = gpus_with(std::slice::from_ref(&fake));
        assert!(matches!(gpus.totals(), Err(GpuError::Failed(m)) if m == "one"));
        assert!(matches!(gpus.totals(), Err(GpuError::Failed(m)) if m == "two"));
        assert!(matches!(gpus.totals(), Err(GpuError::Disabled(m)) if m == "three"));
        assert_eq!(fake.device_calls.get(), 3);

        for _ in 0..3 {
            assert!(gpus.totals().expect("disabled answers Ok").is_empty());
            let sample = gpus
                .sample(true, &|_| Some(1))
                .expect("disabled answers Ok");
            assert!(sample.devices.is_empty() && sample.processes.is_empty());
        }
        assert_eq!(fake.device_calls.get(), 3);
        assert_eq!(fake.process_calls.get(), 0);
    }

    #[test]
    fn a_success_resets_the_streak() {
        let fake = script(vec![
            err("a"),
            err("b"),
            Ok(vec![device("0000:01:00.0")]),
            err("c"),
            err("d"),
            err("e"),
        ]);
        let mut gpus = gpus_with(&[fake]);
        assert!(matches!(gpus.totals(), Err(GpuError::Failed(_))));
        assert!(matches!(gpus.totals(), Err(GpuError::Failed(_))));
        assert_eq!(gpus.totals().expect("success").len(), 1);
        assert!(matches!(gpus.totals(), Err(GpuError::Failed(m)) if m == "c"));
        assert!(matches!(gpus.totals(), Err(GpuError::Failed(m)) if m == "d"));
        assert!(matches!(gpus.totals(), Err(GpuError::Disabled(m)) if m == "e"));
    }

    #[test]
    fn process_errors_share_the_streak_with_device_errors() {
        let fake = script(vec![err("devices")]);
        *fake.processes.borrow_mut() =
            vec![Err("walk 1".to_owned()), Err("walk 2".to_owned())].into();
        let mut gpus = gpus_with(std::slice::from_ref(&fake));
        assert!(matches!(gpus.totals(), Err(GpuError::Failed(_))));
        assert!(matches!(
            gpus.sample(true, &|_| Some(0)),
            Err(GpuError::Failed(m)) if m == "walk 1"
        ));
        assert!(matches!(
            gpus.sample(true, &|_| Some(0)),
            Err(GpuError::Disabled(m)) if m == "walk 2"
        ));
        assert_eq!(fake.process_calls.get(), 2);
    }

    #[test]
    fn one_failing_backend_fails_the_query_and_counts_once() {
        let healthy = script(vec![
            Ok(vec![device("0000:01:00.0")]),
            Ok(vec![device("0000:01:00.0")]),
            Ok(vec![device("0000:01:00.0")]),
        ]);
        let broken = script(vec![err("x"), err("y"), err("z")]);
        let mut gpus = gpus_with(&[healthy, broken]);
        assert!(matches!(gpus.totals(), Err(GpuError::Failed(_))));
        assert!(matches!(gpus.totals(), Err(GpuError::Failed(_))));
        assert!(matches!(gpus.totals(), Err(GpuError::Disabled(_))));
    }

    #[test]
    fn devices_from_every_backend_in_order() {
        let first = script(vec![Ok(vec![device("a")])]);
        let second = script(vec![Ok(vec![device("b"), device("c")])]);
        let mut gpus = gpus_with(&[first, second]);
        let ids: Vec<String> = gpus
            .totals()
            .expect("ok")
            .into_iter()
            .map(|device| device.id)
            .collect();
        assert_eq!(ids, ["a", "b", "c"]);
    }

    #[test]
    fn sample_resolves_identity_and_drops_unknown_pids() {
        let fake = script(vec![Ok(vec![device("0000:01:00.0")])]);
        *fake.processes.borrow_mut() = vec![Ok(vec![process(10), process(11), process(12)])].into();
        let mut gpus = gpus_with(&[fake]);
        let sample = gpus
            .sample(true, &|pid| (pid != 11).then_some(u64::from(pid) * 1000))
            .expect("ok");
        let rows: Vec<(u32, u64)> = sample
            .processes
            .iter()
            .map(|row| (row.pid, row.start_time_ms))
            .collect();
        assert_eq!(rows, [(10, 10_000), (12, 12_000)]);
        assert_eq!(sample.devices.len(), 1);
    }

    #[test]
    fn totals_and_device_only_samples_never_walk_processes() {
        let fake = script(Vec::new());
        let mut gpus = gpus_with(std::slice::from_ref(&fake));
        gpus.totals().expect("ok");
        gpus.sample(false, &|_| Some(0)).expect("ok");
        assert_eq!(fake.device_calls.get(), 2);
        assert_eq!(fake.process_calls.get(), 0);
        gpus.sample(true, &|_| Some(0)).expect("ok");
        assert_eq!(fake.process_calls.get(), 1);
    }

    #[test]
    fn wire_shapes_are_camel_case_with_lowercase_literals() {
        let mut sample = device("0000:01:00.0");
        sample.status = GpuStatus::Suspended;
        sample.util_percent = Some(0.0);
        sample.vram_total_bytes = None;
        sample.vram_used_bytes = None;
        assert_eq!(
            serde_json::to_value(&sample).expect("serialize"),
            serde_json::json!({
                "id": "0000:01:00.0",
                "vendor": "nvidia",
                "name": "GPU",
                "status": "suspended",
                "utilPercent": 0.0,
                "vramTotalBytes": null,
                "vramUsedBytes": null,
                "sharedMemory": false,
            })
        );
        let mut intel = device("0000:00:02.0");
        intel.vendor = GpuVendor::Intel;
        intel.status = GpuStatus::Unavailable;
        let json = serde_json::to_value(&intel).expect("serialize");
        assert_eq!(json["vendor"], "intel");
        assert_eq!(json["status"], "unavailable");
        assert_eq!(
            serde_json::to_value(GpuStatus::Active).expect("serialize"),
            "active"
        );

        let mut row = process(42);
        row.start_time_ms = 7;
        row.util_percent = None;
        assert_eq!(
            serde_json::to_value(&row).expect("serialize"),
            serde_json::json!({
                "pid": 42,
                "startTimeMs": 7,
                "deviceId": "0000:01:00.0",
                "utilPercent": null,
                "vramBytes": 1,
            })
        );
    }
}
