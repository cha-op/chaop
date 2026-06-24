use crate::config::ExecutionConfig;
use crate::placeholder::ConnectorEvent;
use serde::Deserialize;
use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

pub fn codex_exec_started_event(workspace_root: &Path) -> ConnectorEvent {
    ConnectorEvent {
        kind: "command.started".to_owned(),
        priority: "P1".to_owned(),
        summary: format!(
            "Connector started Codex CLI fallback in {}.",
            workspace_root.to_string_lossy()
        ),
        payload: None,
    }
}

pub fn codex_exec_result_events(
    config: &ExecutionConfig,
    workspace_root: &Path,
    prompt: &str,
) -> Vec<ConnectorEvent> {
    codex_exec_result_events_with_cancel(
        config,
        workspace_root,
        prompt,
        Arc::new(AtomicBool::new(false)),
    )
}

pub(crate) fn codex_exec_result_events_with_cancel(
    config: &ExecutionConfig,
    workspace_root: &Path,
    prompt: &str,
    cancel: Arc<AtomicBool>,
) -> Vec<ConnectorEvent> {
    let output = run_codex_command(config, workspace_root, prompt, &cancel);
    match output {
        Ok(output) if output.cancelled => vec![ConnectorEvent {
            kind: "command.failed".to_owned(),
            priority: "P1".to_owned(),
            summary: "Codex CLI fallback was cancelled because the connector connection closed."
                .to_owned(),
            payload: None,
        }],
        Ok(output) if output.timed_out => vec![ConnectorEvent {
            kind: "command.failed".to_owned(),
            priority: "P1".to_owned(),
            summary: format!(
                "Codex CLI fallback timed out after {} seconds.",
                config.codex_timeout_seconds.max(1)
            ),
            payload: None,
        }],
        Ok(output) => codex_result_events(
            output.success,
            output.code,
            &output.stdout,
            &output.stderr,
            output.truncated,
        ),
        Err(error) if error.kind() == ErrorKind::NotFound => vec![ConnectorEvent {
            kind: "command.failed".to_owned(),
            priority: "P1".to_owned(),
            summary: format!(
                "Codex executable not found: {}. Set execution.codex_command to an absolute path visible to the connector process.",
                config.codex_command
            ),
            payload: None,
        }],
        Err(error) => vec![ConnectorEvent {
            kind: "command.failed".to_owned(),
            priority: "P1".to_owned(),
            summary: format!("Codex CLI fallback could not start: {error}."),
            payload: None,
        }],
    }
}

fn codex_command(config: &ExecutionConfig, workspace_root: &Path) -> Command {
    let mut command = Command::new(&config.codex_command);
    command.arg("exec");
    if let Some(profile) = config.codex_profile.as_deref() {
        command.args(["--profile", profile]);
    }
    if let Some(model) = config.codex_model.as_deref() {
        command.args(["--model", model]);
    }
    command
        .args(["--json", "--ephemeral", "--sandbox", &config.codex_sandbox])
        .arg("-C")
        .arg(workspace_root)
        .args(&config.extra_args)
        .arg("-");
    command
}

fn run_codex_command(
    config: &ExecutionConfig,
    workspace_root: &Path,
    prompt: &str,
    cancel: &AtomicBool,
) -> std::io::Result<CodexCommandOutput> {
    let max_bytes = config.codex_output_max_bytes;
    let mut command = codex_command(config, workspace_root);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes())?;
    }

    let stdout = child
        .stdout
        .take()
        .expect("stdout is piped for codex command");
    let stderr = child
        .stderr
        .take()
        .expect("stderr is piped for codex command");
    let stdout_handle = read_capped(stdout, max_bytes);
    let stderr_handle = read_capped(stderr, max_bytes);

    let timeout = Duration::from_secs(config.codex_timeout_seconds.max(1));
    let started_at = Instant::now();
    let (status, timed_out, cancelled) = loop {
        if let Some(status) = child.try_wait()? {
            break (status, false, false);
        }
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            break (child.wait()?, false, true);
        }
        if started_at.elapsed() >= timeout {
            let _ = child.kill();
            break (child.wait()?, true, false);
        }
        thread::sleep(Duration::from_millis(100));
    };

    let stdout = join_capped_output(stdout_handle)?;
    let stderr = join_capped_output(stderr_handle)?;
    Ok(CodexCommandOutput {
        success: status.success() && !timed_out,
        code: status.code(),
        stdout: String::from_utf8_lossy(&stdout.bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.bytes).into_owned(),
        timed_out,
        cancelled,
        truncated: stdout.truncated || stderr.truncated,
    })
}

fn read_capped<R: Read + Send + 'static>(
    mut reader: R,
    max_bytes: usize,
) -> thread::JoinHandle<std::io::Result<CappedOutput>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut truncated = false;
        let mut buffer = [0_u8; 8192];

        loop {
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }

            let remaining = max_bytes.saturating_sub(bytes.len());
            if remaining == 0 {
                truncated = true;
                continue;
            }

            let take = remaining.min(count);
            bytes.extend_from_slice(&buffer[..take]);
            if take < count {
                truncated = true;
            }
        }

        Ok(CappedOutput { bytes, truncated })
    })
}

fn join_capped_output(
    handle: thread::JoinHandle<std::io::Result<CappedOutput>>,
) -> std::io::Result<CappedOutput> {
    match handle.join() {
        Ok(result) => result,
        Err(_) => Err(std::io::Error::other("codex output reader thread panicked")),
    }
}

fn codex_result_events(
    success: bool,
    code: Option<i32>,
    stdout: &str,
    stderr: &str,
    truncated: bool,
) -> Vec<ConnectorEvent> {
    if !success {
        return vec![ConnectorEvent {
            kind: "command.failed".to_owned(),
            priority: "P1".to_owned(),
            summary: format!(
                "Codex CLI fallback failed{}: {}",
                code.map(|value| format!(" with exit code {value}"))
                    .unwrap_or_default(),
                truncate_summary(first_non_empty(stderr, stdout), 600)
            ),
            payload: None,
        }];
    }

    let summary = parse_codex_jsonl(stdout);
    let mut events = Vec::new();
    if let Some(message) = summary.last_agent_message {
        events.push(ConnectorEvent {
            kind: "command.output".to_owned(),
            priority: "P2".to_owned(),
            summary: format!("Codex: {}", truncate_summary(&message, 700)),
            payload: None,
        });
    } else {
        events.push(ConnectorEvent {
            kind: "command.output".to_owned(),
            priority: "P2".to_owned(),
            summary: "Codex CLI fallback completed without an assistant message.".to_owned(),
            payload: None,
        });
    }

    if let Some(usage) = summary.usage {
        events.push(ConnectorEvent {
            kind: "command.output".to_owned(),
            priority: "P3".to_owned(),
            summary: usage.summary(),
            payload: None,
        });
    }

    if truncated {
        events.push(ConnectorEvent {
            kind: "command.output".to_owned(),
            priority: "P2".to_owned(),
            summary:
                "Codex CLI fallback output exceeded the connector cap; summaries may be incomplete."
                    .to_owned(),
            payload: None,
        });
    }

    events.push(ConnectorEvent {
        kind: "command.finished".to_owned(),
        priority: "P1".to_owned(),
        summary: "Codex CLI fallback completed successfully.".to_owned(),
        payload: None,
    });
    events
}

fn parse_codex_jsonl(stdout: &str) -> CodexSummary {
    let mut summary = CodexSummary::default();
    for line in stdout.lines() {
        let Ok(event) = serde_json::from_str::<CodexJsonEvent>(line) else {
            continue;
        };
        if event.event_type == "item.completed"
            && event
                .item
                .as_ref()
                .and_then(|item| item.item_type.as_deref())
                == Some("agent_message")
        {
            if let Some(text) = event.item.and_then(|item| item.text) {
                summary.last_agent_message = Some(text);
            }
        }
        if event.event_type == "turn.completed" {
            summary.usage = event.usage;
        }
    }
    summary
}

fn first_non_empty<'a>(first: &'a str, second: &'a str) -> &'a str {
    let trimmed = first.trim();
    if trimmed.is_empty() {
        second.trim()
    } else {
        trimmed
    }
}

fn truncate_summary(value: &str, max_chars: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= max_chars {
        return compact;
    }

    let mut truncated = compact.chars().take(max_chars).collect::<String>();
    truncated.push_str("...");
    truncated
}

#[derive(Debug, Default, PartialEq, Eq)]
struct CodexSummary {
    last_agent_message: Option<String>,
    usage: Option<CodexUsage>,
}

struct CodexCommandOutput {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
    cancelled: bool,
    truncated: bool,
}

struct CappedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

#[derive(Debug, Deserialize)]
struct CodexJsonEvent {
    #[serde(rename = "type")]
    event_type: String,
    item: Option<CodexItem>,
    usage: Option<CodexUsage>,
}

#[derive(Debug, Deserialize)]
struct CodexItem {
    #[serde(rename = "type")]
    item_type: Option<String>,
    text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct CodexUsage {
    input_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    reasoning_output_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

impl CodexUsage {
    fn summary(&self) -> String {
        let total = self
            .total_tokens
            .or_else(|| match (self.input_tokens, self.output_tokens) {
                (Some(input), Some(output)) => Some(input + output),
                _ => None,
            })
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_owned());
        let input = self
            .input_tokens
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_owned());
        let cached = self.cached_input_tokens.unwrap_or(0);
        let output = self
            .output_tokens
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_owned());
        let reasoning = self.reasoning_output_tokens.unwrap_or(0);
        format!(
            "Codex CLI fallback usage: {total} total tokens, {input} input ({cached} cached), {output} output, {reasoning} reasoning."
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{codex_result_events, parse_codex_jsonl};
    use crate::config::ExecutionConfig;
    use std::fs;
    use std::path::Path;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use std::thread;
    use std::time::Duration;

    #[test]
    fn parses_codex_jsonl_agent_message_and_usage() {
        let summary = parse_codex_jsonl(
            r#"{"type":"thread.started","thread_id":"thread-1"}
{"type":"item.completed","item":{"type":"agent_message","text":"chaop-smoke"}}
{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":4,"output_tokens":3,"reasoning_output_tokens":1,"total_tokens":15}}"#,
        );

        assert_eq!(summary.last_agent_message.as_deref(), Some("chaop-smoke"));
        assert_eq!(
            summary.usage.expect("usage").summary(),
            "Codex CLI fallback usage: 15 total tokens, 12 input (4 cached), 3 output, 1 reasoning."
        );
    }

    #[test]
    fn builds_success_events_from_codex_output() {
        let events = codex_result_events(
            true,
            Some(0),
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"done"}}
{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":2}}"#,
            "",
            false,
        );

        let kinds = events
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            vec!["command.output", "command.output", "command.finished"]
        );
        assert_eq!(events[0].summary, "Codex: done");
        assert_eq!(
            events[1].summary,
            "Codex CLI fallback usage: 9 total tokens, 7 input (0 cached), 2 output, 0 reasoning."
        );
    }

    #[test]
    fn builds_failure_event_from_stderr() {
        let events = codex_result_events(false, Some(2), "", "network unavailable\n", false);

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "command.failed");
        assert_eq!(
            events[0].summary,
            "Codex CLI fallback failed with exit code 2: network unavailable"
        );
    }

    #[test]
    fn reports_missing_codex_executable_with_config_hint() {
        let config = ExecutionConfig {
            codex_command: "/definitely/not/codex".to_owned(),
            ..ExecutionConfig::default()
        };
        let events = super::codex_exec_result_events(&config, Path::new("."), "status");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "command.failed");
        assert_eq!(
            events[0].summary,
            "Codex executable not found: /definitely/not/codex. Set execution.codex_command to an absolute path visible to the connector process."
        );
    }

    #[cfg(unix)]
    #[test]
    fn cancellable_codex_exec_returns_without_waiting_for_timeout() {
        use std::os::unix::fs::PermissionsExt;

        let tempdir = tempfile::tempdir().expect("tempdir");
        let command_path = tempdir.path().join("fake-codex");
        fs::write(&command_path, "#!/bin/sh\nexec sleep 30\n").expect("fake codex");
        let mut permissions = fs::metadata(&command_path)
            .expect("fake codex metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&command_path, permissions).expect("fake codex permissions");

        let config = ExecutionConfig {
            codex_command: command_path.to_string_lossy().into_owned(),
            codex_timeout_seconds: 30,
            ..ExecutionConfig::default()
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = Arc::clone(&cancel);
        let workspace_root = tempdir.path().to_path_buf();
        let worker = thread::spawn(move || {
            super::codex_exec_result_events_with_cancel(
                &config,
                &workspace_root,
                "status",
                worker_cancel,
            )
        });

        thread::sleep(Duration::from_millis(150));
        cancel.store(true, Ordering::Relaxed);
        let events = worker.join().expect("worker");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "command.failed");
        assert_eq!(
            events[0].summary,
            "Codex CLI fallback was cancelled because the connector connection closed."
        );
    }
}
