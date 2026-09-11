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
