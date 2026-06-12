use crate::config::{AgentConfig, ExecutionMode};
use crate::executor::{codex_exec_result_events, codex_exec_started_event};
use crate::placeholder::ConnectorEvent;
use crate::placeholder::placeholder_event_stream;
use crate::session_inventory::build_host_sessions_report;
use serde::Deserialize;
use serde_json::json;
use std::collections::VecDeque;
use std::fs;
use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::mpsc::{self, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;
use tungstenite::{Error as WebSocketError, Message, connect};

type AgentSocket = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>;
const CONNECTOR_READ_TICK_SECONDS: u64 = 5;
const CONNECTOR_RECONNECT_BACKOFF_SECONDS: u64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunMode {
    Continuous,
    Once,
}

#[derive(Debug, Deserialize)]
struct Envelope {
    kind: String,
    payload: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct CommandDispatch {
    command: CommandPayload,
}

#[derive(Debug, Deserialize)]
struct CommandPayload {
    id: String,
    #[serde(rename = "type", default)]
    command_type: CommandType,
    prompt: String,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CommandType {
    #[default]
    Placeholder,
    Codex,
}

pub fn run_connector(
    config: &AgentConfig,
    run_mode: RunMode,
) -> Result<(), Box<dyn std::error::Error>> {
    loop {
        match run_connected_session(config, run_mode) {
            Ok(()) if run_mode == RunMode::Once => return Ok(()),
            Ok(()) => {}
            Err(error) if run_mode == RunMode::Once => return Err(error),
            Err(error) => {
                eprintln!("connector connection ended: {error}; reconnecting");
            }
        }
        thread::sleep(reconnect_backoff());
    }
}

fn run_connected_session(
    config: &AgentConfig,
    run_mode: RunMode,
) -> Result<(), Box<dyn std::error::Error>> {
    let token = fs::read_to_string(&config.token_file)?.trim().to_owned();
    if token.is_empty() {
        return Err("connector token file is empty".into());
    }

    let mut request = config.control_url.as_str().into_client_request()?;
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {token}").parse()?);

    let (mut socket, _) = connect(request)?;
    configure_socket(&mut socket)?;
    set_socket_read_timeout(&mut socket, Some(connector_read_tick()))?;
    socket.send(Message::Text(
        json!({ "kind": "agent.ready" }).to_string().into(),
    ))?;
    let mut last_host_sessions_message = None;
    let mut deferred_messages = VecDeque::<String>::new();
    send_host_sessions(&mut socket, config, &mut last_host_sessions_message, true)?;
    let mut next_host_sessions_at = Instant::now() + host_sessions_interval(config);

    loop {
        let message = match deferred_messages.pop_front() {
            Some(text) => Message::Text(text.into()),
            None => match socket.read() {
                Ok(message) => message,
                Err(error) if is_read_timeout(&error) => {
                    if Instant::now() >= next_host_sessions_at {
                        send_host_sessions(
                            &mut socket,
                            config,
                            &mut last_host_sessions_message,
                            false,
                        )?;
                        next_host_sessions_at = Instant::now() + host_sessions_interval(config);
                    }
                    continue;
                }
                Err(error) => return Err(error.into()),
            },
        };
        match message {
            Message::Text(text) => {
                if handle_text_message(
                    &mut socket,
                    text.as_ref(),
                    config,
                    &mut last_host_sessions_message,
                    &mut deferred_messages,
                )? && run_mode == RunMode::Once
                {
                    socket.close(None)?;
                    return Ok(());
                }
                set_socket_read_timeout(&mut socket, Some(connector_read_tick()))?;
            }
            Message::Ping(payload) => socket.send(Message::Pong(payload))?,
            Message::Close(_) => return Ok(()),
            _ => {}
        }
    }
}

fn send_host_sessions(
    socket: &mut AgentSocket,
    config: &AgentConfig,
    last_sent: &mut Option<String>,
    force: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let Some(message) = host_sessions_message(config) else {
        return Ok(());
    };
    if !force && last_sent.as_deref() == Some(message.as_str()) {
        return Ok(());
    }
    socket.send(Message::Text(message.clone().into()))?;
    *last_sent = Some(message);
    Ok(())
}

fn host_sessions_message(config: &AgentConfig) -> Option<String> {
    let Ok(report) = build_host_sessions_report(config) else {
        return None;
    };
    Some(
        json!({
            "kind": "agent.host_sessions",
            "payload": report
        })
        .to_string(),
    )
}

fn handle_text_message(
    socket: &mut AgentSocket,
    text: &str,
    config: &AgentConfig,
    last_host_sessions_message: &mut Option<String>,
    deferred_messages: &mut VecDeque<String>,
) -> Result<bool, Box<dyn std::error::Error>> {
    let envelope: Envelope = serde_json::from_str(text)?;
    if envelope.kind == "host_sessions.refresh" {
        send_host_sessions(socket, config, last_host_sessions_message, true)?;
        return Ok(false);
    }

    if envelope.kind != "command.dispatch" {
        return Ok(false);
    }

    let dispatch: CommandDispatch = serde_json::from_value(envelope.payload)?;
    if dispatch.command.command_type == CommandType::Codex
        && config.execution.mode == ExecutionMode::CodexExec
    {
        dispatch_events(
            socket,
            &dispatch.command,
            vec![codex_exec_started_event(&config.workspace_root)],
            config,
            last_host_sessions_message,
            deferred_messages,
        )?;
        let events = wait_for_codex_exec_events(
            socket,
            config,
            &dispatch.command.prompt,
            last_host_sessions_message,
            deferred_messages,
        );
        dispatch_events(
            socket,
            &dispatch.command,
            events?,
            config,
            last_host_sessions_message,
            deferred_messages,
        )?;
        return Ok(true);
    }

    dispatch_events(
        socket,
        &dispatch.command,
        command_events(&dispatch.command),
        config,
        last_host_sessions_message,
        deferred_messages,
    )?;
    Ok(true)
}

fn wait_for_codex_exec_events(
    socket: &mut AgentSocket,
    config: &AgentConfig,
    prompt: &str,
    last_host_sessions_message: &mut Option<String>,
    deferred_messages: &mut VecDeque<String>,
) -> Result<Vec<ConnectorEvent>, Box<dyn std::error::Error>> {
    let execution = config.execution.clone();
    let workspace_root = config.workspace_root.clone();
    let prompt = prompt.to_owned();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let events = codex_exec_result_events(&execution, &workspace_root, &prompt);
        let _ = sender.send(events);
    });

    set_socket_read_timeout(socket, Some(connector_read_tick()))?;
    loop {
        match receiver.try_recv() {
            Ok(events) => {
                set_socket_read_timeout(socket, Some(connector_read_tick()))?;
                return Ok(events);
            }
            Err(TryRecvError::Disconnected) => {
                return Err("codex exec worker stopped before returning events".into());
            }
            Err(TryRecvError::Empty) => {}
        }

        match socket.read() {
            Ok(Message::Text(text)) => {
                handle_background_text_message(
                    socket,
                    text.as_ref(),
                    config,
                    last_host_sessions_message,
                    deferred_messages,
                )?;
            }
            Ok(Message::Ping(payload)) => socket.send(Message::Pong(payload))?,
            Ok(Message::Close(_)) => {
                return Err("connection closed while codex exec was running".into());
            }
            Ok(_) => {}
            Err(error) if is_read_timeout(&error) => {}
            Err(error) => return Err(error.into()),
        }
    }
}

fn handle_background_text_message(
    socket: &mut AgentSocket,
    text: &str,
    config: &AgentConfig,
    last_host_sessions_message: &mut Option<String>,
    deferred_messages: &mut VecDeque<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let envelope: Envelope = serde_json::from_str(text)?;
    if envelope.kind == "host_sessions.refresh" {
        send_host_sessions(socket, config, last_host_sessions_message, true)?;
    } else {
        deferred_messages.push_back(text.to_owned());
    }
    Ok(())
}

fn command_events(command: &CommandPayload) -> Vec<ConnectorEvent> {
    match command.command_type {
        CommandType::Placeholder => placeholder_event_stream(&command.prompt),
        CommandType::Codex => vec![
            ConnectorEvent {
                kind: "command.started".to_owned(),
                priority: "P1".to_owned(),
                summary: "Connector received a Codex command, but codex_exec is disabled."
                    .to_owned(),
            },
            ConnectorEvent {
                kind: "command.failed".to_owned(),
                priority: "P1".to_owned(),
                summary: "Codex exec is disabled in this connector config.".to_owned(),
            },
        ],
    }
}

fn dispatch_events(
    socket: &mut AgentSocket,
    command: &CommandPayload,
    events: Vec<ConnectorEvent>,
    config: &AgentConfig,
    last_host_sessions_message: &mut Option<String>,
    deferred_messages: &mut VecDeque<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    for event in events {
        if event.kind == "command.accepted" {
            continue;
        }
        socket.send(Message::Text(
            json!({
                "kind": "agent.event",
                "payload": {
                    "command_id": command.id,
                    "kind": event.kind,
                    "priority": event.priority,
                    "summary": event.summary
                }
            })
            .to_string()
            .into(),
        ))?;
        wait_for_ack(
            socket,
            &command.id,
            &event.kind,
            config,
            last_host_sessions_message,
            deferred_messages,
        )?;
    }
    Ok(())
}

fn configure_socket(socket: &mut AgentSocket) -> std::io::Result<()> {
    match socket.get_mut() {
        tungstenite::stream::MaybeTlsStream::Plain(stream) => {
            stream.set_write_timeout(Some(Duration::from_secs(10)))
        }
        tungstenite::stream::MaybeTlsStream::NativeTls(stream) => stream
            .get_ref()
            .set_write_timeout(Some(Duration::from_secs(10))),
        _ => Ok(()),
    }
}

fn connector_read_tick() -> Duration {
    Duration::from_secs(CONNECTOR_READ_TICK_SECONDS)
}

fn host_sessions_interval(config: &AgentConfig) -> Duration {
    Duration::from_secs(config.session_inventory.report_interval_seconds.max(1))
}

fn reconnect_backoff() -> Duration {
    Duration::from_secs(CONNECTOR_RECONNECT_BACKOFF_SECONDS)
}

fn is_read_timeout(error: &WebSocketError) -> bool {
    matches!(
        error,
        WebSocketError::Io(io_error)
            if io_error.kind() == ErrorKind::WouldBlock || io_error.kind() == ErrorKind::TimedOut
    )
}

fn wait_for_ack(
    socket: &mut AgentSocket,
    command_id: &str,
    event_kind: &str,
    config: &AgentConfig,
    last_host_sessions_message: &mut Option<String>,
    deferred_messages: &mut VecDeque<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    set_socket_read_timeout(socket, Some(Duration::from_secs(10)))?;
    loop {
        match socket.read()? {
            Message::Text(text) => {
                match classify_ack_wait_text(text.as_ref(), command_id, event_kind)? {
                    AckWaitAction::Matched => {
                        set_socket_read_timeout(socket, None)?;
                        return Ok(());
                    }
                    AckWaitAction::HostSessionsRefresh => {
                        send_host_sessions(socket, config, last_host_sessions_message, true)?;
                    }
                    AckWaitAction::Defer => deferred_messages.push_back(text.to_string()),
                }
            }
            Message::Ping(payload) => socket.send(Message::Pong(payload))?,
            Message::Close(_) => {
                set_socket_read_timeout(socket, None)?;
                return Err("connection closed before command acknowledgement".into());
            }
            _ => {}
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AckWaitAction {
    Matched,
    HostSessionsRefresh,
    Defer,
}

fn classify_ack_wait_text(
    text: &str,
    command_id: &str,
    event_kind: &str,
) -> Result<AckWaitAction, serde_json::Error> {
    let envelope: Envelope = serde_json::from_str(text)?;
    if envelope.kind == "host_sessions.refresh" {
        return Ok(AckWaitAction::HostSessionsRefresh);
    }
    if envelope.kind == "server.ack"
        && envelope
            .payload
            .get("command_id")
            .and_then(|value| value.as_str())
            == Some(command_id)
        && envelope
            .payload
            .get("kind")
            .and_then(|value| value.as_str())
            == Some(event_kind)
    {
        return Ok(AckWaitAction::Matched);
    }
    Ok(AckWaitAction::Defer)
}

fn set_socket_read_timeout(
    socket: &mut AgentSocket,
    timeout: Option<Duration>,
) -> std::io::Result<()> {
    match socket.get_mut() {
        tungstenite::stream::MaybeTlsStream::Plain(stream) => stream.set_read_timeout(timeout),
        tungstenite::stream::MaybeTlsStream::NativeTls(stream) => {
            stream.get_ref().set_read_timeout(timeout)
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AckWaitAction, CommandPayload, CommandType, classify_ack_wait_text, command_events,
        host_sessions_interval, is_read_timeout,
    };
    use crate::config::{AgentConfig, BootstrapConfig, ExecutionConfig, SessionInventoryConfig};
    use std::io::{self, ErrorKind};
    use std::time::Duration;
    use tungstenite::Error as WebSocketError;

    #[test]
    fn placeholder_commands_use_placeholder_stream() {
        let command = CommandPayload {
            id: "command-1".to_owned(),
            command_type: CommandType::Placeholder,
            prompt: "check status".to_owned(),
        };

        let events = command_events(&command);

        assert_eq!(
            events.first().map(|event| event.kind.as_str()),
            Some("command.accepted")
        );
        assert_eq!(
            events.last().map(|event| event.summary.as_str()),
            Some("Placeholder command completed successfully.")
        );
    }

    #[test]
    fn codex_commands_fail_when_execution_is_disabled() {
        let command = CommandPayload {
            id: "command-1".to_owned(),
            command_type: CommandType::Codex,
            prompt: "Say exactly: chaop-smoke".to_owned(),
        };

        let events = command_events(&command);

        assert_eq!(
            events
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["command.started", "command.failed"]
        );
        assert_eq!(
            events.last().map(|event| event.summary.as_str()),
            Some("Codex exec is disabled in this connector config.")
        );
    }

    #[test]
    fn host_sessions_interval_uses_configured_seconds_with_floor() {
        let mut config = test_config();
        config.session_inventory.report_interval_seconds = 0;
        assert_eq!(host_sessions_interval(&config), Duration::from_secs(1));

        config.session_inventory.report_interval_seconds = 7;
        assert_eq!(host_sessions_interval(&config), Duration::from_secs(7));
    }

    #[test]
    fn recognises_socket_read_timeouts() {
        assert!(is_read_timeout(&WebSocketError::Io(io::Error::from(
            ErrorKind::TimedOut
        ))));
        assert!(is_read_timeout(&WebSocketError::Io(io::Error::from(
            ErrorKind::WouldBlock
        ))));
        assert!(!is_read_timeout(&WebSocketError::Io(io::Error::from(
            ErrorKind::NotFound
        ))));
    }

    #[test]
    fn ack_wait_defers_command_dispatch_messages() {
        let action = classify_ack_wait_text(
            r#"{"kind":"command.dispatch","payload":{"command":{"id":"command-2","prompt":"next"}}}"#,
            "command-1",
            "command.output",
        )
        .expect("classified");

        assert_eq!(action, AckWaitAction::Defer);
    }

    #[test]
    fn ack_wait_matches_expected_ack() {
        let action = classify_ack_wait_text(
            r#"{"kind":"server.ack","payload":{"command_id":"command-1","kind":"command.output"}}"#,
            "command-1",
            "command.output",
        )
        .expect("classified");

        assert_eq!(action, AckWaitAction::Matched);
    }

    fn test_config() -> AgentConfig {
        AgentConfig {
            connector_name: "mac-studio".to_owned(),
            control_url: "wss://api.example.com/ws/agent".to_owned(),
            bootstrap_url: "https://api.example.com/connector/bootstrap".to_owned(),
            workspace_root: "/Users/you/Program".into(),
            token_file: "/Users/you/.chaop/connector.token".into(),
            spool_db: "/Users/you/.chaop/connector-spool.sqlite".into(),
            bootstrap: BootstrapConfig {
                secret_file: "/Users/you/.chaop/bootstrap.secret".into(),
            },
            execution: ExecutionConfig::default(),
            session_inventory: SessionInventoryConfig::default(),
        }
    }
}
