//! Display devices from `<root>/sys/bus/pci/devices`. Reading these files never wakes a device.

use std::fs;
use std::path::{Path, PathBuf};

pub(super) const NVIDIA_VENDOR: &str = "0x10de";
pub(super) const INTEL_VENDOR: &str = "0x8086";

pub(super) struct PciDisplay {
    /// The sysfs address, e.g. `0000:01:00.0`; also the wire `id`.
    pub(super) address: String,
    pub(super) path: PathBuf,
    pub(super) driver: String,
}

impl PciDisplay {
    /// `unsupported` means runtime PM is off, so the device never sleeps and querying it is safe.
    pub(super) fn awake(&self) -> bool {
        matches!(
            read_trimmed(&self.path.join("power/runtime_status")).as_deref(),
            Some("active" | "unsupported")
        )
    }
}

/// Display-class devices from `vendor` bound to one of `drivers`, sorted by address. A missing
/// tree (macOS, Windows, containers without sysfs) is no devices, not an error.
pub(super) fn displays(root: &Path, vendor: &str, drivers: &[&str]) -> Vec<PciDisplay> {
    let Ok(entries) = fs::read_dir(root.join("sys/bus/pci/devices")) else {
        return Vec::new();
    };
    let mut found: Vec<PciDisplay> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if read_trimmed(&path.join("vendor")).as_deref() != Some(vendor) {
                return None;
            }
            if !read_trimmed(&path.join("class"))?.starts_with("0x03") {
                return None;
            }
            let driver = fs::read_link(path.join("driver"))
                .ok()?
                .file_name()?
                .to_string_lossy()
                .into_owned();
            drivers.contains(&driver.as_str()).then(|| PciDisplay {
                address: entry.file_name().to_string_lossy().into_owned(),
                path,
                driver,
            })
        })
        .collect();
    found.sort_by(|a, b| a.address.cmp(&b.address));
    found
}

pub(super) fn read_trimmed(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|text| text.trim().to_owned())
}
