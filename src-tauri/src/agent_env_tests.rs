use super::*;
use std::sync::Mutex as StdMutex;

#[derive(Default)]
pub(crate) struct FakeStore {
    pub(crate) text: StdMutex<Option<String>>,
    unreadable: StdMutex<bool>,
    pub(crate) unwritable: StdMutex<bool>,
}
impl KeyStore for Arc<FakeStore> {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
        if *self.unreadable.lock().unwrap() {
            return Err("locked".into());
        }
        Ok(self.text.lock().unwrap().clone().map(Zeroizing::new))
    }
    fn replace(&self, text: &str) -> Result<(), String> {
        if *self.unwritable.lock().unwrap() {
            return Err("locked".into());
        }
        *self.text.lock().unwrap() = Some(text.into());
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        if *self.unwritable.lock().unwrap() {
            return Err("locked".into());
        }
        *self.text.lock().unwrap() = None;
        Ok(())
    }
}

pub(crate) fn set(name: &str, value: &str) -> Row {
    Row {
        name: name.into(),
        value: Some(value.into()),
    }
}
fn keep(name: &str) -> Row {
    Row {
        name: name.into(),
        value: None,
    }
}
fn env(store: &Arc<FakeStore>) -> AgentEnv {
    AgentEnv::with(Box::new(store.clone()))
}
async fn given(env: &AgentEnv) -> Vec<(String, String)> {
    env.for_process()
        .await
        .into_iter()
        .map(|(n, v)| (n.into_string().unwrap(), v.into_string().unwrap()))
        .collect()
}

#[tokio::test]
async fn an_unreadable_store_starts_agents_without_the_list() {
    let store = Arc::new(FakeStore::default());
    *store.unreadable.lock().unwrap() = true;
    assert!(given(&env(&store)).await.is_empty());
}

#[tokio::test]
async fn rows_keep_replace_or_delete_saved_values() {
    let store = Arc::new(FakeStore::default());
    env(&store)
        .set(vec![set("A", "1"), set("B", "2"), set("C", "3")])
        .await
        .unwrap();
    // As after a relaunch: values are read back from the store.
    let env = env(&store);
    assert_eq!(
        env.status().await.unwrap(),
        Status {
            names: vec!["A".into(), "B".into(), "C".into()],
            saved: false
        }
    );
    env.set(vec![keep("A"), set("B", "two"), set("D", "4")])
        .await
        .unwrap();
    assert_eq!(
        given(&env).await,
        [("A", "1"), ("B", "two"), ("D", "4")].map(|(n, v)| (n.to_string(), v.to_string()))
    );
    assert!(env.status().await.unwrap().saved);
    assert!(env.set(vec![keep("MISSING")]).await.is_err());
}

#[tokio::test]
async fn a_failed_save_changes_nothing() {
    let store = Arc::new(FakeStore::default());
    let env = env(&store);
    env.set(vec![set("A", "1")]).await.unwrap();
    let env = AgentEnv::with(Box::new(store.clone()));
    *store.unwritable.lock().unwrap() = true;
    assert!(env.set(vec![set("A", "2")]).await.is_err());
    assert!(env.set(vec![set("PATH", "/x")]).await.is_err());
    assert!(!env.status().await.unwrap().saved);
    assert_eq!(given(&env).await, vec![("A".into(), "1".into())]);
}

#[tokio::test]
async fn every_blocked_name_is_rejected_in_any_case() {
    let env = env(&Arc::new(FakeStore::default()));
    for name in BLOCKED
        .iter()
        .chain(PATHS)
        .copied()
        .chain(["BUZZ_AGENT", "NOSTR_KEY", "path"])
        // Named here too, so dropping one from `BLOCKED` fails.
        .chain([
            "OPENAI_BASE_PATH",
            "LITELLM_BASE_PATH",
            "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
            "AZURE_OPENAI_RESOURCE_NAME",
            "KIMI_CODE_OAUTH_HOST",
            "KIMI_OAUTH_HOST",
            "ANTHROPIC_FOUNDRY_RESOURCE",
            "CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL",
            "CODEX_AGENT_IDENTITY_JWKS_BASE_URL",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI",
            "AWS_EC2_METADATA_SERVICE_ENDPOINT",
            "HOME",
            "CLAUDE_CONFIG_DIR",
            "CODEX_HOME",
            "GOOSE_PATH_ROOT",
            "PI_CODING_AGENT_DIR",
            "USERPROFILE",
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "LOCALAPPDATA",
            "APPDATA",
        ])
    {
        let mixed: String = name
            .chars()
            .enumerate()
            .map(|(i, c)| {
                if i % 2 == 0 {
                    c.to_ascii_lowercase()
                } else {
                    c
                }
            })
            .collect();
        for name in [name.to_string(), name.to_ascii_lowercase(), mixed] {
            assert!(
                env.set(vec![set(&name, "x")]).await.is_err(),
                "{name} was allowed"
            );
        }
    }
    for name in [
        "ANTHROPIC_API_KEY",
        "AWS_REGION",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        "GITHUB_TOKEN",
        "DATABRICKS_TOKEN",
        "_X1",
    ] {
        env.set(vec![set(name, "x")]).await.unwrap();
    }
}

#[tokio::test]
async fn invalid_names_values_and_duplicates_are_rejected() {
    let env = env(&Arc::new(FakeStore::default()));
    for name in ["", "1A", "A-B", "A B", "A=B", "É", &"A".repeat(129)] {
        assert!(env.set(vec![set(name, "x")]).await.is_err(), "{name:?}");
    }
    assert!(env.set(vec![set("A", "x\0y")]).await.is_err());
    assert!(env
        .set(vec![set("Foo", "1"), set("FOO", "2")])
        .await
        .is_err());
}

#[tokio::test]
async fn the_list_fits_windows_utf16_limit() {
    let env = env(&Arc::new(FakeStore::default()));
    // `{"A":"…"}` is 8 characters around the value; 1280 UTF-16 units fit.
    env.set(vec![set("A", &"x".repeat(1272))]).await.unwrap();
    assert!(env.set(vec![set("A", &"x".repeat(1273))]).await.is_err());
    // A character outside the BMP is two UTF-16 units.
    env.set(vec![set("A", &"😀".repeat(636))]).await.unwrap();
    assert!(env.set(vec![set("A", &"😀".repeat(637))]).await.is_err());
}

pub(crate) const ADA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(crate) const BO: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

pub(crate) type Stores = Arc<StdMutex<std::collections::HashMap<String, Arc<FakeStore>>>>;

/// One fake item per agent, kept by the test.
pub(crate) fn envs() -> (AgentEnvs, Stores) {
    let stores: Stores = Default::default();
    let held = stores.clone();
    let envs = AgentEnvs::with(Box::new(move |pubkey: &str| -> Box<dyn KeyStore> {
        Box::new(
            held.lock()
                .unwrap()
                .entry(pubkey.to_owned())
                .or_default()
                .clone(),
        )
    }));
    (envs, stores)
}
async fn agent_given(envs: &AgentEnvs, pubkey: &str) -> Vec<(String, String)> {
    envs.for_process(Some(pubkey))
        .await
        .vars()
        .map(|(n, v)| (n.to_str().unwrap().into(), v.to_str().unwrap().into()))
        .collect()
}

#[tokio::test]
async fn each_agent_gets_only_its_own_list() {
    let (envs, _) = envs();
    envs.set(ADA, vec![set("FOO", "ada")], || Ok(true))
        .await
        .unwrap();
    assert_eq!(
        agent_given(&envs, ADA).await,
        vec![("FOO".to_string(), "ada".to_string())]
    );
    assert!(agent_given(&envs, BO).await.is_empty());
    assert_eq!(
        envs.status(Some(BO)).await.unwrap().names,
        Vec::<String>::new()
    );
}

#[tokio::test]
async fn an_agent_list_uses_the_same_rules() {
    let (envs, _) = envs();
    assert!(envs
        .set(ADA, vec![set("ANTHROPIC_MODEL", "x")], || Ok(true))
        .await
        .is_err());
    assert!(envs
        .set(ADA, vec![set("FOO", &"x".repeat(SIZE_LIMIT))], || Ok(true))
        .await
        .is_err());
    assert!(envs.set("ADA", vec![], || Ok(true)).await.is_err());
    assert!(envs.status(Some("../x")).await.is_err());
}

#[tokio::test]
async fn an_ineligible_agent_saves_nothing() {
    let (envs, stores) = envs();
    let refused = envs.set(ADA, vec![set("FOO", "bar")], || Ok(false)).await;
    assert!(refused.is_err());
    assert!(stores.lock().unwrap().get(ADA).is_none_or(|store| store
        .text
        .lock()
        .unwrap()
        .is_none()));
}

#[tokio::test]
async fn forgetting_deletes_the_item_and_its_read_copy() {
    let (envs, stores) = envs();
    // None saved is already gone.
    envs.forget(ADA).await.unwrap();
    envs.set(ADA, vec![set("FOO", "bar")], || Ok(true))
        .await
        .unwrap();
    envs.forget(ADA).await.unwrap();
    assert!(stores.lock().unwrap()[ADA].text.lock().unwrap().is_none());
    assert!(agent_given(&envs, ADA).await.is_empty());
}

#[tokio::test]
async fn a_failed_forget_is_reported_and_can_be_retried() {
    let (envs, stores) = envs();
    envs.set(ADA, vec![set("FOO", "bar")], || Ok(true))
        .await
        .unwrap();
    let store = stores.lock().unwrap()[ADA].clone();
    *store.unwritable.lock().unwrap() = true;
    assert!(envs.forget(ADA).await.is_err());
    // Still read as saved: nothing claims it is gone.
    assert_eq!(agent_given(&envs, ADA).await.len(), 1);
    *store.unwritable.lock().unwrap() = false;
    envs.forget(ADA).await.unwrap();
    assert!(agent_given(&envs, ADA).await.is_empty());
}

/// A save queued between the cleanup and the row change finds the Delete
/// started and is refused, so no list outlives the agent.
#[tokio::test]
async fn a_save_after_cleanup_is_refused() {
    let (envs, stores) = envs();
    envs.set(ADA, vec![set("FOO", "bar")], || Ok(true))
        .await
        .unwrap();
    let mut row = agent_row(ADA);
    row.deleting = true;
    let rows = vec![row];
    envs.forget(ADA).await.unwrap();
    let late = envs
        .set(ADA, vec![set("FOO", "again")], || Ok(eligible(&rows, ADA)))
        .await;
    assert!(late.is_err());
    assert!(stores.lock().unwrap()[ADA].text.lock().unwrap().is_none());
}

pub(crate) fn agent_row(pubkey: &str) -> buzz_agent_controller::AppAgent {
    serde_json::from_value(serde_json::json!({
        "pubkey": pubkey,
        "relay": "wss://relay.example",
        "owner": "c".repeat(64),
        "auth": "[]",
    }))
    .unwrap()
}

#[test]
fn only_live_unprotected_agents_are_eligible() {
    let live = agent_row(ADA);
    assert!(eligible(std::slice::from_ref(&live), ADA));
    assert!(!eligible(std::slice::from_ref(&live), BO));
    for change in [
        |a: &mut buzz_agent_controller::AppAgent| a.deleted = true,
        |a: &mut buzz_agent_controller::AppAgent| a.deleting = true,
        |a: &mut buzz_agent_controller::AppAgent| a.joining = true,
    ] {
        let mut row = live.clone();
        change(&mut row);
        assert!(!eligible(&[row], ADA));
    }
}

/// Agents here, as `rows`, for the spawn checks.
fn host_with(
    rows: &[buzz_agent_controller::AppAgent],
) -> (tempfile::TempDir, crate::app_agents::AppAgentHost) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("identities.json");
    std::fs::write(&path, serde_json::to_vec(rows).unwrap()).unwrap();
    let host = crate::app_agents::AppAgentHost::new(
        Ok(path),
        Err("unused".into()),
        true,
        crate::federated_identity::agent::AgentTokens::unconfigured(),
    );
    (dir, host)
}

#[tokio::test]
async fn a_spawn_gets_only_an_eligible_named_agents_list() {
    let (envs, _) = envs();
    envs.set(ADA, vec![set("FOO", "ada")], || Ok(true))
        .await
        .unwrap();
    let mut deleting = agent_row(BO);
    deleting.deleting = true;
    let (_dir, host) = host_with(&[agent_row(ADA), deleting]);
    let asks = vec![SECRET.to_string()];
    let goose = bundled("buzz.goose", "goose");
    let spawn =
        |agent, protected| for_spawn(&envs, &host, &asks, agent, &goose, "bundled", protected);
    assert_eq!(spawn(Some(ADA), false).await.unwrap().vars().count(), 1);
    // No agent named: the device list alone, empty here.
    assert_eq!(spawn(None, false).await.unwrap().vars().count(), 0);
    envs.set_device(vec![set("BAR", "device")]).await.unwrap();
    assert_eq!(spawn(None, false).await.unwrap().vars().count(), 1);
    assert_eq!(spawn(Some(ADA), false).await.unwrap().vars().count(), 2);
    // An agent being removed, or not here, is refused.
    assert!(spawn(Some(BO), false).await.is_err());
    let absent = "c".repeat(64);
    assert!(spawn(Some(&absent), false).await.is_err());
    // Protected launches are refused.
    assert!(spawn(Some(ADA), true).await.is_err());
    // A process that doesn't ask gets nothing.
    assert!(
        for_spawn(&envs, &host, &[], Some(ADA), &goose, "bundled", false)
            .await
            .unwrap()
            .vars()
            .next()
            .is_none()
    );
}

#[test]
fn the_anthropic_key_has_one_spelling_where_names_ignore_case() {
    // Claude's sign-in check and the host override match it exactly.
    assert!(check("anthropic_api_key", true).is_err());
    assert!(check("Anthropic_Api_Key", true).is_err());
    assert!(check("ANTHROPIC_API_KEY", true).is_ok());
    // Elsewhere it's another variable.
    assert!(check("anthropic_api_key", false).is_ok());
}

#[tokio::test]
async fn every_agent_gets_the_device_list_and_its_own_wins() {
    let (envs, stores) = envs();
    envs.set_device(vec![set("FOO", "device"), set("BAR", "device")])
        .await
        .unwrap();
    envs.set(ADA, vec![set("FOO", "ada")], || Ok(true))
        .await
        .unwrap();
    // The process takes the last of a repeated name, so Ada's comes after.
    assert_eq!(
        agent_given(&envs, ADA).await,
        vec![
            ("BAR".to_string(), "device".to_string()),
            ("FOO".to_string(), "device".to_string()),
            ("FOO".to_string(), "ada".to_string()),
        ]
    );
    // As a command gets it, Ada's value wins.
    let command = command_env(&envs.for_process(Some(ADA)).await);
    assert!(command.contains(&("FOO".to_string(), "ada".to_string())));
    assert!(!command.contains(&("FOO".to_string(), "device".to_string())));
    assert_eq!(agent_given(&envs, BO).await.len(), 2);
    assert_eq!(envs.for_process(None).await.vars().count(), 2);
    assert_eq!(
        envs.status(None).await.unwrap().names,
        vec!["BAR".to_string(), "FOO".to_string()]
    );
    // An agent's cleanup leaves the device list.
    envs.forget(ADA).await.unwrap();
    assert_eq!(agent_given(&envs, ADA).await.len(), 2);
    assert!(stores.lock().unwrap().contains_key("default"));
}

#[tokio::test]
async fn a_page_load_clears_saved_and_keeps_the_lists() {
    let (envs, stores) = envs();
    let pubkey = "a".repeat(64);
    envs.set_device(vec![set("FOO", "1")]).await.unwrap();
    envs.set(&pubkey, vec![set("BAR", "2")], || Ok(true))
        .await
        .unwrap();
    assert!(envs.status(None).await.unwrap().saved);
    assert!(envs.status(Some(&pubkey)).await.unwrap().saved);
    envs.page_load();
    let device = envs.status(None).await.unwrap();
    let own = envs.status(Some(&pubkey)).await.unwrap();
    assert!(!device.saved && !own.saved);
    assert_eq!(device.names, ["FOO"]);
    assert_eq!(own.names, ["BAR"]);
    assert_eq!(stores.lock().unwrap().len(), 2);
}

/// `process` as the bundled catalog's manifest for `plugin` declares it.
fn bundled(plugin: &str, process: &str) -> buzzodz_plugins::HostProcess {
    buzzodz_plugins::bundled_manifests()
        .into_iter()
        .find(|manifest| manifest.id == plugin)
        .and_then(|manifest| manifest.host)
        .and_then(|host| host.processes.into_iter().find(|p| p.id == process))
        .unwrap_or_else(|| panic!("{plugin} declares no {process}"))
}

/// A plugin manager over a temp home, with `test.claimant` installed and
/// enabled: a non-bundled plugin whose `goose` process declares `agentEnv`.
fn manager_with_claimant() -> (tempfile::TempDir, buzzodz_plugins::Manager, String) {
    let root = tempfile::tempdir().unwrap();
    let manager =
        buzzodz_plugins::Manager::open(Some(root.path().join("data")), "test", false).unwrap();
    let source = root.path().join("plugin");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
    std::fs::write(
        source.join("manifest.json"),
        serde_json::to_vec(&serde_json::json!({
            "id": "test.claimant", "name": "Claimant", "apiVersion": 1,
            "host": {"processes": [
                {"id": "goose", "program": "goose-acp", "agentEnv": true}
            ]}
        }))
        .unwrap(),
    )
    .unwrap();
    buzzodz_plugins::sign_release(&source, &nostr::key::SecretKey::generate().to_secret_hex())
        .unwrap();
    let revision = manager
        .install(&source)
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == "test.claimant")
        .unwrap()
        .revision;
    manager.change("enable", "test.claimant").unwrap();
    // Off by default; on, so its refusal is the capability's.
    manager.change("enable", "buzz.mesh-compute").unwrap();
    (root, manager, revision)
}

/// The variables a spawn of `plugin`'s `process` at `revision` starts with,
/// through the native spawn's own lookup and list wiring, as a command gets
/// them; `None` when the spawn is refused.
async fn launched(
    manager: &buzzodz_plugins::Manager,
    envs: &AgentEnvs,
    host: &crate::app_agents::AppAgentHost,
    plugin: &str,
    revision: &str,
    process: &str,
) -> Option<Vec<(String, String)>> {
    let declared =
        crate::host_process::declared_process(manager, plugin, revision, process).unwrap();
    let list = for_spawn(
        envs,
        host,
        &[SECRET.into()],
        Some(ADA),
        &declared,
        revision,
        false,
    )
    .await
    .ok()?;
    Some(command_env(&list))
}

/// The spawn's own environment setup, with nothing but `list` added.
fn spawn_env(command: &mut tokio::process::Command, list: &Lists) {
    let path = std::env::var_os("PATH").unwrap_or_default();
    crate::host_process::set_environment(command, &[], list, &path, &Default::default(), "0")
        .unwrap();
}

fn command_env(list: &Lists) -> Vec<(String, String)> {
    let mut command = tokio::process::Command::new("/usr/bin/true");
    spawn_env(&mut command, list);
    command
        .as_std()
        .get_envs()
        .filter_map(|(n, v)| Some((n.to_str()?.to_owned(), v?.to_str()?.to_owned())))
        .filter(|(n, _)| list.vars().any(|(name, _)| name == n.as_str()))
        .collect()
}

async fn fixture() -> (
    AgentEnvs,
    tempfile::TempDir,
    crate::app_agents::AppAgentHost,
) {
    let (envs, _) = envs();
    envs.set(ADA, vec![set("FOO", "ada")], || Ok(true))
        .await
        .unwrap();
    let (dir, host) = host_with(&[agent_row(ADA)]);
    (envs, dir, host)
}

async fn launch_of(
    plugin: &str,
    revision: Option<&str>,
    process: &str,
) -> Option<Vec<(String, String)>> {
    let (envs, _dir, host) = fixture().await;
    let (_root, manager, claimant) = manager_with_claimant();
    let revision = revision.unwrap_or(&claimant);
    launched(&manager, &envs, &host, plugin, revision, process).await
}

#[tokio::test]
async fn a_plugin_that_is_not_bundled_gets_nothing_even_declaring_it() {
    assert_eq!(launch_of("test.claimant", None, "goose").await, None);
}

#[tokio::test]
async fn a_harness_helper_process_gets_nothing() {
    assert_eq!(
        launch_of("buzz.goose", Some("bundled"), "read-protected").await,
        None
    );
}

#[tokio::test]
async fn the_mesh_goose_launch_is_refused() {
    assert_eq!(
        launch_of("buzz.mesh-compute", Some("bundled"), "goose").await,
        None
    );
}

#[test]
fn bundled_harnesses_declare_exactly_their_agent_processes() {
    let mut declared: Vec<(String, String)> = buzzodz_plugins::bundled_manifests()
        .into_iter()
        .flat_map(|manifest| {
            let id = manifest.id.clone();
            manifest
                .host
                .into_iter()
                .flat_map(|host| host.processes)
                .filter(|process| process.agent_env)
                .map(move |process| (id.clone(), process.id))
        })
        .collect();
    declared.sort();
    let expected: Vec<(String, String)> = [
        ("buzz.claude-code", "claude-sh"),
        ("buzz.codex", "codex-sh"),
        ("buzz.goose", "goose"),
        ("buzz.pi", "node"),
        ("buzz.pi", "pi-sh"),
    ]
    .iter()
    .map(|(a, b)| (a.to_string(), b.to_string()))
    .collect();
    assert_eq!(declared, expected);
}

#[cfg(unix)]
#[tokio::test]
async fn a_bundled_harness_child_sees_its_list() {
    let (envs, _) = envs();
    envs.set(ADA, vec![set("TEST_AGENT_ENV", "fixture")], || Ok(true))
        .await
        .unwrap();
    let (_dir, host) = host_with(&[agent_row(ADA)]);
    let (_root, manager, _) = manager_with_claimant();
    let declared =
        crate::host_process::declared_process(&manager, "buzz.goose", "bundled", "goose").unwrap();
    let list = for_spawn(
        &envs,
        &host,
        &[SECRET.into()],
        Some(ADA),
        &declared,
        "bundled",
        false,
    )
    .await
    .unwrap();
    let mut command = tokio::process::Command::new("/usr/bin/printenv");
    command.arg("TEST_AGENT_ENV");
    spawn_env(&mut command, &list);
    let output = command.output().await.unwrap();
    assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "fixture");
}

#[tokio::test]
async fn a_save_that_keeps_no_value_replaces_a_damaged_device_list() {
    let damaged = || {
        let store = Arc::new(FakeStore::default());
        *store.text.lock().unwrap() = Some("not json".into());
        store
    };
    let (full, stores) = envs();
    stores.lock().unwrap().insert(DEVICE.into(), damaged());
    // Keeping a value needs the damaged list, so it fails.
    assert!(full.set_device(vec![keep("FOO")]).await.is_err());
    full.set_device(vec![set("FOO", "1")]).await.unwrap();
    assert_eq!(full.status(None).await.unwrap().names, ["FOO"]);

    let (empty, stores) = envs();
    stores.lock().unwrap().insert(DEVICE.into(), damaged());
    empty.set_device(Vec::new()).await.unwrap();
    assert!(empty.status(None).await.unwrap().names.is_empty());
}
