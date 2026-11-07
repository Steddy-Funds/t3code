//! Intel through rc6 sysfs and DRM fdinfo (nr2-gpu).

use super::{GpuDeviceSample, GpuProcessSample};

pub(super) fn available() -> bool {
    false
}

#[derive(Default)]
pub(super) struct Intel;

impl Intel {
    pub(super) fn devices(&mut self) -> Result<Vec<GpuDeviceSample>, String> {
        Ok(Vec::new())
    }

    pub(super) fn processes(&mut self) -> Result<Vec<GpuProcessSample>, String> {
        Ok(Vec::new())
    }
}
