//! Host-wide collection for native v4 (nr2-native-host).
#![expect(dead_code, reason = "skeleton until nr2-native-host wires it in")]

/// What one `hostSample` carries, from `setHostStreaming` or `hostSampleNow`.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct HostSampleOptions {
    pub(crate) processes: bool,
    pub(crate) gpus: bool,
    pub(crate) gpu_processes: bool,
}
