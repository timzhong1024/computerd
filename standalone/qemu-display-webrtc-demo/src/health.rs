use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tokio::sync::Mutex;

#[derive(Debug, Default)]
pub struct HealthState {
    qemu_connected: AtomicBool,
    ffmpeg_running: AtomicBool,
    last_frame_generation: AtomicU64,
    last_error: Mutex<Option<String>>,
}

impl HealthState {
    pub fn set_qemu_connected(&self, value: bool) {
        self.qemu_connected.store(value, Ordering::Relaxed);
    }

    pub fn set_ffmpeg_running(&self, value: bool) {
        self.ffmpeg_running.store(value, Ordering::Relaxed);
    }

    pub fn set_last_frame_generation(&self, generation: u64) {
        self.last_frame_generation
            .store(generation, Ordering::Relaxed);
    }

    pub async fn set_last_error(&self, error: impl Into<String>) {
        *self.last_error.lock().await = Some(error.into());
    }

    pub async fn clear_last_error(&self) {
        *self.last_error.lock().await = None;
    }

    pub async fn snapshot(&self) -> HealthSnapshot {
        HealthSnapshot {
            qemu_connected: self.qemu_connected.load(Ordering::Relaxed),
            ffmpeg_running: self.ffmpeg_running.load(Ordering::Relaxed),
            last_frame_generation: self.last_frame_generation.load(Ordering::Relaxed),
            last_error: self.last_error.lock().await.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct HealthSnapshot {
    pub qemu_connected: bool,
    pub ffmpeg_running: bool,
    pub last_frame_generation: u64,
    pub last_error: Option<String>,
}
