//! Agent identities an earlier agent system saved on this machine, which Agents
//! can take over: the harness controller's library and old Buzz's. The identity
//! and its public name, picture and description move, with its instructions
//! and workspace as a `Carry` for the new type to adopt. Public connection
//! selectors can seed a reviewed import; credentials and memberships stay behind. Old Buzz's teams are listed apart, each with its
//! members, for the app to rebuild. Neither store is ever written.
use crate::config::{agent_id, canonical_key, canonical_relay, MAX_AGENTS};
use crate::import::read_json;
use crate::{Credentials, LegacySource, Result, Secret};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;

mod connection;
pub use connection::SavedConnection;

const KEY_GONE: &str = "That agent's key is no longer saved";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortSource {
    /// This app's harness agents, whose keys are already in its credential store.
    Harness,
    Installed,
    Development,
}
impl PortSource {
    fn legacy(self) -> Option<LegacySource> {
        match self {
            Self::Harness => None,
            Self::Installed => Some(LegacySource::Installed),
            Self::Development => Some(LegacySource::Development),
        }
    }
}

/// One identity another store holds, as it was last saved there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Portable {
    pub source: PortSource,
    pub pubkey: String,
    pub name: String,
    /// An HTTPS URL, or an inline image (`inline_picture`) an import uploads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    /// The community it was saved for there; the new identity uses the open one.
    pub relay: String,
    /// Public saved runtime choices, not credentials or proof of readiness.
    pub connection: SavedConnection,
    /// Settings any type may adopt. Only taking the agent over reports them.
    #[serde(skip)]
    pub carry: Carry,
}

/// An old Buzz team as old Buzz last saved it, keyed by its old ID.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OldTeam {
    pub id: String,
    pub name: String,
    /// Its shared instructions, "" for none.
    pub instructions: String,
    /// Each identity on it, named and sourced as the agent list has it, whether
    /// or not it was taken over already.
    pub members: Vec<OldMember>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OldMember {
    pub pubkey: String,
    pub name: String,
    pub source: PortSource,
}

/// What an agent kept in an earlier system that a new type may give it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Carry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// Its working directory, absolute or `~/…`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct Portables {
    pub agents: Vec<Portable>,
    /// Old Buzz's teams with at least one member, built-in ones left out. The
    /// Installed and Development copies of one merge, Installed's text first.
    pub teams: Vec<OldTeam>,
    /// A store that could not be read; the others are still listed.
    pub warnings: Vec<String>,
}

/// The harness library file and the OS data directory old Buzz kept its own in.
#[derive(Clone)]
pub struct OldStores {
    pub harness: PathBuf,
    pub data_dir: PathBuf,
}
impl OldStores {
    /// Every identity on this machine, one per key. The harness copy wins, since
    /// reading its key needs no other app's keychain entry. A missing store adds
    /// nothing.
    pub fn list(&self) -> Portables {
        let mut found = Portables::default();
        let mut seen = BTreeSet::new();
        for source in [
            PortSource::Harness,
            PortSource::Installed,
            PortSource::Development,
        ] {
            match self.read(source) {
                Ok((agents, teams)) => {
                    match teams {
                        Ok(teams) => teams.into_iter().for_each(|team| found.merge(team)),
                        Err(error) => found.warnings.push(error),
                    }
                    found.agents.extend(
                        agents
                            .into_iter()
                            .map(|(agent, _)| agent)
                            .filter(|agent| seen.insert(agent.pubkey.clone())),
                    );
                }
                Err(error) => found.warnings.push(error),
            }
        }
        found.teams.retain(|team| !team.members.is_empty());
        // Named and sourced as the copy that is listed.
        for member in found.teams.iter_mut().flat_map(|team| &mut team.members) {
            if let Some(agent) = found.agents.iter().find(|a| a.pubkey == member.pubkey) {
                member.name.clone_from(&agent.name);
                member.source = agent.source;
            }
        }
        found
    }
    /// One listed identity and its key, both re-read from the store it is in, so
    /// the caller names only its choice. A harness copy whose key is gone falls
    /// back to old Buzz's copy of the same identity, which keeps its own key.
    pub fn take(
        &self,
        source: PortSource,
        pubkey: &str,
        credentials: &dyn Credentials,
    ) -> Result<(Portable, Secret)> {
        let taken = self.take_from(source, pubkey, credentials);
        if source != PortSource::Harness || !matches!(&taken, Err(e) if e == KEY_GONE) {
            return taken;
        }
        for legacy in [PortSource::Installed, PortSource::Development] {
            match self.take_from(legacy, pubkey, credentials) {
                Err(error) if error != crate::CREDENTIALS_BUSY => {}
                result => return result,
            }
        }
        taken
    }
    fn take_from(
        &self,
        source: PortSource,
        pubkey: &str,
        credentials: &dyn Credentials,
    ) -> Result<(Portable, Secret)> {
        let (agent, saved) = self
            .read(source)?
            .0
            .into_iter()
            .find(|(agent, _)| agent.pubkey == pubkey)
            .ok_or("That agent is no longer saved there")?;
        let key = match source.legacy() {
            Some(_) if !saved.is_empty() => Secret::parse(&saved, pubkey)?,
            Some(legacy) => credentials.read_legacy(legacy, pubkey)?,
            None => credentials.read(&saved, pubkey)?.ok_or(KEY_GONE)?,
        };
        Ok((agent, key))
    }
    /// Its identities, each with where its key is: the harness credential ID, or
    /// the key old Buzz kept in the record itself, if it did, and its teams with
    /// their members. Teams that cannot be read are reported apart.
    fn read(&self, source: PortSource) -> Result<Read> {
        let (path, records) = match source.legacy() {
            None => (self.harness.clone(), "agents"),
            Some(legacy) => (
                self.data_dir
                    .join(legacy.app_directory())
                    .join("agents/managed-agents.json"),
                "",
            ),
        };
        if !path.try_exists().unwrap_or(true) {
            return Ok((vec![], Ok(vec![])));
        }
        let file =
            read_json(&path, false).map_err(|_| format!("Could not read {}", path.display()))?;
        let records = if records.is_empty() {
            &file
        } else {
            &file[records]
        };
        let records = records
            .as_array()
            .filter(|records| records.len() <= MAX_AGENTS)
            .ok_or_else(|| format!("Could not read {}", path.display()))?;
        let linked = |record: &Value| {
            record["team_id"].is_string() || record["persona_team_dir"].is_string()
        };
        let mut teams = match source.legacy() {
            Some(_) if records.iter().any(linked) => old_teams(&path.with_file_name("teams.json")),
            _ => Ok(vec![]),
        };
        let mut found = vec![];
        for record in records {
            let Some((agent, key)) = portable(source, record, records) else {
                continue;
            };
            // As old Buzz links them: by team ID, or by its team folder's name.
            let id = record["team_id"].as_str();
            let folder = record["persona_team_dir"]
                .as_str()
                .and_then(|dir| std::path::Path::new(dir).file_name())
                .and_then(|name| name.to_str());
            for (_, team) in teams
                .iter_mut()
                .flatten()
                .filter(|(dir, team)| Some(&*team.id) == id || Some(&**dir) == folder)
            {
                team.members.push(OldMember {
                    pubkey: agent.pubkey.clone(),
                    name: agent.name.clone(),
                    source,
                });
            }
            found.push((agent, key));
        }
        let teams = teams.map(|teams| teams.into_iter().map(|(_, team)| team).collect());
        Ok((found, teams))
    }
}

impl Portables {
    /// Adds a store's team, or its new members to the same team from another.
    fn merge(&mut self, team: OldTeam) {
        match self.teams.iter_mut().find(|row| row.id == team.id) {
            None => self.teams.push(team),
            Some(row) => {
                for member in team.members {
                    if !row.members.iter().any(|m| m.pubkey == member.pubkey) {
                        row.members.push(member);
                    }
                }
            }
        }
    }
}

/// A store's identities, each with where its key is, and its teams if they
/// could be read.
type Read = (Vec<(Portable, String)>, Result<Vec<OldTeam>>);

/// Old Buzz's teams beside its agents, built-in ones left out, each with the
/// folder name its agents may link it by: its source folder's, else its ID. A
/// missing file has none; any invalid team makes the file unreadable.
fn old_teams(path: &std::path::Path) -> Result<Vec<(String, OldTeam)>> {
    if !path.try_exists().unwrap_or(true) {
        return Ok(vec![]);
    }
    let unreadable = || format!("Could not read {}", path.display());
    let file = read_json(path, false).map_err(|_| unreadable())?;
    let teams = file
        .as_array()
        .filter(|teams| teams.len() <= MAX_AGENTS)
        .ok_or_else(unreadable)?;
    let mut ids = BTreeSet::new();
    let mut found = vec![];
    for team in teams {
        let id = team["id"].as_str().unwrap_or("");
        let instructions = match &team["instructions"] {
            Value::Null => "",
            value => value.as_str().ok_or_else(unreadable)?,
        };
        if id.is_empty()
            || id.len() > 256
            || id.contains('\0')
            || !ids.insert(id)
            || instructions.len() > 128 * 1024
            || instructions.contains('\0')
        {
            return Err(unreadable());
        }
        if team["is_builtin"].as_bool() != Some(true) {
            let dir = team["source_dir"]
                .as_str()
                .and_then(|dir| std::path::Path::new(dir).file_name())
                .and_then(|name| name.to_str())
                .unwrap_or(id);
            found.push((
                dir.into(),
                OldTeam {
                    id: id.into(),
                    name: team_name(team["name"].as_str().unwrap_or("")),
                    instructions: instructions.trim().into(),
                    members: vec![],
                },
            ));
        }
    }
    Ok(found)
}

/// Trimmed, at most 120 UTF-16 units as the app counts them, never splitting a
/// character; a blank name gets a stand-in.
fn team_name(raw: &str) -> String {
    let name = raw.trim();
    if name.is_empty() {
        return "Team from old Buzz".into();
    }
    let mut units = 0;
    name.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 120
        })
        .collect()
}

fn portable(source: PortSource, record: &Value, records: &[Value]) -> Option<(Portable, String)> {
    let text = |key: &str| record.get(key).and_then(Value::as_str).unwrap_or("");
    let harness = source == PortSource::Harness;
    let pubkey = text("pubkey");
    let relay =
        canonical_relay(text(if harness { "relayUrl" } else { "relay_url" })).unwrap_or_default();
    let name = text("name").trim();
    if !canonical_key(pubkey) || name.is_empty() {
        return None;
    }
    let credential = if harness {
        Some(text("credentialId"))
            .filter(|id| !id.is_empty())
            .map_or_else(|| agent_id(pubkey, &relay), str::to_owned)
    } else {
        text("private_key_nsec").to_owned()
    };
    // A harness string is authoritative, including "" for explicit removal.
    // Legacy imports saved no override but retained the identity's artwork and
    // linked definition; snapshots retained their public profile's avatarUrl.
    let picture = if harness {
        record["picture"].as_str().or_else(|| {
            let imported = &record["imported"];
            let saved = &imported["record"];
            if saved["profile"].is_object() {
                saved["profile"]["avatarUrl"].as_str()
            } else {
                saved["avatar_url"]
                    .as_str()
                    .or_else(|| imported["definition"]["avatar_url"].as_str())
            }
        })
    } else {
        record["avatar_url"].as_str()
    }
    // Inline data is kept even when unusable, so the import can say it was left behind.
    .filter(|url| public_picture(url) || url.starts_with("data:"))
    .map(str::to_owned);
    Some((
        Portable {
            source,
            pubkey: pubkey.into(),
            name: name.into(),
            picture,
            about: description(source, record, records),
            relay,
            connection: connection::saved(source, record, records),
            carry: Carry {
                // Old Buzz ran an instance's own prompt, never its definition's.
                instructions: present(text(if harness {
                    "systemPrompt"
                } else {
                    "system_prompt"
                })),
                // Old Buzz saved no workspace.
                workspace: harness.then(|| present(text("workspace"))).flatten(),
            },
        },
        credential,
    ))
}

/// Old Buzz's linked definition owns the authored description, never a stale
/// instance copy. Harness imports retain either that definition or a snapshot's
/// public profile. A missing/blank source stays absent; no community lookup.
fn description(source: PortSource, record: &Value, records: &[Value]) -> Option<String> {
    let value = if source == PortSource::Harness {
        let imported = &record["imported"];
        let saved = &imported["record"];
        if saved["profile"]["about"].is_string() {
            &saved["profile"]["about"]
        } else if saved["persona_id"].is_string() {
            &imported["definition"]["description"]
        } else {
            &saved["description"]
        }
    } else if let Some(persona) = record["persona_id"].as_str() {
        &records.iter().find(|definition| {
            definition["pubkey"].as_str().unwrap_or("").is_empty()
                && definition["slug"].as_str() == Some(persona)
        })?["description"]
    } else {
        &record["description"]
    };
    present(value.as_str()?)
}

fn present(text: &str) -> Option<String> {
    Some(text.trim())
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// A profile picture is a public HTTPS URL of bounded length, never inline data.
pub(crate) fn public_picture(url: &str) -> bool {
    url.len() <= 2048
        && url::Url::parse(url).is_ok_and(|url| {
            url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
        })
}

/// An image old Buzz kept inline as a base64 `data:` URL, which an import
/// uploads to the community: its type and bytes.
pub fn inline_picture(url: &str) -> Option<(&'static str, Vec<u8>)> {
    use base64::Engine;
    const TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    let (mime, data) = url.strip_prefix("data:")?.split_once(";base64,")?;
    let mime = TYPES.into_iter().find(|known| *known == mime)?;
    if data.len() > 8 * 1024 * 1024 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()?;
    Some((mime, bytes))
}

#[cfg(test)]
mod tests;
