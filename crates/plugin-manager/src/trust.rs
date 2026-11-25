//! Plugin trust: a local JSON file, beside the profile folders, that limits which publisher
//! keys may run external plugins. Without the file, any valid signature is accepted. With
//! it, only listed publishers run, plus the saved Buzz human identity when self-developed
//! plugins are allowed. An unusable file blocks every external plugin rather than
//! silently dropping the restriction.
use crate::{atomic_write, managed::read_file, Result};
use nostr::key::PublicKey;
use serde_json::{json, Map, Value};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
};

pub const FILE_NAME: &str = "plugin-trust.json";
pub const PATH_ENV: &str = "BUZZ_PLUGIN_TRUST";
const MAX_BYTES: u64 = 64 * 1024;
const MAX_PUBLISHERS: usize = 64;
const MAX_NAME_CHARS: usize = 80;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Publisher {
    /// Lowercase hex public key.
    pub publisher: String,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Policy {
    pub publishers: Vec<Publisher>,
    pub allow_self_developed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    /// No file: any valid signature is accepted.
    Absent,
    /// The file cannot be used; no external plugin may run until it is fixed or removed.
    Invalid {
        reason: String,
    },
    /// `BUZZ_PLUGIN_TRUST` names a file that does not exist. Like `Invalid`, no external
    /// plugin may run, so a mistyped or undeployed policy never lifts the restriction;
    /// unlike it, `update` may create the file.
    Missing,
    Ready(Policy),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Trust {
    pub path: Option<PathBuf>,
    pub status: Status,
}

/// `BUZZ_PLUGIN_TRUST` when set, otherwise the file beside the profile folders.
pub fn load(root: &Path, env: Option<OsString>) -> Trust {
    let explicit = env.as_ref().is_some_and(|value| !value.is_empty());
    let path = match env.filter(|value| !value.is_empty()) {
        Some(value) if Path::new(&value).is_absolute() => PathBuf::from(value),
        Some(_) => {
            return Trust {
                path: None,
                status: Status::Invalid {
                    reason: format!("{PATH_ENV} must be an absolute path"),
                },
            }
        }
        None => root.join(FILE_NAME),
    };
    let status = match read_file(&path, "Plugin trust file", MAX_BYTES) {
        // A link whose target is gone is a broken deployment, not an absent policy.
        Ok(None) if std::fs::symlink_metadata(&path).is_ok() => Status::Invalid {
            reason: "Plugin trust file is a symbolic link to a missing file".into(),
        },
        Ok(None) if explicit => Status::Missing,
        Ok(None) => Status::Absent,
        Ok(Some(text)) => match parse(&text) {
            Ok(policy) => Status::Ready(policy),
            Err(reason) => Status::Invalid { reason },
        },
        Err(reason) => Status::Invalid { reason },
    };
    Trust {
        path: Some(path),
        status,
    }
}

/// Accepts a 64-digit hex key or an `npub`; returns lowercase hex.
pub fn parse_publisher(text: &str) -> Result<String> {
    PublicKey::parse(text.trim())
        .map(|key| key.to_hex())
        .map_err(|_| "publisher must be an npub or a 64-digit hex public key".into())
}

pub fn parse(text: &str) -> Result<Policy> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("Invalid JSON: {e}"))?;
    let Value::Object(mut root) = value else {
        return Err("Expected a JSON object".into());
    };
    match root.remove("version") {
        Some(Value::Number(version)) if version.as_u64() == Some(1) => {}
        Some(_) => return Err("Unsupported version; this Buzz reads version 1".into()),
        None => return Err("Missing version".into()),
    }
    let entries = match root.remove("trustedPublishers") {
        None => vec![],
        Some(Value::Array(entries)) => entries,
        Some(_) => return Err("trustedPublishers must be an array".into()),
    };
    let allow_self_developed = match root.remove("allowSelfDeveloped") {
        None => false,
        Some(Value::Bool(value)) => value,
        Some(_) => return Err("allowSelfDeveloped must be true or false".into()),
    };
    // Unknown fields fail rather than being ignored, so a misspelling cannot loosen policy.
    if let Some(unknown) = root.keys().next() {
        return Err(format!("Unknown field {unknown:?}"));
    }
    if entries.len() > MAX_PUBLISHERS {
        return Err(format!("At most {MAX_PUBLISHERS} trusted publishers"));
    }
    let mut publishers: Vec<Publisher> = vec![];
    for (index, entry) in entries.into_iter().enumerate() {
        let publisher = entry_publisher(entry)
            .map_err(|reason| format!("Trusted publisher {}: {reason}", index + 1))?;
        if publishers
            .iter()
            .any(|p| p.publisher == publisher.publisher)
        {
            return Err(format!(
                "Trusted publisher {}: listed more than once",
                index + 1
            ));
        }
        publishers.push(publisher);
    }
    Ok(Policy {
        publishers,
        allow_self_developed,
    })
}

fn entry_publisher(entry: Value) -> Result<Publisher> {
    let Value::Object(mut entry) = entry else {
        return Err("expected an object".into());
    };
    let publisher = match entry.remove("publisher") {
        Some(Value::String(text)) => parse_publisher(&text)?,
        _ => return Err("publisher must be an npub or a 64-digit hex public key".into()),
    };
    let name = match entry.remove("name") {
        None => None,
        Some(Value::String(name)) => Some(valid_name(&name)?),
        Some(_) => return Err("name must be text".into()),
    };
    if let Some(unknown) = entry.keys().next() {
        return Err(format!("unknown field {unknown:?}"));
    }
    Ok(Publisher { publisher, name })
}

pub fn valid_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_NAME_CHARS
        || name
            .chars()
            .any(|c| c.is_control() || (c.is_whitespace() && c != ' '))
    {
        return Err(format!(
            "name must be 1 to {MAX_NAME_CHARS} characters without control characters"
        ));
    }
    Ok(name.into())
}

impl Trust {
    /// Whether this policy may run a plugin from `publisher` (`None` for unsigned).
    /// `own_publisher` is consulted only when self-developed plugins are allowed and
    /// the publisher is not listed.
    pub fn check(
        &self,
        publisher: Option<&str>,
        own_publisher: impl FnOnce() -> Result<String>,
    ) -> Result<()> {
        let policy = match &self.status {
            Status::Absent => return Ok(()),
            Status::Invalid { reason } => {
                return Err(format!(
                    "Plugin trust file is unusable ({reason}); fix or remove it to run external plugins"
                ))
            }
            Status::Missing => {
                return Err(format!(
                    "{PATH_ENV} names a plugin trust file that does not exist; create it or unset {PATH_ENV} to run external plugins"
                ))
            }
            Status::Ready(policy) => policy,
        };
        let Some(publisher) = publisher else {
            return Err(
                "Plugin trust policy requires a release signed by a trusted publisher".into(),
            );
        };
        if policy.publishers.iter().any(|p| p.publisher == publisher) {
            return Ok(());
        }
        if policy.allow_self_developed {
            match own_publisher() {
                Ok(own) if own == publisher => return Ok(()),
                Ok(_) => {}
                Err(reason) => {
                    return Err(format!(
                        "Publisher {publisher} is not trusted, and your Buzz identity could not be read to check for a self-developed plugin: {reason}"
                    ))
                }
            }
        }
        Err(format!(
            "Publisher {publisher} is not trusted; add it with buzzodz plugin trust add"
        ))
    }

    /// Whether a policy restricts publishers, which also forbids unsigned plugins.
    pub fn is_restricted(&self) -> bool {
        !matches!(self.status, Status::Absent)
    }

    /// Apply `edit` to the policy and save it, creating the file when absent.
    pub fn update(&self, edit: impl FnOnce(&mut Policy) -> Result<()>) -> Result<Policy> {
        let path = self.path.as_ref().ok_or(match &self.status {
            Status::Invalid { reason } => reason.clone(),
            _ => "Plugin trust file location is unknown".into(),
        })?;
        let mut policy = match &self.status {
            Status::Absent | Status::Missing => Policy::default(),
            Status::Ready(policy) => policy.clone(),
            Status::Invalid { reason } => {
                return Err(format!(
                    "{} is unusable ({reason}); fix or remove it first",
                    path.display()
                ))
            }
        };
        edit(&mut policy)?;
        if policy.publishers.len() > MAX_PUBLISHERS {
            return Err(format!("At most {MAX_PUBLISHERS} trusted publishers"));
        }
        let publishers: Vec<Value> = policy
            .publishers
            .iter()
            .map(|p| {
                let mut entry = Map::new();
                entry.insert("publisher".into(), p.publisher.clone().into());
                if let Some(name) = &p.name {
                    entry.insert("name".into(), name.clone().into());
                }
                Value::Object(entry)
            })
            .collect();
        let text = serde_json::to_vec_pretty(&json!({
            "version": 1,
            "trustedPublishers": publishers,
            "allowSelfDeveloped": policy.allow_self_developed,
        }))
        .map_err(crate::err)?;
        atomic_write(path, &text)?;
        Ok(policy)
    }
}

/// The saved Buzz human identity's public key, read from secure storage at most once per
/// process so catalog polling never repeats a read or a prompt. A missing identity or
/// busy storage is retried; any other failure is kept until restart.
pub fn own_publisher() -> Result<String> {
    static OWN: Mutex<Option<Result<String>>> = Mutex::new(None);
    let mut own = OWN.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(result) = own.as_ref() {
        return result.clone();
    }
    let (result, lasting) = crate::saved_human_publisher();
    if lasting {
        *own = Some(result.clone());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::nips::nip19::ToBech32;

    const KEY: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const OTHER: &str = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

    fn ready(publishers: &[&str], allow_self_developed: bool) -> Trust {
        Trust {
            path: None,
            status: Status::Ready(Policy {
                publishers: publishers
                    .iter()
                    .map(|p| Publisher {
                        publisher: (*p).into(),
                        name: None,
                    })
                    .collect(),
                allow_self_developed,
            }),
        }
    }
    fn unreachable_own() -> Result<String> {
        panic!("own identity must not be read")
    }

    #[test]
    fn absent_policy_accepts_any_publisher_and_unsigned() {
        let trust = Trust {
            path: None,
            status: Status::Absent,
        };
        assert!(!trust.is_restricted());
        trust.check(Some(KEY), unreachable_own).unwrap();
        trust.check(None, unreachable_own).unwrap();
    }

    #[test]
    fn ready_policy_accepts_only_listed_publishers() {
        let trust = ready(&[KEY], false);
        assert!(trust.is_restricted());
        trust.check(Some(KEY), unreachable_own).unwrap();
        assert!(trust
            .check(Some(OTHER), unreachable_own)
            .unwrap_err()
            .contains("is not trusted"));
        assert!(trust
            .check(None, unreachable_own)
            .unwrap_err()
            .contains("signed by a trusted publisher"));
    }

    #[test]
    fn self_developed_accepts_only_the_saved_identity() {
        let trust = ready(&[], true);
        trust.check(Some(KEY), || Ok(KEY.into())).unwrap();
        assert!(trust.check(Some(OTHER), || Ok(KEY.into())).is_err());
        assert!(trust
            .check(Some(KEY), || Err("Denied".into()))
            .unwrap_err()
            .contains("could not be read"));
        assert!(trust.check(None, unreachable_own).is_err());
        // Listed publishers never need the identity read.
        ready(&[OTHER], true)
            .check(Some(OTHER), unreachable_own)
            .unwrap();
        // Disabled self-developed never matches the saved identity.
        assert!(ready(&[], false).check(Some(KEY), unreachable_own).is_err());
    }

    #[test]
    fn invalid_policy_blocks_everything() {
        let trust = Trust {
            path: None,
            status: Status::Invalid {
                reason: "Invalid JSON".into(),
            },
        };
        assert!(trust.is_restricted());
        assert!(trust
            .check(Some(KEY), unreachable_own)
            .unwrap_err()
            .contains("unusable"));
    }

    #[test]
    fn parse_accepts_hex_and_npub_and_rejects_loosening_mistakes() {
        let npub = PublicKey::parse(OTHER).unwrap().to_bech32().unwrap();
        let policy = parse(&format!(
            r#"{{"version":1,"trustedPublishers":[{{"publisher":"{}","name":" Block "}},{{"publisher":"{npub}"}}],"allowSelfDeveloped":true}}"#,
            KEY.to_uppercase()
        ))
        .unwrap();
        assert_eq!(
            policy,
            Policy {
                publishers: vec![
                    Publisher {
                        publisher: KEY.into(),
                        name: Some("Block".into())
                    },
                    Publisher {
                        publisher: OTHER.into(),
                        name: None
                    },
                ],
                allow_self_developed: true,
            }
        );
        assert_eq!(parse(r#"{"version":1}"#).unwrap(), Policy::default());
        for (text, reason) in [
            ("[]", "JSON object"),
            (r#"{"version":2}"#, "Unsupported version"),
            (r#"{"trustedPublishers":[]}"#, "Missing version"),
            (
                r#"{"version":1,"allowSelfDevelopment":true}"#,
                "Unknown field",
            ),
            (
                r#"{"version":1,"allowSelfDeveloped":"yes"}"#,
                "true or false",
            ),
            (
                r#"{"version":1,"trustedPublishers":{}}"#,
                "must be an array",
            ),
            (
                r#"{"version":1,"trustedPublishers":[{"publisher":"abc"}]}"#,
                "npub",
            ),
            (
                &format!(
                    r#"{{"version":1,"trustedPublishers":[{{"publisher":"{KEY}","pubkey":"x"}}]}}"#
                ),
                "unknown field",
            ),
            (
                &format!(
                    r#"{{"version":1,"trustedPublishers":[{{"publisher":"{KEY}"}},{{"publisher":"{KEY}"}}]}}"#
                ),
                "more than once",
            ),
        ] {
            assert!(parse(text).unwrap_err().contains(reason), "{text}");
        }
    }

    #[test]
    fn load_and_update_round_trip_and_fail_closed() {
        let home = tempfile::tempdir().unwrap();
        let trust = load(home.path(), None);
        assert_eq!(trust.status, Status::Absent);
        assert_eq!(trust.path, Some(home.path().join(FILE_NAME)));
        trust
            .update(|policy| {
                policy.publishers.push(Publisher {
                    publisher: KEY.into(),
                    name: Some("Block".into()),
                });
                policy.allow_self_developed = true;
                Ok(())
            })
            .unwrap();
        let reloaded = load(home.path(), None);
        assert_eq!(
            reloaded.status,
            Status::Ready(
                parse(&std::fs::read_to_string(home.path().join(FILE_NAME)).unwrap()).unwrap()
            )
        );
        let Status::Ready(policy) = &reloaded.status else {
            panic!("expected a ready policy");
        };
        assert_eq!(policy.publishers[0].publisher, KEY);
        assert!(policy.allow_self_developed);

        std::fs::write(home.path().join(FILE_NAME), "{").unwrap();
        let broken = load(home.path(), None);
        assert!(matches!(broken.status, Status::Invalid { .. }));
        assert!(broken
            .update(|_| Ok(()))
            .unwrap_err()
            .contains("fix or remove"));

        let relative = load(home.path(), Some("plugin-trust.json".into()));
        assert!(relative.check(Some(KEY), unreachable_own).is_err());
        let elsewhere = home.path().join("elsewhere.json");
        assert_eq!(
            load(home.path(), Some(elsewhere.clone().into())).path,
            Some(elsewhere)
        );
    }

    #[test]
    fn explicit_missing_file_fails_closed_but_can_be_created() {
        let home = tempfile::tempdir().unwrap();
        let explicit = home.path().join("policy.json");
        let missing = load(home.path(), Some(explicit.clone().into()));
        assert_eq!(missing.status, Status::Missing);
        assert!(missing.is_restricted());
        assert!(missing
            .check(Some(KEY), unreachable_own)
            .unwrap_err()
            .contains("does not exist"));
        // The default location stays optional.
        assert_eq!(load(home.path(), None).status, Status::Absent);
        missing
            .update(|policy| {
                policy.allow_self_developed = true;
                Ok(())
            })
            .unwrap();
        assert!(matches!(
            load(home.path(), Some(explicit.into())).status,
            Status::Ready(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn dangling_symlink_fails_closed_at_either_location() {
        let home = tempfile::tempdir().unwrap();
        let target = home.path().join("deployed.json");
        std::os::unix::fs::symlink(&target, home.path().join(FILE_NAME)).unwrap();
        let explicit = home.path().join("explicit.json");
        std::os::unix::fs::symlink(&target, &explicit).unwrap();
        for trust in [
            load(home.path(), None),
            load(home.path(), Some(explicit.into())),
        ] {
            assert!(trust
                .check(Some(KEY), unreachable_own)
                .unwrap_err()
                .contains("symbolic link to a missing file"));
            assert!(trust.update(|_| Ok(())).is_err());
        }
    }
}
