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
