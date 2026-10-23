//! Atomic synthetic API snapshots for concurrent child/parent fixture readers.
use serde_json::Value;
use std::{
    io::Write,
    path::Path,
    time::{Duration, Instant},
};
pub fn write(path: impl AsRef<Path>, value: &Value) {
    let path = path.as_ref();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match replace(path, value) {
            Ok(()) => return,
            // Fixture readers no longer cause this: they open with the default
            // share-delete mode, which the POSIX rename tolerates. A foreign
            // handle without it, such as a scanner, can still briefly block
            // replacement; std reports that fallback failure as error 5.
            Err(error)
                if cfg!(windows)
                    && matches!(error.raw_os_error(), Some(5 | 32 | 33))
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("atomic fixture replacement failed: {error}"),
        }
    }
}
/// One atomic replacement attempt. `NamedTempFile::persist` only calls
/// `MoveFileExW`, which denies replacement while any handle is open, so a busy
/// reader could starve the writer. On that denial `std::fs::rename` retries with
/// POSIX rename semantics, which replace the name while readers hold the old file
/// open; they keep reading the complete old file.
pub fn replace(path: &Path, value: &Value) -> std::io::Result<()> {
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    serde_json::to_writer(&mut temporary, value)?;
    temporary.flush()?;
    // Close the temporary file so only its complete contents are renamed.
    let temporary = temporary.into_temp_path().keep().map_err(|e| e.error)?;
    std::fs::rename(&temporary, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
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
