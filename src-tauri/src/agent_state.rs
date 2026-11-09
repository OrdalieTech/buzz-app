//! Agent state shared by every program that runs this machine's agents: each
//! agent's settings, the owner's teams, unfinished setups, and the agent types'
//! saved sessions. It lives in `agents/state/`, next to `identities.json`, so
//! the app and the standalone `buzz-agent-host` read and write the same state.
//!
//! One file per key, each replaced whole through a rename, so a crash leaves
//! the last complete copy, and two programs that write different keys never
//! overwrite each other. The `hosts/` locks decide which program runs an agent.
//!
//! A file's name is its key, encoded. A key whose encoded name is too long for
//! the file system gets a fixed-length name instead, `~` and the SHA-256 of the
//! key, and its file holds `{"key": …, "value": …}` so `load` can recover it.
use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The largest value kept, as an upper bound on what `localStorage` held.
const VALUE_LIMIT: usize = 4 * 1024 * 1024;
/// The longest file name macOS, Linux and Windows all allow, in bytes.
const NAME_LIMIT: usize = 255;
const TEMPORARY: &str = ".tmp";
/// Starts the name of a file that holds its key. `encode` never writes `~`.
const HASHED: char = '~';

/// The contents of a file whose name is a hash of its key.
#[derive(Serialize, Deserialize)]
struct Hashed<'a> {
    key: std::borrow::Cow<'a, str>,
    value: std::borrow::Cow<'a, str>,
}

pub(crate) struct AgentState {
    dir: Result<PathBuf, String>,
}

impl AgentState {
    /// `dir` is `agents/state`.
    pub(crate) fn new(dir: Result<PathBuf, String>) -> Self {
        Self { dir }
    }

    fn dir(&self) -> Result<&Path, String> {
        self.dir.as_deref().map_err(Clone::clone)
    }

    /// The Agents root selected at startup, shared with identities and hosting.
    pub(crate) fn agents_root(&self) -> Result<&Path, String> {
        self.dir()?
            .parent()
            .ok_or_else(|| "Invalid agent storage".into())
    }

    /// Every key and its value. Unreadable or foreign files are skipped.
    pub(crate) fn load(&self) -> Result<HashMap<String, String>, String> {
        let dir = self.dir()?;
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(_) => return Err("Could not read agent state".into()),
        };
        let mut items = HashMap::new();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let key = decode(name);
            if key.is_none() && !name.starts_with(HASHED) {
                continue;
            }
            let Ok(text) = fs::read_to_string(entry.path()) else {
                continue;
            };
            match key {
                Some(key) => {
                    items.insert(key, text);
                }
                None => {
                    // Skip a file whose key does not give its name.
                    if let Ok(saved) = serde_json::from_str::<Hashed>(&text) {
                        if file_name(&saved.key) == name {
                            items.insert(saved.key.into_owned(), saved.value.into_owned());
                        }
                    }
                }
            }
        }
        Ok(items)
    }

    /// Reads one key. Only a missing file is absent; other failures stop the read.
    pub(crate) fn read(&self, key: &str) -> Result<Option<String>, String> {
        if key.is_empty() {
            return Err("Invalid agent state key".into());
        }
        let name = file_name(key);
        let text = match fs::read_to_string(self.dir()?.join(&name)) {
            Ok(text) => text,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Could not read agent state".into()),
        };
        if !name.starts_with(HASHED) {
            return Ok(Some(text));
        }
        let saved =
            serde_json::from_str::<Hashed>(&text).map_err(|_| "Could not read agent state")?;
        if saved.key != key {
            return Err("Invalid agent state key".into());
        }
        Ok(Some(saved.value.into_owned()))
    }

    /// Saves `value` under `key`, or removes the key when `value` is `None`.
    pub(crate) fn set(&self, key: &str, value: Option<&str>) -> Result<(), String> {
        self.write(key, value, false).map(|_| ())
    }

    /// Saves `value` under `key` only if no file holds the key, in one step, so
    /// two programs that add the same key at once never replace each other's.
    /// Returns what the file already held when it was there.
    pub(crate) fn add(&self, key: &str, value: &str) -> Result<Option<String>, String> {
        self.write(key, Some(value), true)
    }

    fn write(
        &self,
        key: &str,
        value: Option<&str>,
        absent: bool,
    ) -> Result<Option<String>, String> {
        if key.is_empty() {
            return Err("Invalid agent state key".into());
        }
        let dir = self.dir()?;
        let name = file_name(key);
        let path = dir.join(&name);
        let Some(value) = value else {
            return match fs::remove_file(&path) {
                Err(error) if error.kind() != ErrorKind::NotFound => {
                    Err("Could not save agent state".into())
                }
                _ => Ok(None),
            };
        };
        if value.len() > VALUE_LIMIT {
            return Err("Agent state is too large".into());
        }
        let hashed;
        let contents = if name.starts_with(HASHED) {
            hashed = serde_json::to_string(&Hashed {
                key: key.into(),
                value: value.into(),
            })
            .map_err(|_| "Could not save agent state")?;
            hashed.as_str()
        } else {
            value
        };
        let saved = (|| {
            fs::create_dir_all(dir)?;
            let mut file = tempfile::Builder::new()
                .suffix(TEMPORARY)
                .tempfile_in(dir)?;
            std::io::Write::write_all(&mut file, contents.as_bytes())?;
            file.as_file().sync_all()?;
            if !absent {
                file.persist(&path).map_err(|error| error.error)?;
                return Ok(None);
            }
            match file.persist_noclobber(&path) {
                Ok(_) => Ok(None),
                Err(error) if error.error.kind() == ErrorKind::AlreadyExists => {
                    let text = fs::read_to_string(&path)?;
                    if !name.starts_with(HASHED) {
                        return Ok(Some(text));
                    }
                    let saved = serde_json::from_str::<Hashed>(&text)
                        .map_err(|error| std::io::Error::new(ErrorKind::InvalidData, error))?;
                    Ok(Some(saved.value.into_owned()))
                }
                Err(error) => Err(error.error),
            }
        })();
        saved.map_err(|_| "Could not save agent state".into())
    }
}

/// The file `key` is saved in: its encoded name, or `~` and the key's SHA-256
/// when that name is too long.
pub(crate) fn file_name(key: &str) -> String {
    let name = encode(key);
    if name.len() <= NAME_LIMIT {
        return name;
    }
    format!("{HASHED}{:x}", Sha256::digest(key.as_bytes()))
}

/// A file name for `key`: bytes other than `A-Z a-z 0-9 . _ -` become `%XX`.
pub(crate) fn encode(key: &str) -> String {
    let mut name = String::with_capacity(key.len());
    for byte in key.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-') {
            name.push(byte as char);
        } else {
            name.push_str(&format!("%{byte:02X}"));
        }
    }
    name
}

/// The key a file name holds, or `None` for a file that is not one, such as a
/// write in progress.
pub(crate) fn decode(name: &str) -> Option<String> {
    if name.is_empty() || name.ends_with(TEMPORARY) || name.starts_with('.') {
        return None;
    }
    let bytes = name.as_bytes();
    let mut key = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                let hex = name.get(index + 1..index + 3)?;
                key.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            }
            byte if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-') => {
                key.push(byte);
                index += 1;
            }
            _ => return None,
        }
    }
    String::from_utf8(key).ok()
}

#[tauri::command]
pub(crate) async fn app_agent_state_load(
    state: tauri::State<'_, AgentState>,
    key: Option<String>,
) -> Result<HashMap<String, String>, String> {
    match key {
        Some(key) => Ok(state
            .read(&key)?
            .map(|value| (key, value))
            .into_iter()
            .collect()),
        None => state.load(),
    }
}

/// Saves or removes `value` under `key`. With `absent`, it saves only if no
/// file holds the key, and returns what the file held when one did.
#[tauri::command]
pub(crate) async fn app_agent_state_set(
    state: tauri::State<'_, AgentState>,
    key: String,
    value: Option<String>,
    absent: Option<bool>,
) -> Result<Option<String>, String> {
    match (value, absent.unwrap_or(false)) {
        (Some(value), true) => state.add(&key, &value),
        (value, _) => state.set(&key, value.as_deref()).map(|_| None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agents_root_preserves_startup_storage_errors() {
        let state = AgentState::new(Err("Local agent storage is unavailable".into()));
        assert_eq!(
            state.agents_root().unwrap_err(),
            "Local agent storage is unavailable"
        );
    }

    #[test]
    fn names_round_trip() {
        for key in [
            "buzz.agents.v1",
            "buzz.codex.sessions.v4:wss://relay.example/a:ab",
            "a/b c%d",
        ] {
            let name = encode(key);
            assert!(!name.contains('/') && !name.contains(':'), "{name}");
            assert_eq!(decode(&name).as_deref(), Some(key));
        }
        assert_eq!(decode("x.tmp"), None);
        assert_eq!(decode(".hidden"), None);
        assert_eq!(decode("bad%Z"), None);
        assert_eq!(decode("has space"), None);
    }

    #[test]
    fn saves_loads_and_removes() {
        let root = tempfile::tempdir().unwrap();
        let state = AgentState::new(Ok(root.path().join("state")));
        assert!(state.load().unwrap().is_empty());
        state.set("one:a", Some("1")).unwrap();
        state.set("two", Some("2")).unwrap();
        state.set("two", Some("22")).unwrap();
        fs::write(root.path().join("state").join("partial.tmp"), "x").unwrap();
        let items = state.load().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items["one:a"], "1");
        assert_eq!(items["two"], "22");
        state.set("one:a", None).unwrap();
        state.set("missing", None).unwrap();
        assert_eq!(state.load().unwrap().keys().collect::<Vec<_>>(), ["two"]);
        assert!(state.set("", Some("x")).is_err());
        state.set(&"k".repeat(NAME_LIMIT), Some("x")).unwrap();
        assert!(root
            .path()
            .join("state")
            .join("k".repeat(NAME_LIMIT))
            .exists());
    }

    #[test]
    fn adds_a_key_only_where_none_is_saved() {
        let root = tempfile::tempdir().unwrap();
        let state = AgentState::new(Ok(root.path().join("state")));
        assert_eq!(state.add("one", "first").unwrap(), None);
        // Another program saved it first: it keeps that value, and gets it back.
        assert_eq!(state.add("one", "stale").unwrap().as_deref(), Some("first"));
        assert_eq!(state.load().unwrap()["one"], "first");
        let long = "k".repeat(NAME_LIMIT + 1);
        assert_eq!(state.add(&long, "first").unwrap(), None);
        assert_eq!(state.add(&long, "stale").unwrap().as_deref(), Some("first"));
        assert_eq!(state.load().unwrap()[&long], "first");
        // No write in progress is left behind.
        assert_eq!(fs::read_dir(root.path().join("state")).unwrap().count(), 2);
    }

    #[test]
    fn reads_one_key_without_writing_and_rejects_unreadable_state() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("state");
        let state = AgentState::new(Ok(dir.clone()));
        assert_eq!(state.read("missing").unwrap(), None);
        assert!(!dir.exists());
        for key in ["short".to_owned(), "k".repeat(NAME_LIMIT + 1)] {
            state.set(&key, Some("first")).unwrap();
            assert_eq!(state.read(&key).unwrap().as_deref(), Some("first"));
            state.set(&key, Some("second")).unwrap();
            assert_eq!(state.read(&key).unwrap().as_deref(), Some("second"));
            let path = dir.join(file_name(&key));
            fs::remove_file(&path).unwrap();
            fs::create_dir(&path).unwrap();
            assert!(state.read(&key).is_err());
            fs::remove_dir(&path).unwrap();
        }
        let key = "k".repeat(NAME_LIMIT + 1);
        let path = dir.join(file_name(&key));
        for text in ["not json", r#"{"key":"other","value":"x"}"#] {
            fs::write(&path, text).unwrap();
            assert!(state.read(&key).is_err());
        }
    }

    #[test]
    fn saves_keys_whose_names_are_too_long_under_a_hash() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("state");
        let state = AgentState::new(Ok(dir.clone()));
        // 251 bytes, as Codex names it for a community on a 95-character host;
        // `encode` makes it 263.
        let key = format!(
            "buzz.codex.sessions.v4:https://agents.production.us-west-2.buzz-workspace.platform.engineering.internal.tools.example.com:{}:{}",
            "a".repeat(64),
            "b".repeat(64),
        );
        assert_eq!(key.len(), 251);
        assert!(encode(&key).len() > NAME_LIMIT);
        for key in [key.as_str(), &":".repeat(86), &"k".repeat(NAME_LIMIT + 1)] {
            state.set(key, Some("{\"a\":1}")).unwrap();
            let name = file_name(key);
            assert!(name.starts_with(HASHED) && name.len() == 65, "{name}");
            assert!(dir.join(&name).exists());
            assert_eq!(state.load().unwrap()[key], "{\"a\":1}");
            state.set(key, Some("2")).unwrap();
            assert_eq!(state.load().unwrap()[key], "2");
            state.set(key, None).unwrap();
            assert!(!state.load().unwrap().contains_key(key));
        }
        // A hashed file whose key does not give its name is not loaded.
        fs::write(
            dir.join(format!("{HASHED}{}", "0".repeat(64))),
            r#"{"key":"other","value":"x"}"#,
        )
        .unwrap();
        fs::write(dir.join(format!("{HASHED}bad")), "not json").unwrap();
        assert!(state.load().unwrap().is_empty());
    }

    #[test]
    fn saves_codex_session_keys_of_long_community_hosts() {
        let root = tempfile::tempdir().unwrap();
        let state = AgentState::new(Ok(root.path().join("state")));
        // 202 bytes, as Codex names it for a community on a 47-character host.
        let key = format!(
            "buzz.codex.sessions.v4:https://agents.production.engineering.example.com:{}:{}",
            "a".repeat(64),
            "b".repeat(64),
        );
        assert_eq!(key.len(), 202);
        state.set(&key, Some("{}")).unwrap();
        assert_eq!(state.load().unwrap()[&key], "{}");
    }
}
