//! Bounded JSON with duplicate-key rejection; unknown keys survive in Value.
use crate::diagnostic::{Code, Diagnostic};
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;
struct Unique(Value);
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Unique;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON without duplicate keys")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Unique, E> {
                Ok(Unique(Value::Bool(v)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Unique, E> {
                Ok(Unique(Value::Number(v.into())))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Unique, E> {
                Ok(Unique(Value::Number(v.into())))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Unique, E> {
                Number::from_f64(v)
                    .map(|n| Unique(Value::Number(n)))
                    .ok_or_else(|| E::custom("non-finite number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Unique, E> {
                Ok(Unique(Value::String(v.into())))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Unique, E> {
                Ok(Unique(Value::String(v)))
            }
            fn visit_none<E: de::Error>(self) -> Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Unique, A::Error> {
                let mut a = vec![];
                while let Some(Unique(v)) = seq.next_element()? {
                    a.push(v);
                }
                Ok(Unique(Value::Array(a)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Unique, A::Error> {
                let mut a = Map::new();
                while let Some(k) = map.next_key::<String>()? {
                    if a.contains_key(&k) {
                        return Err(de::Error::custom("duplicate JSON key"));
                    }
                    let Unique(v) = map.next_value()?;
                    a.insert(k, v);
                }
                Ok(Unique(Value::Object(a)))
            }
        }
        deserializer.deserialize_any(V)
    }
}
pub fn json(bytes: &[u8], limit: usize, depth: usize) -> Result<Value, Diagnostic> {
    if bytes.len() > limit {
        return Err(Diagnostic::new(
            Code::InputLimit,
            "json",
            "JSON exceeds its size allowance.",
            "Supply bounded input.",
        ));
    }
    let value: Unique = serde_json::from_slice(bytes)
        .map_err(|_| Diagnostic::input("Malformed JSON or duplicate keys."))?;
    fn bounded(v: &Value, n: usize) -> bool {
        if n == 0 {
            return false;
        }
        match v {
            Value::Array(a) => a.iter().all(|v| bounded(v, n - 1)),
            Value::Object(a) => a.values().all(|v| bounded(v, n - 1)),
            _ => true,
        }
    }
    if !bounded(&value.0, depth) {
        return Err(Diagnostic::input("JSON exceeds its nesting allowance."));
    }
    Ok(value.0)
}
