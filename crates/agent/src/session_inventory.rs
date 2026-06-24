use crate::config::AgentConfig;
use crate::placeholder::ConnectorEvent;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, ErrorKind, Read, Seek, SeekFrom};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc::{Receiver, RecvTimeoutError, Sender},
};
use std::time::{Duration, Instant};
use tungstenite::{
    Message, WebSocket, client::client, connect, handshake::HandshakeError, http::Uri,
    stream::MaybeTlsStream,
};

const APP_SERVER_THREAD_SOURCE_KINDS: [&str; 3] = ["cli", "vscode", "appServer"];
const APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE: usize = 200;
const APP_SERVER_ARCHIVE_SYNC_MAX_PAGES_PER_STATE: usize = 2;
const APP_SERVER_ARCHIVE_SYNC_DEADLINE_SECONDS: u64 = 12;

type AppServerSocket = WebSocket<MaybeTlsStream<TcpStream>>;

pub struct AppServerCommandChannels {
    pub event_sender: Sender<ConnectorEvent>,
    pub interaction_receiver: Receiver<TurnInteractionResponseDispatch>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct TurnInteractionResponseDispatch {
    pub command_id: String,
    pub interaction_id: String,
    pub response: TurnInteractionResponse,
    #[serde(default)]
    pub auto_resolved: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum TurnInteractionResponse {
    #[serde(rename = "approval")]
    Approval { decision: String },
    #[serde(rename = "input")]
    Input {
        answers: HashMap<String, TurnInteractionInputAnswer>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct TurnInteractionInputAnswer {
    pub answers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentHostSessionsReport {
    pub sessions: Vec<AgentHostSession>,
    pub inventory_scope: InventoryScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_server_inventory_ok: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentHostSession {
    pub session_id: String,
    pub title: String,
    pub title_source: TitleSource,
    pub app_server_present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentBackfillEvent {
    pub kind: String,
    pub priority: String,
    pub summary: String,
    pub idempotency_key: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InventoryScope {
    Full,
    Incremental,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostSessionBackfill {
    pub events: Vec<AgentBackfillEvent>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TitleSource {
    Metadata,
    AppServer,
    History,
    Fallback,
}

#[derive(Debug, Default)]
struct SessionDraft {
    session_id: String,
    metadata_title: Option<String>,
    app_server_present: bool,
    cwd: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SessionIndexLine {
    id: String,
    thread_name: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HistoryLine {
    session_id: String,
    text: Option<String>,
    ts: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HistorySession {
    title: String,
    updated_at: Option<String>,
}

pub fn build_host_sessions_report(
    config: &AgentConfig,
) -> Result<AgentHostSessionsReport, Box<dyn std::error::Error>> {
    if !config.session_inventory.enabled {
        return Ok(AgentHostSessionsReport {
            sessions: Vec::new(),
            inventory_scope: InventoryScope::Incremental,
            app_server_inventory_ok: None,
        });
    }

    let codex_home = config
        .session_inventory
        .codex_home
        .clone()
        .unwrap_or_else(default_codex_home);
    let mut drafts = HashMap::<String, SessionDraft>::new();

    read_session_index(
        &codex_home,
        &mut drafts,
        config.session_inventory.max_sessions,
    )?;
    read_rollouts(
        &codex_home,
        &mut drafts,
        config.session_inventory.max_sessions,
    )?;
    let history_sessions =
        read_history_sessions(&codex_home, config.session_inventory.max_sessions)?;
    let (app_server_sessions, app_server_inventory_ok, app_server_inventory_truncated) =
        if let Some(url) = config.session_inventory.app_server_url.as_deref() {
            match load_app_server_sessions(
                url,
                config.session_inventory.max_sessions,
                config.session_inventory.app_server_timeout_seconds,
            ) {
                Ok(inventory) => (inventory.sessions, Some(true), inventory.truncated),
                Err(_) => (HashMap::new(), Some(false), false),
            }
        } else {
            (HashMap::new(), None, false)
        };

    for (session_id, app_session) in &app_server_sessions {
        let draft = drafts
            .entry(session_id.clone())
            .or_insert_with(|| SessionDraft {
                session_id: session_id.clone(),
                ..SessionDraft::default()
            });
        draft.cwd = first_non_empty_raw(draft.cwd.take(), app_session.cwd.clone());
        draft.app_server_present = true;
        draft.updated_at = max_string(app_session.updated_at.clone(), draft.updated_at.take());
    }

    for (session_id, history) in &history_sessions {
        let draft = drafts
            .entry(session_id.clone())
            .or_insert_with(|| SessionDraft {
                session_id: session_id.clone(),
                ..SessionDraft::default()
            });
        draft.updated_at = max_string(history.updated_at.clone(), draft.updated_at.take());
    }

    let mut sessions = drafts
        .into_values()
        .map(|draft| {
            let app_title = app_server_sessions
                .get(&draft.session_id)
                .and_then(|session| session.name.clone());
            resolve_session(draft, app_title, &history_sessions)
        })
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    let inventory_scope = if app_server_inventory_truncated
        || sessions.len() > config.session_inventory.max_sessions
    {
        InventoryScope::Incremental
    } else {
        InventoryScope::Full
    };
    sessions.truncate(config.session_inventory.max_sessions);

    Ok(AgentHostSessionsReport {
        sessions,
        inventory_scope,
        app_server_inventory_ok,
    })
}

pub fn build_host_session_backfill(
    config: &AgentConfig,
    session_id: &str,
    limit: usize,
) -> Result<HostSessionBackfill, Box<dyn std::error::Error>> {
    if !config.session_inventory.enabled {
        return Err("session inventory is disabled".into());
    }

    let codex_home = config
        .session_inventory
        .codex_home
        .clone()
        .unwrap_or_else(default_codex_home);
    let limit = limit.clamp(1, 80);

    if let Some(path) = find_rollout_path(
        &codex_home,
        session_id,
        config.session_inventory.max_sessions,
    )? {
        return read_rollout_backfill(&path, session_id, limit);
    }

    Ok(read_history_backfill(
        &codex_home,
        session_id,
        limit,
        config.session_inventory.max_sessions,
    )?)
}

fn read_session_index(
    codex_home: &Path,
    drafts: &mut HashMap<String, SessionDraft>,
    max_sessions: usize,
) -> std::io::Result<()> {
    let path = codex_home.join("session_index.jsonl");
    if !path.exists() {
        return Ok(());
    }
    for line in read_recent_lines(&path, metadata_scan_limit(max_sessions))? {
        let Ok(entry) = serde_json::from_str::<SessionIndexLine>(&line) else {
            continue;
        };
        let draft = drafts
            .entry(entry.id.clone())
            .or_insert_with(|| SessionDraft {
                session_id: entry.id.clone(),
                ..SessionDraft::default()
            });
        draft.metadata_title = first_non_empty(entry.thread_name, draft.metadata_title.take());
        draft.updated_at = max_string(entry.updated_at, draft.updated_at.take());
    }
    Ok(())
}

fn read_history_sessions(
    codex_home: &Path,
    max_sessions: usize,
) -> std::io::Result<HashMap<String, HistorySession>> {
    let path = codex_home.join("history.jsonl");
    let mut sessions = HashMap::new();
    if !path.exists() {
        return Ok(sessions);
    }
    for line in read_recent_lines(&path, metadata_scan_limit(max_sessions))? {
        let Ok(entry) = serde_json::from_str::<HistoryLine>(&line) else {
            continue;
        };
        let updated_at = entry.ts.and_then(unix_seconds_to_iso);
        if let Some(existing) = sessions.get_mut(&entry.session_id) {
            existing.updated_at = max_string(updated_at, existing.updated_at.take());
            continue;
        }
        if let Some(text) = compact_title(entry.text.as_deref()) {
            sessions.insert(
                entry.session_id,
                HistorySession {
                    title: text,
                    updated_at,
                },
            );
        }
    }
    Ok(sessions)
}

fn read_rollouts(
    codex_home: &Path,
    drafts: &mut HashMap<String, SessionDraft>,
    max_sessions: usize,
) -> std::io::Result<()> {
    let sessions_dir = codex_home.join("sessions");
    if !sessions_dir.exists() {
        return Ok(());
    }
    for path in rollout_paths(&sessions_dir, rollout_scan_limit(max_sessions))? {
        read_rollout_metadata(&path, drafts)?;
    }
    Ok(())
}

fn read_rollout_metadata(
    path: &Path,
    drafts: &mut HashMap<String, SessionDraft>,
) -> std::io::Result<()> {
    let file = fs::File::open(path)?;
    let reader = BufReader::new(file);
    let mut session_id = None::<String>;
    let mut cwd = None::<String>;
    let mut title = None::<String>;
    let mut updated_at = None::<String>;

    for line in reader.lines().take(80) {
        let line = line?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        updated_at = max_string(
            value
                .get("timestamp")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            updated_at,
        );
        match value.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                if let Some(payload) = value.get("payload") {
                    session_id = payload
                        .get("id")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .or(session_id);
                    cwd = payload
                        .get("cwd")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .or(cwd);
                    title = metadata_title(payload).or(title);
                }
            }
            Some("turn_context") => {
                if let Some(payload) = value.get("payload") {
                    cwd = payload
                        .get("cwd")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .or(cwd);
                }
            }
            _ => {}
        }
    }

    if let Some(session_id) = session_id {
        let draft = drafts
            .entry(session_id.clone())
            .or_insert_with(|| SessionDraft {
                session_id,
                ..SessionDraft::default()
            });
        draft.cwd = first_non_empty_raw(cwd, draft.cwd.take());
        draft.metadata_title = first_non_empty(title, draft.metadata_title.take());
        draft.updated_at = max_string(updated_at, draft.updated_at.take());
    }
    Ok(())
}

fn find_rollout_path(
    codex_home: &Path,
    session_id: &str,
    max_sessions: usize,
) -> std::io::Result<Option<PathBuf>> {
    let sessions_dir = codex_home.join("sessions");
    if !sessions_dir.exists() {
        return Ok(None);
    }

    for path in rollout_paths(&sessions_dir, rollout_scan_limit(max_sessions).max(1_000))? {
        if rollout_path_has_session_id(&path, session_id)? {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn rollout_path_has_session_id(path: &Path, session_id: &str) -> std::io::Result<bool> {
    let file = fs::File::open(path)?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(80) {
        let line = line?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        if value
            .get("payload")
            .and_then(|payload| payload.get("id"))
            .and_then(Value::as_str)
            == Some(session_id)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn rollout_resume_cwd(path: &Path, session_id: &str) -> std::io::Result<Option<String>> {
    let file = fs::File::open(path)?;
    let reader = BufReader::new(file);
    let mut matched_session = false;
    let mut cwd = None;
    for line in reader.lines().take(80) {
        let line = line?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(payload) = value.get("payload") else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("session_meta")
                if payload.get("id").and_then(Value::as_str) == Some(session_id) =>
            {
                matched_session = true;
                if let Some(value) = payload.get("cwd").and_then(Value::as_str) {
                    cwd = Some(value.to_owned());
                }
            }
            Some("turn_context") if matched_session => {
                if let Some(value) = payload.get("cwd").and_then(Value::as_str) {
                    cwd = Some(value.to_owned());
                }
            }
            _ => {}
        }
    }
    Ok(cwd)
}

fn read_rollout_backfill(
    path: &Path,
    session_id: &str,
    limit: usize,
) -> Result<HostSessionBackfill, Box<dyn std::error::Error>> {
    let mut events = Vec::<AgentBackfillEvent>::new();
    let scan_limit = rollout_backfill_line_scan_limit(limit);
    let lines = read_recent_lines(path, scan_limit)?;
    let reached_scan_limit = lines.len() == scan_limit;

    for line in lines {
        let record_hash = stable_hash(&line);
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(event) = backfill_event_from_rollout_record(session_id, &value, &record_hash)
        else {
            continue;
        };
        events.push(event);
    }

    let truncated = events.len() > limit || reached_scan_limit;
    if events.len() > limit {
        let drain_count = events.len() - limit;
        events.drain(0..drain_count);
    }

    Ok(HostSessionBackfill { events, truncated })
}

fn read_history_backfill(
    codex_home: &Path,
    session_id: &str,
    limit: usize,
    max_sessions: usize,
) -> std::io::Result<HostSessionBackfill> {
    let path = codex_home.join("history.jsonl");
    if !path.exists() {
        return Ok(HostSessionBackfill {
            events: Vec::new(),
            truncated: false,
        });
    }

    let mut events = Vec::new();
    for line in read_recent_lines(&path, metadata_scan_limit(max_sessions))? {
        let Ok(entry) = serde_json::from_str::<HistoryLine>(&line) else {
            continue;
        };
        if entry.session_id != session_id {
            continue;
        }
        let Some(text) = compact_event_text(entry.text.as_deref()) else {
            continue;
        };
        let created_at = entry.ts.and_then(unix_seconds_to_iso);
        let timestamp = created_at.as_deref().unwrap_or("unknown time");
        events.push(AgentBackfillEvent {
            kind: "command.output".to_owned(),
            priority: "P3".to_owned(),
            summary: format!("{} - User: {text}", compact_timestamp(timestamp)),
            idempotency_key: format!("history:{session_id}:{timestamp}:{}", stable_hash(&text)),
            created_at: created_at.unwrap_or_else(unknown_backfill_created_at),
        });
    }
    let truncated = events.len() > limit;
    if truncated {
        let drain_count = events.len() - limit;
        events.drain(0..drain_count);
    }
    Ok(HostSessionBackfill { events, truncated })
}

fn backfill_event_from_rollout_record(
    session_id: &str,
    value: &Value,
    record_hash: &str,
) -> Option<AgentBackfillEvent> {
    if value.get("type").and_then(Value::as_str) != Some("response_item") {
        return None;
    }

    let created_at = value
        .get("timestamp")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let timestamp = created_at.as_deref().unwrap_or("unknown time");
    let item = value.get("payload")?;
    let item_type = item.get("type").and_then(Value::as_str)?;
    let summary = match item_type {
        "message" => {
            let role = item.get("role").and_then(Value::as_str)?;
            if role != "user" && role != "assistant" {
                return None;
            }
            let text = message_text(item, role)?;
            let label = if role == "user" { "User" } else { "Assistant" };
            format!("{} - {label}: {text}", compact_timestamp(timestamp))
        }
        "function_call" => {
            let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
            format!("{} - Tool call: {name}", compact_timestamp(timestamp))
        }
        _ => return None,
    };

    let idempotency_key = format!(
        "rollout:{session_id}:{timestamp}:{item_type}:{}",
        record_hash
    );

    Some(AgentBackfillEvent {
        kind: "command.output".to_owned(),
        priority: "P3".to_owned(),
        summary,
        idempotency_key,
        created_at: created_at.unwrap_or_else(unknown_backfill_created_at),
    })
}

fn unknown_backfill_created_at() -> String {
    "1970-01-01T00:00:00.000Z".to_owned()
}

fn message_text(item: &Value, role: &str) -> Option<String> {
    let content = item.get("content").and_then(Value::as_array)?;
    let mut parts = Vec::new();
    for part in content {
        let text = part
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| part.get("input").and_then(Value::as_str));
        let text = match (role, text) {
            ("user", Some(value)) => strip_injected_context_prefix(value),
            (_, Some(value)) => Some(value.trim()),
            (_, None) => None,
        };
        if let Some(text) = text.and_then(|value| compact_event_text(Some(value))) {
            parts.push(text);
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

fn compact_event_text(value: Option<&str>) -> Option<String> {
    let compact = value?.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return None;
    }
    let mut text = compact.chars().take(260).collect::<String>();
    if compact.chars().count() > 260 {
        text.push_str("...");
    }
    Some(text)
}

fn looks_like_injected_context(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("# AGENTS.md instructions")
        || trimmed.starts_with("<environment_context>")
        || trimmed.starts_with("<permissions instructions>")
        || trimmed.starts_with("<apps_instructions>")
        || trimmed.starts_with("<skills_instructions>")
        || trimmed.starts_with("<plugins_instructions>")
        || trimmed.starts_with("<developer")
}

fn strip_injected_context_prefix(text: &str) -> Option<&str> {
    let trimmed = text.trim();
    if !looks_like_injected_context(trimmed) {
        return Some(trimmed);
    }

    let mut latest_end = None::<usize>;
    for marker in [
        "</INSTRUCTIONS>",
        "</environment_context>",
        "</permissions instructions>",
        "</collaboration_mode>",
        "</apps_instructions>",
        "</skills_instructions>",
        "</plugins_instructions>",
        "</developer>",
    ] {
        if let Some(index) = trimmed.rfind(marker) {
            latest_end =
                Some(latest_end.map_or(index + marker.len(), |end| end.max(index + marker.len())));
        }
    }

    let remainder = trimmed.get(latest_end?..)?.trim();
    if remainder.is_empty() {
        None
    } else {
        Some(remainder)
    }
}

fn compact_timestamp(timestamp: &str) -> String {
    timestamp
        .strip_suffix('Z')
        .unwrap_or(timestamp)
        .replace('T', " ")
        .chars()
        .take(16)
        .collect()
}

fn rollout_scan_limit(max_sessions: usize) -> usize {
    max_sessions.saturating_mul(3).clamp(50, 500)
}

fn metadata_scan_limit(max_sessions: usize) -> usize {
    max_sessions.saturating_mul(5).clamp(50, 1000)
}

fn rollout_backfill_line_scan_limit(event_limit: usize) -> usize {
    event_limit.saturating_mul(20).clamp(200, 2_000)
}

fn read_recent_lines(path: &Path, limit: usize) -> std::io::Result<Vec<String>> {
    if limit == 0 {
        return Ok(Vec::new());
    }

    let mut file = fs::File::open(path)?;
    let mut position = file.seek(SeekFrom::End(0))?;
    let mut bytes = Vec::<u8>::new();
    let mut newline_count = 0_usize;
    let mut chunk = [0_u8; 8192];

    while position > 0 && newline_count <= limit {
        let read_len = (position as usize).min(chunk.len());
        position -= read_len as u64;
        file.seek(SeekFrom::Start(position))?;
        file.read_exact(&mut chunk[..read_len])?;
        newline_count += chunk[..read_len]
            .iter()
            .filter(|byte| **byte == b'\n')
            .count();

        let mut next = Vec::with_capacity(read_len + bytes.len());
        next.extend_from_slice(&chunk[..read_len]);
        next.extend_from_slice(&bytes);
        bytes = next;
    }

    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
    if lines.len() > limit {
        lines = lines.split_off(lines.len() - limit);
    }
    Ok(lines)
}

fn rollout_paths(root: &Path, limit: usize) -> std::io::Result<Vec<PathBuf>> {
    let limit = limit.max(1);
    let day_dirs = dated_session_dirs(root)?;
    if !day_dirs.is_empty() {
        let mut paths = Vec::new();
        for day_dir in day_dirs {
            paths.extend(rollout_files_in_dir(&day_dir)?);
            if paths.len() >= limit {
                break;
            }
        }
        sort_paths_by_mtime_desc(&mut paths);
        paths.truncate(limit);
        return Ok(paths);
    }

    let mut paths = Vec::new();
    collect_rollout_paths(root, &mut paths, limit)?;
    sort_paths_by_mtime_desc(&mut paths);
    paths.truncate(limit);
    Ok(paths)
}

fn collect_rollout_paths(
    path: &Path,
    paths: &mut Vec<PathBuf>,
    limit: usize,
) -> std::io::Result<()> {
    if paths.len() >= limit {
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_rollout_paths(&path, paths, limit)?;
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        {
            paths.push(path);
            if paths.len() >= limit {
                break;
            }
        }
    }
    Ok(())
}

fn dated_session_dirs(root: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut day_dirs = Vec::new();
    for year in sorted_numeric_dirs(root, false)? {
        for month in sorted_numeric_dirs(&year, false)? {
            for day in sorted_numeric_dirs(&month, false)? {
                day_dirs.push(day);
            }
        }
    }
    day_dirs.sort_by(|left, right| right.cmp(left));
    Ok(day_dirs)
}

fn sorted_numeric_dirs(root: &Path, ascending: bool) -> std::io::Result<Vec<PathBuf>> {
    let mut dirs = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.chars().all(|char| char.is_ascii_digit()))
        {
            dirs.push(path);
        }
    }
    if ascending {
        dirs.sort();
    } else {
        dirs.sort_by(|left, right| right.cmp(left));
    }
    Ok(dirs)
}

fn rollout_files_in_dir(root: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        {
            paths.push(path);
        }
    }
    sort_paths_by_mtime_desc(&mut paths);
    Ok(paths)
}

fn sort_paths_by_mtime_desc(paths: &mut [PathBuf]) {
    paths.sort_by(|left, right| {
        let right_time = right
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok();
        let left_time = left
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok();
        right_time.cmp(&left_time).then_with(|| right.cmp(left))
    });
}

fn resolve_session(
    draft: SessionDraft,
    app_server_title: Option<String>,
    history_sessions: &HashMap<String, HistorySession>,
) -> AgentHostSession {
    let (title, title_source) = if let Some(title) = compact_title(draft.metadata_title.as_deref())
    {
        (title, TitleSource::Metadata)
    } else if let Some(title) = compact_title(app_server_title.as_deref()) {
        (title, TitleSource::AppServer)
    } else if let Some(title) = compact_title(
        history_sessions
            .get(&draft.session_id)
            .map(|history| history.title.as_str()),
    ) {
        (title, TitleSource::History)
    } else {
        (fallback_title(&draft), TitleSource::Fallback)
    };

    AgentHostSession {
        session_id: draft.session_id,
        title,
        title_source,
        app_server_present: draft.app_server_present,
        cwd: draft.cwd,
        updated_at: draft
            .updated_at
            .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned()),
    }
}

fn unix_seconds_to_iso(seconds: i64) -> Option<String> {
    if seconds < 0 {
        return None;
    }
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z"
    ))
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i64, i64, i64) {
    let shifted_days = days_since_unix_epoch + 719_468;
    let era = if shifted_days >= 0 {
        shifted_days
    } else {
        shifted_days - 146_096
    } / 146_097;
    let day_of_era = shifted_days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_piece = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_piece + 2) / 5 + 1;
    let month = month_piece + if month_piece < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    (year, month, day)
}

fn load_app_server_sessions(
    url: &str,
    limit: usize,
    timeout_seconds: u64,
) -> Result<AppServerSessionInventory, Box<dyn std::error::Error>> {
    let timeout = Duration::from_secs(timeout_seconds.max(1));
    let mut socket = connect_app_server(url, timeout)?;
    initialize_app_server_connection(&mut socket)?;
    let session_limit = limit.max(1);
    let page_limit = session_limit.saturating_add(1);
    socket.send(Message::Text(
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "thread/list",
            "params": app_server_thread_list_params(page_limit, None, Some(false))
        })
        .to_string()
        .into(),
    ))?;

    let value = read_app_server_inventory_page(&mut socket, 1)?;
    let sessions = app_server_sessions_from_response(&value);
    let raw_thread_count = app_server_thread_list_data(&value)
        .map(|threads| threads.len())
        .unwrap_or_default();
    let truncated =
        raw_thread_count > session_limit || app_server_thread_list_next_cursor(&value).is_some();
    Ok(AppServerSessionInventory {
        sessions,
        truncated,
    })
}

pub fn app_server_health_check(
    url: &str,
    timeout_seconds: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    let timeout = Duration::from_secs(timeout_seconds.max(1));
    let mut socket = connect_app_server(url, timeout)?;
    initialize_app_server_connection(&mut socket)
}

fn read_app_server_inventory_page(
    socket: &mut AppServerSocket,
    request_id: i64,
) -> Result<Value, Box<dyn std::error::Error>> {
    loop {
        match socket.read()? {
            Message::Text(text) => {
                let value = serde_json::from_str::<Value>(text.as_ref())?;
                if value.get("id").and_then(Value::as_i64) != Some(request_id) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    return Err(app_server_error("thread/list", error).into());
                }
                validate_app_server_thread_list_response(&value)?;
                return Ok(value);
            }
            Message::Close(_) => {
                return Err("app-server closed before thread/list response".into());
            }
            _ => {}
        }
    }
}

fn connect_app_server(
    url: &str,
    timeout: Duration,
) -> Result<AppServerSocket, Box<dyn std::error::Error>> {
    let uri = url.parse::<Uri>()?;
    if uri.scheme_str() == Some("ws") {
        return connect_plain_app_server(url, &uri, timeout);
    }

    let (mut socket, _) = connect(url)?;
    configure_socket_timeout(&mut socket, timeout)?;
    Ok(socket)
}

fn connect_plain_app_server(
    url: &str,
    uri: &Uri,
    timeout: Duration,
) -> Result<AppServerSocket, Box<dyn std::error::Error>> {
    let host = uri.host().ok_or("app-server URL did not include a host")?;
    let host = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    let port = uri.port_u16().unwrap_or(80);
    let mut last_error = None;

    for addr in (host, port).to_socket_addrs()? {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(stream) => {
                stream.set_nodelay(true)?;
                stream.set_read_timeout(Some(timeout))?;
                stream.set_write_timeout(Some(timeout))?;
                let (socket, _) = match client(url, MaybeTlsStream::Plain(stream)) {
                    Ok(result) => result,
                    Err(HandshakeError::Failure(error)) => return Err(error.into()),
                    Err(HandshakeError::Interrupted(_)) => {
                        return Err("app-server websocket handshake was interrupted".into());
                    }
                };
                return Ok(socket);
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
    }

    Err(match last_error {
        Some(error) => format!("unable to connect to app-server {url}: {error}").into(),
        None => format!("app-server URL {url} resolved to no socket addresses").into(),
    })
}

fn configure_socket_timeout(
    socket: &mut AppServerSocket,
    timeout: Duration,
) -> std::io::Result<()> {
    match socket.get_mut() {
        tungstenite::stream::MaybeTlsStream::Plain(stream) => {
            stream.set_read_timeout(Some(timeout))?;
            stream.set_write_timeout(Some(timeout))
        }
        tungstenite::stream::MaybeTlsStream::NativeTls(stream) => {
            stream.get_ref().set_read_timeout(Some(timeout))?;
            stream.get_ref().set_write_timeout(Some(timeout))
        }
        _ => Ok(()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AppServerSession {
    name: Option<String>,
    cwd: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AppServerSessionInventory {
    sessions: HashMap<String, AppServerSession>,
    truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AppServerArchiveResolution {
    NeedsUpdate(Vec<String>),
    AlreadySynced,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AppServerArchivePageScan {
    Complete(AppServerArchiveCompletePageScan),
    Exhausted { session_thread_ids: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AppServerArchiveCompletePageScan {
    thread_ids: Vec<String>,
    matched_exact_thread: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct AppServerArchivePageMatches {
    exact_thread_id: Option<String>,
    session_thread_ids: Vec<String>,
}

fn app_server_sessions_from_response(value: &Value) -> HashMap<String, AppServerSession> {
    let mut sessions = HashMap::new();
    let Some(data) = value
        .get("result")
        .and_then(|result| result.get("data"))
        .and_then(Value::as_array)
    else {
        return sessions;
    };
    for thread in data {
        let Some(session_id) = app_server_thread_session_id(thread) else {
            continue;
        };
        sessions
            .entry(session_id.to_owned())
            .or_insert_with(|| AppServerSession {
                name: compact_title(thread.get("name").and_then(Value::as_str)),
                cwd: thread
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                updated_at: app_server_thread_timestamp(thread),
            });
    }
    sessions
}

fn validate_app_server_thread_list_response(
    value: &Value,
) -> Result<(), Box<dyn std::error::Error>> {
    let data = app_server_thread_list_data(value)
        .ok_or("app-server thread/list response did not include result.data")?;
    for (index, thread) in data.iter().enumerate() {
        if !thread.is_object() {
            return Err(
                format!("app-server thread/list response data[{index}] was not an object").into(),
            );
        }
        if app_server_thread_id(thread).is_none() {
            return Err(format!(
                "app-server thread/list response data[{index}] did not include thread.id"
            )
            .into());
        }
    }

    if let Some(next_cursor) = value
        .get("result")
        .and_then(|result| result.get("nextCursor"))
    {
        match next_cursor {
            Value::Null => {}
            Value::String(cursor) if !cursor.trim().is_empty() => {}
            Value::String(_) => {
                return Err("app-server thread/list response included empty nextCursor".into());
            }
            _ => {
                return Err(
                    "app-server thread/list response included non-string nextCursor".into(),
                );
            }
        }
    }
    Ok(())
}

fn app_server_thread_session_id(thread: &Value) -> Option<&str> {
    thread
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|session_id| !session_id.trim().is_empty())
        .or_else(|| app_server_thread_id(thread))
}

fn app_server_thread_id(thread: &Value) -> Option<&str> {
    thread
        .get("id")
        .and_then(Value::as_str)
        .filter(|session_id| !session_id.trim().is_empty())
}

#[cfg(test)]
fn app_server_titles_from_response(value: &Value) -> HashMap<String, String> {
    app_server_sessions_from_response(value)
        .into_iter()
        .filter_map(|(session_id, session)| session.name.map(|name| (session_id, name)))
        .collect()
}

pub fn create_app_server_thread(
    config: &AgentConfig,
    title: Option<&str>,
) -> Result<AgentHostSession, Box<dyn std::error::Error>> {
    let url = config
        .session_inventory
        .app_server_url
        .as_deref()
        .ok_or("session_inventory.app_server_url is required for local thread creation")?;
    let cwd = config.workspace_root.to_string_lossy().into_owned();
    create_app_server_thread_at(
        url,
        title,
        &cwd,
        config.session_inventory.app_server_timeout_seconds,
    )
}

pub fn ensure_app_server_host_session(
    config: &AgentConfig,
    session_id: &str,
    title: Option<&str>,
    cwd: Option<&str>,
) -> Result<AgentHostSession, Box<dyn std::error::Error>> {
    let url =
        config.session_inventory.app_server_url.as_deref().ok_or(
            "session_inventory.app_server_url is required for app-server host session attach",
        )?;
    let cwd = app_server_command_cwd(config, cwd);
    let codex_home = config
        .session_inventory
        .codex_home
        .clone()
        .unwrap_or_else(default_codex_home);
    ensure_app_server_host_session_at(
        url,
        session_id,
        title,
        &cwd,
        None,
        Some((&codex_home, config.session_inventory.max_sessions)),
        config.session_inventory.app_server_timeout_seconds,
    )
}

pub fn set_app_server_thread_archived(
    config: &AgentConfig,
    thread_id: &str,
    archived: bool,
) -> Result<bool, Box<dyn std::error::Error>> {
    let url = config
        .session_inventory
        .app_server_url
        .as_deref()
        .ok_or("session_inventory.app_server_url is required for app-server archive sync")?;
    let codex_home = config
        .session_inventory
        .codex_home
        .clone()
        .unwrap_or_else(default_codex_home);
    set_app_server_thread_archived_at_with_rollout_lookup(
        url,
        thread_id,
        archived,
        Some((&codex_home, config.session_inventory.max_sessions)),
        config.session_inventory.app_server_timeout_seconds,
    )
}

pub fn app_server_command_started_event(session_id: &str) -> ConnectorEvent {
    ConnectorEvent {
        kind: "command.started".to_owned(),
        priority: "P1".to_owned(),
        summary: format!("Connector started Codex app-server turn for local thread {session_id}."),
        payload: None,
    }
}

pub fn app_server_command_result_events_with_cancel(
    config: &AgentConfig,
    session_id: &str,
    cwd: Option<&str>,
    command_id: &str,
    prompt: &str,
    cancel: Arc<AtomicBool>,
    channels: Option<AppServerCommandChannels>,
) -> Vec<ConnectorEvent> {
    match run_app_server_command(
        config, session_id, cwd, command_id, prompt, cancel, channels,
    ) {
        Ok(events) => events,
        Err(AppServerCommandError::Cancelled) => vec![ConnectorEvent {
            kind: "command.failed".to_owned(),
            priority: "P1".to_owned(),
            summary: "Codex app-server turn was cancelled because the connector connection closed."
                .to_owned(),
            payload: None,
        }],
        Err(AppServerCommandError::TimedOut(seconds)) => vec![ConnectorEvent {
            kind: "command.failed".to_owned(),
            priority: "P1".to_owned(),
            summary: format!("Codex app-server turn timed out after {seconds} seconds."),
            payload: None,
        }],
        Err(AppServerCommandError::Other(error)) => vec![ConnectorEvent {
            kind: "command.failed".to_owned(),
            priority: "P1".to_owned(),
            summary: format!("Codex app-server turn could not start: {error}."),
            payload: None,
        }],
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AppServerCommandError {
    Cancelled,
    TimedOut(u64),
    Other(String),
}

fn run_app_server_command(
    config: &AgentConfig,
    session_id: &str,
    cwd: Option<&str>,
    command_id: &str,
    prompt: &str,
    cancel: Arc<AtomicBool>,
    channels: Option<AppServerCommandChannels>,
) -> Result<Vec<ConnectorEvent>, AppServerCommandError> {
    let url = config
        .session_inventory
        .app_server_url
        .as_deref()
        .ok_or_else(|| {
            AppServerCommandError::Other(
                "session_inventory.app_server_url is required for app-server execution".to_owned(),
            )
        })?;
    let timeout_seconds = config.execution.codex_timeout_seconds.max(1);
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    let socket_timeout = app_server_command_socket_timeout(
        config.session_inventory.app_server_timeout_seconds,
        timeout_seconds,
    );
    let mut socket = connect_app_server(url, socket_timeout)
        .map_err(|error| AppServerCommandError::Other(error.to_string()))?;
    initialize_app_server_connection_for_command(
        &mut socket,
        socket_timeout,
        deadline,
        timeout_seconds,
        &cancel,
    )?;

    let cwd = app_server_command_cwd(config, cwd);
    let mut request_id = 1;
    let resolved_thread_id = resolve_app_server_thread_id_for_command(
        &mut socket,
        session_id,
        &mut request_id,
        socket_timeout,
        deadline,
        timeout_seconds,
        &cancel,
    )?;
    let (resume_params, fallback_thread_id, require_resumed_thread_id, requested_turn_cwd) =
        if let Some(thread_id) = resolved_thread_id {
            (
                serde_json::json!({
                    "threadId": thread_id.clone(),
                    "cwd": cwd.clone(),
                    "runtimeWorkspaceRoots": [cwd.clone()],
                    "excludeTurns": true
                }),
                thread_id,
                false,
                cwd.clone(),
            )
        } else {
            let codex_home = config
                .session_inventory
                .codex_home
                .clone()
                .unwrap_or_else(default_codex_home);
            let rollout_path = find_rollout_path(
                &codex_home,
                session_id,
                config.session_inventory.max_sessions,
            )
            .map_err(|error| AppServerCommandError::Other(error.to_string()))?;
            let Some(rollout_path) = rollout_path else {
                return Err(AppServerCommandError::Other(format!(
                    "active app-server thread {session_id} was not found and no local rollout was available"
                )));
            };
            let resume_cwd = rollout_resume_cwd(&rollout_path, session_id)
                .map_err(|error| AppServerCommandError::Other(error.to_string()))?
                .unwrap_or_else(|| cwd.clone());
            (
                serde_json::json!({
                    "threadId": session_id,
                    "path": rollout_path.to_string_lossy(),
                    "cwd": resume_cwd.clone(),
                    "runtimeWorkspaceRoots": [resume_cwd.clone()],
                    "excludeTurns": true
                }),
                session_id.to_owned(),
                true,
                resume_cwd,
            )
        };
    let resume_response = send_app_server_request_for_command(
        &mut socket,
        request_id,
        "thread/resume",
        resume_params,
        socket_timeout,
        deadline,
        timeout_seconds,
        &cancel,
    )?;
    request_id += 1;
    let resumed_thread = if require_resumed_thread_id {
        let resumed = app_server_thread_from_response(&resume_response)
            .map_err(|error| {
                let message = error.to_string();
                if message == "app-server thread/start response did not include thread.id" {
                    AppServerCommandError::Other(
                        "app-server thread/resume response did not include thread.id for rollout path resume"
                            .to_owned(),
                    )
                } else {
                    AppServerCommandError::Other(message)
                }
            })?;
        if resumed.session_id != session_id {
            return Err(AppServerCommandError::Other(format!(
                "app-server thread/resume returned session {} while starting session {session_id}",
                resumed.session_id
            )));
        }
        Some(resumed)
    } else {
        None
    };
    let thread_id = match resumed_thread.as_ref() {
        Some(resumed) => resumed.id.clone(),
        None => response_thread_id(&resume_response).unwrap_or(fallback_thread_id),
    };
    let turn_cwd = resume_response
        .pointer("/result/thread/cwd")
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.trim().is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or(requested_turn_cwd);

    let turn_response = send_app_server_turn_start_for_command(
        &mut socket,
        &mut request_id,
        &thread_id,
        serde_json::json!({
            "threadId": thread_id,
            "clientUserMessageId": command_id,
            "input": [{
                "type": "text",
                "text": prompt,
                "text_elements": []
            }],
            "cwd": turn_cwd.clone(),
            "runtimeWorkspaceRoots": [turn_cwd],
            "approvalPolicy": "on-request",
            "approvalsReviewer": "user"
        }),
        socket_timeout,
        deadline,
        timeout_seconds,
        &cancel,
    )?;
    let Some(turn) = turn_response
        .get("result")
        .and_then(|result| result.get("turn"))
    else {
        return Err(AppServerCommandError::Other(
            "app-server turn/start response did not include result.turn".to_owned(),
        ));
    };
    let turn_id = turn
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppServerCommandError::Other(
                "app-server turn/start response did not include turn.id".to_owned(),
            )
        })?
        .to_owned();
    if turn_is_terminal(turn) {
        return Ok(app_server_command_events_from_turn(turn, None));
    }
    let channels_ref = channels.as_ref();
    wait_for_app_server_turn_completion(
        &mut socket,
        &thread_id,
        &turn_id,
        command_id,
        socket_timeout,
        deadline,
        timeout_seconds,
        config.execution.codex_output_max_bytes,
        &cancel,
        &mut request_id,
        channels_ref,
    )
}

fn initialize_app_server_connection_for_command(
    socket: &mut AppServerSocket,
    timeout: Duration,
    deadline: Instant,
    timeout_seconds: u64,
    cancel: &AtomicBool,
) -> Result<(), AppServerCommandError> {
    let _ = send_app_server_request_for_command(
        socket,
        0,
        "initialize",
        serde_json::json!({
            "clientInfo": {
                "name": "chaop-agent",
                "title": "Chaop connector",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": {
                "experimentalApi": true,
                "requestAttestation": false
            }
        }),
        timeout,
        deadline,
        timeout_seconds,
        cancel,
    )?;
    socket
        .send(Message::Text(
            serde_json::json!({
                "jsonrpc": "2.0",
                "method": "initialized"
            })
            .to_string()
            .into(),
        ))
        .map_err(|error| AppServerCommandError::Other(error.to_string()))?;
    Ok(())
}

fn send_app_server_request_for_command(
    socket: &mut AppServerSocket,
    id: i64,
    method: &str,
    params: Value,
    timeout: Duration,
    deadline: Instant,
    timeout_seconds: u64,
    cancel: &AtomicBool,
) -> Result<Value, AppServerCommandError> {
    socket
        .send(Message::Text(
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params
            })
            .to_string()
            .into(),
        ))
        .map_err(|error| AppServerCommandError::Other(error.to_string()))?;

    loop {
        ensure_app_server_command_budget(deadline, timeout_seconds, cancel)?;
        configure_socket_timeout(
            socket,
            remaining_app_server_command_timeout(timeout, deadline),
        )
        .map_err(|error| AppServerCommandError::Other(error.to_string()))?;
        match socket.read() {
            Ok(Message::Text(text)) => {
                let value = serde_json::from_str::<Value>(text.as_ref())
                    .map_err(|error| AppServerCommandError::Other(error.to_string()))?;
                if value.get("id").and_then(Value::as_i64) != Some(id) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    return Err(AppServerCommandError::Other(
                        app_server_error(method, error).to_string(),
                    ));
                }
                return Ok(value);
            }
            Ok(Message::Close(_)) => {
                return Err(AppServerCommandError::Other(format!(
                    "app-server closed before {method} completed"
                )));
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if error.kind() == ErrorKind::WouldBlock || error.kind() == ErrorKind::TimedOut => {
            }
            Err(error) => return Err(AppServerCommandError::Other(error.to_string())),
        }
    }
}

fn send_app_server_turn_start_for_command(
    socket: &mut AppServerSocket,
    next_request_id: &mut i64,
    thread_id: &str,
    params: Value,
    timeout: Duration,
    deadline: Instant,
    timeout_seconds: u64,
    cancel: &AtomicBool,
) -> Result<Value, AppServerCommandError> {
    ensure_app_server_command_budget(deadline, timeout_seconds, cancel)?;

    let id = *next_request_id;
    *next_request_id += 1;
    socket
        .send(Message::Text(
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "turn/start",
                "params": params
            })
            .to_string()
            .into(),
        ))
        .map_err(|error| AppServerCommandError::Other(error.to_string()))?;

    let mut interruption = None::<AppServerCommandError>;
    let mut interruption_deadline = None::<Instant>;
    loop {
        if interruption.is_none() {
            interruption = app_server_command_interruption(deadline, timeout_seconds, cancel);
            if interruption.is_some() {
                interruption_deadline = Some(Instant::now() + timeout);
            }
        }
        if let (Some(error), Some(deadline)) = (&interruption, interruption_deadline)
            && Instant::now() >= deadline
        {
            return Err(error.clone());
        }

        let read_deadline = interruption_deadline.unwrap_or(deadline);
        configure_socket_timeout(
            socket,
            remaining_app_server_command_timeout(timeout, read_deadline),
        )
        .map_err(|error| AppServerCommandError::Other(error.to_string()))?;
        match socket.read() {
            Ok(Message::Text(text)) => {
                let value = serde_json::from_str::<Value>(text.as_ref())
                    .map_err(|error| AppServerCommandError::Other(error.to_string()))?;
                if value.get("id").and_then(Value::as_i64) != Some(id) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    if let Some(interruption) = interruption {
                        return Err(interruption);
                    }
                    return Err(AppServerCommandError::Other(
                        app_server_error("turn/start", error).to_string(),
                    ));
                }
                if let Some(interruption) = interruption {
                    if let Some(turn_id) = turn_id_from_start_response(&value) {
                        send_app_server_turn_interrupt(
                            socket,
                            *next_request_id,
                            thread_id,
                            turn_id,
                        );
                        *next_request_id += 1;
                    }
                    return Err(interruption);
                }
                return Ok(value);
            }
            Ok(Message::Close(_)) => {
                return Err(AppServerCommandError::Other(
                    "app-server closed before turn/start completed".to_owned(),
                ));
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if error.kind() == ErrorKind::WouldBlock || error.kind() == ErrorKind::TimedOut => {
            }
            Err(error) => return Err(AppServerCommandError::Other(error.to_string())),
        }
    }
}

fn resolve_app_server_thread_id_for_command(
    socket: &mut AppServerSocket,
    session_id: &str,
    next_request_id: &mut i64,
    timeout: Duration,
    deadline: Instant,
    timeout_seconds: u64,
    cancel: &AtomicBool,
) -> Result<Option<String>, AppServerCommandError> {
    let scan = find_app_server_thread_ids_in_pages_for_command(
        socket,
        session_id,
        Some(false),
        next_request_id,
        timeout,
        deadline,
        timeout_seconds,
        cancel,
    )?;
    Ok(scan.thread_ids.into_iter().next())
}

fn find_app_server_thread_ids_in_pages_for_command(
    socket: &mut AppServerSocket,
    thread_id: &str,
    archived_filter: Option<bool>,
    next_request_id: &mut i64,
    timeout: Duration,
    deadline: Instant,
    timeout_seconds: u64,
    cancel: &AtomicBool,
) -> Result<AppServerArchiveCompletePageScan, AppServerCommandError> {
    let mut seen_threads = HashSet::new();
    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();
    loop {
        ensure_app_server_command_budget(deadline, timeout_seconds, cancel)?;
        let response = send_app_server_request_for_command(
            socket,
            *next_request_id,
            "thread/list",
            app_server_thread_list_params(
                APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE,
                cursor.as_deref(),
                archived_filter,
            ),
            timeout,
            deadline,
            timeout_seconds,
            cancel,
        )?;
        *next_request_id += 1;

        let matches = app_server_archive_thread_ids_from_response(&response, thread_id);
        if let Some(exact_thread_id) = matches.exact_thread_id {
            return Ok(AppServerArchiveCompletePageScan {
                thread_ids: vec![exact_thread_id],
                matched_exact_thread: true,
            });
        }
        if let Some(session_thread_id) = matches.session_thread_ids.into_iter().next() {
            return Ok(AppServerArchiveCompletePageScan {
                thread_ids: vec![session_thread_id],
                matched_exact_thread: false,
            });
        }

        let page_len = app_server_thread_list_data(&response)
            .map(std::vec::Vec::len)
            .unwrap_or(0);
        let page_keys = app_server_thread_identity_keys_from_response(&response);
        let new_key_count = page_keys
            .into_iter()
            .filter(|key| seen_threads.insert(key.to_owned()))
            .count();
        let next_cursor = app_server_thread_list_next_cursor(&response);
        if next_cursor.is_none() || page_len == 0 || new_key_count == 0 {
            return Ok(AppServerArchiveCompletePageScan {
                thread_ids: Vec::new(),
                matched_exact_thread: false,
            });
        }
        let next_cursor = next_cursor.expect("checked above");
        if !seen_cursors.insert(next_cursor.clone()) {
            return Ok(AppServerArchiveCompletePageScan {
                thread_ids: Vec::new(),
                matched_exact_thread: false,
            });
        }
        cursor = Some(next_cursor);
    }
}

fn wait_for_app_server_turn_completion(
    socket: &mut AppServerSocket,
    thread_id: &str,
    turn_id: &str,
    command_id: &str,
    timeout: Duration,
    deadline: Instant,
    timeout_seconds: u64,
    output_max_bytes: usize,
    cancel: &AtomicBool,
    next_request_id: &mut i64,
    channels: Option<&AppServerCommandChannels>,
) -> Result<Vec<ConnectorEvent>, AppServerCommandError> {
    let mut output = AppServerTurnOutput::new(output_max_bytes);
    loop {
        if cancel.load(Ordering::Relaxed) {
            send_app_server_turn_interrupt(socket, *next_request_id, thread_id, turn_id);
            *next_request_id += 1;
            return Err(AppServerCommandError::Cancelled);
        }
        if Instant::now() >= deadline {
            send_app_server_turn_interrupt(socket, *next_request_id, thread_id, turn_id);
            *next_request_id += 1;
            return Err(AppServerCommandError::TimedOut(timeout_seconds));
        }
        configure_socket_timeout(
            socket,
            remaining_app_server_command_timeout(timeout, deadline),
        )
        .map_err(|error| AppServerCommandError::Other(error.to_string()))?;
        match socket.read() {
            Ok(Message::Text(text)) => {
                let value = serde_json::from_str::<Value>(text.as_ref())
                    .map_err(|error| AppServerCommandError::Other(error.to_string()))?;
                if let Some(events) = handle_app_server_turn_message(
                    socket,
                    &value,
                    thread_id,
                    turn_id,
                    command_id,
                    &mut output,
                    deadline,
                    timeout_seconds,
                    cancel,
                    channels,
                )? {
                    return Ok(events);
                }
            }
            Ok(Message::Close(_)) => {
                return Err(AppServerCommandError::Other(
                    "app-server closed before turn completed".to_owned(),
                ));
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if error.kind() == ErrorKind::WouldBlock || error.kind() == ErrorKind::TimedOut => {
            }
            Err(error) => return Err(AppServerCommandError::Other(error.to_string())),
        }
    }
}

fn send_app_server_turn_interrupt(
    socket: &mut AppServerSocket,
    id: i64,
    thread_id: &str,
    turn_id: &str,
) {
    let _ = socket.send(Message::Text(
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "turn/interrupt",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id
            }
        })
        .to_string()
        .into(),
    ));
}

fn handle_app_server_turn_message(
    socket: &mut AppServerSocket,
    value: &Value,
    thread_id: &str,
    turn_id: &str,
    command_id: &str,
    output: &mut AppServerTurnOutput,
    deadline: Instant,
    timeout_seconds: u64,
    cancel: &AtomicBool,
    channels: Option<&AppServerCommandChannels>,
) -> Result<Option<Vec<ConnectorEvent>>, AppServerCommandError> {
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return Ok(None);
    };
    let params = value.get("params").unwrap_or(&Value::Null);
    if let Some(request_id) = value.get("id").and_then(Value::as_i64)
        && handle_app_server_turn_request(
            socket,
            request_id,
            method,
            params,
            thread_id,
            turn_id,
            command_id,
            deadline,
            timeout_seconds,
            cancel,
            channels,
        )?
    {
        return Ok(None);
    }
    match method {
        "item/agentMessage/delta" if notification_matches(params, thread_id, turn_id) => {
            if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                output.push_agent_message_delta(delta);
            }
        }
        "turn/completed" if turn_completed_notification_matches(params, thread_id, turn_id) => {
            let turn = params.get("turn").ok_or_else(|| {
                AppServerCommandError::Other(
                    "app-server turn/completed notification did not include turn".to_owned(),
                )
            })?;
            return Ok(Some(app_server_command_events_from_turn(
                turn,
                Some(output),
            )));
        }
        "error" if notification_matches(params, thread_id, turn_id) => {
            let will_retry = params
                .get("willRetry")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !will_retry {
                return Err(AppServerCommandError::Other(format!(
                    "app-server reported a turn error: {}",
                    app_server_turn_error_message(params.get("error"))
                )));
            }
        }
        _ => {}
    }
    Ok(None)
}

fn handle_app_server_turn_request(
    socket: &mut AppServerSocket,
    request_id: i64,
    method: &str,
    params: &Value,
    thread_id: &str,
    turn_id: &str,
    command_id: &str,
    deadline: Instant,
    timeout_seconds: u64,
    cancel: &AtomicBool,
    channels: Option<&AppServerCommandChannels>,
) -> Result<bool, AppServerCommandError> {
    if !app_server_turn_request_method(method) || !notification_matches(params, thread_id, turn_id)
    {
        return Ok(false);
    }
    let Some(channels) = channels else {
        return Err(AppServerCommandError::Other(
            "app-server requested user interaction, but the connector interaction channel is unavailable"
                .to_owned(),
        ));
    };
    let event = turn_interaction_event(method, request_id, params)?;
    let interaction_id = event
        .payload
        .as_ref()
        .and_then(|payload| payload.get("interaction_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppServerCommandError::Other(
                "turn interaction event did not include interaction_id".to_owned(),
            )
        })?
        .to_owned();
    let request_payload = event.payload.clone();
    channels.event_sender.send(event).map_err(|_| {
        AppServerCommandError::Other("turn interaction event channel closed".to_owned())
    })?;
    let response = receive_turn_interaction_response(
        &channels.interaction_receiver,
        command_id,
        &interaction_id,
        deadline,
        timeout_seconds,
        cancel,
        auto_resolution_deadline(method, params),
    )?;
    if response.auto_resolved {
        let event = turn_interaction_resolution_event(&response, request_payload.as_ref())?;
        channels.event_sender.send(event).map_err(|_| {
            AppServerCommandError::Other(
                "turn interaction resolution event channel closed".to_owned(),
            )
        })?;
    }
    let result = app_server_turn_interaction_result(method, params, &response.response)?;
    socket
        .send(Message::Text(
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": result
            })
            .to_string()
            .into(),
        ))
        .map_err(|error| AppServerCommandError::Other(error.to_string()))?;
    Ok(true)
}

fn app_server_turn_request_method(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "item/tool/requestUserInput"
    )
}

fn turn_interaction_event(
    method: &str,
    request_id: i64,
    params: &Value,
) -> Result<ConnectorEvent, AppServerCommandError> {
    match method {
        "item/commandExecution/requestApproval" => {
            let command = params
                .get("command")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(ToOwned::to_owned);
            let cwd = params
                .get("cwd")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let title = "Approve command execution";
            Ok(ConnectorEvent {
                kind: "approval.requested".to_owned(),
                priority: "P0".to_owned(),
                summary: match command.as_deref() {
                    Some(command) => format!("Approval requested for command: {command}"),
                    None => "Approval requested for command execution.".to_owned(),
                },
                payload: Some(turn_interaction_payload(
                    method,
                    request_id,
                    params,
                    "approval",
                    Some("command_execution"),
                    title,
                    params.get("reason").and_then(Value::as_str),
                    command,
                    cwd,
                    None,
                    None,
                    None,
                )?),
            })
        }
        "item/fileChange/requestApproval" => {
            let grant_root = params
                .get("grantRoot")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let title = "Approve file change";
            Ok(ConnectorEvent {
                kind: "approval.requested".to_owned(),
                priority: "P0".to_owned(),
                summary: match grant_root.as_deref() {
                    Some(root) => format!("Approval requested for file changes under {root}."),
                    None => "Approval requested for file changes.".to_owned(),
                },
                payload: Some(turn_interaction_payload(
                    method,
                    request_id,
                    params,
                    "approval",
                    Some("file_change"),
                    title,
                    params.get("reason").and_then(Value::as_str),
                    None,
                    None,
                    grant_root,
                    None,
                    None,
                )?),
            })
        }
        "item/permissions/requestApproval" => {
            let cwd = params
                .get("cwd")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let title = "Approve permissions";
            Ok(ConnectorEvent {
                kind: "approval.requested".to_owned(),
                priority: "P0".to_owned(),
                summary: "Approval requested for app-server permissions.".to_owned(),
                payload: Some(turn_interaction_payload(
                    method,
                    request_id,
                    params,
                    "approval",
                    Some("permissions"),
                    title,
                    params.get("reason").and_then(Value::as_str),
                    None,
                    cwd,
                    None,
                    None,
                    None,
                )?),
            })
        }
        "item/tool/requestUserInput" => {
            let questions = params
                .get("questions")
                .and_then(Value::as_array)
                .map(|questions| {
                    questions
                        .iter()
                        .filter_map(turn_interaction_question)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let title = "Provide requested input";
            Ok(ConnectorEvent {
                kind: "input.requested".to_owned(),
                priority: "P0".to_owned(),
                summary: format!(
                    "Codex requested {} input {}.",
                    questions.len(),
                    if questions.len() == 1 {
                        "answer"
                    } else {
                        "answers"
                    }
                ),
                payload: Some(turn_interaction_payload(
                    method,
                    request_id,
                    params,
                    "input",
                    None,
                    title,
                    None,
                    None,
                    None,
                    None,
                    Some(questions),
                    params.get("autoResolutionMs").and_then(Value::as_u64),
                )?),
            })
        }
        _ => Err(AppServerCommandError::Other(format!(
            "unsupported app-server interaction method: {method}"
        ))),
    }
}

#[allow(clippy::too_many_arguments)]
fn turn_interaction_payload(
    method: &str,
    request_id: i64,
    params: &Value,
    request_kind: &str,
    subject: Option<&str>,
    title: &str,
    detail: Option<&str>,
    command: Option<String>,
    cwd: Option<String>,
    grant_root: Option<String>,
    questions: Option<Vec<Value>>,
    auto_resolution_ms: Option<u64>,
) -> Result<Value, AppServerCommandError> {
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppServerCommandError::Other(
                "app-server interaction request did not include threadId".to_owned(),
            )
        })?;
    let turn_id = params
        .get("turnId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppServerCommandError::Other(
                "app-server interaction request did not include turnId".to_owned(),
            )
        })?;
    let interaction_id = turn_interaction_id(method, request_id, params);
    let mut payload = serde_json::Map::new();
    payload.insert("type".to_owned(), json!("turn_interaction"));
    payload.insert("interaction_id".to_owned(), json!(interaction_id));
    payload.insert("status".to_owned(), json!("pending"));
    payload.insert("method".to_owned(), json!(method));
    payload.insert("request_kind".to_owned(), json!(request_kind));
    if let Some(subject) = subject {
        payload.insert("subject".to_owned(), json!(subject));
    }
    payload.insert("app_server_thread_id".to_owned(), json!(thread_id));
    payload.insert("app_server_turn_id".to_owned(), json!(turn_id));
    if let Some(item_id) = params.get("itemId").and_then(Value::as_str) {
        payload.insert("app_server_item_id".to_owned(), json!(item_id));
    }
    payload.insert("title".to_owned(), json!(title));
    if let Some(detail) = detail.filter(|value| !value.trim().is_empty()) {
        payload.insert("detail".to_owned(), json!(detail));
    }
    if let Some(command) = command.filter(|value| !value.trim().is_empty()) {
        payload.insert("command".to_owned(), json!(command));
    }
    if let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) {
        payload.insert("cwd".to_owned(), json!(cwd));
    }
    if let Some(grant_root) = grant_root.filter(|value| !value.trim().is_empty()) {
        payload.insert("grant_root".to_owned(), json!(grant_root));
    }
    if let Some(requested_permissions) = requested_permissions_from_request(params) {
        payload.insert("requested_permissions".to_owned(), requested_permissions);
    }
    if let Some(questions) = questions.filter(|value| !value.is_empty()) {
        payload.insert("questions".to_owned(), Value::Array(questions));
    }
    if let Some(auto_resolution_ms) = auto_resolution_ms {
        payload.insert("auto_resolution_ms".to_owned(), json!(auto_resolution_ms));
    }
    Ok(Value::Object(payload))
}

fn turn_interaction_id(method: &str, request_id: i64, params: &Value) -> String {
    params
        .get("approvalId")
        .and_then(Value::as_str)
        .or_else(|| params.get("itemId").and_then(Value::as_str))
        .map(|value| format!("{method}:{value}:{request_id}"))
        .unwrap_or_else(|| format!("{method}:{request_id}"))
}

fn turn_interaction_question(value: &Value) -> Option<Value> {
    let id = value.get("id").and_then(Value::as_str)?;
    let header = value.get("header").and_then(Value::as_str)?;
    let question = value.get("question").and_then(Value::as_str)?;
    let mut item = serde_json::Map::new();
    item.insert("id".to_owned(), json!(id));
    item.insert("header".to_owned(), json!(header));
    item.insert("question".to_owned(), json!(question));
    item.insert(
        "is_other".to_owned(),
        json!(
            value
                .get("isOther")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        ),
    );
    item.insert(
        "is_secret".to_owned(),
        json!(
            value
                .get("isSecret")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        ),
    );
    if let Some(options) = value.get("options").and_then(Value::as_array) {
        let mapped = options
            .iter()
            .filter_map(|option| {
                let label = option.get("label").and_then(Value::as_str)?;
                let description = option.get("description").and_then(Value::as_str)?;
                Some(json!({
                    "label": label,
                    "description": description
                }))
            })
            .collect::<Vec<_>>();
        if !mapped.is_empty() {
            item.insert("options".to_owned(), Value::Array(mapped));
        }
    }
    Some(Value::Object(item))
}

fn receive_turn_interaction_response(
    receiver: &Receiver<TurnInteractionResponseDispatch>,
    command_id: &str,
    interaction_id: &str,
    deadline: Instant,
    timeout_seconds: u64,
    cancel: &AtomicBool,
    auto_resolution_deadline: Option<Instant>,
) -> Result<TurnInteractionResponseDispatch, AppServerCommandError> {
    loop {
        ensure_app_server_command_budget(deadline, timeout_seconds, cancel)?;
        let now = Instant::now();
        if auto_resolution_deadline.is_some_and(|auto_deadline| now >= auto_deadline) {
            return Ok(auto_resolved_input_response(command_id, interaction_id));
        }
        let remaining = deadline.saturating_duration_since(now);
        let mut wait = remaining.min(Duration::from_millis(100));
        if let Some(auto_deadline) = auto_resolution_deadline {
            wait = wait.min(auto_deadline.saturating_duration_since(now));
        }
        match receiver.recv_timeout(wait) {
            Ok(dispatch)
                if dispatch.command_id == command_id
                    && dispatch.interaction_id == interaction_id =>
            {
                return Ok(dispatch);
            }
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Err(AppServerCommandError::Other(
                    "turn interaction response channel closed".to_owned(),
                ));
            }
        }
    }
}

fn auto_resolution_deadline(method: &str, params: &Value) -> Option<Instant> {
    if method != "item/tool/requestUserInput" {
        return None;
    }
    params
        .get("autoResolutionMs")
        .and_then(Value::as_u64)
        .map(|ms| Instant::now() + Duration::from_millis(ms))
}

fn auto_resolved_input_response(
    command_id: &str,
    interaction_id: &str,
) -> TurnInteractionResponseDispatch {
    TurnInteractionResponseDispatch {
        command_id: command_id.to_owned(),
        interaction_id: interaction_id.to_owned(),
        response: TurnInteractionResponse::Input {
            answers: HashMap::new(),
        },
        auto_resolved: true,
    }
}

fn turn_interaction_resolution_event(
    dispatch: &TurnInteractionResponseDispatch,
    request_payload: Option<&Value>,
) -> Result<ConnectorEvent, AppServerCommandError> {
    let request_payload = request_payload.ok_or_else(|| {
        AppServerCommandError::Other(
            "turn interaction resolution did not include request payload".to_owned(),
        )
    })?;
    let title = request_payload
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("requested interaction");
    match &dispatch.response {
        TurnInteractionResponse::Input { answers } => Ok(ConnectorEvent {
            kind: "input.received".to_owned(),
            priority: "P1".to_owned(),
            summary: format!("Input auto-resolved for {title}."),
            payload: Some(json!({
                "type": "turn_interaction_resolution",
                "interaction_id": dispatch.interaction_id,
                "status": "answered",
                "answer_count": answers.len()
            })),
        }),
        TurnInteractionResponse::Approval { decision } => {
            let status = match decision.as_str() {
                "accept" => "accepted",
                "acceptForSession" => "accepted_for_session",
                "decline" => "declined",
                "cancel" => "cancelled",
                _ => "cancelled",
            };
            Ok(ConnectorEvent {
                kind: "approval.resolved".to_owned(),
                priority: "P1".to_owned(),
                summary: format!("Approval {} for {title}.", status.replace('_', " ")),
                payload: Some(json!({
                    "type": "turn_interaction_resolution",
                    "interaction_id": dispatch.interaction_id,
                    "status": status,
                    "decision": decision
                })),
            })
        }
    }
}

fn app_server_turn_interaction_result(
    method: &str,
    params: &Value,
    response: &TurnInteractionResponse,
) -> Result<Value, AppServerCommandError> {
    match (method, response) {
        (
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval",
            TurnInteractionResponse::Approval { decision },
        ) => Ok(json!({ "decision": decision })),
        ("item/permissions/requestApproval", TurnInteractionResponse::Approval { decision }) => {
            let permissions = if decision == "accept" || decision == "acceptForSession" {
                granted_permissions_from_request(params)
            } else {
                json!({})
            };
            let scope = if decision == "acceptForSession" {
                "session"
            } else {
                "turn"
            };
            Ok(json!({
                "permissions": permissions,
                "scope": scope
            }))
        }
        ("item/tool/requestUserInput", TurnInteractionResponse::Input { answers }) => Ok(json!({
            "answers": answers
        })),
        ("item/tool/requestUserInput", TurnInteractionResponse::Approval { .. }) => Err(
            AppServerCommandError::Other("input request received an approval response".to_owned()),
        ),
        (_, TurnInteractionResponse::Input { .. }) => Err(AppServerCommandError::Other(
            "approval request received an input response".to_owned(),
        )),
        _ => Err(AppServerCommandError::Other(format!(
            "unsupported app-server interaction method: {method}"
        ))),
    }
}

fn granted_permissions_from_request(params: &Value) -> Value {
    let Some(requested) = params.get("permissions") else {
        return json!({});
    };
    let mut granted = serde_json::Map::new();
    if let Some(network) = requested.get("network").filter(|value| !value.is_null()) {
        granted.insert("network".to_owned(), network.clone());
    }
    if let Some(file_system) = requested.get("fileSystem").filter(|value| !value.is_null()) {
        granted.insert("fileSystem".to_owned(), file_system.clone());
    }
    Value::Object(granted)
}

fn requested_permissions_from_request(params: &Value) -> Option<Value> {
    let requested = params.get("permissions")?;
    let mut permissions = serde_json::Map::new();
    if let Some(network) = requested.get("network").filter(|value| !value.is_null()) {
        permissions.insert("network".to_owned(), network.clone());
    }
    if let Some(file_system) = requested.get("fileSystem").filter(|value| !value.is_null()) {
        permissions.insert("fileSystem".to_owned(), file_system.clone());
    }
    if permissions.is_empty() {
        None
    } else {
        Some(Value::Object(permissions))
    }
}

fn notification_matches(params: &Value, thread_id: &str, turn_id: &str) -> bool {
    params.get("threadId").and_then(Value::as_str) == Some(thread_id)
        && params.get("turnId").and_then(Value::as_str) == Some(turn_id)
}

fn turn_completed_notification_matches(params: &Value, thread_id: &str, turn_id: &str) -> bool {
    params.get("threadId").and_then(Value::as_str) == Some(thread_id)
        && params
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            == Some(turn_id)
}

fn app_server_command_events_from_turn(
    turn: &Value,
    fallback: Option<&AppServerTurnOutput>,
) -> Vec<ConnectorEvent> {
    let mut events = Vec::new();
    let agent_message = last_agent_message_from_turn(turn).or_else(|| {
        fallback.and_then(|output| compact_command_summary(&output.agent_message, 700))
    });
    if let Some(message) = agent_message {
        events.push(ConnectorEvent {
            kind: "command.output".to_owned(),
            priority: "P2".to_owned(),
            summary: format!("Codex: {message}"),
            payload: None,
        });
    } else if turn_status(turn) == Some("completed") {
        events.push(ConnectorEvent {
            kind: "command.output".to_owned(),
            priority: "P2".to_owned(),
            summary: "Codex app-server turn completed without an assistant message.".to_owned(),
            payload: None,
        });
    }

    match turn_status(turn) {
        Some("completed") => events.push(ConnectorEvent {
            kind: "command.finished".to_owned(),
            priority: "P1".to_owned(),
            summary: "Codex app-server turn completed successfully.".to_owned(),
            payload: None,
        }),
        Some("interrupted") => events.push(ConnectorEvent {
            kind: "command.failed".to_owned(),
            priority: "P1".to_owned(),
            summary: "Codex app-server turn was interrupted.".to_owned(),
            payload: None,
        }),
        Some("failed") => events.push(ConnectorEvent {
            kind: "command.failed".to_owned(),
            priority: "P1".to_owned(),
            summary: format!(
                "Codex app-server turn failed: {}",
                app_server_turn_error_message(turn.get("error"))
            ),
            payload: None,
        }),
        _ => events.push(ConnectorEvent {
            kind: "command.failed".to_owned(),
            priority: "P1".to_owned(),
            summary: "Codex app-server turn ended with an unknown status.".to_owned(),
            payload: None,
        }),
    }
    events
}

fn response_thread_id(value: &Value) -> Option<String> {
    value
        .get("result")
        .and_then(|result| result.get("thread"))
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn turn_id_from_start_response(value: &Value) -> Option<&str> {
    value
        .get("result")
        .and_then(|result| result.get("turn"))
        .and_then(|turn| turn.get("id"))
        .and_then(Value::as_str)
}

fn app_server_command_cwd(config: &AgentConfig, cwd: Option<&str>) -> String {
    cwd.filter(|value| Path::new(value).is_absolute())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| config.workspace_root.to_string_lossy().into_owned())
}

fn turn_is_terminal(turn: &Value) -> bool {
    matches!(
        turn_status(turn),
        Some("completed") | Some("failed") | Some("interrupted")
    )
}

fn turn_status(turn: &Value) -> Option<&str> {
    turn.get("status").and_then(Value::as_str)
}

fn last_agent_message_from_turn(turn: &Value) -> Option<String> {
    turn.get("items")
        .and_then(Value::as_array)?
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("agentMessage"))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .filter_map(|text| compact_command_summary(text, 700))
        .last()
}

fn app_server_turn_error_message(error: Option<&Value>) -> String {
    error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .and_then(|message| compact_command_summary(message, 500))
        .unwrap_or_else(|| "unknown error".to_owned())
}

fn compact_command_summary(value: &str, max_chars: usize) -> Option<String> {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return None;
    }
    if compact.chars().count() <= max_chars {
        return Some(compact);
    }
    let mut truncated = compact.chars().take(max_chars).collect::<String>();
    truncated.push_str("...");
    Some(truncated)
}

struct AppServerTurnOutput {
    agent_message: String,
    agent_message_max_bytes: usize,
}

impl AppServerTurnOutput {
    fn new(agent_message_max_bytes: usize) -> Self {
        Self {
            agent_message: String::new(),
            agent_message_max_bytes,
        }
    }

    fn push_agent_message_delta(&mut self, delta: &str) {
        let remaining = self
            .agent_message_max_bytes
            .saturating_sub(self.agent_message.len());
        if remaining == 0 {
            return;
        }

        let mut end = 0;
        for (index, value) in delta.char_indices() {
            let next_end = index + value.len_utf8();
            if next_end > remaining {
                break;
            }
            end = next_end;
        }
        if end > 0 {
            self.agent_message.push_str(&delta[..end]);
        }
    }
}

fn ensure_app_server_command_budget(
    deadline: Instant,
    timeout_seconds: u64,
    cancel: &AtomicBool,
) -> Result<(), AppServerCommandError> {
    if let Some(error) = app_server_command_interruption(deadline, timeout_seconds, cancel) {
        return Err(error);
    }
    Ok(())
}

fn app_server_command_interruption(
    deadline: Instant,
    timeout_seconds: u64,
    cancel: &AtomicBool,
) -> Option<AppServerCommandError> {
    if cancel.load(Ordering::Relaxed) {
        return Some(AppServerCommandError::Cancelled);
    }
    if Instant::now() >= deadline {
        return Some(AppServerCommandError::TimedOut(timeout_seconds));
    }
    None
}

fn app_server_command_socket_timeout(
    app_server_timeout_seconds: u64,
    command_timeout_seconds: u64,
) -> Duration {
    Duration::from_secs(
        app_server_timeout_seconds
            .max(1)
            .min(command_timeout_seconds)
            .min(5),
    )
}

fn remaining_app_server_command_timeout(timeout: Duration, deadline: Instant) -> Duration {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Duration::from_millis(1);
    }
    remaining.min(timeout).max(Duration::from_millis(1))
}

#[cfg(test)]
fn set_app_server_thread_archived_at(
    url: &str,
    thread_id: &str,
    archived: bool,
    timeout_seconds: u64,
) -> Result<bool, Box<dyn std::error::Error>> {
    set_app_server_thread_archived_at_with_rollout_lookup(
        url,
        thread_id,
        archived,
        None,
        timeout_seconds,
    )
}

fn set_app_server_thread_archived_at_with_rollout_lookup(
    url: &str,
    thread_id: &str,
    archived: bool,
    rollout_lookup: Option<(&Path, usize)>,
    timeout_seconds: u64,
) -> Result<bool, Box<dyn std::error::Error>> {
    let deadline = Instant::now() + Duration::from_secs(APP_SERVER_ARCHIVE_SYNC_DEADLINE_SECONDS);
    let timeout = app_server_archive_socket_timeout(timeout_seconds);
    let mut socket =
        connect_app_server(url, remaining_app_server_archive_timeout(timeout, deadline))?;
    initialize_app_server_connection_before_deadline(&mut socket, timeout, deadline)?;
    let mut request_id = 1;
    let Some(resolution) = resolve_app_server_thread_ids_for_archive(
        &mut socket,
        thread_id,
        archived,
        &mut request_id,
        timeout,
        deadline,
    )?
    else {
        let Some(resolved_thread_id) = resume_app_server_thread_from_rollout_path_for_archive(
            &mut socket,
            thread_id,
            rollout_lookup,
            &mut request_id,
            timeout,
            deadline,
        )?
        else {
            return Ok(false);
        };
        let method = if archived {
            "thread/archive"
        } else {
            "thread/unarchive"
        };
        ensure_app_server_local_budget(deadline)?;
        let _ = send_app_server_request_before_deadline(
            &mut socket,
            request_id,
            method,
            serde_json::json!({
                "threadId": resolved_thread_id
            }),
            timeout,
            deadline,
        )?;
        return Ok(true);
    };
    let method = if archived {
        "thread/archive"
    } else {
        "thread/unarchive"
    };
    let AppServerArchiveResolution::NeedsUpdate(resolved_thread_ids) = resolution else {
        return Ok(true);
    };
    for resolved_thread_id in resolved_thread_ids {
        ensure_app_server_local_budget(deadline)?;
        let _ = send_app_server_request_before_deadline(
            &mut socket,
            request_id,
            method,
            serde_json::json!({
                "threadId": resolved_thread_id
            }),
            timeout,
            deadline,
        )?;
        request_id += 1;
    }
    Ok(true)
}

fn resume_app_server_thread_from_rollout_path_for_archive(
    socket: &mut AppServerSocket,
    thread_id: &str,
    rollout_lookup: Option<(&Path, usize)>,
    next_request_id: &mut i64,
    timeout: Duration,
    deadline: Instant,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let Some((codex_home, max_sessions)) = rollout_lookup else {
        return Ok(None);
    };
    let Some(rollout_path) = find_rollout_path(codex_home, thread_id, max_sessions)? else {
        return Ok(None);
    };
    let mut params = serde_json::json!({
        "threadId": thread_id,
        "path": rollout_path.to_string_lossy(),
        "excludeTurns": true
    });
    if let Some(cwd) = rollout_resume_cwd(&rollout_path, thread_id)? {
        params["cwd"] = serde_json::json!(cwd.clone());
        params["runtimeWorkspaceRoots"] = serde_json::json!([cwd]);
    }
    let response = send_app_server_request_before_deadline(
        socket,
        *next_request_id,
        "thread/resume",
        params,
        timeout,
        deadline,
    )?;
    *next_request_id += 1;
    let resumed = app_server_thread_from_response(&response)?;
    if resumed.session_id != thread_id {
        return Err(format!(
            "app-server thread/resume returned session {} while syncing archive for session {thread_id}",
            resumed.session_id
        )
        .into());
    }
    Ok(Some(resumed.id))
}

fn resolve_app_server_thread_ids_for_archive(
    socket: &mut AppServerSocket,
    thread_id: &str,
    archived: bool,
    next_request_id: &mut i64,
    timeout: Duration,
    deadline: Instant,
) -> Result<Option<AppServerArchiveResolution>, Box<dyn std::error::Error>> {
    let source_scan = find_app_server_thread_ids_in_pages(
        socket,
        thread_id,
        Some(!archived),
        next_request_id,
        timeout,
        deadline,
    )?;
    let source_scan_exhausted = matches!(source_scan, AppServerArchivePageScan::Exhausted { .. });
    match source_scan {
        AppServerArchivePageScan::Complete(scan) if !scan.thread_ids.is_empty() => {
            return Ok(Some(AppServerArchiveResolution::NeedsUpdate(
                scan.thread_ids,
            )));
        }
        AppServerArchivePageScan::Exhausted { session_thread_ids }
            if !session_thread_ids.is_empty() =>
        {
            return Err(
                "app-server archive sync exceeded page budget while resolving a session tree"
                    .into(),
            );
        }
        AppServerArchivePageScan::Complete(_) | AppServerArchivePageScan::Exhausted { .. } => {}
    }
    match find_app_server_thread_ids_in_pages(
        socket,
        thread_id,
        Some(archived),
        next_request_id,
        timeout,
        deadline,
    )? {
        AppServerArchivePageScan::Complete(scan) if !scan.thread_ids.is_empty() => {
            if source_scan_exhausted && !scan.matched_exact_thread {
                return Err(
                    "app-server archive sync exceeded page budget before resolving session tree state"
                        .into(),
                );
            }
            return Ok(Some(AppServerArchiveResolution::AlreadySynced));
        }
        AppServerArchivePageScan::Exhausted { session_thread_ids }
            if !session_thread_ids.is_empty() =>
        {
            if source_scan_exhausted {
                return Err(
                    "app-server archive sync exceeded page budget before resolving session tree state"
                        .into(),
                );
            }
            return Ok(Some(AppServerArchiveResolution::AlreadySynced));
        }
        AppServerArchivePageScan::Exhausted { .. } => {
            return Err(
                "app-server archive sync exceeded page budget before resolving thread state".into(),
            );
        }
        AppServerArchivePageScan::Complete(_) => {}
    }
    if source_scan_exhausted {
        return Err(
            "app-server archive sync exceeded page budget before resolving thread state".into(),
        );
    }
    Ok(None)
}

fn find_app_server_thread_ids_in_pages(
    socket: &mut AppServerSocket,
    thread_id: &str,
    archived_filter: Option<bool>,
    next_request_id: &mut i64,
    timeout: Duration,
    deadline: Instant,
) -> Result<AppServerArchivePageScan, Box<dyn std::error::Error>> {
    let mut seen_threads = HashSet::new();
    let mut seen_match_thread_ids = HashSet::new();
    let mut session_thread_ids = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();
    for _ in 0..APP_SERVER_ARCHIVE_SYNC_MAX_PAGES_PER_STATE {
        ensure_app_server_local_budget(deadline)?;
        let response = send_app_server_thread_list_request(
            socket,
            *next_request_id,
            APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE,
            cursor.as_deref(),
            archived_filter,
            timeout,
            deadline,
        )?;
        *next_request_id += 1;

        let matches = app_server_archive_thread_ids_from_response(&response, thread_id);
        if let Some(exact_thread_id) = matches.exact_thread_id {
            return Ok(AppServerArchivePageScan::Complete(
                AppServerArchiveCompletePageScan {
                    thread_ids: vec![exact_thread_id],
                    matched_exact_thread: true,
                },
            ));
        }
        for session_thread_id in matches.session_thread_ids {
            if seen_match_thread_ids.insert(session_thread_id.clone()) {
                session_thread_ids.push(session_thread_id);
            }
        }

        let page_len = app_server_thread_list_data(&response)
            .map(std::vec::Vec::len)
            .unwrap_or(0);
        let page_keys = app_server_thread_identity_keys_from_response(&response);
        let new_key_count = page_keys
            .into_iter()
            .filter(|key| seen_threads.insert(key.to_owned()))
            .count();
        let next_cursor = app_server_thread_list_next_cursor(&response);
        if next_cursor.is_none() || page_len == 0 || new_key_count == 0 {
            return Ok(AppServerArchivePageScan::Complete(
                AppServerArchiveCompletePageScan {
                    thread_ids: session_thread_ids,
                    matched_exact_thread: false,
                },
            ));
        }
        let next_cursor = next_cursor.expect("checked above");
        if !seen_cursors.insert(next_cursor.clone()) {
            return Ok(AppServerArchivePageScan::Complete(
                AppServerArchiveCompletePageScan {
                    thread_ids: session_thread_ids,
                    matched_exact_thread: false,
                },
            ));
        }
        cursor = Some(next_cursor);
    }
    Ok(AppServerArchivePageScan::Exhausted { session_thread_ids })
}

fn ensure_app_server_local_budget(deadline: Instant) -> Result<(), Box<dyn std::error::Error>> {
    if Instant::now() >= deadline {
        return Err("app-server request exceeded local time budget".into());
    }
    Ok(())
}

fn app_server_archive_socket_timeout(timeout_seconds: u64) -> Duration {
    Duration::from_secs(
        timeout_seconds
            .max(1)
            .min(APP_SERVER_ARCHIVE_SYNC_DEADLINE_SECONDS),
    )
}

fn ensure_app_server_host_session_at(
    url: &str,
    session_id: &str,
    title: Option<&str>,
    cwd: &str,
    rollout_path: Option<&Path>,
    rollout_lookup: Option<(&Path, usize)>,
    timeout_seconds: u64,
) -> Result<AgentHostSession, Box<dyn std::error::Error>> {
    let timeout = Duration::from_secs(timeout_seconds.max(1));
    let mut socket = connect_app_server(url, timeout)?;
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds.max(1));
    initialize_app_server_connection_before_deadline(&mut socket, timeout, deadline)?;
    let mut request_id = 1;
    let can_resume_from_rollout = rollout_path.is_some() || rollout_lookup.is_some();
    let resolved_thread = resolve_app_server_thread_for_ensure(
        &mut socket,
        session_id,
        &mut request_id,
        timeout,
        deadline,
        can_resume_from_rollout,
    )?;
    let resume_params = if let Some(resolved_thread) = resolved_thread {
        let thread_id = resolved_thread.thread_id;
        if resolved_thread.archived {
            let _ = send_app_server_request_before_deadline(
                &mut socket,
                request_id,
                "thread/unarchive",
                serde_json::json!({
                    "threadId": thread_id.clone()
                }),
                timeout,
                deadline,
            )?;
            request_id += 1;
        }
        serde_json::json!({
            "threadId": thread_id,
            "cwd": cwd,
            "runtimeWorkspaceRoots": [cwd],
            "excludeTurns": true
        })
    } else {
        let rollout_path = if let Some(rollout_path) = rollout_path {
            Some(rollout_path.to_path_buf())
        } else if let Some((codex_home, max_sessions)) = rollout_lookup {
            find_rollout_path(codex_home, session_id, max_sessions)?
        } else {
            None
        };
        let Some(rollout_path) = rollout_path else {
            return Err(format!(
                "app-server host session attach could not find local rollout for session {session_id}"
            )
            .into());
        };
        let resume_cwd =
            rollout_resume_cwd(&rollout_path, session_id)?.unwrap_or_else(|| cwd.to_owned());
        serde_json::json!({
            "threadId": session_id,
            "path": rollout_path.to_string_lossy(),
            "cwd": resume_cwd.clone(),
            "runtimeWorkspaceRoots": [resume_cwd],
            "excludeTurns": true
        })
    };
    let response = send_app_server_request_before_deadline(
        &mut socket,
        request_id,
        "thread/resume",
        resume_params,
        timeout,
        deadline,
    )?;
    let resumed = app_server_thread_from_response(&response)?;
    if resumed.session_id != session_id {
        return Err(format!(
            "app-server thread/resume returned session {} while attaching session {session_id}",
            resumed.session_id
        )
        .into());
    }
    let cwd = resumed.cwd.or_else(|| Some(cwd.to_owned()));
    Ok(AgentHostSession {
        session_id: session_id.to_owned(),
        title: compact_title(resumed.name.as_deref())
            .or_else(|| compact_title(title))
            .unwrap_or_else(|| {
                fallback_title(&SessionDraft {
                    session_id: session_id.to_owned(),
                    cwd: cwd.clone(),
                    ..SessionDraft::default()
                })
            }),
        title_source: TitleSource::AppServer,
        app_server_present: true,
        cwd,
        updated_at: resumed.updated_at,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AppServerThreadForEnsure {
    thread_id: String,
    archived: bool,
}

fn resolve_app_server_thread_for_ensure(
    socket: &mut AppServerSocket,
    session_id: &str,
    next_request_id: &mut i64,
    timeout: Duration,
    deadline: Instant,
    allow_exhausted_miss: bool,
) -> Result<Option<AppServerThreadForEnsure>, Box<dyn std::error::Error>> {
    if let Some(thread_id) = scan_app_server_thread_id_for_ensure(
        socket,
        session_id,
        Some(false),
        next_request_id,
        timeout,
        deadline,
        allow_exhausted_miss,
    )? {
        return Ok(Some(AppServerThreadForEnsure {
            thread_id,
            archived: false,
        }));
    }
    Ok(scan_app_server_thread_id_for_ensure(
        socket,
        session_id,
        Some(true),
        next_request_id,
        timeout,
        deadline,
        allow_exhausted_miss,
    )?
    .map(|thread_id| AppServerThreadForEnsure {
        thread_id,
        archived: true,
    }))
}

fn scan_app_server_thread_id_for_ensure(
    socket: &mut AppServerSocket,
    session_id: &str,
    archived_filter: Option<bool>,
    next_request_id: &mut i64,
    timeout: Duration,
    deadline: Instant,
    allow_exhausted_miss: bool,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    match find_app_server_thread_ids_in_pages(
        socket,
        session_id,
        archived_filter,
        next_request_id,
        timeout,
        deadline,
    )? {
        AppServerArchivePageScan::Complete(scan) => Ok(scan.thread_ids.into_iter().next()),
        AppServerArchivePageScan::Exhausted { session_thread_ids } => {
            if let Some(thread_id) = session_thread_ids.into_iter().next() {
                Ok(Some(thread_id))
            } else if allow_exhausted_miss {
                Ok(None)
            } else {
                Err(
                    "app-server host session attach exceeded page budget while resolving thread id"
                        .into(),
                )
            }
        }
    }
}

fn create_app_server_thread_at(
    url: &str,
    title: Option<&str>,
    cwd: &str,
    timeout_seconds: u64,
) -> Result<AgentHostSession, Box<dyn std::error::Error>> {
    let timeout = Duration::from_secs(timeout_seconds.max(1));
    let mut socket = connect_app_server(url, timeout)?;
    initialize_app_server_connection(&mut socket)?;
    let start_response = send_app_server_request(
        &mut socket,
        1,
        "thread/start",
        serde_json::json!({
            "cwd": cwd,
            "ephemeral": false,
            "threadSource": "user"
        }),
    )?;
    let started = app_server_thread_from_response(&start_response)?;
    let requested_title = compact_title(title);

    if let Some(title) = requested_title.as_deref() {
        let _ = send_app_server_request(
            &mut socket,
            2,
            "thread/name/set",
            serde_json::json!({
                "threadId": started.id,
                "name": title
            }),
        );
    }

    Ok(AgentHostSession {
        session_id: started.session_id.clone(),
        title: requested_title
            .or_else(|| compact_title(started.name.as_deref()))
            .unwrap_or_else(|| {
                fallback_title(&SessionDraft {
                    session_id: started.session_id.clone(),
                    cwd: started.cwd.clone(),
                    ..SessionDraft::default()
                })
            }),
        title_source: TitleSource::AppServer,
        app_server_present: true,
        cwd: started.cwd,
        updated_at: started.updated_at,
    })
}

fn initialize_app_server_connection_before_deadline(
    socket: &mut AppServerSocket,
    timeout: Duration,
    deadline: Instant,
) -> Result<(), Box<dyn std::error::Error>> {
    let _ = send_app_server_request_before_deadline(
        socket,
        0,
        "initialize",
        serde_json::json!({
            "clientInfo": {
                "name": "chaop-agent",
                "title": "Chaop connector",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": {
                "experimentalApi": true,
                "requestAttestation": false
            }
        }),
        timeout,
        deadline,
    )?;
    socket.send(Message::Text(
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": "initialized"
        })
        .to_string()
        .into(),
    ))?;
    Ok(())
}

fn initialize_app_server_connection(
    socket: &mut AppServerSocket,
) -> Result<(), Box<dyn std::error::Error>> {
    let _ = send_app_server_request(
        socket,
        0,
        "initialize",
        serde_json::json!({
            "clientInfo": {
                "name": "chaop-agent",
                "title": "Chaop connector",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": {
                "experimentalApi": true,
                "requestAttestation": false
            }
        }),
    )?;
    socket.send(Message::Text(
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": "initialized"
        })
        .to_string()
        .into(),
    ))?;
    Ok(())
}

fn send_app_server_request(
    socket: &mut AppServerSocket,
    id: i64,
    method: &str,
    params: Value,
) -> Result<Value, Box<dyn std::error::Error>> {
    send_app_server_request_inner(socket, id, method, params, None)
}

fn send_app_server_request_inner(
    socket: &mut AppServerSocket,
    id: i64,
    method: &str,
    params: Value,
    archive_budget: Option<(Duration, Instant)>,
) -> Result<Value, Box<dyn std::error::Error>> {
    socket.send(Message::Text(
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        })
        .to_string()
        .into(),
    ))?;

    loop {
        if let Some((timeout, deadline)) = archive_budget {
            ensure_app_server_local_budget(deadline)?;
            configure_socket_timeout(
                socket,
                remaining_app_server_archive_timeout(timeout, deadline),
            )?;
        }
        match socket.read() {
            Err(tungstenite::Error::Io(error))
                if archive_budget.is_some()
                    && matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) =>
            {
                return Err(
                    format!("app-server {method} timed out before matching response").into(),
                );
            }
            Err(error) => return Err(error.into()),
            Ok(Message::Text(text)) => {
                let value = serde_json::from_str::<Value>(text.as_ref())?;
                if value.get("id").and_then(Value::as_i64) != Some(id) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    return Err(app_server_error(method, error).into());
                }
                return Ok(value);
            }
            Ok(Message::Close(_)) => {
                return Err(format!("app-server closed before {method} completed").into());
            }
            Ok(_) => {}
        }
    }
}

fn send_app_server_request_before_deadline(
    socket: &mut AppServerSocket,
    id: i64,
    method: &str,
    params: Value,
    timeout: Duration,
    deadline: Instant,
) -> Result<Value, Box<dyn std::error::Error>> {
    ensure_app_server_local_budget(deadline)?;
    configure_socket_timeout(
        socket,
        remaining_app_server_archive_timeout(timeout, deadline),
    )?;
    send_app_server_request_inner(socket, id, method, params, Some((timeout, deadline)))
}

fn send_app_server_thread_list_request(
    socket: &mut AppServerSocket,
    id: i64,
    limit: usize,
    cursor: Option<&str>,
    archived_filter: Option<bool>,
    timeout: Duration,
    deadline: Instant,
) -> Result<Value, Box<dyn std::error::Error>> {
    send_app_server_request_before_deadline(
        socket,
        id,
        "thread/list",
        app_server_thread_list_params(limit, cursor, archived_filter),
        timeout,
        deadline,
    )
}

fn remaining_app_server_archive_timeout(timeout: Duration, deadline: Instant) -> Duration {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Duration::from_millis(1);
    }
    remaining.min(timeout).max(Duration::from_millis(1))
}

fn app_server_thread_list_params(
    limit: usize,
    cursor: Option<&str>,
    archived_filter: Option<bool>,
) -> Value {
    let mut params = serde_json::json!({
        "archived": archived_filter,
        "limit": limit,
        "sortKey": "updated_at",
        "sortDirection": "desc",
        "sourceKinds": APP_SERVER_THREAD_SOURCE_KINDS,
        "useStateDbOnly": true
    });
    if let Some(cursor) = cursor {
        params["cursor"] = serde_json::json!(cursor);
    }
    params
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AppServerThread {
    id: String,
    session_id: String,
    name: Option<String>,
    cwd: Option<String>,
    updated_at: String,
}

fn app_server_thread_from_response(
    value: &Value,
) -> Result<AppServerThread, Box<dyn std::error::Error>> {
    let thread = value
        .get("result")
        .and_then(|result| result.get("thread"))
        .ok_or("app-server thread/start response did not include result.thread")?;
    let id = thread
        .get("id")
        .and_then(Value::as_str)
        .ok_or("app-server thread/start response did not include thread.id")?;
    let session_id = app_server_thread_session_id(thread).unwrap_or(id);
    Ok(AppServerThread {
        id: id.to_owned(),
        session_id: session_id.to_owned(),
        name: thread
            .get("name")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        cwd: thread
            .get("cwd")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        updated_at: app_server_thread_timestamp(thread)
            .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned()),
    })
}

fn app_server_archive_thread_ids_from_response(
    value: &Value,
    requested_id: &str,
) -> AppServerArchivePageMatches {
    let mut matches = AppServerArchivePageMatches::default();
    let Some(threads) = app_server_thread_list_data(value) else {
        return matches;
    };
    for thread in threads {
        let thread_id = thread.get("id").and_then(Value::as_str);
        let session_id = thread.get("sessionId").and_then(Value::as_str);
        if thread_id == Some(requested_id) {
            let exact_thread_id = thread_id.expect("checked above");
            if session_id == Some(requested_id) {
                matches.session_thread_ids.push(exact_thread_id.to_owned());
                continue;
            }
            matches.exact_thread_id = Some(exact_thread_id.to_owned());
            break;
        }
        if session_id == Some(requested_id) {
            if let Some(thread_id) = thread_id {
                matches.session_thread_ids.push(thread_id.to_owned());
            }
        }
    }
    matches
}

fn app_server_thread_identity_keys_from_response(value: &Value) -> Vec<String> {
    app_server_thread_list_data(value)
        .map(|threads| {
            threads
                .iter()
                .filter_map(|thread| {
                    thread
                        .get("id")
                        .and_then(Value::as_str)
                        .or_else(|| thread.get("sessionId").and_then(Value::as_str))
                        .map(ToOwned::to_owned)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn app_server_thread_list_data(value: &Value) -> Option<&Vec<Value>> {
    value
        .get("result")
        .and_then(|result| result.get("data"))
        .and_then(Value::as_array)
}

fn app_server_thread_list_next_cursor(value: &Value) -> Option<String> {
    value
        .get("result")
        .and_then(|result| result.get("nextCursor"))
        .and_then(Value::as_str)
        .filter(|cursor| !cursor.trim().is_empty())
        .map(ToOwned::to_owned)
}

fn app_server_thread_timestamp(thread: &Value) -> Option<String> {
    ["updatedAt", "createdAt"]
        .into_iter()
        .find_map(|key| thread.get(key).and_then(value_to_unix_seconds))
        .and_then(unix_seconds_to_iso)
}

fn value_to_unix_seconds(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| {
            value
                .as_u64()
                .and_then(|seconds| i64::try_from(seconds).ok())
        })
        .or_else(|| value.as_f64().map(|seconds| seconds.floor() as i64))
}

fn app_server_error(method: &str, error: &Value) -> String {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown app-server error");
    format!("app-server {method} failed: {message}")
}

fn metadata_title(payload: &Value) -> Option<String> {
    ["title", "name", "thread_name"]
        .into_iter()
        .find_map(|key| payload.get(key).and_then(Value::as_str))
        .and_then(|value| compact_title(Some(value)))
}

fn compact_title(value: Option<&str>) -> Option<String> {
    let compact = value?.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return None;
    }
    let mut title = compact.chars().take(96).collect::<String>();
    if compact.chars().count() > 96 {
        title.push_str("...");
    }
    Some(title)
}

fn fallback_title(draft: &SessionDraft) -> String {
    if let Some(cwd) = draft.cwd.as_deref().and_then(|value| {
        Path::new(value)
            .file_name()
            .and_then(|name| name.to_str())
            .map(ToOwned::to_owned)
    }) {
        return format!("{cwd} ({})", short_session_id(&draft.session_id));
    }
    format!("Codex session {}", short_session_id(&draft.session_id))
}

fn short_session_id(session_id: &str) -> String {
    session_id.chars().take(8).collect()
}

fn first_non_empty(first: Option<String>, second: Option<String>) -> Option<String> {
    compact_title(first.as_deref()).or_else(|| compact_title(second.as_deref()))
}

fn first_non_empty_raw(first: Option<String>, second: Option<String>) -> Option<String> {
    first
        .filter(|value| !value.trim().is_empty())
        .or_else(|| second.filter(|value| !value.trim().is_empty()))
}

fn max_string(first: Option<String>, second: Option<String>) -> Option<String> {
    match (first, second) {
        (Some(first), Some(second)) => Some(if first > second { first } else { second }),
        (Some(first), None) => Some(first),
        (None, Some(second)) => Some(second),
        (None, None) => None,
    }
}

fn stable_hash(value: &str) -> String {
    let mut hash = 0x811c9dc5_u32;
    for byte in value.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("{hash:08x}")
}

fn default_codex_home() -> PathBuf {
    if let Ok(value) = std::env::var("CODEX_HOME") {
        return value.into();
    }
    std::env::var("HOME")
        .map(|home| PathBuf::from(home).join(".codex"))
        .unwrap_or_else(|_| PathBuf::from(".codex"))
}

#[cfg(test)]
mod tests {
    use super::{
        APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE, AppServerCommandChannels, AppServerTurnOutput,
        HistorySession, InventoryScope, SessionDraft, TitleSource, TurnInteractionInputAnswer,
        TurnInteractionResponse, TurnInteractionResponseDispatch,
        app_server_command_result_events_with_cancel, app_server_sessions_from_response,
        app_server_thread_from_response, app_server_titles_from_response,
        build_host_session_backfill, build_host_sessions_report, create_app_server_thread_at,
        ensure_app_server_host_session_at, load_app_server_sessions, read_recent_lines,
        remaining_app_server_archive_timeout, resolve_session, rollout_paths,
        set_app_server_thread_archived_at, set_app_server_thread_archived_at_with_rollout_lookup,
        unix_seconds_to_iso,
    };
    use crate::config::{AgentConfig, BootstrapConfig, ExecutionConfig, SessionInventoryConfig};
    use serde_json::{Value, json};
    use std::collections::HashMap;
    use std::fs;
    use std::net::{TcpListener, TcpStream};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
    };
    use std::thread;
    use std::time::{Duration, Instant};
    use tungstenite::{Message, accept};

    #[test]
    fn title_resolution_prefers_metadata_over_history() {
        let draft = SessionDraft {
            session_id: "session-1".to_owned(),
            metadata_title: Some("Metadata title".to_owned()),
            app_server_present: true,
            cwd: Some("/tmp/project".to_owned()),
            updated_at: Some("2026-06-11T10:00:00.000Z".to_owned()),
        };
        let mut history = HashMap::new();
        history.insert(
            "session-1".to_owned(),
            HistorySession {
                title: "History title".to_owned(),
                updated_at: Some("2026-06-11T09:00:00.000Z".to_owned()),
            },
        );

        let session = resolve_session(draft, Some("App title".to_owned()), &history);

        assert_eq!(session.title, "Metadata title");
        assert_eq!(session.title_source, TitleSource::Metadata);
        assert!(session.app_server_present);
    }

    #[test]
    fn title_resolution_uses_app_server_before_history() {
        let draft = SessionDraft {
            session_id: "session-1".to_owned(),
            metadata_title: None,
            app_server_present: true,
            cwd: Some("/tmp/project".to_owned()),
            updated_at: None,
        };
        let mut history = HashMap::new();
        history.insert(
            "session-1".to_owned(),
            HistorySession {
                title: "History title".to_owned(),
                updated_at: Some("2026-06-11T09:00:00.000Z".to_owned()),
            },
        );

        let session = resolve_session(draft, Some("App title".to_owned()), &history);

        assert_eq!(session.title, "App title");
        assert_eq!(session.title_source, TitleSource::AppServer);
        assert!(session.app_server_present);
    }

    #[test]
    fn parses_app_server_thread_names() {
        let response = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "data": [
                    { "id": "session-1", "name": "App server title" },
                    { "id": "session-2", "name": null }
                ]
            }
        });

        let titles = app_server_titles_from_response(&response);

        assert_eq!(
            titles.get("session-1").map(String::as_str),
            Some("App server title")
        );
        assert!(!titles.contains_key("session-2"));
    }

    #[test]
    fn parses_app_server_thread_inventory_metadata() {
        let response = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "data": [
                    {
                        "id": "session-1",
                        "name": null,
                        "cwd": "/tmp/project",
                        "updatedAt": 1781263443
                    }
                ]
            }
        });

        let sessions = app_server_sessions_from_response(&response);
        let session = sessions.get("session-1").expect("session");

        assert_eq!(session.name, None);
        assert_eq!(session.cwd.as_deref(), Some("/tmp/project"));
        assert_eq!(
            session.updated_at.as_deref(),
            Some("2026-06-12T11:24:03.000Z")
        );
    }

    #[test]
    fn app_server_inventory_uses_session_tree_id_over_thread_id() {
        let response = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "data": [
                    {
                        "id": "thread-1",
                        "sessionId": "session-tree-1",
                        "name": "Thread title",
                        "cwd": "/tmp/project",
                        "updatedAt": 1781263443
                    }
                ]
            }
        });

        let sessions = app_server_sessions_from_response(&response);

        assert!(sessions.contains_key("session-tree-1"));
        assert!(!sessions.contains_key("thread-1"));
    }

    #[test]
    fn app_server_inventory_keeps_first_session_tree_row() {
        let response = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "data": [
                    {
                        "id": "thread-new",
                        "sessionId": "session-tree-1",
                        "name": "New thread",
                        "cwd": "/tmp/new-project",
                        "updatedAt": 1781263443
                    },
                    {
                        "id": "thread-old",
                        "sessionId": "session-tree-1",
                        "name": "Old thread",
                        "cwd": "/tmp/old-project",
                        "updatedAt": 1781263000
                    }
                ]
            }
        });

        let sessions = app_server_sessions_from_response(&response);
        let session = sessions.get("session-tree-1").expect("session");

        assert_eq!(session.name.as_deref(), Some("New thread"));
        assert_eq!(session.cwd.as_deref(), Some("/tmp/new-project"));
        assert_eq!(
            session.updated_at.as_deref(),
            Some("2026-06-12T11:24:03.000Z")
        );
    }

    #[test]
    fn loads_app_server_sessions_after_initialization() {
        let (url, requests) = run_fake_app_server_with_requests(vec![json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "data": [
                    {
                        "id": "session-1",
                        "name": "Server title",
                        "cwd": "/tmp/project",
                        "updatedAt": 1781263443
                    }
                ]
            }
        })]);

        let inventory = load_app_server_sessions(&url, 20, 1).expect("sessions");
        let session = inventory.sessions.get("session-1").expect("session");
        let request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/list request");
        let source_kinds = request
            .pointer("/params/sourceKinds")
            .and_then(serde_json::Value::as_array)
            .expect("sourceKinds array");

        assert_eq!(
            request.get("method").and_then(serde_json::Value::as_str),
            Some("thread/list")
        );
        assert!(!inventory.truncated);
        assert_eq!(
            request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            request
                .pointer("/params/sortKey")
                .and_then(serde_json::Value::as_str),
            Some("updated_at")
        );
        assert_eq!(
            source_kinds
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>(),
            vec!["cli", "vscode", "appServer"]
        );
        assert_eq!(session.name.as_deref(), Some("Server title"));
        assert_eq!(session.cwd.as_deref(), Some("/tmp/project"));
        assert_eq!(
            session.updated_at.as_deref(),
            Some("2026-06-12T11:24:03.000Z")
        );
    }

    #[test]
    fn loads_app_server_sessions_until_limit_plus_one() {
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": [
                        {
                            "id": "session-1",
                            "name": "First page",
                            "cwd": "/tmp/page-1",
                            "updatedAt": 1781263443
                        },
                        {
                            "id": "session-2",
                            "name": "Second page",
                            "cwd": "/tmp/page-2",
                            "updatedAt": 1781267043
                        }
                    ],
                    "nextCursor": "cursor-page-2"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": [
                        {
                            "id": "session-3",
                            "name": "Third page",
                            "cwd": "/tmp/page-3",
                            "updatedAt": 1781268043
                        }
                    ],
                    "nextCursor": null
                }
            }),
        ]);

        let inventory = load_app_server_sessions(&url, 1, 1).expect("sessions");
        let first_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("first request");
        let second_request = requests.recv_timeout(Duration::from_millis(100));

        assert_eq!(inventory.sessions.len(), 2);
        assert!(inventory.truncated);
        assert_eq!(
            inventory
                .sessions
                .get("session-1")
                .and_then(|session| session.name.as_deref()),
            Some("First page")
        );
        assert_eq!(
            inventory
                .sessions
                .get("session-2")
                .and_then(|session| session.name.as_deref()),
            Some("Second page")
        );
        assert!(first_request.pointer("/params/cursor").is_none());
        assert_eq!(
            first_request
                .pointer("/params/limit")
                .and_then(serde_json::Value::as_u64),
            Some(2)
        );
        assert!(second_request.is_err());
    }

    #[test]
    fn load_app_server_sessions_fails_on_thread_list_error() {
        let url = run_fake_app_server(vec![json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": { "message": "state database unavailable" }
        })]);

        let error = load_app_server_sessions(&url, 20, 1).expect_err("thread/list error");

        assert_eq!(
            error.to_string(),
            "app-server thread/list failed: state database unavailable"
        );
    }

    #[test]
    fn load_app_server_sessions_fails_on_malformed_thread_list_response() {
        let url = run_fake_app_server(vec![json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {}
        })]);

        let error = load_app_server_sessions(&url, 20, 1).expect_err("malformed response");

        assert_eq!(
            error.to_string(),
            "app-server thread/list response did not include result.data"
        );
    }

    #[test]
    fn load_app_server_sessions_fails_on_thread_list_row_without_identity() {
        let url = run_fake_app_server(vec![json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "data": [
                    {
                        "threadId": "schema-drift-1",
                        "name": "Schema drift"
                    }
                ]
            }
        })]);

        let error = load_app_server_sessions(&url, 20, 1).expect_err("malformed row");

        assert_eq!(
            error.to_string(),
            "app-server thread/list response data[0] did not include thread.id"
        );
    }

    #[test]
    fn load_app_server_sessions_fails_on_thread_list_row_without_thread_id() {
        let url = run_fake_app_server(vec![json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "data": [
                    {
                        "sessionId": "session-tree-1",
                        "name": "Missing executable thread id"
                    }
                ]
            }
        })]);

        let error = load_app_server_sessions(&url, 20, 1).expect_err("missing thread id");

        assert_eq!(
            error.to_string(),
            "app-server thread/list response data[0] did not include thread.id"
        );
    }

    #[test]
    fn load_app_server_sessions_fails_on_non_string_next_cursor() {
        let url = run_fake_app_server(vec![json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "data": [
                    {
                        "id": "session-1",
                        "name": "First page"
                    }
                ],
                "nextCursor": { "cursor": "cursor-page-2" }
            }
        })]);

        let error = load_app_server_sessions(&url, 20, 1).expect_err("malformed cursor");

        assert_eq!(
            error.to_string(),
            "app-server thread/list response included non-string nextCursor"
        );
    }

    #[test]
    fn load_app_server_sessions_marks_paginated_response_as_truncated() {
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": [
                        {
                            "id": "session-1",
                            "name": "First page"
                        }
                    ],
                    "nextCursor": "cursor-loop"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": [
                        {
                            "id": "session-2",
                            "name": "Second page"
                        }
                    ],
                    "nextCursor": "cursor-loop"
                }
            }),
        ]);

        let inventory = load_app_server_sessions(&url, 20, 1).expect("sessions");
        let first_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("first request");
        let second_request = requests.recv_timeout(Duration::from_millis(100));

        assert_eq!(inventory.sessions.len(), 1);
        assert!(inventory.truncated);
        assert!(first_request.pointer("/params/cursor").is_none());
        assert!(second_request.is_err());
    }

    #[test]
    fn load_app_server_sessions_does_not_follow_duplicate_session_pages() {
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": [
                        {
                            "id": "thread-1",
                            "sessionId": "session-tree-1",
                            "name": "First thread"
                        },
                        {
                            "id": "thread-2",
                            "sessionId": "session-tree-1",
                            "name": "Second thread"
                        }
                    ],
                    "nextCursor": "cursor-page-2"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": [
                        {
                            "id": "thread-3",
                            "sessionId": "session-tree-2",
                            "name": "Should not be requested"
                        }
                    ],
                    "nextCursor": null
                }
            }),
        ]);

        let inventory = load_app_server_sessions(&url, 20, 1).expect("sessions");
        let first_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("first request");
        let second_request = requests.recv_timeout(Duration::from_millis(100));

        assert_eq!(inventory.sessions.len(), 1);
        assert!(inventory.truncated);
        assert_eq!(
            inventory
                .sessions
                .get("session-tree-1")
                .and_then(|session| session.name.as_deref()),
            Some("First thread")
        );
        assert!(first_request.pointer("/params/cursor").is_none());
        assert!(second_request.is_err());
    }

    #[test]
    fn load_app_server_sessions_fails_when_socket_closes_before_response() {
        let url = run_fake_app_server(Vec::new());

        let error = load_app_server_sessions(&url, 20, 1).expect_err("closed socket");

        assert!(!error.to_string().is_empty());
    }

    #[test]
    fn parses_app_server_thread_start_response() {
        let response = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "thread": {
                    "id": "thread-1",
                    "name": "Created title",
                    "cwd": "/tmp/project",
                    "updatedAt": 1781263443
                }
            }
        });

        let thread = app_server_thread_from_response(&response).expect("thread");

        assert_eq!(thread.id, "thread-1");
        assert_eq!(thread.session_id, "thread-1");
        assert_eq!(thread.name.as_deref(), Some("Created title"));
        assert_eq!(thread.cwd.as_deref(), Some("/tmp/project"));
        assert_eq!(thread.updated_at, "2026-06-12T11:24:03.000Z");
    }

    #[test]
    fn creates_app_server_thread_and_sets_name() {
        let url = run_fake_app_server(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "thread": {
                        "id": "thread-1",
                        "name": null,
                        "cwd": "/tmp/project",
                        "updatedAt": 1781263443
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {}
            }),
        ]);

        let session = create_app_server_thread_at(&url, Some("Requested title"), "/tmp/project", 1)
            .expect("created thread");

        assert_eq!(session.session_id, "thread-1");
        assert_eq!(session.title, "Requested title");
        assert_eq!(session.title_source, TitleSource::AppServer);
        assert_eq!(session.cwd.as_deref(), Some("/tmp/project"));
    }

    #[test]
    fn resumes_host_session_through_app_server_without_turn_start() {
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": [
                        {
                            "id": "thread-live-1",
                            "sessionId": "session-1",
                            "name": "Recovered title",
                            "cwd": "/tmp/project",
                            "updatedAt": 1781263443
                        }
                    ]
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "thread": {
                        "id": "thread-live-1",
                        "sessionId": "session-1",
                        "name": "Recovered title",
                        "cwd": "/tmp/project",
                        "updatedAt": 1781263443
                    }
                }
            }),
        ]);

        let session = ensure_app_server_host_session_at(
            &url,
            "session-1",
            Some("Fallback"),
            "/tmp/project",
            None,
            None,
            1,
        )
        .expect("resumed host session");
        let list_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/list request");
        assert_eq!(
            list_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/list")
        );
        let resume_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/resume request");

        assert_eq!(
            resume_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/resume")
        );
        assert_eq!(
            resume_request
                .get("params")
                .and_then(|params| params.get("threadId"))
                .and_then(serde_json::Value::as_str),
            Some("thread-live-1")
        );
        assert_eq!(
            resume_request
                .get("params")
                .and_then(|params| params.get("excludeTurns"))
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
        assert_eq!(session.session_id, "session-1");
        assert_eq!(session.title, "Recovered title");
        assert_eq!(session.title_source, TitleSource::AppServer);
        assert!(session.app_server_present);
        assert_eq!(session.cwd.as_deref(), Some("/tmp/project"));
        assert_eq!(session.updated_at, "2026-06-12T11:24:03.000Z");
    }

    #[test]
    fn ensure_host_session_rejects_mismatched_resume_session_id() {
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": [
                        {
                            "id": "thread-live-1",
                            "sessionId": "session-1",
                            "name": "Recovered title",
                            "cwd": "/tmp/project",
                            "updatedAt": 1781263443
                        }
                    ]
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "thread": {
                        "id": "thread-live-1",
                        "sessionId": "session-other",
                        "name": "Wrong session",
                        "cwd": "/tmp/project",
                        "updatedAt": 1781263443
                    }
                }
            }),
        ]);

        let error = ensure_app_server_host_session_at(
            &url,
            "session-1",
            Some("Fallback"),
            "/tmp/project",
            None,
            None,
            1,
        )
        .expect_err("mismatched app-server session id should fail");
        assert!(
            error
                .to_string()
                .contains("returned session session-other while attaching session session-1")
        );
        assert_eq!(
            requests
                .recv_timeout(Duration::from_secs(1))
                .expect("thread/list request")
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/list")
        );
        assert_eq!(
            requests
                .recv_timeout(Duration::from_secs(1))
                .expect("thread/resume request")
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/resume")
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn resumes_archived_host_session_through_resolved_app_server_thread_id() {
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": []
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": [
                        {
                            "id": "thread-archived-1",
                            "sessionId": "session-1",
                            "name": "Archived title",
                            "cwd": "/tmp/project",
                            "updatedAt": 1781263443
                        }
                    ]
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {}
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 4,
                "result": {
                    "thread": {
                        "id": "thread-archived-1",
                        "sessionId": "session-1",
                        "name": "Archived title",
                        "cwd": "/tmp/project",
                        "updatedAt": 1781263443
                    }
                }
            }),
        ]);

        let session = ensure_app_server_host_session_at(
            &url,
            "session-1",
            Some("Fallback"),
            "/tmp/project",
            None,
            None,
            1,
        )
        .expect("resumed archived host session");
        let active_list_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("active thread/list request");
        assert_eq!(
            active_list_request
                .get("params")
                .and_then(|params| params.get("archived"))
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        let archived_list_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("archived thread/list request");
        assert_eq!(
            archived_list_request
                .get("params")
                .and_then(|params| params.get("archived"))
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        let unarchive_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/unarchive request");
        assert_eq!(
            unarchive_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/unarchive")
        );
        assert_eq!(
            unarchive_request
                .get("params")
                .and_then(|params| params.get("threadId"))
                .and_then(serde_json::Value::as_str),
            Some("thread-archived-1")
        );
        let resume_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/resume request");
        assert_eq!(
            resume_request
                .get("params")
                .and_then(|params| params.get("threadId"))
                .and_then(serde_json::Value::as_str),
            Some("thread-archived-1")
        );
        assert_eq!(session.session_id, "session-1");
        assert_eq!(session.title, "Archived title");
        assert!(session.app_server_present);
    }

    #[test]
    fn ensure_host_session_uses_matched_session_before_page_budget_error() {
        let first_page = [
            vec![json!({
                "id": "thread-live-1",
                "sessionId": "session-1",
                "name": "Recovered title",
                "cwd": "/tmp/project",
                "updatedAt": 1781263443
            })],
            (0..APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE - 1)
                .map(|index| json!({ "id": format!("thread-old-{index}") }))
                .collect::<Vec<_>>(),
        ]
        .concat();
        let second_page = (0..APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE)
            .map(|index| json!({ "id": format!("thread-older-{index}") }))
            .collect::<Vec<_>>();
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": first_page,
                    "nextCursor": "cursor-page-2"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": second_page,
                    "nextCursor": "cursor-page-3"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {
                    "thread": {
                        "id": "thread-live-1",
                        "sessionId": "session-1",
                        "name": "Recovered title",
                        "cwd": "/tmp/project",
                        "updatedAt": 1781263443
                    }
                }
            }),
        ]);

        let session = ensure_app_server_host_session_at(
            &url,
            "session-1",
            Some("Fallback"),
            "/tmp/project",
            None,
            None,
            1,
        )
        .expect("session match should be usable before page-budget error");
        let first_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("first thread/list request");
        let second_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("second thread/list request");
        let resume_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/resume request");

        assert_eq!(
            first_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/list")
        );
        assert_eq!(
            second_request
                .pointer("/params/cursor")
                .and_then(serde_json::Value::as_str),
            Some("cursor-page-2")
        );
        assert_eq!(
            resume_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-live-1")
        );
        assert_eq!(session.session_id, "session-1");
        assert_eq!(session.title, "Recovered title");
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn ensure_host_session_errors_when_thread_resolution_page_budget_is_exhausted() {
        let first_page = (0..APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE)
            .map(|index| json!({ "id": format!("thread-old-{index}") }))
            .collect::<Vec<_>>();
        let second_page = (0..APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE)
            .map(|index| json!({ "id": format!("thread-older-{index}") }))
            .collect::<Vec<_>>();
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": first_page,
                    "nextCursor": "cursor-page-2"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": second_page,
                    "nextCursor": "cursor-page-3"
                }
            }),
        ]);

        let error = ensure_app_server_host_session_at(
            &url,
            "session-1",
            Some("Fallback"),
            "/tmp/project",
            None,
            None,
            1,
        )
        .expect_err("page budget exhaustion should fail");
        assert!(error.to_string().contains("exceeded page budget"));
        let first_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("first thread/list request");
        let second_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("second thread/list request");

        assert_eq!(
            first_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/list")
        );
        assert_eq!(
            second_request
                .pointer("/params/cursor")
                .and_then(serde_json::Value::as_str),
            Some("cursor-page-2")
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn resumes_unlisted_host_session_from_rollout_path() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let rollout_path = tempdir
            .path()
            .join("sessions/2026/06/16/rollout-session-1.jsonl");
        fs::create_dir_all(rollout_path.parent().expect("rollout parent")).expect("sessions dir");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-06-16T15:00:00.000Z","type":"session_meta","payload":{"id":"session-1","cwd":"/tmp/project-from-rollout"}}"#,
        )
        .expect("rollout");
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": []
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": []
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {
                    "thread": {
                        "id": "thread-from-path",
                        "sessionId": "session-1",
                        "name": "Recovered from path",
                        "cwd": "/tmp/project",
                        "updatedAt": 1781263443
                    }
                }
            }),
        ]);

        let session = ensure_app_server_host_session_at(
            &url,
            "session-1",
            Some("Fallback"),
            "/tmp/project",
            Some(&rollout_path),
            None,
            1,
        )
        .expect("path-based resume should attach the host session");
        let active_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("active thread/list request");
        let archived_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("archived thread/list request");

        assert_eq!(
            active_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            archived_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        let resume_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/resume request");
        assert_eq!(
            resume_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/resume")
        );
        assert_eq!(
            resume_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("session-1")
        );
        assert_eq!(
            resume_request
                .pointer("/params/path")
                .and_then(serde_json::Value::as_str),
            Some(rollout_path.to_string_lossy().as_ref())
        );
        assert_eq!(
            resume_request
                .pointer("/params/cwd")
                .and_then(serde_json::Value::as_str),
            Some("/tmp/project-from-rollout")
        );
        assert_eq!(
            resume_request
                .pointer("/params/runtimeWorkspaceRoots/0")
                .and_then(serde_json::Value::as_str),
            Some("/tmp/project-from-rollout")
        );
        assert_eq!(
            resume_request
                .pointer("/params/excludeTurns")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
        assert_eq!(session.session_id, "session-1");
        assert_eq!(session.title, "Recovered from path");
        assert!(session.app_server_present);
    }

    #[test]
    fn ensure_host_session_errors_without_resolved_thread_or_rollout_path() {
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": []
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": []
                }
            }),
        ]);

        let error = ensure_app_server_host_session_at(
            &url,
            "session-1",
            Some("Fallback"),
            "/tmp/project",
            None,
            None,
            1,
        )
        .expect_err("missing app-server thread and rollout path should fail");
        assert!(
            error
                .to_string()
                .contains("could not find local rollout for session session-1")
        );
        let active_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("active thread/list request");
        let archived_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("archived thread/list request");

        assert_eq!(
            active_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            archived_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn ensure_host_session_resume_is_bounded_by_local_deadline() {
        let (url, requests) = run_fake_app_server_with_unmatched_resume_messages();

        let error = ensure_app_server_host_session_at(
            &url,
            "session-1",
            Some("Fallback"),
            "/tmp/project",
            None,
            None,
            1,
        )
        .expect_err("unmatched resume response should fail by deadline");
        let message = error.to_string();
        assert!(
            message.contains("app-server thread/resume timed out before matching response"),
            "{message}"
        );
        let list_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/list request");
        let resume_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/resume request");

        assert_eq!(
            list_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/list")
        );
        assert_eq!(
            resume_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/resume")
        );
        assert_eq!(
            resume_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-live-1")
        );
    }

    #[test]
    fn keeps_created_app_server_thread_when_name_set_fails() {
        let url = run_fake_app_server(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "thread": {
                        "id": "thread-1",
                        "name": "Server title",
                        "cwd": "/tmp/project",
                        "updatedAt": 1781263443
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "error": { "message": "name update unavailable" }
            }),
        ]);

        let session = create_app_server_thread_at(&url, Some("Requested title"), "/tmp/project", 1)
            .expect("created thread despite name failure");

        assert_eq!(session.session_id, "thread-1");
        assert_eq!(session.title, "Requested title");
    }

    #[test]
    fn archives_app_server_thread() {
        let (url, requests) = run_fake_app_server_with_requests(vec![
            app_server_thread_list_response(),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {}
            }),
        ]);

        assert!(set_app_server_thread_archived_at(&url, "thread-1", true, 1).expect("archive"));
        let list_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/list request");
        assert_eq!(
            list_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/list")
        );
        assert_eq!(
            list_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );

        let request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/archive request");

        assert_eq!(
            request.get("method").and_then(serde_json::Value::as_str),
            Some("thread/archive")
        );
        assert_eq!(
            request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-1")
        );
    }

    #[test]
    fn archives_official_thread_id_without_session_id_as_exact_match() {
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": [
                        {
                            "id": "thread-1"
                        }
                    ],
                    "nextCursor": "cursor-page-2"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {}
            }),
        ]);

        assert!(set_app_server_thread_archived_at(&url, "thread-1", true, 1).expect("archive"));
        let list_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/list request");
        let archive_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/archive request");

        assert_eq!(
            list_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/list")
        );
        assert_eq!(
            archive_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/archive")
        );
        assert_eq!(
            archive_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-1")
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn archives_app_server_thread_by_resolving_legacy_session_id() {
        let (url, requests) = run_fake_app_server_with_requests(vec![
            app_server_thread_list_response(),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {}
            }),
        ]);

        assert!(
            set_app_server_thread_archived_at(&url, "session-tree-1", true, 1).expect("archive")
        );
        let list_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/list request");
        assert_eq!(
            list_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        let request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/archive request");

        assert_eq!(
            request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-1")
        );
    }

    #[test]
    fn archives_all_app_server_threads_in_a_session_tree() {
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": [
                        {
                            "id": "thread-1",
                            "sessionId": "session-tree-1"
                        },
                        {
                            "id": "thread-2",
                            "sessionId": "session-tree-1"
                        },
                        {
                            "id": "thread-other",
                            "sessionId": "session-tree-other"
                        }
                    ]
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {}
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {}
            }),
        ]);

        assert!(
            set_app_server_thread_archived_at(&url, "session-tree-1", true, 1).expect("archive")
        );
        let list_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/list request");
        let first_archive_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("first thread/archive request");
        let second_archive_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("second thread/archive request");

        assert_eq!(
            list_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            first_archive_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-1")
        );
        assert_eq!(
            second_archive_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-2")
        );
    }

    #[test]
    fn archives_session_tree_when_root_thread_id_matches_session_id() {
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": [
                        {
                            "id": "session-tree-1",
                            "sessionId": "session-tree-1"
                        },
                        {
                            "id": "thread-2",
                            "sessionId": "session-tree-1"
                        }
                    ]
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {}
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {}
            }),
        ]);

        assert!(
            set_app_server_thread_archived_at(&url, "session-tree-1", true, 1).expect("archive")
        );
        let _list_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/list request");
        let first_archive_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("first thread/archive request");
        let second_archive_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("second thread/archive request");

        assert_eq!(
            first_archive_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("session-tree-1")
        );
        assert_eq!(
            second_archive_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-2")
        );
    }

    #[test]
    fn archive_sync_paginates_until_thread_is_found() {
        let first_page = (0..APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE)
            .map(|index| json!({ "id": format!("thread-old-{index}") }))
            .collect::<Vec<_>>();
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": first_page,
                    "nextCursor": "cursor-page-2"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": [
                        {
                            "id": "thread-201",
                            "sessionId": "session-tree-201"
                        }
                    ],
                    "nextCursor": null
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {}
            }),
        ]);

        assert!(
            set_app_server_thread_archived_at(&url, "session-tree-201", true, 1).expect("archive")
        );
        let first_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("first thread/list request");
        let second_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("second thread/list request");
        let archive_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/archive request");

        assert_eq!(
            first_request
                .pointer("/params/cursor")
                .and_then(serde_json::Value::as_str),
            None
        );
        assert_eq!(
            second_request
                .pointer("/params/cursor")
                .and_then(serde_json::Value::as_str),
            Some("cursor-page-2")
        );
        assert_eq!(
            first_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            second_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            archive_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/archive")
        );
        assert_eq!(
            archive_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-201")
        );
    }

    #[test]
    fn archive_sync_errors_before_partial_session_tree_update_after_page_budget() {
        let first_page = (0..APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE)
            .map(|index| {
                if index == 0 {
                    json!({
                        "id": "thread-1",
                        "sessionId": "session-tree-1"
                    })
                } else {
                    json!({ "id": format!("thread-old-{index}") })
                }
            })
            .collect::<Vec<_>>();
        let second_page = (0..APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE)
            .map(|index| json!({ "id": format!("thread-older-{index}") }))
            .collect::<Vec<_>>();
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": first_page,
                    "nextCursor": "cursor-page-2"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": second_page,
                    "nextCursor": "cursor-page-3"
                }
            }),
        ]);

        let error = set_app_server_thread_archived_at(&url, "session-tree-1", true, 1)
            .expect_err("ambiguous archive sync should fail");
        assert!(
            error
                .to_string()
                .contains("exceeded page budget while resolving a session tree")
        );
        let first_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("first thread/list request");
        let second_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("second thread/list request");

        assert_eq!(
            first_request
                .pointer("/params/cursor")
                .and_then(serde_json::Value::as_str),
            None
        );
        assert_eq!(
            second_request
                .pointer("/params/cursor")
                .and_then(serde_json::Value::as_str),
            Some("cursor-page-2")
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn archive_sync_errors_when_unmatched_pages_exhaust_page_budget() {
        let first_page = (0..APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE)
            .map(|index| json!({ "id": format!("thread-old-{index}") }))
            .collect::<Vec<_>>();
        let second_page = (0..APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE)
            .map(|index| json!({ "id": format!("thread-older-{index}") }))
            .collect::<Vec<_>>();
        let first_target_page = (0..APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE)
            .map(|index| json!({ "id": format!("thread-archived-old-{index}") }))
            .collect::<Vec<_>>();
        let second_target_page = (0..APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE)
            .map(|index| json!({ "id": format!("thread-archived-older-{index}") }))
            .collect::<Vec<_>>();
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": first_page,
                    "nextCursor": "cursor-page-2"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": second_page,
                    "nextCursor": "cursor-page-3"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {
                    "data": first_target_page,
                    "nextCursor": "cursor-page-4"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 4,
                "result": {
                    "data": second_target_page,
                    "nextCursor": "cursor-page-5"
                }
            }),
        ]);

        let error = set_app_server_thread_archived_at(&url, "session-tree-missing", true, 1)
            .expect_err("unbounded archive sync should fail");
        assert!(
            error
                .to_string()
                .contains("exceeded page budget before resolving thread state")
        );
        let first_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("first thread/list request");
        let second_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("second thread/list request");
        let first_target_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("first target-state thread/list request");
        let second_target_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("second target-state thread/list request");

        assert_eq!(
            first_request
                .pointer("/params/cursor")
                .and_then(serde_json::Value::as_str),
            None
        );
        assert_eq!(
            second_request
                .pointer("/params/cursor")
                .and_then(serde_json::Value::as_str),
            Some("cursor-page-2")
        );
        assert_eq!(
            first_target_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            second_target_request
                .pointer("/params/cursor")
                .and_then(serde_json::Value::as_str),
            Some("cursor-page-4")
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn archive_sync_checks_exact_target_state_after_source_page_budget_miss() {
        let first_source_page = (0..APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE)
            .map(|index| json!({ "id": format!("thread-old-{index}") }))
            .collect::<Vec<_>>();
        let second_source_page = (0..APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE)
            .map(|index| json!({ "id": format!("thread-older-{index}") }))
            .collect::<Vec<_>>();
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": first_source_page,
                    "nextCursor": "cursor-page-2"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": second_source_page,
                    "nextCursor": "cursor-page-3"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {
                    "data": [
                        {
                            "id": "thread-archived-1",
                            "sessionId": "session-tree-archived"
                        }
                    ]
                }
            }),
        ]);

        assert!(
            set_app_server_thread_archived_at(&url, "thread-archived-1", true, 1)
                .expect("already archived")
        );
        let first_source_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("first source-state thread/list request");
        let second_source_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("second source-state thread/list request");
        let target_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("target-state thread/list request");

        assert_eq!(
            first_source_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            second_source_request
                .pointer("/params/cursor")
                .and_then(serde_json::Value::as_str),
            Some("cursor-page-2")
        );
        assert_eq!(
            target_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn archive_sync_errors_when_source_exhausts_before_target_session_tree_match() {
        let first_source_page = (0..APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE)
            .map(|index| json!({ "id": format!("thread-old-{index}") }))
            .collect::<Vec<_>>();
        let second_source_page = (0..APP_SERVER_ARCHIVE_SYNC_LIST_PAGE_SIZE)
            .map(|index| json!({ "id": format!("thread-older-{index}") }))
            .collect::<Vec<_>>();
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": first_source_page,
                    "nextCursor": "cursor-page-2"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": second_source_page,
                    "nextCursor": "cursor-page-3"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {
                    "data": [
                        {
                            "id": "thread-archived-1",
                            "sessionId": "session-tree-archived"
                        }
                    ]
                }
            }),
        ]);

        let error = set_app_server_thread_archived_at(&url, "session-tree-archived", true, 1)
            .expect_err("ambiguous target session tree match should fail");
        assert!(
            error
                .to_string()
                .contains("exceeded page budget before resolving session tree state")
        );
        let first_source_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("first source-state thread/list request");
        let second_source_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("second source-state thread/list request");
        let target_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("target-state thread/list request");

        assert_eq!(
            first_source_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            second_source_request
                .pointer("/params/cursor")
                .and_then(serde_json::Value::as_str),
            Some("cursor-page-2")
        );
        assert_eq!(
            target_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn archive_sync_noops_when_thread_is_not_in_app_server_list() {
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": []
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": []
                }
            }),
        ]);

        assert!(
            !set_app_server_thread_archived_at(&url, "history-only-session", true, 1)
                .expect("archive no-op")
        );
        let source_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("source thread/list request");
        let target_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("target thread/list request");

        assert_eq!(
            source_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/list")
        );
        assert_eq!(
            source_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            target_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn archive_sync_resumes_unlisted_rollout_before_archive() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let codex_home = tempdir.path();
        let rollout_path = codex_home.join("sessions/2026/06/16/rollout-session-tree-1.jsonl");
        fs::create_dir_all(rollout_path.parent().expect("rollout parent")).expect("sessions dir");
        fs::write(
            &rollout_path,
            concat!(
                r#"{"timestamp":"2026-06-16T15:00:00.000Z","type":"session_meta","payload":{"id":"session-tree-1","cwd":"/tmp/project"}}"#,
                "\n",
                r#"{"timestamp":"2026-06-16T15:01:00.000Z","type":"turn_context","payload":{"cwd":"/tmp/project-from-turn"}}"#
            ),
        )
        .expect("rollout");
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": []
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": []
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {
                    "thread": {
                        "id": "thread-from-path",
                        "sessionId": "session-tree-1",
                        "cwd": "/tmp/project-from-turn",
                        "updatedAt": 1781263443
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 4,
                "result": {}
            }),
        ]);

        assert!(
            set_app_server_thread_archived_at_with_rollout_lookup(
                &url,
                "session-tree-1",
                true,
                Some((codex_home, SessionInventoryConfig::default().max_sessions)),
                1,
            )
            .expect("archive fallback")
        );

        let source_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("source thread/list request");
        let target_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("target thread/list request");
        let resume_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/resume request");
        let archive_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/archive request");

        assert_eq!(
            source_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            target_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            resume_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/resume")
        );
        assert_eq!(
            resume_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("session-tree-1")
        );
        assert_eq!(
            resume_request
                .pointer("/params/path")
                .and_then(serde_json::Value::as_str),
            Some(rollout_path.to_string_lossy().as_ref())
        );
        assert_eq!(
            resume_request
                .pointer("/params/cwd")
                .and_then(serde_json::Value::as_str),
            Some("/tmp/project-from-turn")
        );
        assert_eq!(
            resume_request
                .pointer("/params/runtimeWorkspaceRoots/0")
                .and_then(serde_json::Value::as_str),
            Some("/tmp/project-from-turn")
        );
        assert_eq!(
            resume_request
                .pointer("/params/excludeTurns")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            archive_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/archive")
        );
        assert_eq!(
            archive_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-from-path")
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn archive_sync_rejects_mismatched_rollout_resume_session_id() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let codex_home = tempdir.path();
        let rollout_path = codex_home.join("sessions/2026/06/16/rollout-session-tree-1.jsonl");
        fs::create_dir_all(rollout_path.parent().expect("rollout parent")).expect("sessions dir");
        fs::write(
            &rollout_path,
            concat!(
                r#"{"timestamp":"2026-06-16T15:00:00.000Z","type":"session_meta","payload":{"id":"session-tree-1","cwd":"/tmp/project"}}"#,
                "\n",
                r#"{"timestamp":"2026-06-16T15:01:00.000Z","type":"turn_context","payload":{"cwd":"/tmp/project-from-turn"}}"#
            ),
        )
        .expect("rollout");
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": []
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": []
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {
                    "thread": {
                        "id": "thread-from-path",
                        "sessionId": "session-other",
                        "cwd": "/tmp/project-from-turn",
                        "updatedAt": 1781263443
                    }
                }
            }),
        ]);

        let error = set_app_server_thread_archived_at_with_rollout_lookup(
            &url,
            "session-tree-1",
            true,
            Some((codex_home, SessionInventoryConfig::default().max_sessions)),
            1,
        )
        .expect_err("archive fallback should reject mismatched resume session");

        assert!(error
            .to_string()
            .contains("app-server thread/resume returned session session-other while syncing archive for session session-tree-1"));

        let source_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("source thread/list request");
        let target_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("target thread/list request");
        let resume_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/resume request");
        assert_eq!(
            source_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            target_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            resume_request
                .pointer("/params/path")
                .and_then(serde_json::Value::as_str),
            Some(rollout_path.to_string_lossy().as_ref())
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn archive_sync_succeeds_when_thread_is_already_in_target_state() {
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": []
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": [
                        {
                            "id": "thread-1",
                            "sessionId": "session-tree-1",
                            "name": "Thread title",
                            "cwd": "/tmp/project",
                            "updatedAt": 1781263443
                        }
                    ]
                }
            }),
        ]);

        assert!(set_app_server_thread_archived_at(&url, "thread-1", true, 1).expect("archive"));
        let source_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("source thread/list request");
        let target_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("target thread/list request");

        assert_eq!(
            source_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            target_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn archive_sync_timeout_does_not_reset_after_deadline() {
        let timeout = Duration::from_secs(5);

        let expired = remaining_app_server_archive_timeout(
            timeout,
            Instant::now() - Duration::from_millis(1),
        );
        let soon = remaining_app_server_archive_timeout(
            timeout,
            Instant::now() + Duration::from_millis(50),
        );

        assert_eq!(expired, Duration::from_millis(1));
        assert!(soon >= Duration::from_millis(1));
        assert!(soon <= Duration::from_millis(100));
    }

    #[test]
    fn unarchive_sync_succeeds_when_thread_is_already_in_target_state() {
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": []
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": [
                        {
                            "id": "thread-1",
                            "sessionId": "session-tree-1",
                            "name": "Thread title",
                            "cwd": "/tmp/project",
                            "updatedAt": 1781263443
                        }
                    ]
                }
            }),
        ]);

        assert!(set_app_server_thread_archived_at(&url, "thread-1", false, 1).expect("unarchive"));
        let source_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("source thread/list request");
        let target_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("target thread/list request");

        assert_eq!(
            source_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            target_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn unarchives_app_server_thread() {
        let (url, requests) = run_fake_app_server_with_requests(vec![
            app_server_thread_list_response(),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "thread": {
                        "id": "thread-1",
                        "sessionId": "session-tree-1",
                        "name": "Thread title",
                        "cwd": "/tmp/project",
                        "updatedAt": 1781263443
                    }
                }
            }),
        ]);

        assert!(set_app_server_thread_archived_at(&url, "thread-1", false, 1).expect("unarchive"));
        let list_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/list request");
        assert_eq!(
            list_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        let request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/unarchive request");

        assert_eq!(
            request.get("method").and_then(serde_json::Value::as_str),
            Some("thread/unarchive")
        );
        assert_eq!(
            request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-1")
        );
    }

    #[test]
    fn converts_history_unix_seconds_to_iso() {
        assert_eq!(
            unix_seconds_to_iso(0).as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
        assert_eq!(
            unix_seconds_to_iso(1_781_263_443).as_deref(),
            Some("2026-06-12T11:24:03.000Z")
        );
        assert_eq!(unix_seconds_to_iso(-1), None);
    }

    #[test]
    fn rollout_paths_are_limited_to_recent_date_directories() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let sessions_dir = tempdir.path();
        fs::create_dir_all(sessions_dir.join("2026/06/10")).expect("old dir");
        fs::create_dir_all(sessions_dir.join("2026/06/12")).expect("new dir");
        fs::write(
            sessions_dir.join("2026/06/10/rollout-old.jsonl"),
            r#"{"type":"session_meta","payload":{"id":"old"}}"#,
        )
        .expect("old rollout");
        fs::write(
            sessions_dir.join("2026/06/12/rollout-new.jsonl"),
            r#"{"type":"session_meta","payload":{"id":"new"}}"#,
        )
        .expect("new rollout");

        let paths = rollout_paths(sessions_dir, 1).expect("paths");

        assert_eq!(paths.len(), 1);
        assert_eq!(
            paths[0].file_name().and_then(|name| name.to_str()),
            Some("rollout-new.jsonl")
        );
    }

    #[test]
    fn recent_line_reader_returns_only_tail_lines() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let path = tempdir.path().join("history.jsonl");
        let lines = (0..200)
            .map(|index| format!(r#"{{"session_id":"session-{index}","text":"Prompt {index}"}}"#))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&path, lines).expect("history");

        let recent = read_recent_lines(&path, 3).expect("recent lines");

        assert_eq!(
            recent,
            vec![
                r#"{"session_id":"session-197","text":"Prompt 197"}"#,
                r#"{"session_id":"session-198","text":"Prompt 198"}"#,
                r#"{"session_id":"session-199","text":"Prompt 199"}"#
            ]
        );
    }

    #[test]
    fn scans_codex_home_without_transcripts() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let codex_home = tempdir.path();
        fs::create_dir_all(codex_home.join("sessions/2026/06/11")).expect("sessions dir");
        fs::write(
            codex_home.join("session_index.jsonl"),
            r#"{"id":"session-1","thread_name":"Metadata index title","updated_at":"2026-06-11T10:00:00.000Z"}"#,
        )
        .expect("session index");
        fs::write(
            codex_home.join("history.jsonl"),
            r#"{"session_id":"session-2","text":"History title from first prompt","ts":1781263443}
{"session_id":"session-3","text":"History-only prompt","ts":1781267043}"#,
        )
        .expect("history");
        fs::write(
            codex_home.join("sessions/2026/06/11/rollout-session-2.jsonl"),
            r#"{"timestamp":"2026-06-11T09:00:00.000Z","type":"session_meta","payload":{"id":"session-2","cwd":"/tmp/project"}}"#,
        )
        .expect("rollout");

        let config = AgentConfig {
            connector_name: "mac-studio".to_owned(),
            control_url: "wss://api.example.com/ws/agent".to_owned(),
            bootstrap_url: "https://api.example.com/connector/bootstrap".to_owned(),
            workspace_root: "/tmp/project".into(),
            token_file: "/tmp/token".into(),
            spool_db: "/tmp/spool.sqlite".into(),
            bootstrap: BootstrapConfig {
                secret_file: "/tmp/bootstrap.secret".into(),
            },
            execution: ExecutionConfig::default(),
            session_inventory: SessionInventoryConfig {
                codex_home: Some(codex_home.into()),
                app_server_url: None,
                ..SessionInventoryConfig::default()
            },
        };

        let report = build_host_sessions_report(&config).expect("report");

        assert_eq!(report.inventory_scope, InventoryScope::Full);
        assert_eq!(report.app_server_inventory_ok, None);
        assert_eq!(report.sessions.len(), 3);
        assert_eq!(report.sessions[0].session_id, "session-3");
        assert_eq!(report.sessions[0].title, "History-only prompt");
        assert_eq!(report.sessions[0].title_source, TitleSource::History);
        assert_eq!(report.sessions[1].title, "History title from first prompt");
        assert_eq!(report.sessions[2].title, "Metadata index title");
    }

    #[test]
    fn host_session_report_marks_truncated_inventory_as_incremental() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let codex_home = tempdir.path();
        fs::write(
            codex_home.join("session_index.jsonl"),
            r#"{"id":"session-1","thread_name":"First","updated_at":"2026-06-12T10:00:00.000Z"}
{"id":"session-2","thread_name":"Second","updated_at":"2026-06-12T11:00:00.000Z"}"#,
        )
        .expect("session index");

        let mut config = test_config(codex_home);
        config.session_inventory.max_sessions = 1;

        let report = build_host_sessions_report(&config).expect("report");

        assert_eq!(report.inventory_scope, InventoryScope::Incremental);
        assert_eq!(report.sessions.len(), 1);
        assert_eq!(report.sessions[0].session_id, "session-2");
    }

    #[test]
    fn host_session_report_marks_truncated_app_server_inventory_as_incremental() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": [
                        {
                            "id": "session-1",
                            "name": "First app-server thread",
                            "updatedAt": 1781263443
                        },
                        {
                            "id": "session-2",
                            "name": "Second app-server thread",
                            "updatedAt": 1781267043
                        }
                    ],
                    "nextCursor": "cursor-page-2"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": [
                        {
                            "id": "session-3",
                            "name": "Third app-server thread",
                            "updatedAt": 1781268043
                        }
                    ],
                    "nextCursor": null
                }
            }),
        ]);
        let mut config = test_config(tempdir.path());
        config.session_inventory.max_sessions = 1;
        config.session_inventory.app_server_url = Some(url);

        let report = build_host_sessions_report(&config).expect("report");
        let first_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("first request");
        let second_request = requests.recv_timeout(Duration::from_millis(100));

        assert_eq!(report.inventory_scope, InventoryScope::Incremental);
        assert_eq!(report.app_server_inventory_ok, Some(true));
        assert_eq!(report.sessions.len(), 1);
        assert_eq!(report.sessions[0].session_id, "session-2");
        assert!(first_request.pointer("/params/cursor").is_none());
        assert_eq!(
            first_request
                .pointer("/params/limit")
                .and_then(serde_json::Value::as_u64),
            Some(2)
        );
        assert!(second_request.is_err());
    }

    #[test]
    fn disabled_host_session_report_is_not_a_full_inventory() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let mut config = test_config(tempdir.path());
        config.session_inventory.enabled = false;

        let report = build_host_sessions_report(&config).expect("report");

        assert_eq!(report.inventory_scope, InventoryScope::Incremental);
        assert_eq!(report.app_server_inventory_ok, None);
        assert!(report.sessions.is_empty());
    }

    #[test]
    fn host_session_report_marks_app_server_inventory_failure() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let codex_home = tempdir.path();
        fs::write(
            codex_home.join("session_index.jsonl"),
            r#"{"id":"session-1","thread_name":"Metadata index title","updated_at":"2026-06-12T10:00:00.000Z"}"#,
        )
        .expect("session index");

        let config = AgentConfig {
            connector_name: "mac-studio".to_owned(),
            control_url: "wss://api.example.com/ws/agent".to_owned(),
            bootstrap_url: "https://api.example.com/connector/bootstrap".to_owned(),
            workspace_root: "/tmp/project".into(),
            token_file: "/tmp/token".into(),
            spool_db: "/tmp/spool.sqlite".into(),
            bootstrap: BootstrapConfig {
                secret_file: "/tmp/bootstrap.secret".into(),
            },
            execution: ExecutionConfig::default(),
            session_inventory: SessionInventoryConfig {
                codex_home: Some(codex_home.into()),
                app_server_url: Some("not-a-url".to_owned()),
                ..SessionInventoryConfig::default()
            },
        };

        let report = build_host_sessions_report(&config).expect("report");

        assert_eq!(report.inventory_scope, InventoryScope::Full);
        assert_eq!(report.app_server_inventory_ok, Some(false));
        assert_eq!(report.sessions.len(), 1);
        assert_eq!(report.sessions[0].session_id, "session-1");
        assert!(!report.sessions[0].app_server_present);
    }

    #[test]
    fn backfills_bounded_rollout_history_for_one_session() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let codex_home = tempdir.path();
        fs::create_dir_all(codex_home.join("sessions/2026/06/13")).expect("sessions dir");
        fs::write(
            codex_home.join("sessions/2026/06/13/rollout-session-1.jsonl"),
            r##"{"timestamp":"2026-06-13T03:00:00.000Z","type":"session_meta","payload":{"id":"session-1","cwd":"/tmp/project"}}
{"timestamp":"2026-06-13T03:01:00.000Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"developer instructions"}]}}
{"timestamp":"2026-06-13T03:02:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /tmp/project"}]}}
{"timestamp":"2026-06-13T03:03:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Run the integration check"}]}}
{"timestamp":"2026-06-13T03:04:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I will inspect the failing path."}]}}
{"timestamp":"2026-06-13T03:05:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call-1","arguments":"{}"}}
{"timestamp":"2026-06-13T03:06:00.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"test passed\nextra line"}}
"##,
        )
        .expect("rollout");

        let config = test_config(codex_home);
        let backfill = build_host_session_backfill(&config, "session-1", 10).expect("backfill");

        assert_eq!(backfill.truncated, false);
        assert_eq!(backfill.events.len(), 3);
        assert_eq!(
            backfill.events[0].summary,
            "2026-06-13 03:03 - User: Run the integration check"
        );
        assert_eq!(backfill.events[0].created_at, "2026-06-13T03:03:00.000Z");
        assert_eq!(
            backfill.events[1].summary,
            "2026-06-13 03:04 - Assistant: I will inspect the failing path."
        );
        assert_eq!(backfill.events[1].created_at, "2026-06-13T03:04:00.000Z");
        assert_eq!(
            backfill.events[2].summary,
            "2026-06-13 03:05 - Tool call: exec_command"
        );
        assert_eq!(backfill.events[2].created_at, "2026-06-13T03:05:00.000Z");
    }

    #[test]
    fn backfills_history_prompt_when_rollout_is_missing() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let codex_home = tempdir.path();
        fs::write(
            codex_home.join("history.jsonl"),
            r#"{"session_id":"session-1","text":"History prompt","ts":1781263443}"#,
        )
        .expect("history");

        let config = test_config(codex_home);
        let backfill = build_host_session_backfill(&config, "session-1", 10).expect("backfill");

        assert_eq!(backfill.events.len(), 1);
        assert_eq!(
            backfill.events[0].summary,
            "2026-06-12 11:24 - User: History prompt"
        );
        assert_eq!(backfill.events[0].kind, "command.output");
        assert_eq!(backfill.events[0].priority, "P3");
        assert_eq!(backfill.events[0].created_at, "2026-06-12T11:24:03.000Z");
    }

    #[test]
    fn rollout_backfill_preserves_prompt_after_injected_context() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let codex_home = tempdir.path();
        fs::create_dir_all(codex_home.join("sessions/2026/06/13")).expect("sessions dir");
        fs::write(
            codex_home.join("sessions/2026/06/13/rollout-session-1.jsonl"),
            r##"{"timestamp":"2026-06-13T03:00:00.000Z","type":"session_meta","payload":{"id":"session-1","cwd":"/tmp/project"}}
{"timestamp":"2026-06-13T03:01:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>\nKeep docs bilingual.\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>/tmp/project</cwd>\n</environment_context>\n\nImplement the parser"}]}}"##,
        )
        .expect("rollout");

        let config = test_config(codex_home);
        let backfill = build_host_session_backfill(&config, "session-1", 10).expect("backfill");

        assert_eq!(backfill.events.len(), 1);
        assert_eq!(
            backfill.events[0].summary,
            "2026-06-13 03:01 - User: Implement the parser"
        );
    }

    #[test]
    fn history_backfill_uses_inventory_scan_horizon() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let codex_home = tempdir.path();
        let mut lines = vec![
            r#"{"session_id":"session-1","text":"Visible older prompt","ts":1781263443}"#
                .to_owned(),
        ];
        lines.extend((0..199).map(|index| {
            let filler_id = index + 1_000;
            format!(
                r#"{{"session_id":"session-{filler_id}","text":"Filler prompt {index}","ts":1781263444}}"#
            )
        }));
        fs::write(codex_home.join("history.jsonl"), lines.join("\n")).expect("history");

        let mut config = test_config(codex_home);
        config.session_inventory.max_sessions = 100;
        let backfill = build_host_session_backfill(&config, "session-1", 30).expect("backfill");

        assert_eq!(backfill.events.len(), 1);
        assert_eq!(
            backfill.events[0].summary,
            "2026-06-12 11:24 - User: Visible older prompt"
        );
    }

    #[test]
    fn backfill_is_disabled_when_session_inventory_is_disabled() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let codex_home = tempdir.path();
        fs::write(
            codex_home.join("history.jsonl"),
            r#"{"session_id":"session-1","text":"History prompt","ts":1781263443}"#,
        )
        .expect("history");

        let mut config = test_config(codex_home);
        config.session_inventory.enabled = false;

        let error = build_host_session_backfill(&config, "session-1", 10).expect_err("disabled");

        assert_eq!(error.to_string(), "session inventory is disabled");
    }

    #[test]
    fn backfill_does_not_match_rollout_filename_by_session_prefix() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let codex_home = tempdir.path();
        fs::create_dir_all(codex_home.join("sessions/2026/06/13")).expect("sessions dir");
        fs::write(
            codex_home.join("sessions/2026/06/13/rollout-session-10.jsonl"),
            r#"{"timestamp":"2026-06-13T03:00:00.000Z","type":"session_meta","payload":{"id":"session-10","cwd":"/tmp/project"}}
{"timestamp":"2026-06-13T03:01:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Wrong session"}]}}"#,
        )
        .expect("rollout");

        let config = test_config(codex_home);
        let backfill = build_host_session_backfill(&config, "session-1", 10).expect("backfill");

        assert!(backfill.events.is_empty());
    }

    #[test]
    fn rollout_backfill_idempotency_keys_use_raw_record_identity() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let codex_home = tempdir.path();
        fs::create_dir_all(codex_home.join("sessions/2026/06/13")).expect("sessions dir");
        fs::write(
            codex_home.join("sessions/2026/06/13/rollout-session-1.jsonl"),
            r#"{"timestamp":"2026-06-13T03:00:00.000Z","type":"session_meta","payload":{"id":"session-1","cwd":"/tmp/project"}}
{"timestamp":"2026-06-13T03:01:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call-1","arguments":"{}"}}
{"timestamp":"2026-06-13T03:01:00.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call-2","arguments":"{}"}}"#,
        )
        .expect("rollout");

        let config = test_config(codex_home);
        let backfill = build_host_session_backfill(&config, "session-1", 10).expect("backfill");

        assert_eq!(backfill.events.len(), 2);
        assert_eq!(backfill.events[0].summary, backfill.events[1].summary);
        assert_ne!(
            backfill.events[0].idempotency_key,
            backfill.events[1].idempotency_key
        );
    }

    #[test]
    fn app_server_command_resumes_session_and_starts_turn() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": [
                        {
                            "id": "thread-live-1",
                            "sessionId": "session-tree-1",
                            "name": "Live thread",
                            "cwd": "/tmp/project",
                            "updatedAt": 1781263443
                        }
                    ],
                    "nextCursor": "cursor-page-2"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "thread": {
                        "id": "thread-live-1",
                        "sessionId": "session-tree-1",
                        "turns": []
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {
                    "turn": completed_turn("turn-1", "chaop-smoke")
                }
            }),
        ]);
        let config = AgentConfig {
            execution: ExecutionConfig {
                codex_timeout_seconds: 5,
                ..ExecutionConfig::default()
            },
            session_inventory: SessionInventoryConfig {
                app_server_url: Some(url),
                app_server_timeout_seconds: 1,
                ..SessionInventoryConfig::default()
            },
            ..test_config(tempdir.path())
        };

        let events = app_server_command_result_events_with_cancel(
            &config,
            "session-tree-1",
            Some("/tmp/attached-project"),
            "command-1",
            "Say exactly: chaop-smoke",
            Arc::new(AtomicBool::new(false)),
            None,
        );

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, "command.output");
        assert_eq!(events[0].summary, "Codex: chaop-smoke");
        assert_eq!(events[1].kind, "command.finished");
        assert_eq!(
            events[1].summary,
            "Codex app-server turn completed successfully."
        );

        let list_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/list request");
        let resume_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/resume request");
        let turn_start_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("turn/start request");

        assert_eq!(
            list_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/list")
        );
        assert_eq!(
            list_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            resume_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-live-1")
        );
        assert_eq!(
            resume_request
                .pointer("/params/cwd")
                .and_then(serde_json::Value::as_str),
            Some("/tmp/attached-project")
        );
        assert_eq!(
            turn_start_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-live-1")
        );
        assert_eq!(
            turn_start_request
                .pointer("/params/cwd")
                .and_then(serde_json::Value::as_str),
            Some("/tmp/attached-project")
        );
        assert_eq!(
            turn_start_request
                .pointer("/params/clientUserMessageId")
                .and_then(serde_json::Value::as_str),
            Some("command-1")
        );
        assert_eq!(
            turn_start_request
                .pointer("/params/approvalPolicy")
                .and_then(serde_json::Value::as_str),
            Some("on-request")
        );
        assert_eq!(
            turn_start_request
                .pointer("/params/approvalsReviewer")
                .and_then(serde_json::Value::as_str),
            Some("user")
        );
        assert_eq!(
            turn_start_request
                .pointer("/params/input/0/text")
                .and_then(serde_json::Value::as_str),
            Some("Say exactly: chaop-smoke")
        );
    }

    #[test]
    fn app_server_command_resumes_unlisted_session_from_rollout_path() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let codex_home = tempdir.path();
        let rollout_path = codex_home.join("sessions/2026/06/16/rollout-session-tree-1.jsonl");
        fs::create_dir_all(rollout_path.parent().expect("rollout parent")).expect("sessions dir");
        fs::write(
            &rollout_path,
            concat!(
                r#"{"timestamp":"2026-06-16T15:00:00.000Z","type":"session_meta","payload":{"id":"session-tree-1","cwd":"/tmp/project"}}"#,
                "\n",
                r#"{"timestamp":"2026-06-16T15:01:00.000Z","type":"turn_context","payload":{"cwd":"/tmp/project-from-turn"}}"#
            ),
        )
        .expect("rollout");
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": []
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "thread": {
                        "id": "thread-from-path",
                        "sessionId": "session-tree-1",
                        "cwd": "/tmp/project-from-response",
                        "turns": []
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {
                    "turn": completed_turn("turn-1", "path command")
                }
            }),
        ]);
        let config = AgentConfig {
            execution: ExecutionConfig {
                codex_timeout_seconds: 5,
                ..ExecutionConfig::default()
            },
            session_inventory: SessionInventoryConfig {
                codex_home: Some(codex_home.into()),
                app_server_url: Some(url),
                app_server_timeout_seconds: 1,
                ..SessionInventoryConfig::default()
            },
            ..test_config(tempdir.path())
        };

        let events = app_server_command_result_events_with_cancel(
            &config,
            "session-tree-1",
            Some("/tmp/attached-project"),
            "command-1",
            "Use the recovered thread",
            Arc::new(AtomicBool::new(false)),
            None,
        );

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].summary, "Codex: path command");
        assert_eq!(events[1].kind, "command.finished");

        let list_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/list request");
        let resume_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/resume request");
        let turn_start_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("turn/start request");

        assert_eq!(
            list_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            resume_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("session-tree-1")
        );
        assert_eq!(
            resume_request
                .pointer("/params/path")
                .and_then(serde_json::Value::as_str),
            Some(rollout_path.to_string_lossy().as_ref())
        );
        assert_eq!(
            resume_request
                .pointer("/params/cwd")
                .and_then(serde_json::Value::as_str),
            Some("/tmp/project-from-turn")
        );
        assert_eq!(
            resume_request
                .pointer("/params/runtimeWorkspaceRoots/0")
                .and_then(serde_json::Value::as_str),
            Some("/tmp/project-from-turn")
        );
        assert_eq!(
            turn_start_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-from-path")
        );
        assert_eq!(
            turn_start_request
                .pointer("/params/cwd")
                .and_then(serde_json::Value::as_str),
            Some("/tmp/project-from-response")
        );
        assert_eq!(
            turn_start_request
                .pointer("/params/runtimeWorkspaceRoots/0")
                .and_then(serde_json::Value::as_str),
            Some("/tmp/project-from-response")
        );
        assert_eq!(
            turn_start_request
                .pointer("/params/clientUserMessageId")
                .and_then(serde_json::Value::as_str),
            Some("command-1")
        );
    }

    #[test]
    fn app_server_command_requires_thread_id_after_rollout_path_resume() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let codex_home = tempdir.path();
        let rollout_path = codex_home.join("sessions/2026/06/16/rollout-session-tree-1.jsonl");
        fs::create_dir_all(rollout_path.parent().expect("rollout parent")).expect("sessions dir");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-06-16T15:00:00.000Z","type":"session_meta","payload":{"id":"session-tree-1","cwd":"/tmp/project"}}"#,
        )
        .expect("rollout");
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": []
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "thread": {
                        "sessionId": "session-tree-1",
                        "turns": []
                    }
                }
            }),
        ]);
        let config = AgentConfig {
            execution: ExecutionConfig {
                codex_timeout_seconds: 5,
                ..ExecutionConfig::default()
            },
            session_inventory: SessionInventoryConfig {
                codex_home: Some(codex_home.into()),
                app_server_url: Some(url),
                app_server_timeout_seconds: 1,
                ..SessionInventoryConfig::default()
            },
            ..test_config(tempdir.path())
        };

        let events = app_server_command_result_events_with_cancel(
            &config,
            "session-tree-1",
            Some("/tmp/attached-project"),
            "command-1",
            "Use the recovered thread",
            Arc::new(AtomicBool::new(false)),
            None,
        );

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "command.failed");
        assert_eq!(
            events[0].summary,
            "Codex app-server turn could not start: app-server thread/resume response did not include thread.id for rollout path resume."
        );

        let list_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/list request");
        let resume_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/resume request");
        assert_eq!(
            list_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            resume_request
                .pointer("/params/path")
                .and_then(serde_json::Value::as_str),
            Some(rollout_path.to_string_lossy().as_ref())
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn app_server_command_rejects_mismatched_rollout_resume_session_id() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let codex_home = tempdir.path();
        let rollout_path = codex_home.join("sessions/2026/06/16/rollout-session-tree-1.jsonl");
        fs::create_dir_all(rollout_path.parent().expect("rollout parent")).expect("sessions dir");
        fs::write(
            &rollout_path,
            r#"{"timestamp":"2026-06-16T15:00:00.000Z","type":"session_meta","payload":{"id":"session-tree-1","cwd":"/tmp/project"}}"#,
        )
        .expect("rollout");
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": []
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "thread": {
                        "id": "thread-from-path",
                        "sessionId": "session-other",
                        "turns": []
                    }
                }
            }),
        ]);
        let config = AgentConfig {
            execution: ExecutionConfig {
                codex_timeout_seconds: 5,
                ..ExecutionConfig::default()
            },
            session_inventory: SessionInventoryConfig {
                codex_home: Some(codex_home.into()),
                app_server_url: Some(url),
                app_server_timeout_seconds: 1,
                ..SessionInventoryConfig::default()
            },
            ..test_config(tempdir.path())
        };

        let events = app_server_command_result_events_with_cancel(
            &config,
            "session-tree-1",
            Some("/tmp/attached-project"),
            "command-1",
            "Use the recovered thread",
            Arc::new(AtomicBool::new(false)),
            None,
        );

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "command.failed");
        assert_eq!(
            events[0].summary,
            "Codex app-server turn could not start: app-server thread/resume returned session session-other while starting session session-tree-1."
        );

        let list_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/list request");
        let resume_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/resume request");
        assert_eq!(
            list_request
                .pointer("/params/archived")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            resume_request
                .pointer("/params/path")
                .and_then(serde_json::Value::as_str),
            Some(rollout_path.to_string_lossy().as_ref())
        );
        assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn app_server_command_resolves_session_beyond_archive_sync_page_budget() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let (url, requests) = run_fake_app_server_with_requests(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": [
                        {
                            "id": "thread-old-1",
                            "sessionId": "session-tree-old-1",
                            "updatedAt": 1781263000
                        }
                    ],
                    "nextCursor": "cursor-page-2"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "data": [
                        {
                            "id": "thread-old-2",
                            "sessionId": "session-tree-old-2",
                            "updatedAt": 1781263100
                        }
                    ],
                    "nextCursor": "cursor-page-3"
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {
                    "data": [
                        {
                            "id": "thread-live-1",
                            "sessionId": "session-tree-1",
                            "updatedAt": 1781263443
                        }
                    ]
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 4,
                "result": {
                    "thread": {
                        "id": "thread-live-1",
                        "sessionId": "session-tree-1",
                        "turns": []
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 5,
                "result": {
                    "turn": completed_turn("turn-1", "page-three command")
                }
            }),
        ]);
        let config = AgentConfig {
            execution: ExecutionConfig {
                codex_timeout_seconds: 5,
                ..ExecutionConfig::default()
            },
            session_inventory: SessionInventoryConfig {
                app_server_url: Some(url),
                app_server_timeout_seconds: 1,
                ..SessionInventoryConfig::default()
            },
            ..test_config(tempdir.path())
        };

        let events = app_server_command_result_events_with_cancel(
            &config,
            "session-tree-1",
            None,
            "command-1",
            "Find me on page three",
            Arc::new(AtomicBool::new(false)),
            None,
        );

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].summary, "Codex: page-three command");
        assert_eq!(events[1].kind, "command.finished");

        let first_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("first thread/list request");
        let second_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("second thread/list request");
        let third_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("third thread/list request");
        let resume_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/resume request");

        assert_eq!(
            first_request
                .pointer("/params/cursor")
                .and_then(serde_json::Value::as_str),
            None
        );
        assert_eq!(
            second_request
                .pointer("/params/cursor")
                .and_then(serde_json::Value::as_str),
            Some("cursor-page-2")
        );
        assert_eq!(
            third_request
                .pointer("/params/cursor")
                .and_then(serde_json::Value::as_str),
            Some("cursor-page-3")
        );
        assert_eq!(
            resume_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-live-1")
        );
    }

    #[test]
    fn app_server_command_reports_failed_turn() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let url = run_fake_app_server(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": [
                        {
                            "id": "thread-live-1",
                            "sessionId": "session-tree-1",
                            "updatedAt": 1781263443
                        }
                    ]
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "thread": {
                        "id": "thread-live-1",
                        "sessionId": "session-tree-1",
                        "turns": []
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {
                    "turn": failed_turn("turn-1", "approval denied")
                }
            }),
        ]);
        let config = AgentConfig {
            execution: ExecutionConfig {
                codex_timeout_seconds: 5,
                ..ExecutionConfig::default()
            },
            session_inventory: SessionInventoryConfig {
                app_server_url: Some(url),
                app_server_timeout_seconds: 1,
                ..SessionInventoryConfig::default()
            },
            ..test_config(tempdir.path())
        };

        let events = app_server_command_result_events_with_cancel(
            &config,
            "session-tree-1",
            None,
            "command-1",
            "Run risky command",
            Arc::new(AtomicBool::new(false)),
            None,
        );

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "command.failed");
        assert_eq!(
            events[0].summary,
            "Codex app-server turn failed: approval denied"
        );
    }

    #[test]
    fn app_server_command_waits_for_turn_completed_notification() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let url = run_fake_app_server(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": [
                        {
                            "id": "thread-live-1",
                            "sessionId": "session-tree-1",
                            "updatedAt": 1781263443
                        }
                    ]
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "thread": {
                        "id": "thread-live-1",
                        "sessionId": "session-tree-1",
                        "turns": []
                    }
                }
            }),
            json!([
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "result": {
                        "turn": in_progress_turn("turn-1")
                    }
                },
                {
                    "jsonrpc": "2.0",
                    "method": "turn/completed",
                    "params": {
                        "threadId": "thread-live-1",
                        "turn": completed_turn("turn-1", "done after notification")
                    }
                }
            ]),
        ]);
        let config = AgentConfig {
            execution: ExecutionConfig {
                codex_timeout_seconds: 5,
                ..ExecutionConfig::default()
            },
            session_inventory: SessionInventoryConfig {
                app_server_url: Some(url),
                app_server_timeout_seconds: 1,
                ..SessionInventoryConfig::default()
            },
            ..test_config(tempdir.path())
        };

        let events = app_server_command_result_events_with_cancel(
            &config,
            "session-tree-1",
            None,
            "command-1",
            "Wait for completion",
            Arc::new(AtomicBool::new(false)),
            None,
        );

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].summary, "Codex: done after notification");
        assert_eq!(events[1].kind, "command.finished");
    }

    #[test]
    fn app_server_command_forwards_command_approval_interaction() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let (url, _requests, app_responses) = run_fake_app_server_with_turn_interaction(json!({
            "jsonrpc": "2.0",
            "id": 80,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": "thread-live-1",
                "turnId": "turn-1",
                "itemId": "item-approval-1",
                "startedAtMs": 1781263443000_i64,
                "approvalId": null,
                "environmentId": null,
                "reason": "Needs write access",
                "command": "touch requested.txt",
                "cwd": "/tmp/project"
            }
        }));
        let config = AgentConfig {
            execution: ExecutionConfig {
                codex_timeout_seconds: 5,
                ..ExecutionConfig::default()
            },
            session_inventory: SessionInventoryConfig {
                app_server_url: Some(url),
                app_server_timeout_seconds: 1,
                ..SessionInventoryConfig::default()
            },
            ..test_config(tempdir.path())
        };
        let (event_tx, event_rx) = mpsc::channel();
        let (response_tx, response_rx) = mpsc::channel();

        let handle = thread::spawn(move || {
            app_server_command_result_events_with_cancel(
                &config,
                "session-tree-1",
                Some("/tmp/project"),
                "command-1",
                "Run approved command",
                Arc::new(AtomicBool::new(false)),
                Some(AppServerCommandChannels {
                    event_sender: event_tx,
                    interaction_receiver: response_rx,
                }),
            )
        });

        let event = event_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("approval event");
        assert_eq!(event.kind, "approval.requested");
        assert_eq!(
            event
                .payload
                .as_ref()
                .and_then(|payload| payload.get("subject"))
                .and_then(Value::as_str),
            Some("command_execution")
        );
        let interaction_id = event
            .payload
            .as_ref()
            .and_then(|payload| payload.get("interaction_id"))
            .and_then(Value::as_str)
            .expect("interaction id")
            .to_owned();
        response_tx
            .send(TurnInteractionResponseDispatch {
                command_id: "command-1".to_owned(),
                interaction_id,
                response: TurnInteractionResponse::Approval {
                    decision: "accept".to_owned(),
                },
                auto_resolved: false,
            })
            .expect("send interaction response");

        let app_response = app_responses
            .recv_timeout(Duration::from_secs(1))
            .expect("app-server interaction response");
        assert_eq!(
            app_response
                .pointer("/result/decision")
                .and_then(Value::as_str),
            Some("accept")
        );
        let events = handle.join().expect("command thread");
        assert_eq!(
            events.last().map(|event| event.kind.as_str()),
            Some("command.finished")
        );
    }

    #[test]
    fn app_server_command_forwards_permissions_approval_details() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let (url, _requests, app_responses) = run_fake_app_server_with_turn_interaction(json!({
            "jsonrpc": "2.0",
            "id": 83,
            "method": "item/permissions/requestApproval",
            "params": {
                "threadId": "thread-live-1",
                "turnId": "turn-1",
                "itemId": "item-permissions-1",
                "reason": "Needs access to inspect the workspace and fetch package metadata.",
                "cwd": "/tmp/project",
                "permissions": {
                    "network": {
                        "host": "registry.npmjs.org"
                    },
                    "fileSystem": {
                        "read": ["/tmp/project"],
                        "write": ["/tmp/project/package-lock.json"]
                    }
                }
            }
        }));
        let config = AgentConfig {
            execution: ExecutionConfig {
                codex_timeout_seconds: 5,
                ..ExecutionConfig::default()
            },
            session_inventory: SessionInventoryConfig {
                app_server_url: Some(url),
                app_server_timeout_seconds: 1,
                ..SessionInventoryConfig::default()
            },
            ..test_config(tempdir.path())
        };
        let (event_tx, event_rx) = mpsc::channel();
        let (response_tx, response_rx) = mpsc::channel();

        let handle = thread::spawn(move || {
            app_server_command_result_events_with_cancel(
                &config,
                "session-tree-1",
                Some("/tmp/project"),
                "command-1",
                "Inspect dependencies",
                Arc::new(AtomicBool::new(false)),
                Some(AppServerCommandChannels {
                    event_sender: event_tx,
                    interaction_receiver: response_rx,
                }),
            )
        });

        let event = event_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("permissions approval event");
        assert_eq!(event.kind, "approval.requested");
        assert_eq!(
            event
                .payload
                .as_ref()
                .and_then(|payload| payload.get("subject"))
                .and_then(Value::as_str),
            Some("permissions")
        );
        assert_eq!(
            event
                .payload
                .as_ref()
                .and_then(|payload| payload.pointer("/requested_permissions/network/host"))
                .and_then(Value::as_str),
            Some("registry.npmjs.org")
        );
        assert_eq!(
            event
                .payload
                .as_ref()
                .and_then(|payload| {
                    payload.pointer("/requested_permissions/fileSystem/write/0")
                })
                .and_then(Value::as_str),
            Some("/tmp/project/package-lock.json")
        );
        let interaction_id = event
            .payload
            .as_ref()
            .and_then(|payload| payload.get("interaction_id"))
            .and_then(Value::as_str)
            .expect("interaction id")
            .to_owned();
        response_tx
            .send(TurnInteractionResponseDispatch {
                command_id: "command-1".to_owned(),
                interaction_id,
                response: TurnInteractionResponse::Approval {
                    decision: "acceptForSession".to_owned(),
                },
                auto_resolved: false,
            })
            .expect("send permissions response");

        let app_response = app_responses
            .recv_timeout(Duration::from_secs(1))
            .expect("app-server permissions response");
        assert_eq!(
            app_response
                .pointer("/result/scope")
                .and_then(Value::as_str),
            Some("session")
        );
        assert_eq!(
            app_response
                .pointer("/result/permissions/network/host")
                .and_then(Value::as_str),
            Some("registry.npmjs.org")
        );
        let events = handle.join().expect("command thread");
        assert_eq!(
            events.last().map(|event| event.kind.as_str()),
            Some("command.finished")
        );
    }

    #[test]
    fn app_server_command_forwards_user_input_interaction() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let (url, _requests, app_responses) = run_fake_app_server_with_turn_interaction(json!({
            "jsonrpc": "2.0",
            "id": 81,
            "method": "item/tool/requestUserInput",
            "params": {
                "threadId": "thread-live-1",
                "turnId": "turn-1",
                "itemId": "item-input-1",
                "questions": [
                    {
                        "id": "q1",
                        "header": "Confirm",
                        "question": "Continue?",
                        "isOther": false,
                        "isSecret": false,
                        "options": [
                            {
                                "label": "Yes",
                                "description": "Continue this turn."
                            }
                        ]
                    }
                ],
                "autoResolutionMs": null
            }
        }));
        let config = AgentConfig {
            execution: ExecutionConfig {
                codex_timeout_seconds: 5,
                ..ExecutionConfig::default()
            },
            session_inventory: SessionInventoryConfig {
                app_server_url: Some(url),
                app_server_timeout_seconds: 1,
                ..SessionInventoryConfig::default()
            },
            ..test_config(tempdir.path())
        };
        let (event_tx, event_rx) = mpsc::channel();
        let (response_tx, response_rx) = mpsc::channel();

        let handle = thread::spawn(move || {
            app_server_command_result_events_with_cancel(
                &config,
                "session-tree-1",
                None,
                "command-1",
                "Ask for input",
                Arc::new(AtomicBool::new(false)),
                Some(AppServerCommandChannels {
                    event_sender: event_tx,
                    interaction_receiver: response_rx,
                }),
            )
        });

        let event = event_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("input event");
        assert_eq!(event.kind, "input.requested");
        assert_eq!(
            event
                .payload
                .as_ref()
                .and_then(|payload| payload.pointer("/questions/0/is_secret"))
                .and_then(Value::as_bool),
            Some(false)
        );
        let interaction_id = event
            .payload
            .as_ref()
            .and_then(|payload| payload.get("interaction_id"))
            .and_then(Value::as_str)
            .expect("interaction id")
            .to_owned();
        let mut answers = HashMap::new();
        answers.insert(
            "q1".to_owned(),
            TurnInteractionInputAnswer {
                answers: vec!["Yes".to_owned()],
            },
        );
        response_tx
            .send(TurnInteractionResponseDispatch {
                command_id: "command-1".to_owned(),
                interaction_id,
                response: TurnInteractionResponse::Input { answers },
                auto_resolved: false,
            })
            .expect("send input response");

        let app_response = app_responses
            .recv_timeout(Duration::from_secs(1))
            .expect("app-server input response");
        assert_eq!(
            app_response
                .pointer("/result/answers/q1/answers/0")
                .and_then(Value::as_str),
            Some("Yes")
        );
        let events = handle.join().expect("command thread");
        assert_eq!(
            events.last().map(|event| event.kind.as_str()),
            Some("command.finished")
        );
    }

    #[test]
    fn app_server_command_auto_resolves_user_input_interaction() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let (url, _requests, app_responses) = run_fake_app_server_with_turn_interaction(json!({
            "jsonrpc": "2.0",
            "id": 82,
            "method": "item/tool/requestUserInput",
            "params": {
                "threadId": "thread-live-1",
                "turnId": "turn-1",
                "itemId": "item-input-1",
                "questions": [
                    {
                        "id": "q1",
                        "header": "Confirm",
                        "question": "Continue?",
                        "isOther": false,
                        "isSecret": false
                    }
                ],
                "autoResolutionMs": 10
            }
        }));
        let config = AgentConfig {
            execution: ExecutionConfig {
                codex_timeout_seconds: 5,
                ..ExecutionConfig::default()
            },
            session_inventory: SessionInventoryConfig {
                app_server_url: Some(url),
                app_server_timeout_seconds: 1,
                ..SessionInventoryConfig::default()
            },
            ..test_config(tempdir.path())
        };
        let (event_tx, event_rx) = mpsc::channel();
        let (_response_tx, response_rx) = mpsc::channel();

        let handle = thread::spawn(move || {
            app_server_command_result_events_with_cancel(
                &config,
                "session-tree-1",
                None,
                "command-1",
                "Ask for input",
                Arc::new(AtomicBool::new(false)),
                Some(AppServerCommandChannels {
                    event_sender: event_tx,
                    interaction_receiver: response_rx,
                }),
            )
        });

        let event = event_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("input event");
        assert_eq!(event.kind, "input.requested");
        assert_eq!(
            event
                .payload
                .as_ref()
                .and_then(|payload| payload.get("auto_resolution_ms"))
                .and_then(Value::as_u64),
            Some(10)
        );

        let resolution_event = event_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("auto-resolution event");
        assert_eq!(resolution_event.kind, "input.received");
        assert_eq!(
            resolution_event
                .payload
                .as_ref()
                .and_then(|payload| payload.get("type"))
                .and_then(Value::as_str),
            Some("turn_interaction_resolution")
        );
        assert_eq!(
            resolution_event
                .payload
                .as_ref()
                .and_then(|payload| payload.get("answer_count"))
                .and_then(Value::as_u64),
            Some(0)
        );

        let app_response = app_responses
            .recv_timeout(Duration::from_secs(1))
            .expect("auto-resolved app-server input response");
        assert_eq!(
            app_response
                .pointer("/result/answers")
                .and_then(Value::as_object)
                .map(serde_json::Map::len),
            Some(0)
        );
        let events = handle.join().expect("command thread");
        assert_eq!(
            events.last().map(|event| event.kind.as_str()),
            Some("command.finished")
        );
    }

    #[test]
    fn app_server_turn_output_caps_delta_bytes() {
        let mut output = AppServerTurnOutput::new(5);

        output.push_agent_message_delta("abcd");
        output.push_agent_message_delta("éfg");
        output.push_agent_message_delta("x");

        assert_eq!(output.agent_message, "abcdx");
        assert!(output.agent_message.len() <= 5);
    }

    #[test]
    fn app_server_turn_wait_interrupts_when_cancelled_after_turn_id_is_known() {
        let (url, requests) = run_fake_app_server_single_request();
        let (mut socket, _) = tungstenite::connect(url.as_str()).expect("connect fake app-server");
        let cancel = AtomicBool::new(true);
        let mut next_request_id = 4;

        let result = super::wait_for_app_server_turn_completion(
            &mut socket,
            "thread-live-1",
            "turn-1",
            "command-1",
            Duration::from_secs(1),
            Instant::now() + Duration::from_secs(5),
            5,
            1024,
            &cancel,
            &mut next_request_id,
            None,
        );

        assert_eq!(result, Err(super::AppServerCommandError::Cancelled));
        assert_eq!(next_request_id, 5);
        let interrupt_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("turn/interrupt request");

        assert_eq!(
            interrupt_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("turn/interrupt")
        );
        assert_eq!(
            interrupt_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-live-1")
        );
        assert_eq!(
            interrupt_request
                .pointer("/params/turnId")
                .and_then(serde_json::Value::as_str),
            Some("turn-1")
        );
    }

    #[test]
    fn app_server_turn_start_interrupts_when_cancelled_before_turn_id_is_read() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let (url, requests, release_turn_start) = run_fake_app_server_with_gated_turn_start();
        let config = AgentConfig {
            execution: ExecutionConfig {
                codex_timeout_seconds: 5,
                ..ExecutionConfig::default()
            },
            session_inventory: SessionInventoryConfig {
                app_server_url: Some(url),
                app_server_timeout_seconds: 1,
                ..SessionInventoryConfig::default()
            },
            ..test_config(tempdir.path())
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let command_cancel = Arc::clone(&cancel);
        let handle = thread::spawn(move || {
            app_server_command_result_events_with_cancel(
                &config,
                "session-tree-1",
                Some("/tmp/attached-project"),
                "command-1",
                "Continue carefully",
                command_cancel,
                None,
            )
        });

        let list_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/list request");
        let resume_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("thread/resume request");
        let turn_start_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("turn/start request");
        assert_eq!(
            list_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/list")
        );
        assert_eq!(
            resume_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("thread/resume")
        );
        assert_eq!(
            turn_start_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("turn/start")
        );

        cancel.store(true, Ordering::Relaxed);
        release_turn_start
            .send(())
            .expect("release turn/start response");

        let interrupt_request = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("turn/interrupt request");
        assert_eq!(
            interrupt_request
                .get("method")
                .and_then(serde_json::Value::as_str),
            Some("turn/interrupt")
        );
        assert_eq!(
            interrupt_request
                .pointer("/params/threadId")
                .and_then(serde_json::Value::as_str),
            Some("thread-live-1")
        );
        assert_eq!(
            interrupt_request
                .pointer("/params/turnId")
                .and_then(serde_json::Value::as_str),
            Some("turn-race-1")
        );

        let events = handle.join().expect("command worker joins");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "command.failed");
        assert_eq!(
            events[0].summary,
            "Codex app-server turn was cancelled because the connector connection closed."
        );
    }

    #[test]
    fn app_server_command_omits_local_command_execution_output() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let url = run_fake_app_server(vec![
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "data": [
                        {
                            "id": "thread-live-1",
                            "sessionId": "session-tree-1",
                            "updatedAt": 1781263443
                        }
                    ]
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "thread": {
                        "id": "thread-live-1",
                        "sessionId": "session-tree-1",
                        "turns": []
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {
                    "turn": {
                        "id": "turn-1",
                        "items": [
                            {
                                "type": "commandExecution",
                                "id": "item-command-1",
                                "aggregatedOutput": "secret stdout should stay local"
                            },
                            {
                                "type": "agentMessage",
                                "id": "item-agent-1",
                                "text": "safe assistant summary",
                                "phase": null,
                                "memoryCitation": null
                            }
                        ],
                        "itemsView": "full",
                        "status": "completed",
                        "error": null,
                        "startedAt": 1781263443,
                        "completedAt": 1781263444,
                        "durationMs": 1000
                    }
                }
            }),
        ]);
        let config = AgentConfig {
            execution: ExecutionConfig {
                codex_timeout_seconds: 5,
                ..ExecutionConfig::default()
            },
            session_inventory: SessionInventoryConfig {
                app_server_url: Some(url),
                app_server_timeout_seconds: 1,
                ..SessionInventoryConfig::default()
            },
            ..test_config(tempdir.path())
        };

        let events = app_server_command_result_events_with_cancel(
            &config,
            "session-tree-1",
            None,
            "command-1",
            "Run local command",
            Arc::new(AtomicBool::new(false)),
            None,
        );

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].summary, "Codex: safe assistant summary");
        assert_eq!(events[1].kind, "command.finished");
        assert!(events.iter().all(|event| {
            !event.summary.contains("secret stdout")
                && !event.summary.contains("Codex app-server command output")
        }));
    }

    fn run_fake_app_server(responses: Vec<serde_json::Value>) -> String {
        run_fake_app_server_with_requests(responses).0
    }

    fn run_fake_app_server_with_turn_interaction(
        interaction_request: serde_json::Value,
    ) -> (
        String,
        Receiver<serde_json::Value>,
        Receiver<serde_json::Value>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake app-server");
        let address = listener.local_addr().expect("fake app-server address");
        let (requests_tx, requests_rx) = mpsc::channel();
        let (responses_tx, responses_rx) = mpsc::channel();
        thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept fake app-server client");
            let mut socket = accept(stream).expect("accept websocket");
            let initialize = read_fake_app_server_message(&mut socket);
            assert_eq!(
                initialize.get("method").and_then(serde_json::Value::as_str),
                Some("initialize")
            );
            socket
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 0,
                        "result": {
                            "userAgent": "codex-test",
                            "codexHome": "/tmp/codex",
                            "platformFamily": "unix",
                            "platformOs": "macos"
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .expect("send initialize response");

            let initialized = read_fake_app_server_message(&mut socket);
            assert_eq!(
                initialized
                    .get("method")
                    .and_then(serde_json::Value::as_str),
                Some("initialized")
            );

            let list_request = read_fake_app_server_message(&mut socket);
            let _ = requests_tx.send(list_request);
            socket
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "result": {
                            "data": [
                                {
                                    "id": "thread-live-1",
                                    "sessionId": "session-tree-1",
                                    "updatedAt": 1781263443
                                }
                            ]
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .expect("send thread/list response");

            let resume_request = read_fake_app_server_message(&mut socket);
            let _ = requests_tx.send(resume_request);
            socket
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 2,
                        "result": {
                            "thread": {
                                "id": "thread-live-1",
                                "sessionId": "session-tree-1",
                                "turns": []
                            }
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .expect("send thread/resume response");

            let turn_start_request = read_fake_app_server_message(&mut socket);
            let _ = requests_tx.send(turn_start_request);
            socket
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 3,
                        "result": {
                            "turn": in_progress_turn("turn-1")
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .expect("send turn/start response");

            socket
                .send(Message::Text(interaction_request.to_string().into()))
                .expect("send interaction request");
            let interaction_response = read_fake_app_server_message(&mut socket);
            let _ = responses_tx.send(interaction_response);
            socket
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0",
                        "method": "turn/completed",
                        "params": {
                            "threadId": "thread-live-1",
                            "turn": completed_turn("turn-1", "interaction complete")
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .expect("send turn/completed notification");
        });
        (format!("ws://{address}"), requests_rx, responses_rx)
    }

    fn completed_turn(turn_id: &str, text: &str) -> serde_json::Value {
        json!({
            "id": turn_id,
            "items": [
                {
                    "type": "agentMessage",
                    "id": "item-agent-1",
                    "text": text,
                    "phase": null,
                    "memoryCitation": null
                }
            ],
            "itemsView": "full",
            "status": "completed",
            "error": null,
            "startedAt": 1781263443,
            "completedAt": 1781263444,
            "durationMs": 1000
        })
    }

    fn failed_turn(turn_id: &str, message: &str) -> serde_json::Value {
        json!({
            "id": turn_id,
            "items": [],
            "itemsView": "full",
            "status": "failed",
            "error": {
                "message": message,
                "codexErrorInfo": "other",
                "additionalDetails": null
            },
            "startedAt": 1781263443,
            "completedAt": 1781263444,
            "durationMs": 1000
        })
    }

    fn in_progress_turn(turn_id: &str) -> serde_json::Value {
        json!({
            "id": turn_id,
            "items": [],
            "itemsView": "summary",
            "status": "inProgress",
            "error": null,
            "startedAt": 1781263443,
            "completedAt": null,
            "durationMs": null
        })
    }

    fn app_server_thread_list_response() -> serde_json::Value {
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "data": [
                    {
                        "id": "thread-1",
                        "sessionId": "session-tree-1",
                        "name": "Thread title",
                        "cwd": "/tmp/project",
                        "updatedAt": 1781263443
                    }
                ]
            }
        })
    }

    fn test_config(codex_home: &std::path::Path) -> AgentConfig {
        AgentConfig {
            connector_name: "mac-studio".to_owned(),
            control_url: "wss://api.example.com/ws/agent".to_owned(),
            bootstrap_url: "https://api.example.com/connector/bootstrap".to_owned(),
            workspace_root: "/tmp/project".into(),
            token_file: "/tmp/token".into(),
            spool_db: "/tmp/spool.sqlite".into(),
            bootstrap: BootstrapConfig {
                secret_file: "/tmp/bootstrap.secret".into(),
            },
            execution: ExecutionConfig::default(),
            session_inventory: SessionInventoryConfig {
                codex_home: Some(codex_home.into()),
                app_server_url: None,
                ..SessionInventoryConfig::default()
            },
        }
    }

    fn run_fake_app_server_with_requests(
        responses: Vec<serde_json::Value>,
    ) -> (String, Receiver<serde_json::Value>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake app-server");
        let address = listener.local_addr().expect("fake app-server address");
        let (requests_tx, requests_rx) = mpsc::channel();
        thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept fake app-server client");
            let mut socket = accept(stream).expect("accept websocket");
            let initialize = read_fake_app_server_message(&mut socket);
            assert_eq!(
                initialize.get("id").and_then(serde_json::Value::as_i64),
                Some(0)
            );
            assert_eq!(
                initialize.get("method").and_then(serde_json::Value::as_str),
                Some("initialize")
            );
            assert_eq!(
                initialize
                    .get("params")
                    .and_then(|params| params.get("clientInfo"))
                    .and_then(|info| info.get("name"))
                    .and_then(serde_json::Value::as_str),
                Some("chaop-agent")
            );
            assert_eq!(
                initialize
                    .get("params")
                    .and_then(|params| params.get("capabilities"))
                    .and_then(|capabilities| capabilities.get("experimentalApi"))
                    .and_then(serde_json::Value::as_bool),
                Some(true)
            );
            socket
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 0,
                        "result": {
                            "userAgent": "codex-test",
                            "codexHome": "/tmp/codex",
                            "platformFamily": "unix",
                            "platformOs": "macos"
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .expect("send initialize response");

            let initialized = read_fake_app_server_message(&mut socket);
            assert_eq!(
                initialized
                    .get("method")
                    .and_then(serde_json::Value::as_str),
                Some("initialized")
            );
            assert!(initialized.get("id").is_none());

            for response in responses {
                let request = read_fake_app_server_message(&mut socket);
                let _ = requests_tx.send(request);
                if let Some(messages) = response.as_array() {
                    for message in messages {
                        socket
                            .send(Message::Text(message.to_string().into()))
                            .expect("send app-server response message");
                    }
                } else {
                    socket
                        .send(Message::Text(response.to_string().into()))
                        .expect("send app-server response");
                }
            }
        });
        (format!("ws://{address}"), requests_rx)
    }

    fn run_fake_app_server_with_unmatched_resume_messages() -> (String, Receiver<serde_json::Value>)
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake app-server");
        let address = listener.local_addr().expect("fake app-server address");
        let (requests_tx, requests_rx) = mpsc::channel();
        thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept fake app-server client");
            let mut socket = accept(stream).expect("accept websocket");
            let initialize = read_fake_app_server_message(&mut socket);
            assert_eq!(
                initialize.get("id").and_then(serde_json::Value::as_i64),
                Some(0)
            );
            assert_eq!(
                initialize.get("method").and_then(serde_json::Value::as_str),
                Some("initialize")
            );
            socket
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 0,
                        "result": {
                            "userAgent": "codex-test",
                            "codexHome": "/tmp/codex",
                            "platformFamily": "unix",
                            "platformOs": "macos"
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .expect("send initialize response");

            let initialized = read_fake_app_server_message(&mut socket);
            assert_eq!(
                initialized
                    .get("method")
                    .and_then(serde_json::Value::as_str),
                Some("initialized")
            );

            let list_request = read_fake_app_server_message(&mut socket);
            let _ = requests_tx.send(list_request);
            socket
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "result": {
                            "data": [
                                {
                                    "id": "thread-live-1",
                                    "sessionId": "session-1",
                                    "name": "Recovered title",
                                    "cwd": "/tmp/project",
                                    "updatedAt": 1781263443
                                }
                            ]
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .expect("send thread/list response");

            let resume_request = read_fake_app_server_message(&mut socket);
            let _ = requests_tx.send(resume_request);
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(2) {
                if socket
                    .send(Message::Text(
                        json!({
                            "jsonrpc": "2.0",
                            "method": "thread/background",
                            "params": {}
                        })
                        .to_string()
                        .into(),
                    ))
                    .is_err()
                {
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
        });
        (format!("ws://{address}"), requests_rx)
    }

    fn run_fake_app_server_with_gated_turn_start()
    -> (String, Receiver<serde_json::Value>, Sender<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake app-server");
        let address = listener.local_addr().expect("fake app-server address");
        let (requests_tx, requests_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept fake app-server client");
            let mut socket = accept(stream).expect("accept websocket");
            let initialize = read_fake_app_server_message(&mut socket);
            assert_eq!(
                initialize.get("id").and_then(serde_json::Value::as_i64),
                Some(0)
            );
            assert_eq!(
                initialize.get("method").and_then(serde_json::Value::as_str),
                Some("initialize")
            );
            socket
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 0,
                        "result": {
                            "userAgent": "codex-test",
                            "codexHome": "/tmp/codex",
                            "platformFamily": "unix",
                            "platformOs": "macos"
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .expect("send initialize response");

            let initialized = read_fake_app_server_message(&mut socket);
            assert_eq!(
                initialized
                    .get("method")
                    .and_then(serde_json::Value::as_str),
                Some("initialized")
            );

            let list_request = read_fake_app_server_message(&mut socket);
            let _ = requests_tx.send(list_request);
            socket
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "result": {
                            "data": [
                                {
                                    "id": "thread-live-1",
                                    "sessionId": "session-tree-1",
                                    "updatedAt": 1781263443
                                }
                            ]
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .expect("send thread/list response");

            let resume_request = read_fake_app_server_message(&mut socket);
            let _ = requests_tx.send(resume_request);
            socket
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 2,
                        "result": {
                            "thread": {
                                "id": "thread-live-1",
                                "sessionId": "session-tree-1",
                                "turns": []
                            }
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .expect("send thread/resume response");

            let turn_start_request = read_fake_app_server_message(&mut socket);
            let _ = requests_tx.send(turn_start_request);
            release_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("release turn/start response");
            socket
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 3,
                        "result": {
                            "turn": in_progress_turn("turn-race-1")
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .expect("send turn/start response");

            let interrupt_request = read_fake_app_server_message(&mut socket);
            let _ = requests_tx.send(interrupt_request);
        });
        (format!("ws://{address}"), requests_rx, release_tx)
    }

    fn run_fake_app_server_single_request() -> (String, Receiver<serde_json::Value>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake app-server");
        let address = listener.local_addr().expect("fake app-server address");
        let (requests_tx, requests_rx) = mpsc::channel();
        thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept fake app-server client");
            let mut socket = accept(stream).expect("accept websocket");
            let request = read_fake_app_server_message(&mut socket);
            let _ = requests_tx.send(request);
        });
        (format!("ws://{address}"), requests_rx)
    }

    fn read_fake_app_server_message(
        socket: &mut tungstenite::WebSocket<TcpStream>,
    ) -> serde_json::Value {
        let message = socket.read().expect("read app-server request");
        let Message::Text(text) = message else {
            panic!("expected text message");
        };
        serde_json::from_str(text.as_ref()).expect("valid app-server json")
    }
}
