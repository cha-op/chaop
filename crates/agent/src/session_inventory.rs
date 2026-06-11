use crate::config::AgentConfig;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
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

    read_session_index(&codex_home, &mut drafts)?;
    read_rollouts(&codex_home, &mut drafts)?;
    let history_titles = read_history_titles(&codex_home)?;
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

    let mut sessions = drafts
        .into_values()
        .map(|draft| {
            let app_title = app_server_titles.get(&draft.session_id).cloned();
            resolve_session(draft, app_title, &history_titles)
        })
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions.truncate(config.session_inventory.max_sessions);

    Ok(AgentHostSessionsReport { sessions })
}

fn read_session_index(
    codex_home: &Path,
    drafts: &mut HashMap<String, SessionDraft>,
) -> std::io::Result<()> {
    let path = codex_home.join("session_index.jsonl");
    if !path.exists() {
        return Ok(());
    }
    for line in fs::read_to_string(path)?.lines() {
        let Ok(entry) = serde_json::from_str::<SessionIndexLine>(line) else {
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

fn read_history_titles(codex_home: &Path) -> std::io::Result<HashMap<String, String>> {
    let path = codex_home.join("history.jsonl");
    let mut titles = HashMap::new();
    if !path.exists() {
        return Ok(titles);
    }
    for line in fs::read_to_string(path)?.lines() {
        let Ok(entry) = serde_json::from_str::<HistoryLine>(line) else {
            continue;
        };
        if titles.contains_key(&entry.session_id) {
            continue;
        }
        if let Some(text) = compact_title(entry.text.as_deref()) {
            titles.insert(entry.session_id, text);
        }
    }
    Ok(titles)
}

fn read_rollouts(
    codex_home: &Path,
    drafts: &mut HashMap<String, SessionDraft>,
) -> std::io::Result<()> {
    let sessions_dir = codex_home.join("sessions");
    if !sessions_dir.exists() {
        return Ok(());
    }
    for path in rollout_paths(&sessions_dir)? {
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

fn rollout_paths(root: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    collect_rollout_paths(root, &mut paths)?;
    Ok(paths)
}

fn collect_rollout_paths(path: &Path, paths: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_rollout_paths(&path, paths)?;
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        {
            paths.push(path);
        }
    }
    Ok(())
}

fn resolve_session(
    draft: SessionDraft,
    app_server_title: Option<String>,
    history_titles: &HashMap<String, String>,
) -> AgentHostSession {
    let (title, title_source) = if let Some(title) = compact_title(draft.metadata_title.as_deref()) {
        (title, TitleSource::Metadata)
    } else if let Some(title) = compact_title(app_server_title.as_deref()) {
        (title, TitleSource::AppServer)
    } else if let Some(title) =
        compact_title(history_titles.get(&draft.session_id).map(String::as_str))
    {
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
        SessionDraft, TitleSource, app_server_titles_from_response, build_host_sessions_report,
        resolve_session,
    };
    use crate::config::{
        AgentConfig, BootstrapConfig, ExecutionConfig, SessionInventoryConfig,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::fs;

    #[test]
    fn title_resolution_prefers_metadata_over_history() {
        let draft = SessionDraft {
            session_id: "session-1".to_owned(),
            metadata_title: Some("Metadata title".to_owned()),
            cwd: Some("/tmp/project".to_owned()),
            updated_at: Some("2026-06-11T10:00:00.000Z".to_owned()),
        };
        let mut history = HashMap::new();
        history.insert("session-1".to_owned(), "History title".to_owned());

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
        history.insert("session-1".to_owned(), "History title".to_owned());

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

        assert_eq!(titles.get("session-1").map(String::as_str), Some("App server title"));
        assert!(!titles.contains_key("session-2"));
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
            r#"{"session_id":"session-2","text":"History title from first prompt"}"#,
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
            bootstrap_url: "https://api.example.com/api/agent/bootstrap".to_owned(),
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

        assert_eq!(report.sessions.len(), 2);
        assert_eq!(report.sessions[0].title, "Metadata index title");
        assert_eq!(report.sessions[1].title, "History title from first prompt");
    }
}
