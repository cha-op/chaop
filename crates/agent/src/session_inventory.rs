use crate::config::AgentConfig;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tungstenite::{Message, connect};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentHostSessionsReport {
    pub sessions: Vec<AgentHostSession>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentHostSession {
    pub session_id: String,
    pub title: String,
    pub title_source: TitleSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub updated_at: String,
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
    let app_server_titles = config
        .session_inventory
        .app_server_url
        .as_deref()
        .and_then(|url| {
            load_app_server_titles(
                url,
                config.session_inventory.max_sessions,
                config.session_inventory.app_server_timeout_seconds,
            )
            .ok()
        })
        .unwrap_or_default();

    for session_id in app_server_titles.keys() {
        drafts
            .entry(session_id.clone())
            .or_insert_with(|| SessionDraft {
                session_id: session_id.clone(),
                ..SessionDraft::default()
            });
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
            let app_title = app_server_titles.get(&draft.session_id).cloned();
            resolve_session(draft, app_title, &history_sessions)
        })
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions.truncate(config.session_inventory.max_sessions);

    Ok(AgentHostSessionsReport { sessions })
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

fn rollout_scan_limit(max_sessions: usize) -> usize {
    max_sessions.saturating_mul(3).clamp(50, 500)
}

fn metadata_scan_limit(max_sessions: usize) -> usize {
    max_sessions.saturating_mul(5).clamp(50, 1000)
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

fn load_app_server_titles(
    url: &str,
    limit: usize,
    timeout_seconds: u64,
) -> Result<HashMap<String, String>, Box<dyn std::error::Error>> {
    let (mut socket, _) = connect(url)?;
    configure_socket_timeout(&mut socket, Duration::from_secs(timeout_seconds.max(1)))?;
    socket.send(Message::Text(
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "thread/list",
            "params": {
                "archived": null,
                "limit": limit,
                "sortDirection": "desc",
                "useStateDbOnly": true
            }
        })
        .to_string()
        .into(),
    ))?;

    loop {
        match socket.read()? {
            Message::Text(text) => {
                let value = serde_json::from_str::<Value>(text.as_ref())?;
                if value.get("id").and_then(Value::as_i64) == Some(1) {
                    return Ok(app_server_titles_from_response(&value));
                }
            }
            Message::Close(_) => return Ok(HashMap::new()),
            _ => {}
        }
    }
}

fn configure_socket_timeout(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>,
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

fn app_server_titles_from_response(value: &Value) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    let Some(data) = value
        .get("result")
        .and_then(|result| result.get("data"))
        .and_then(Value::as_array)
    else {
        return titles;
    };
    for thread in data {
        let Some(session_id) = thread.get("sessionId").and_then(Value::as_str) else {
            continue;
        };
        let Some(name) = compact_title(thread.get("name").and_then(Value::as_str)) else {
            continue;
        };
        titles.insert(session_id.to_owned(), name);
    }
    titles
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

fn create_app_server_thread_at(
    url: &str,
    title: Option<&str>,
    cwd: &str,
    timeout_seconds: u64,
) -> Result<AgentHostSession, Box<dyn std::error::Error>> {
    let (mut socket, _) = connect(url)?;
    configure_socket_timeout(&mut socket, Duration::from_secs(timeout_seconds.max(1)))?;
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
        cwd: started.cwd,
        updated_at: started.updated_at,
    })
}

fn send_app_server_request(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>,
    id: i64,
    method: &str,
    params: Value,
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
        match socket.read()? {
            Message::Text(text) => {
                let value = serde_json::from_str::<Value>(text.as_ref())?;
                if value.get("id").and_then(Value::as_i64) != Some(id) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    return Err(app_server_error(method, error).into());
                }
                return Ok(value);
            }
            Message::Close(_) => {
                return Err(format!("app-server closed before {method} completed").into());
            }
            _ => {}
        }
    }
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
    let session_id = thread
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or("app-server thread/start response did not include thread.sessionId")?;
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
        HistorySession, SessionDraft, TitleSource, app_server_thread_from_response,
        app_server_titles_from_response, build_host_sessions_report, create_app_server_thread_at,
        read_recent_lines, resolve_session, rollout_paths, unix_seconds_to_iso,
    };
    use crate::config::{AgentConfig, BootstrapConfig, ExecutionConfig, SessionInventoryConfig};
    use serde_json::json;
    use std::collections::HashMap;
    use std::fs;
    use std::net::TcpListener;
    use std::thread;
    use tungstenite::{Message, accept};

    #[test]
    fn title_resolution_prefers_metadata_over_history() {
        let draft = SessionDraft {
            session_id: "session-1".to_owned(),
            metadata_title: Some("Metadata title".to_owned()),
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
    }

    #[test]
    fn title_resolution_uses_app_server_before_history() {
        let draft = SessionDraft {
            session_id: "session-1".to_owned(),
            metadata_title: None,
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
    }

    #[test]
    fn parses_app_server_thread_names() {
        let response = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "data": [
                    { "sessionId": "session-1", "name": "App server title" },
                    { "sessionId": "session-2", "name": null }
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
    fn parses_app_server_thread_start_response() {
        let response = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "thread": {
                    "id": "thread-1",
                    "sessionId": "session-1",
                    "name": "Created title",
                    "cwd": "/tmp/project",
                    "updatedAt": 1781263443
                }
            }
        });

        let thread = app_server_thread_from_response(&response).expect("thread");

        assert_eq!(thread.id, "thread-1");
        assert_eq!(thread.session_id, "session-1");
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
                        "sessionId": "session-1",
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

        assert_eq!(session.session_id, "session-1");
        assert_eq!(session.title, "Requested title");
        assert_eq!(session.title_source, TitleSource::AppServer);
        assert_eq!(session.cwd.as_deref(), Some("/tmp/project"));
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
                        "sessionId": "session-1",
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

        assert_eq!(session.session_id, "session-1");
        assert_eq!(session.title, "Requested title");
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

        assert_eq!(report.sessions.len(), 3);
        assert_eq!(report.sessions[0].session_id, "session-3");
        assert_eq!(report.sessions[0].title, "History-only prompt");
        assert_eq!(report.sessions[0].title_source, TitleSource::History);
        assert_eq!(report.sessions[1].title, "History title from first prompt");
        assert_eq!(report.sessions[2].title, "Metadata index title");
    }

    fn run_fake_app_server(responses: Vec<serde_json::Value>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake app-server");
        let address = listener.local_addr().expect("fake app-server address");
        thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept fake app-server client");
            let mut socket = accept(stream).expect("accept websocket");
            for response in responses {
                let message = socket.read().expect("read app-server request");
                assert!(matches!(message, Message::Text(_)));
                socket
                    .send(Message::Text(response.to_string().into()))
                    .expect("send app-server response");
            }
        });
        format!("ws://{address}")
    }
}
