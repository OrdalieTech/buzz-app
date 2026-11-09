//! Claude's callback timeout otherwise keeps the original result. A native
//! deadline kills the entire worker even when its frontend stops responding.
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::oneshot, time::Instant};
const DEADLINE: Duration = Duration::from_secs(350);
/// Why the guard refuses a worker it stopped, or input to one that exited.
pub(super) const STOPPED: &str = "The protected Claude worker stopped";
const MAX_FRAME: usize = 4 * 1024 * 1024;
struct Pending {
    deadline: Instant,
    _cancel: oneshot::Sender<()>,
}
#[derive(Default)]
struct State {
    output: Vec<u8>,
    input: Vec<u8>,
    pending: HashMap<String, Pending>,
    failed: bool,
    /// Nothing is left to kill or answer, but its last output still drains.
    exited: bool,
}
#[derive(Clone)]
pub(super) struct ClaudeHooks {
    state: Arc<Mutex<State>>,
    #[cfg_attr(not(unix), allow(dead_code))]
    group: u32,
}
impl ClaudeHooks {
    pub fn new(group: u32) -> Self {
        Self {
            state: Arc::default(),
            group,
        }
    }
    pub fn close(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.exited = true;
        state.pending.clear();
    }
    pub fn trip(&self) {
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.failed || state.exited {
                return;
            }
            state.failed = true;
            state.pending.clear();
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.group as i32), libc::SIGKILL);
        }
    }
    pub fn output(&self, data: &[u8]) -> Result<(), String> {
        self.observe(data, true)
    }
    pub fn input(&self, data: &[u8]) -> Result<(), String> {
        self.observe(data, false)
    }
    fn observe(&self, data: &[u8], output: bool) -> Result<(), String> {
        self.observe_at(data, output, Instant::now())
    }
    fn observe_at(&self, data: &[u8], output: bool, now: Instant) -> Result<(), String> {
        let mut timers = Vec::new();
        let result = (|| {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.failed || (state.exited && !output) {
                return Err(STOPPED.into());
            }
            if state.exited {
                return Ok(());
            }
            let buffer = if output {
                &mut state.output
            } else {
                &mut state.input
            };
            if buffer.len() + data.len() > MAX_FRAME {
                return Err("Protected Claude frame is too large".into());
            }
            buffer.extend_from_slice(data);
            let mut frames = Vec::new();
            while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                let line: Vec<_> = buffer.drain(..=end).collect();
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                frames.push(
                    serde_json::from_slice::<Value>(&line)
                        .map_err(|_| "Invalid protected Claude frame")?,
                );
            }
            for frame in frames {
                if output
                    && frame["type"] == "control_request"
                    && frame["request"]["subtype"] == "hook_callback"
                {
                    let callback = frame["request"]["callback_id"].as_str().unwrap_or_default();
                    if !matches!(
                        callback,
                        "security-tool"
                            | "security-incoming"
                            | "security-incomplete"
                            | "security-session"
                    ) {
                        continue;
                    }
                    let id = frame["request_id"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or("Invalid security callback")?
                        .to_string();
                    if state.pending.len() >= 16 || state.pending.contains_key(&id) {
                        return Err("Invalid concurrent security callback".into());
                    }
                    let deadline = now + DEADLINE;
                    let (cancel, cancelled) = oneshot::channel();
                    state.pending.insert(
                        id.clone(),
                        Pending {
                            deadline,
                            _cancel: cancel,
                        },
                    );
                    timers.push((id, deadline, cancelled));
                } else if !output && frame["type"] == "control_response" {
                    let response = &frame["response"];
                    if let Some(id) = response["request_id"].as_str() {
                        if let Some(pending) = state.pending.get(id) {
                            if pending.deadline <= now
                                || response["subtype"] != "success"
                                || !response["response"].is_object()
                            {
                                return Err(
                                    "A failed or late security callback cannot resume Claude"
                                        .into(),
                                );
                            }
                            state.pending.remove(id);
                        }
                    }
                }
            }
            Ok(())
        })();
        if result.is_err() {
            self.trip();
            return result;
        }
        for (id, deadline, mut cancelled) in timers {
            let guard = self.clone();
            tauri::async_runtime::spawn(async move {
                tokio::select! {
                    _=tokio::time::sleep_until(deadline)=>{
                        let overdue=guard.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).pending.get(&id).is_some_and(|pending|pending.deadline==deadline);
                        if overdue {guard.trip();}
                    },
                    _=&mut cancelled=>{},
                }
            });
        }
        result
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    fn request(id: &str) -> Vec<u8> {
        format!("{}\n",serde_json::json!({"type":"control_request","request_id":id,"request":{"subtype":"hook_callback","callback_id":"security-tool"}})).into_bytes()
    }
    fn response(id: &str, subtype: &str) -> Vec<u8> {
        format!("{}\n",serde_json::json!({"type":"control_response","response":{"request_id":id,"subtype":subtype,"response":{}}})).into_bytes()
    }
    fn worker() -> tokio::process::Child {
        let mut command = tokio::process::Command::new("/bin/sleep");
        command.arg("60").kill_on_drop(true);
        command.as_std_mut().process_group(0);
        command.spawn().unwrap()
    }
    #[test]
    fn an_exited_worker_s_output_drains_but_its_input_is_refused() {
        let guard = ClaudeHooks::new(0);
        guard.close();
        assert_eq!(guard.output(&request("late")), Ok(()));
        assert_eq!(guard.input(b"{}\n"), Err(STOPPED.into()));
    }
    #[tokio::test]
    async fn fragmented_responses_cannot_release_a_different_callback() {
        let mut child = worker();
        let guard = ClaudeHooks::new(child.id().unwrap());
        let frame = request("first");
        guard.output(&frame[..8]).unwrap();
        guard.output(&frame[8..]).unwrap();
        guard.input(&response("other", "success")).unwrap();
        assert_eq!(guard.state.lock().unwrap().pending.len(), 1);
        guard.input(&response("first", "success")).unwrap();
        assert!(guard.state.lock().unwrap().pending.is_empty());
        assert!(child.try_wait().unwrap().is_none());
        guard.close();
        child.kill().await.unwrap();
    }
    #[tokio::test]
    async fn failed_or_late_callback_kills_the_worker() {
        for late in [false, true] {
            let mut child = worker();
            let guard = ClaudeHooks::new(child.id().unwrap());
            guard.output(&request("review")).unwrap();
            let result = if late {
                guard.observe_at(
                    &response("review", "success"),
                    false,
                    Instant::now() + DEADLINE,
                )
            } else {
                guard.input(&response("review", "error"))
            };
            assert!(result.is_err());
            assert!(!tokio::time::timeout(Duration::from_secs(5), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success());
        }
    }
    #[tokio::test]
    async fn native_timeout_needs_no_frontend_response() {
        let mut child = worker();
        let guard = ClaudeHooks::new(child.id().unwrap());
        guard
            .observe_at(&request("stalled"), true, Instant::now() - DEADLINE)
            .unwrap();
        assert!(!tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success());
    }
}
