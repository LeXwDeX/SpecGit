//! Pure forge repository identity and remote validation.
use crate::diagnostic::{Code, Diagnostic};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use url::Url;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Github,
    Gitlab,
}
impl Provider {
    pub fn executable(self) -> &'static str {
        match self {
            Self::Github => "gh",
            Self::Gitlab => "glab",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Repository {
    pub provider: Provider,
    pub host: String,
    pub path: String,
}
pub fn validate_host(host: &str) -> Result<String, Diagnostic> {
    if host.len() > 253
        || host.is_empty()
        || host.chars().any(|c| c.is_control() || c.is_whitespace())
        || host.contains(['/', '@', '?', '#', '\\'])
    {
        return Err(Diagnostic::input(
            "The API host must be a hostname with an optional port, without credentials or a URL path.",
        ));
    }
    let u = Url::parse(&format!("https://{host}"))
        .map_err(|_| Diagnostic::input("Invalid API host."))?;
    if u.host_str().is_none() || u.path() != "/" {
        return Err(Diagnostic::input("Invalid API host."));
    }
    Ok(host.to_ascii_lowercase())
}
pub fn parse_remote(
    raw: &str,
    selected: Option<Provider>,
    api_host: Option<&str>,
) -> Result<Repository, Diagnostic> {
    let invalid = || {
        Diagnostic::new(
            Code::UnsupportedProvider,
            "remote",
            "The selected remote is unsupported or ambiguous.",
            "Select an HTTPS or SSH forge remote and explicitly declare custom-host provider/API routing.",
        )
    };
    if raw.len() > 4096
        || raw.chars().any(|c| c.is_control() || c.is_whitespace())
        || raw.contains(['\\', '%'])
        || raw.split('/').any(|part| part == "." || part == "..")
    {
        return Err(invalid());
    }
    let value = if raw.contains("://") {
        raw.to_owned()
    } else {
        let (host, path) = raw.split_once(':').ok_or_else(invalid)?;
        if !host.contains('@') || path.starts_with('/') {
            return Err(invalid());
        }
        format!("ssh://{host}/{path}")
    };
    let u = Url::from_str(&value).map_err(|_| invalid())?;
    if !["https", "ssh"].contains(&u.scheme())
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || (u.scheme() == "https" && !u.username().is_empty())
    {
        return Err(invalid());
    }
    let host = u.host_str().ok_or_else(invalid)?.to_ascii_lowercase();
    let provider = selected
        .or(match host.as_str() {
            "github.com" => Some(Provider::Github),
            "gitlab.com" => Some(Provider::Gitlab),
            _ => None,
        })
        .ok_or_else(invalid)?;
    let path = u
        .path()
        .strip_prefix('/')
        .ok_or_else(invalid)?
        .trim_end_matches('/')
        .strip_suffix(".git")
        .unwrap_or_else(|| u.path().trim_matches('/'))
        .to_owned();
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() < 2
        || (provider == Provider::Github && parts.len() != 2)
        || parts.iter().any(|p| {
            p.is_empty()
                || *p == "."
                || *p == ".."
                || !p
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        })
    {
        return Err(invalid());
    }
    let host = if let Some(api_host) = api_host {
        validate_host(api_host)?
    } else if u.scheme() == "https" {
        u.port().map(|p| format!("{host}:{p}")).unwrap_or(host)
    } else {
        host
    };
    Ok(Repository {
        provider,
        host,
        path,
    })
}
pub fn valid_oid(s: &str) -> bool {
    [40, 64].contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}
