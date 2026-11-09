//! Public selectors only. Never project commands, arguments, credentials or the
//! environment map. Old runtime defaults outside the saved record stay unknown.
use super::PortSource;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub runtime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

fn selector(value: &Value) -> Option<String> {
    let value = value.as_str()?.trim();
    (!value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control))
        .then(|| value.to_owned())
}
fn runtime(value: &str) -> &'static str {
    match value.trim().rsplit(['/', '\\']).next().unwrap_or(value) {
        "codex" | "codex-acp" => "codex",
        "claude" | "claude-code" | "claudecode" | "claude-agent-acp" | "claude-code-acp" => {
            "claude"
        }
        "goose" | "goose-acp" | "goose.exe" | "goose-acp.exe" => "goose",
        "pi" | "pi-acp" | "buzz-pi-acp" => "pi",
        "buzz-agent" => "buzz-agent",
        _ => "custom",
    }
}

pub(super) fn saved(source: PortSource, record: &Value, records: &[Value]) -> SavedConnection {
    let harness = source == PortSource::Harness;
    let definition = records.iter().find(|row| {
        row["pubkey"].as_str().unwrap_or("").is_empty()
            && record["persona_id"].as_str().is_some_and(|id| {
                row["slug"].as_str() == Some(id) || row["id"].as_str() == Some(id)
            })
    });
    let command = if harness {
        record["harness"]["command"].as_str().unwrap_or("custom")
    } else {
        // As old Buzz's effective_agent_command: explicit pin, live persona,
        // then its bundled runtime. agent_command was only a creation snapshot.
        record["agent_command_override"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| definition.and_then(|row| row["runtime"].as_str()))
            .unwrap_or("buzz-agent")
    };
    let runtime = if record["backend"]["type"].as_str() == Some("provider") {
        "hosted"
    } else {
        runtime(command)
    };
    let selected = if harness { &record["harness"] } else { record };
    let env = &record[if harness { "environment" } else { "env_vars" }];
    let (model_env, provider_env, effort_env) = match runtime {
        "goose" => ("GOOSE_MODEL", "GOOSE_PROVIDER", "GOOSE_THINKING_EFFORT"),
        "buzz-agent" => (
            "BUZZ_AGENT_MODEL",
            "BUZZ_AGENT_PROVIDER",
            "BUZZ_AGENT_THINKING_EFFORT",
        ),
        _ => ("", "", ""),
    };
    SavedConnection {
        runtime: runtime.into(),
        model: selector(&env["BUZZ_ACP_MODEL"])
            .or_else(|| selector(&env[model_env]))
            .or_else(|| selector(&selected["model"])),
        provider: selector(&env[provider_env]).or_else(|| selector(&selected["provider"])),
        effort: selector(&env[effort_env]).or_else(|| {
            harness
                .then(|| selector(&record["imported"]["record"]["effort_level"]))
                .flatten()
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn restores_pinned_choices_and_explicit_effort_without_exporting_environment() {
        let record = json!({
            "persona_id": "helper", "agent_command": "codex", "model": "saved-model", "provider": "openai",
            "env_vars": {"GOOSE_MODEL": "override-model", "GOOSE_PROVIDER": "anthropic", "GOOSE_THINKING_EFFORT": "high", "API_KEY": "secret"}
        });
        let personas =
            vec![json!({"slug": "helper", "runtime": "goose", "model": "new-persona-model"})];
        let result = saved(PortSource::Installed, &record, &personas);
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({"runtime":"goose", "model":"override-model", "provider":"anthropic", "effort":"high"})
        );
        let pinned = json!({"agent_command_override":"/bin/codex", "persona_id":"helper", "model":"saved-model", "provider":"openai"});
        assert_eq!(
            saved(PortSource::Installed, &pinned, &personas),
            SavedConnection {
                runtime: "codex".into(),
                model: Some("saved-model".into()),
                provider: Some("openai".into()),
                effort: None
            }
        );
    }

    #[test]
    fn reads_harness_command_and_environment_but_does_not_guess_unknown_choices() {
        let record = json!({"harness":{"command":"goose", "model":"old", "provider":"openai"}, "environment":{"BUZZ_ACP_MODEL":"selected", "GOOSE_THINKING_EFFORT":"medium"}});
        assert_eq!(
            saved(PortSource::Harness, &record, &[]),
            SavedConnection {
                runtime: "goose".into(),
                model: Some("selected".into()),
                provider: Some("openai".into()),
                effort: Some("medium".into())
            }
        );
        assert_eq!(saved(PortSource::Harness, &json!({"harness":{"command":"goose"},"imported":{"record":{"effort_level":"high"}}}), &[]).effort, Some("high".into()));
        assert_eq!(
            saved(
                PortSource::Installed,
                &json!({"agent_command_override":"custom-wrapper"}),
                &[]
            )
            .runtime,
            "custom"
        );
        assert_eq!(
            saved(
                PortSource::Installed,
                &json!({"backend":{"type":"provider"}}),
                &[]
            )
            .runtime,
            "hosted"
        );
        assert!(
            saved(PortSource::Installed, &json!({"model":"bad\nvalue"}), &[])
                .model
                .is_none()
        );
    }
}
