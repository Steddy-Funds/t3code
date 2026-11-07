//! GPU sampling (nr2-gpu). Errors are contained: nothing here panics or ends the monitor.
#![expect(
    dead_code,
    reason = "skeleton until nr2-gpu and nr2-native-host wire it in"
)]

mod intel;
mod nvidia;

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
    Failed(String),
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

/// Lives for the monitor's lifetime. Vendor backends initialise lazily on first use.
#[derive(Default)]
pub(crate) struct Gpus {
    nvidia: nvidia::Nvidia,
    intel: intel::Intel,
    consecutive_errors: u32,
    disabled: bool,
}

impl Gpus {
    /// Device totals only, no process walk (the always-on 5 s `gpuTotals`). Suspended devices
    /// are reported as `suspended` and never woken.
    pub(crate) fn totals(&mut self) -> Result<Vec<GpuDeviceSample>, GpuError> {
        Ok(Vec::new())
    }

    /// Devices, plus per-process rows when `processes` is set. `start_time_ms` resolves a pid to
    /// the caller's process identity; rows whose pid it does not know are dropped.
    pub(crate) fn sample(
        &mut self,
        _processes: bool,
        _start_time_ms: &dyn Fn(u32) -> Option<u64>,
    ) -> Result<GpuSample, GpuError> {
        Ok(GpuSample::default())
    }
}
