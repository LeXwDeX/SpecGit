//! Atomic synthetic API snapshots for concurrent child/parent fixture readers.
use serde_json::Value;
use std::{io::Write, path::Path};
pub fn write(path: impl AsRef<Path>, value: &Value) {
    let path = path.as_ref();
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap()).unwrap();
    serde_json::to_writer(&mut temporary, value).unwrap();
    temporary.flush().unwrap();
    temporary.persist(path).unwrap();
}
