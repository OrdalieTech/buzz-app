//! Environment variables local agents start with: one list for every agent on
//! this device, and one for each agent. Native code owns them: each list is
//! kept in the OS credential store under Buzz's own item, never synced, and no
//! command returns a value. They are added to the processes of Buzz's harnesses
//! that ask for them and run a local, unprotected agent (a bundled plugin's
//! process declared `agentEnv`, `for_spawn`): the device list, then the named
//! agent's own, so its variable wins, after the login shell's and before the
//! harness's own, so a harness's variable wins. A saved list reaches processes
//! started after the save; running ones keep the list they started with until
//! the agent restarts.
//!
//! Like the Claude key (`claude_key.rs`), a value reaches every command the
//! agent runs, and this trusts installed plugin code.
use crate::claude_key::KeyStore;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
use zeroize::Zeroizing;

/// The device list's item.
#[cfg_attr(test, allow(dead_code))]
const DEVICE_SERVICE: &str = if cfg!(debug_assertions) {
    "xyz.block.buzz.desktop.agent-env.debug"
} else {
    "xyz.block.buzz.desktop.agent-env"
};
/// The device list's key among the lists; never an agent's pubkey.
const DEVICE: &str = "default";
/// Each agent's list, under its pubkey as the account.
#[cfg_attr(test, allow(dead_code))]
const AGENT_SERVICE: &str = if cfg!(debug_assertions) {
    "xyz.block.buzz.desktop.agent-env.agent.debug"
} else {
    "xyz.block.buzz.desktop.agent-env.agent"
};
/// The Windows Credential Manager's limit on a stored password: its UTF-16
/// bytes. Applied everywhere, so a list saved on one platform fits on all.
const SIZE_LIMIT: usize = 2560;
const NAME_LIMIT: usize = 128;

/// Model, provider and endpoint choices belong to Harness defaults and each
/// agent's settings; Buzz sets `PATH` itself. Compared ignoring case.
const BLOCKED: &[&str] = &[
    "PATH",
    // Claude Code: model and provider.
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CODE_AUTO_MODE_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    // Goose: model and provider.
    "GOOSE_PROVIDER",
    "GOOSE_MODEL",
    "GOOSE_SUBAGENT_PROVIDER",
    "GOOSE_SUBAGENT_MODEL",
    "GOOSE_TOOLSHIM_MODEL",
    "GOOSE_TOOLSHIM_OLLAMA_MODEL",
    "GOOSE_PROVIDER__TYPE",
    "GOOSE_LOCAL_DRAFT_MODEL",
    // Goose reads any config key from its upper-case variable first.
    "ACTIVE_PROVIDER",
    "PROVIDERS",
    "GOOSE_TOOLSHIM_BACKEND",
    "LOCAL_LLM_MODEL",
    "AZURE_FOUNDRY_MODEL",
    "PROVIDER",
    "AZURE_OPENAI_DEPLOYMENT_NAME",
    "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
    "SAGEMAKER_ENDPOINT_NAME",
    "GOOSE_LIVE_VOICE_MODEL",
    "DATABRICKS_MODEL_FILTER",
    // Endpoints.
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_UNIX_SOCKET",
    "ANTHROPIC_AWS_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "CLAUDE_CODE_API_BASE_URL",
    "OPENAI_BASE_URL",
    "AZURE_OPENAI_BASE_URL",
    "OPENROUTER_BASE_URL",
    "CODEX_OSS_BASE_URL",
    "CODEX_OSS_PORT",
    "CODEX_APP_SERVER_CHATGPT_BASE_URL",
    "CODEX_AUTHAPI_BASE_URL",
    "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
    "CODEX_REVOKE_TOKEN_URL_OVERRIDE",
    "CODEX_EXEC_SERVER_URL",
    "CODEX_CLOUD_TASKS_BASE_URL",
    "CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL",
    "CODEX_AGENT_IDENTITY_JWKS_BASE_URL",
    "CODEX_APP_SERVER_LOGIN_ISSUER",
    "GOOSE_PROVIDER__HOST",
    "DATABRICKS_HOST",
    "LMSTUDIO_HOST",
    "HF_HOST",
    "MOONSHOT_BASE_URL",
    "ZAI_BASE_URL",
    "ZHIPU_BASE_URL",
    "ASTRON_BASE_URL",
    "PRIVATEMODE_ENDPOINT",
    "ROUTSTR_HOST",
    "LYNKR_HOST",
    "OMLX_HOST",
    "AZURE_FOUNDRY_ENDPOINT",
    "OPENAI_HOST",
    "ANTHROPIC_HOST",
    "ATOMIC_CHAT_HOST",
    "AVIAN_HOST",
    "AZURE_OPENAI_ENDPOINT",
    "GITHUB_COPILOT_HOST",
    "GITHUB_COPILOT_TOKEN_URL",
    "GONDOLA_HOST",
    "GOOGLE_HOST",
    "GOOSE_LIVE_VOICE_ENDPOINT",
    "GROQ_HOST",
    "LEMONADE_HOST",
    "LITELLM_HOST",
    "LLAMA_SWAP_HOST",
    "MUSE_CODE_AUTH_HOST",
    "MUSE_CODE_HOST",
    "NEON_AI_GATEWAY_BASE_URL",
    "OLLAMA_HOST",
    "OPENROUTER_HOST",
    "SNOWFLAKE_HOST",
    "TANZU_AI_ENDPOINT",
    "TETRATE_HOST",
    "XAI_HOST",
    "OPENAI_BASE_PATH",
    "LITELLM_BASE_PATH",
    "AZURE_OPENAI_RESOURCE_NAME",
    "KIMI_CODE_OAUTH_HOST",
    "KIMI_OAUTH_HOST",
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
    "AWS_ENDPOINT_URL_STS",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_EC2_METADATA_SERVICE_ENDPOINT",
];

/// Where a harness, or Buzz reading its conversations, finds its files: an
/// agent's own value would point it at another install, home or database.
/// Compared ignoring case.
const PATHS: &[&str] = &[
    // Every harness's install and Buzz's reads of `~/.claude` and the rest.
    "HOME",
    // Claude Code's settings and conversations, which Buzz reads.
    "CLAUDE_CONFIG_DIR",
    // Codex's home, which `codex.sh` links Buzz's shared state into.
    "CODEX_HOME",
    // Goose's config and sessions, which Buzz reads from another goose.
    "GOOSE_PATH_ROOT",
    // Goose's `config.yaml` and `secrets.yaml` on Linux and macOS, which
    // Buzz's goose setup writes.
    "XDG_CONFIG_HOME",
    // Pi's settings and keys, which Buzz's Pi settings save to `~/.pi/agent`.
    "PI_CODING_AGENT_DIR",
    // Windows's home folder, where Pi finds `~/.pi/agent`.
    "USERPROFILE",
    // Linux and Windows data roots: Claude's, Codex's and Pi's installs, and
    // Pi's conversation database.
    "XDG_DATA_HOME",
    "LOCALAPPDATA",
    // Goose's config and sessions on Windows.
    "APPDATA",
];

/// The `secrets` name an agent launch asks for the list by.
pub(crate) const SECRET: &str = "agent-env";

type List = BTreeMap<String, String>;
type Var = (OsString, OsString);

/// The lists a process starts with, kept apart: the agent's own Anthropic key
/// outranks its harness, the device list's doesn't (`host_process`).
#[derive(Default)]
pub(crate) struct Lists {
    pub(crate) device: Vec<Var>,
    pub(crate) own: Vec<Var>,
}

impl Lists {
    /// The device's variables, then the agent's, so its own win.
    pub(crate) fn vars(&self) -> impl Iterator<Item = &Var> {
        self.device.iter().chain(&self.own)
    }
    /// The Anthropic key the agent's own list sets.
    pub(crate) fn own_key(&self) -> Option<&Var> {
        anthropic_key(&self.own)
    }
    /// The Anthropic key a launch that needs one uses: the agent's own, then
    /// the device's.
    pub(crate) fn key(&self) -> Option<&Var> {
        self.own_key().or_else(|| anthropic_key(&self.device))
    }
}

fn anthropic_key(vars: &[Var]) -> Option<&Var> {
    vars.iter().find(|(name, _)| name == crate::claude_key::ENV)
}

/// A row of a save: `value` replaces the saved value, or `None` keeps it.
/// A saved name left out is deleted.
#[derive(Deserialize)]
pub(crate) struct Row {
    name: String,
    value: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct Status {
    names: Vec<String>,
    /// Saved since the main page loaded, so running agents may have the old
    /// list.
    saved: bool,
}

pub(crate) struct AgentEnv {
    store: Arc<dyn KeyStore>,
    list: Mutex<Option<List>>,
    saved: AtomicBool,
}

impl AgentEnv {
    pub(crate) fn with(store: Box<dyn KeyStore>) -> Self {
        Self {
            store: Arc::from(store),
            list: Mutex::new(None),
            saved: AtomicBool::new(false),
        }
    }
    async fn load(&self) -> Result<List, String> {
        let mut list = self.list.lock().await;
        if let Some(list) = &*list {
            return Ok(list.clone());
        }
        let store = self.store.clone();
        let text = tokio::task::spawn_blocking(move || store.read())
            .await
            .map_err(|_| "Secure storage is unavailable".to_string())??;
        let read = match text {
            Some(text) => serde_json::from_str(&text)
                .map_err(|_| "The saved environment variables are damaged".to_string())?,
            None => List::new(),
        };
        *list = Some(read.clone());
        Ok(read)
    }
    /// The variables an authorized process (`for_spawn`) starts with: none
    /// when the store can't be read, which is logged without values so the
    /// agent still starts.
    pub(crate) async fn for_process(&self) -> Vec<Var> {
        match self.load().await {
            Ok(list) => list
                .iter()
                .map(|(name, value)| (name.into(), value.into()))
                .collect(),
            Err(error) => {
                eprintln!("Agents start without their environment variables: {error}");
                Vec::new()
            }
        }
    }
    pub(crate) async fn status(&self) -> Result<Status, String> {
        Ok(Status {
            names: self.load().await?.keys().cloned().collect(),
            saved: self.saved.load(Ordering::Relaxed),
        })
    }
    /// Replaces the list with `rows`. Nothing changes when a row is invalid
    /// or the store can't be written. The saved list is read only when a row
    /// keeps its value, so a full save replaces a damaged one.
    pub(crate) async fn set(&self, rows: Vec<Row>) -> Result<(), String> {
        let current = if rows.iter().any(|row| row.value.is_none()) {
            self.load().await?
        } else {
            List::new()
        };
        let mut next = List::new();
        let mut seen = std::collections::HashSet::new();
        for row in rows {
            let name = row.name.trim().to_owned();
            check(&name, cfg!(windows))?;
            if !seen.insert(name.to_ascii_uppercase()) {
                return Err(format!("{name} is listed twice"));
            }
            let value = match row.value {
                Some(value) => value,
                None => current
                    .get(&name)
                    .cloned()
                    .ok_or_else(|| format!("Enter a value for {name}"))?,
            };
            if value.contains('\0') {
                return Err(format!(
                    "The value of {name} can't contain a null character"
                ));
            }
            next.insert(name, value);
        }
        let text = Zeroizing::new(serde_json::to_string(&next).map_err(|e| e.to_string())?);
        if text.encode_utf16().count() * 2 > SIZE_LIMIT {
            return Err("These variables are too long to save. Shorten or remove some.".into());
        }
        let mut list = self.list.lock().await;
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.replace(&text))
            .await
            .map_err(|_| "Secure storage is unavailable".to_string())??;
        *list = Some(next);
        self.saved.store(true, Ordering::Relaxed);
        Ok(())
    }
}

/// `windows`: names there ignore case, so the Anthropic key has one
/// spelling, the one Claude's sign-in check and the host override match.
fn check(name: &str, windows: bool) -> Result<(), String> {
    let mut chars = name.chars();
    let valid = name.len() <= NAME_LIMIT
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !valid {
        return Err(if name.is_empty() {
            "Enter a variable name".into()
        } else {
            format!("{name} isn't a valid variable name. Use letters, digits and underscores, not starting with a digit.")
        });
    }
    let upper = name.to_ascii_uppercase();
    if windows && upper == crate::claude_key::ENV && name != crate::claude_key::ENV {
        return Err(format!("Write {name} as {}", crate::claude_key::ENV));
    }
    if upper.starts_with("BUZZ_") || upper.starts_with("NOSTR_") {
        return Err(format!("{name} is reserved by Buzz"));
    }
    if upper == "PATH" {
        return Err("Buzz sets PATH for agents itself".into());
    }
    if PATHS.contains(&upper.as_str()) {
        return Err(format!(
            "{name} sets where a harness keeps its files, which Buzz relies on"
        ));
    }
    if BLOCKED.contains(&upper.as_str()) {
        return Err(format!(
            "{name} chooses a model, provider or endpoint. Set that in Harness defaults or the agent's settings."
        ));
    }
    Ok(())
}

/// The OS credential store, as for the Claude key: one item.
#[cfg_attr(test, allow(dead_code))]
struct OsStore {
    service: &'static str,
    account: String,
}

#[cfg(all(
    any(target_os = "macos", target_os = "windows", target_os = "linux"),
    not(test)
))]
impl KeyStore for OsStore {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
        match buzz_credential_store::read(self.service, &self.account) {
            Ok(bytes) => String::from_utf8(bytes.to_vec())
                .map(|text| Some(Zeroizing::new(text)))
                .map_err(|_| "The saved environment variables are damaged".into()),
            Err(buzz_credential_store::Error::Absent) => Ok(None),
            Err(error) => Err(crate::claude_key::stored(error)),
        }
    }
    fn replace(&self, text: &str) -> Result<(), String> {
        buzz_credential_store::replace(self.service, &self.account, text.as_bytes())
            .map_err(crate::claude_key::stored)
    }
    /// Gone already is gone.
    fn delete(&self) -> Result<(), String> {
        match buzz_credential_store::delete(self.service, &self.account) {
            Ok(()) | Err(buzz_credential_store::Error::Absent) => Ok(()),
            Err(error) => Err(crate::claude_key::stored(error)),
        }
    }
}

#[cfg(any(
    not(any(target_os = "macos", target_os = "windows", target_os = "linux")),
    test
))]
impl KeyStore for OsStore {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
        Err("Secure storage is not available here".into())
    }
    fn replace(&self, _text: &str) -> Result<(), String> {
        Err("Secure storage is not available here".into())
    }
    fn delete(&self) -> Result<(), String> {
        Err("Secure storage is not available here".into())
    }
}

/// An agent's own list: a lowercase hex pubkey, so it names one store item.
fn agent_key(pubkey: &str) -> Result<(), String> {
    if pubkey.len() == 64
        && pubkey
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err("Not an agent".into())
    }
}

/// Whether `pubkey` is a local, unprotected agent here that no Delete or Join
/// is under way for: the only agents with a list of their own. A started
/// Delete marks every row `deleting` before anything goes, so from then on
/// nothing saves a list it would leave behind.
pub(crate) fn eligible(agents: &[buzz_agent_controller::AppAgent], pubkey: &str) -> bool {
    agents.iter().any(|agent| {
        agent.pubkey == pubkey
            && !agent.deleted
            && !agent.joining
            && !agent.deleting
            && agent.protection.is_none()
    })
}

type Open = dyn Fn(&str) -> Box<dyn KeyStore> + Send + Sync;

/// The device list and every agent's own, each read once.
pub(crate) struct AgentEnvs {
    open: Box<Open>,
    lists: std::sync::Mutex<std::collections::HashMap<String, Arc<AgentEnv>>>,
    /// Held across a save's eligibility check and write and across a delete,
    /// so neither lands inside the other.
    turn: Mutex<()>,
}

impl AgentEnvs {
    pub(crate) fn new() -> Self {
        Self::with(Box::new(os_store))
    }
    pub(crate) fn with(open: Box<Open>) -> Self {
        Self {
            open,
            lists: Default::default(),
            turn: Mutex::new(()),
        }
    }
    /// The list under `key`: `DEVICE` or an agent's pubkey.
    fn list(&self, key: &str) -> Arc<AgentEnv> {
        let mut lists = self.lists.lock().unwrap_or_else(|e| e.into_inner());
        lists
            .entry(key.to_owned())
            .or_insert_with(|| Arc::new(AgentEnv::with((self.open)(key))))
            .clone()
    }
    /// The device's variables for a process, then `agent`'s, as
    /// `AgentEnv::for_process`.
    pub(crate) async fn for_process(&self, agent: Option<&str>) -> Lists {
        let device = self.list(DEVICE).for_process().await;
        let own = match agent.filter(|pubkey| agent_key(pubkey).is_ok()) {
            Some(pubkey) => self.list(pubkey).for_process().await,
            None => Vec::new(),
        };
        Lists { device, own }
    }
    /// `agent`'s list, or without one the device's.
    pub(crate) async fn status(&self, agent: Option<&str>) -> Result<Status, String> {
        match agent {
            Some(pubkey) => {
                agent_key(pubkey)?;
                self.list(pubkey).status().await
            }
            None => self.list(DEVICE).status().await,
        }
    }
    /// A new main page has stopped every agent's processes, so none runs a
    /// list from before its last save. The stored lists stay.
    pub(crate) fn page_load(&self) {
        for list in self
            .lists
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            list.saved.store(false, Ordering::Relaxed);
        }
    }
    /// Saves the device list.
    pub(crate) async fn set_device(&self, rows: Vec<Row>) -> Result<(), String> {
        let _turn = self.turn.lock().await;
        self.list(DEVICE).set(rows).await
    }
    /// Saves the agent's list if `eligible` still holds once it is this
    /// save's turn.
    pub(crate) async fn set(
        &self,
        pubkey: &str,
        rows: Vec<Row>,
        eligible: impl FnOnce() -> Result<bool, String>,
    ) -> Result<(), String> {
        agent_key(pubkey)?;
        let _turn = self.turn.lock().await;
        if !eligible()? {
            return Err("This agent can't have environment variables of its own".into());
        }
        self.list(pubkey).set(rows).await
    }
    /// Deletes the agent's list, which is done when there is none. Its read
    /// copy goes only once the store item has.
    pub(crate) async fn forget(&self, pubkey: &str) -> Result<(), String> {
        agent_key(pubkey)?;
        let _turn = self.turn.lock().await;
        let store = Arc::new((self.open)(pubkey));
        tokio::task::spawn_blocking(move || store.delete())
            .await
            .map_err(|_| "Secure storage is unavailable".to_string())??;
        self.lists
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(pubkey);
        Ok(())
    }
}

/// Deletes the own list of every agent the registry names, for Sign out's
/// removal of agents: run before their rows go, so a failure is retried.
pub(crate) fn forget_registry(
    agents: &buzz_agent_controller::AppAgents,
    open: &dyn Fn(&str) -> Box<dyn KeyStore>,
) -> Result<(), String> {
    for agent in agents.list().map_err(|error| error.to_string())? {
        if agent_key(&agent.pubkey).is_ok() {
            open(&agent.pubkey).delete()?;
        }
    }
    Ok(())
}

/// The OS credential store item for `key`: the device list's, or an agent's
/// under its pubkey.
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn os_store(key: &str) -> Box<dyn KeyStore> {
    Box::new(OsStore {
        service: if key == DEVICE {
            DEVICE_SERVICE
        } else {
            AGENT_SERVICE
        },
        account: key.to_owned(),
    })
}

/// Whether `pubkey` is a local agent here that may have its own list.
async fn eligible_here(
    agents: &crate::app_agents::AppAgentHost,
    pubkey: &str,
) -> Result<bool, String> {
    let agents = agents.agents()?;
    let pubkey = pubkey.to_owned();
    tokio::task::spawn_blocking(move || {
        agents
            .list()
            .map(|rows| eligible(&rows, &pubkey))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "Agents are unavailable".to_string())?
}

/// The lists a spawn gets: only a process that asks for them with `SECRET`,
/// unprotected, that a bundled plugin's validated manifest declares
/// `agentEnv` (grants at `revision` "bundled" come from Buzz's own catalog,
/// `host_grants`). Without `env_agent` it gets the device list alone; with
/// one, that agent must be able to have its own list here. Decided before
/// any list is read.
pub(crate) async fn for_spawn(
    envs: &AgentEnvs,
    agents: &crate::app_agents::AppAgentHost,
    secrets: &[String],
    env_agent: Option<&str>,
    declared: &buzzodz_plugins::HostProcess,
    revision: &str,
    protected: bool,
) -> Result<Lists, String> {
    if !secrets.iter().any(|s| s == SECRET) {
        return Ok(Lists::default());
    }
    if protected || revision != "bundled" || !declared.agent_env {
        return Err("That secret is not available to this process".into());
    }
    if let Some(agent) = env_agent {
        if !eligible_here(agents, agent).await? {
            return Err("That agent can't have environment variables of its own".into());
        }
    }
    Ok(envs.for_process(env_agent).await)
}

#[tauri::command]
pub(crate) async fn agent_env_status(
    envs: tauri::State<'_, AgentEnvs>,
    agents: tauri::State<'_, crate::app_agents::AppAgentHost>,
    agent: Option<String>,
) -> Result<Status, String> {
    if let Some(agent) = &agent {
        if !eligible_here(&agents, agent).await? {
            return Err("This agent can't have environment variables of its own".into());
        }
    }
    envs.status(agent.as_deref()).await
}

#[tauri::command]
pub(crate) async fn agent_env_set(
    envs: tauri::State<'_, AgentEnvs>,
    agents: tauri::State<'_, crate::app_agents::AppAgentHost>,
    agent: Option<String>,
    rows: Vec<Row>,
) -> Result<(), String> {
    let Some(agent) = agent else {
        return envs.set_device(rows).await;
    };
    let agents = agents.agents()?;
    let pubkey = agent.clone();
    envs.set(&agent, rows, move || {
        agents
            .list()
            .map(|rows| eligible(&rows, &pubkey))
            .map_err(|error| error.to_string())
    })
    .await
}

#[cfg(test)]
#[path = "agent_env_tests.rs"]
pub(crate) mod tests;
