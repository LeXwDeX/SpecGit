//! Atomic synthetic API snapshots for concurrent child/parent fixture readers.
use serde_json::Value;
use std::{
    io::Write,
    path::Path,
    time::{Duration, Instant},
};
pub fn write(path: impl AsRef<Path>, value: &Value) {
    let path = path.as_ref();
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap()).unwrap();
    serde_json::to_writer(&mut temporary, value).unwrap();
    temporary.flush().unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match temporary.persist(path) {
            Ok(_) => return,
            Err(error)
                if cfg!(windows)
                    && matches!(error.error.raw_os_error(), Some(5 | 32 | 33))
                    && Instant::now() < deadline =>
            {
                // Windows may briefly reject replacement while another reader owns
                // the old file. Retain the same complete temporary file for retry.
                temporary = error.file;
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("atomic fixture replacement failed: {}", error.error),
        }
    }
}
#[allow(dead_code)]
pub fn read(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
/// Exclusive cross-process guard for one snapshot's read-modify-write. It locks
/// a stable sidecar file because every write replaces the snapshot itself.
/// Holders reread the snapshot after acquiring it; process exit releases it.
#[allow(dead_code)]
pub struct Lock(std::fs::File);
#[allow(dead_code)]
impl Lock {
    pub fn acquire(path: impl AsRef<Path>) -> Self {
        let mut sidecar = path.as_ref().as_os_str().to_owned();
        sidecar.push(".lock");
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(sidecar)
            .unwrap();
        file.lock().unwrap();
        Self(file)
    }
    /// Runs a wait without the lock. Callers persist before and reread after it.
    pub fn released<T>(&self, wait: impl FnOnce() -> T) -> T {
        self.0.unlock().unwrap();
        let value = wait();
        self.0.lock().unwrap();
        value
    }
}
