//! Offline discovery and explicit JSON input, using the same clap tree as argv/help.
//! Input is `{ "command": "issue", "options": {"json": true}, "args": [] }`.
//! `command` may also be an array for nested commands. Option keys are long names
//! (without `--`); positional values belong to `args`. Business argv cannot be mixed
//! with a JSON request. `--json`, `--human`, and `--cwd` remain explicit global selectors.
use clap::{Arg, ArgAction, Command};
use serde::{
    Deserialize, Deserializer,
    de::{self, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Value, json};
use std::{
    any::TypeId,
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fmt,
    io::Read,
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

pub const MAX_INPUT_BYTES: usize = 1024 * 1024;
pub const INPUT_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputError {
    Invalid(String),
    TooLarge,
    Deadline,
    Cancelled,
    Unavailable,
}
impl fmt::Display for InputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(reason) => write!(f, "Invalid JSON input: {reason}"),
            Self::TooLarge => f.write_str("JSON input exceeds its byte limit."),
            Self::Deadline => f.write_str("JSON input deadline exceeded."),
            Self::Cancelled => f.write_str("JSON input cancelled."),
            Self::Unavailable => f.write_str("Explicit JSON input is unavailable."),
        }
    }
}
impl std::error::Error for InputError {}

/// Effects are supplied by the caller beside its dispatch. Unknown effects never
/// imply read-only operation. Hook framing must be supplied by the host adapter.
pub fn schema_with_effects(command: &mut Command, effects: impl Fn(&[String]) -> Value) -> Value {
    command.build();
    fn describe(
        command: &Command,
        path: &mut Vec<String>,
        effects: &impl Fn(&[String]) -> Value,
    ) -> Value {
        let arguments: Vec<_> = command.get_arguments().map(|arg| {
            let range = arg.get_num_args();
            json!({"id":arg.get_id().as_str(), "long":arg.get_long(), "short":arg.get_short(),
                "position":arg.get_index(), "required":arg.is_required_set(), "global":arg.is_global_set(),
                "help":arg.get_help().map(ToString::to_string), "input_type":input_type(arg),
                "action":format!("{:?}", arg.get_action()),
                "accepts_array":matches!(arg.get_action(), ArgAction::Append) || range.is_some_and(|r| r.max_values() > 1),
                "minimum_values":range.map(|r|r.min_values()), "maximum_values":range.map(|r|r.max_values()),
                "possible_values":arg.get_possible_values().iter().map(|v|v.get_name()).collect::<Vec<_>>(),
                "conflicts":command.get_arg_conflicts_with(arg).iter().map(|a|a.get_id().as_str()).collect::<Vec<_>>(),
                "defaults":arg.get_default_values().iter().map(|s|s.to_string_lossy()).collect::<Vec<_>>()})
        }).collect();
        let children: Vec<_> = command
            .get_subcommands()
            .map(|child| {
                path.push(child.get_name().to_owned());
                let result = describe(child, path, effects);
                path.pop();
                result
            })
            .collect();
        json!({"name":command.get_name(),"path":path,"about":command.get_about().map(ToString::to_string),
            "arguments":arguments,"commands":children,"effects":effects(path)})
    }
    json!({"schema_version":2,"cli_version":command.get_version(),
        "input":{"format":"json","command":"string or array of command names","options":"object keyed by long option name","args":"array of positional values","maximum_bytes":MAX_INPUT_BYTES,"deadline_ms":INPUT_DEADLINE.as_millis(),"mixed_argv":"only --json, --human, and --cwd; duplicate or conflicting selectors rejected"},
        "output":{"default_framing":"one JSON document","hook_framing":"host-specific; inspect command effects","exit":{"0":"operation or observation succeeded","1":"operation failed","2":"invalid input or configuration","3":"external result or required facts unknown","130":"cancelled"}},
        "command":describe(command,&mut Vec::new(),&effects)})
}
pub fn schema(command: &mut Command) -> Value {
    schema_with_effects(
        command,
        |_| json!({"classification":"unknown","authorization":"declaration does not grant authorization"}),
    )
}

fn input_type(arg: &Arg) -> &'static str {
    if matches!(arg.get_action(), ArgAction::SetTrue | ArgAction::SetFalse)
        || arg.get_value_parser().type_id() == TypeId::of::<bool>()
    {
        return "boolean";
    }
    let id = arg.get_value_parser().type_id();
    if matches!(arg.get_action(), ArgAction::Count)
        || [
            TypeId::of::<u8>(),
            TypeId::of::<u16>(),
            TypeId::of::<u32>(),
            TypeId::of::<u64>(),
            TypeId::of::<usize>(),
            TypeId::of::<i8>(),
            TypeId::of::<i16>(),
            TypeId::of::<i32>(),
            TypeId::of::<i64>(),
            TypeId::of::<isize>(),
        ]
        .iter()
        .any(|value| id == *value)
    {
        return "integer";
    }
    if [TypeId::of::<f32>(), TypeId::of::<f64>()]
        .iter()
        .any(|value| id == *value)
    {
        return "number";
    }
    "string"
}

// serde_json::Value accepts duplicate map keys. Reject them at every depth before
// interpretation, including duplicate transport selectors or nested option names.
struct Unique(Value);
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Unique;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("JSON without duplicate keys")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_none<E: de::Error>(self) -> Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Unique, A::Error> {
                let mut out = Vec::new();
                while let Some(Unique(v)) = a.next_element()? {
                    out.push(v);
                }
                Ok(Unique(Value::Array(out)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Unique, A::Error> {
                let mut out = serde_json::Map::new();
                while let Some((k, Unique(v))) = a.next_entry::<String, Unique>()? {
                    if out.insert(k, v).is_some() {
                        return Err(de::Error::custom("duplicate JSON key"));
                    }
                }
                Ok(Unique(Value::Object(out)))
            }
        }
        deserializer.deserialize_any(V)
    }
}
fn invalid(reason: &str) -> InputError {
    InputError::Invalid(reason.to_owned())
}
fn scalar(arg: &Arg, value: &Value) -> Result<String, InputError> {
    match (input_type(arg), value) {
        ("boolean", Value::Bool(v)) => Ok(v.to_string()),
        ("integer", Value::Number(v)) if v.is_i64() || v.is_u64() => Ok(v.to_string()),
        ("number", Value::Number(v)) => Ok(v.to_string()),
        ("string", Value::String(v)) => Ok(v.clone()),
        _ => Err(invalid(
            "option value does not match its declared input type",
        )),
    }
}

pub fn normalize_input(
    command: &mut Command,
    argv: &[OsString],
    bytes: &[u8],
) -> Result<Vec<OsString>, InputError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(InputError::TooLarge);
    }
    let Unique(value) = serde_json::from_slice::<Unique>(bytes)
        .map_err(|_| invalid("malformed JSON or duplicate key"))?;
    let object = value
        .as_object()
        .ok_or_else(|| invalid("expected an object"))?;
    if object
        .keys()
        .any(|k| !["command", "options", "args"].contains(&k.as_str()))
    {
        return Err(invalid("unknown request key"));
    }
    let path = match object.get("command") {
        Some(Value::String(s)) => vec![s.as_str()],
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| {
                v.as_str()
                    .ok_or_else(|| invalid("command path must contain strings"))
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err(invalid("command is required")),
    };
    if path.is_empty() {
        return Err(invalid("command is required"));
    }
    let mut transport = BTreeMap::<String, String>::new();
    let mut iter = argv.iter().skip(1);
    let mut input_seen = false;
    while let Some(v) = iter.next() {
        let s = v
            .to_str()
            .ok_or_else(|| invalid("non-Unicode transport option"))?;
        let (key, inline) = s.split_once('=').map_or((s, None), |(k, v)| (k, Some(v)));
        match key {
            "--input-file" => {
                if input_seen {
                    return Err(invalid("duplicate input-file selector"));
                }
                input_seen = true;
                if inline.is_none() {
                    iter.next()
                        .ok_or_else(|| invalid("input-file needs a path"))?;
                }
            }
            "--json" | "--human" if inline.is_none() => {
                let name = &key[2..];
                if transport.contains_key(if name == "json" { "human" } else { "json" }) {
                    return Err(invalid("json and human selectors are mutually exclusive"));
                }
                if transport.insert(name.into(), "true".into()).is_some() {
                    return Err(invalid("duplicate argv selector"));
                }
            }
            "--cwd" => {
                let v = inline
                    .map(str::to_owned)
                    .or_else(|| iter.next().and_then(|v| v.to_str()).map(str::to_owned))
                    .ok_or_else(|| invalid("cwd needs a path"))?;
                if transport.insert("cwd".into(), v).is_some() {
                    return Err(invalid("duplicate argv selector"));
                }
            }
            _ => return Err(invalid("JSON input cannot be mixed with command argv")),
        }
    }
    command.build();
    let mut current = &*command;
    let mut inherited = Vec::new();
    for name in &path {
        inherited.extend(current.get_arguments().filter(|a| a.is_global_set()));
        current = current
            .get_subcommands()
            .find(|c| c.get_name() == *name)
            .ok_or_else(|| invalid("unknown command"))?;
    }
    let mut out = vec![
        argv.first()
            .cloned()
            .unwrap_or_else(|| OsString::from(command.get_name())),
    ];
    out.extend(path.iter().map(OsString::from));
    if let Some(options) = object.get("options") {
        let options = options
            .as_object()
            .ok_or_else(|| invalid("options must be an object"))?;
        for (name, value) in options {
            if ["input-file", "schema", "help", "version"].contains(&name.as_str()) {
                return Err(invalid(
                    "discovery/input transport options cannot be nested in JSON",
                ));
            }
            if transport.contains_key(name)
                || (name == "human" && transport.contains_key("json"))
                || (name == "json" && transport.contains_key("human"))
            {
                return Err(invalid("JSON option conflicts with argv selector"));
            }
            let arg = current
                .get_arguments()
                .chain(inherited.iter().copied())
                .find(|a| a.get_long() == Some(name))
                .ok_or_else(|| invalid("unknown option"))?;
            match arg.get_action() {
                ArgAction::SetTrue | ArgAction::SetFalse => {
                    let b = value
                        .as_bool()
                        .ok_or_else(|| invalid("flag requires a boolean"))?;
                    if b == matches!(arg.get_action(), ArgAction::SetTrue) {
                        out.push(format!("--{name}").into());
                    } else if arg
                        .get_default_values()
                        .first()
                        .is_some_and(|default| default != if b { "true" } else { "false" })
                    {
                        return Err(invalid(
                            "flag value cannot override its configured default; use its explicit inverse option",
                        ));
                    }
                }
                ArgAction::Count => {
                    let count = value
                        .as_u64()
                        .filter(|n| *n <= 255)
                        .ok_or_else(|| invalid("count must be an integer from 0 to 255"))?;
                    if count == 0
                        && arg
                            .get_default_values()
                            .first()
                            .is_some_and(|default| default != "0")
                    {
                        return Err(invalid(
                            "zero count cannot override a nonzero configured default",
                        ));
                    }
                    for _ in 0..count {
                        out.push(format!("--{name}").into());
                    }
                }
                _ => {
                    let values = match value {
                        Value::Array(a) => a.iter().collect::<Vec<_>>(),
                        v => vec![v],
                    };
                    if values.is_empty() {
                        return Err(invalid("option arrays cannot be empty"));
                    }
                    let range = arg
                        .get_num_args()
                        .unwrap_or(clap::builder::ValueRange::SINGLE);
                    if !matches!(arg.get_action(), ArgAction::Append)
                        && values.len() > range.max_values()
                    {
                        return Err(invalid("option does not accept multiple values"));
                    }
                    if range.max_values() > 1 {
                        out.push(format!("--{name}").into());
                        for v in values {
                            let s = scalar(arg, v)?;
                            if s.starts_with('-') {
                                return Err(invalid(
                                    "multi-value input beginning with '-' is ambiguous; use argv",
                                ));
                            }
                            out.push(s.into());
                        }
                    } else {
                        for v in values {
                            out.push(format!("--{name}={}", scalar(arg, v)?).into());
                        }
                    }
                }
            }
        }
    }
    for (name, value) in transport {
        if name == "json" || name == "human" {
            out.push(format!("--{name}").into());
        } else {
            out.push(format!("--{name}={value}").into());
        }
    }
    if let Some(args) = object.get("args") {
        let args = args
            .as_array()
            .ok_or_else(|| invalid("args must be an array"))?;
        if !args.is_empty() {
            out.push("--".into());
        }
        for value in args {
            match value {
                Value::String(s) => out.push(s.into()),
                Value::Number(n) => out.push(n.to_string().into()),
                _ => return Err(invalid("positional args must be strings or numbers")),
            }
        }
    }
    command
        .clone()
        .try_get_matches_from(&out)
        .map_err(|_| invalid("required arguments, types, or option relationships are invalid"))?;
    Ok(out)
}

/// Cancels the read future; the caller owns the reader's lifecycle.
pub async fn read_bounded<R: AsyncRead + Unpin>(
    reader: &mut R,
    max_bytes: usize,
    deadline: Duration,
    cancellation: CancellationToken,
) -> Result<Vec<u8>, InputError> {
    let read = async {
        let mut bytes = Vec::new();
        reader
            .take(max_bytes.saturating_add(1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| InputError::Unavailable)?;
        if bytes.len() > max_bytes {
            Err(InputError::TooLarge)
        } else {
            Ok(bytes)
        }
    };
    tokio::select! {biased; _=cancellation.cancelled()=>Err(InputError::Cancelled), result=tokio::time::timeout(deadline,read)=>result.map_err(|_|InputError::Deadline)?}
}

/// Only call after explicit --input-file. On timeout/cancellation, the CLI must
/// exit explicitly: blocking filesystem/stdin workers cannot be interrupted by
/// dropping a future and must not hold runtime shutdown open.
pub async fn read_input(
    path: &OsStr,
    max_bytes: usize,
    deadline: Duration,
    cancellation: CancellationToken,
) -> Result<Vec<u8>, InputError> {
    if path == "-" {
        return read_bounded(&mut tokio::io::stdin(), max_bytes, deadline, cancellation).await;
    }
    if cancellation.is_cancelled() {
        return Err(InputError::Cancelled);
    }
    let path = path.to_os_string();
    let read = tokio::task::spawn_blocking(move || {
        // Reject devices/FIFOs before opening: they could otherwise block indefinitely.
        let metadata = std::fs::metadata(&path).map_err(|_| InputError::Unavailable)?;
        if !metadata.is_file() {
            return Err(InputError::Unavailable);
        }
        if metadata.len() > max_bytes as u64 {
            return Err(InputError::TooLarge);
        }
        let file = std::fs::File::open(path).map_err(|_| InputError::Unavailable)?;
        let mut bytes = Vec::new();
        file.take(max_bytes.saturating_add(1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| InputError::Unavailable)?;
        if bytes.len() > max_bytes {
            Err(InputError::TooLarge)
        } else {
            Ok(bytes)
        }
    });
    tokio::select! {biased; _=cancellation.cancelled()=>Err(InputError::Cancelled), result=tokio::time::timeout(deadline,read)=>result.map_err(|_|InputError::Deadline)?.map_err(|_|InputError::Unavailable)?}
}
