//! Portable label grammar shared by declarations and specification consumers.
/// Bounds/grammar are portable across both forge APIs, including comma-separated inputs.
pub fn label_name(s: &str) -> bool {
    let parts: Vec<_> = s.split("::").collect();
    !s.is_empty()
        && s.len() <= 64
        && parts.len() <= 2
        && parts.iter().all(|part| {
            part.split('-').all(|word| {
                !word.is_empty()
                    && word
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            })
        })
}
