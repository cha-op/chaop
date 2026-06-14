use crate::app_server_manager::AppServerManager;
use crate::config::{AgentConfig, ExecutionMode};
use crate::executor::{codex_exec_result_events_with_cancel, codex_exec_started_event};
use crate::placeholder::ConnectorEvent;
use crate::placeholder::placeholder_event_stream;
use crate::session_inventory::{
    AgentHostSessionsReport, InventoryScope, app_server_command_result_events_with_cancel,
    app_server_command_started_event, build_host_session_backfill, build_host_sessions_report,
    create_app_server_thread, set_app_server_thread_archived,
};
use crate::shutdown::{install_signal_handlers, shutdown_requested};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::fs;
use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc::{self, TryRecvError},
};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;
use tungstenite::{Error as WebSocketError, Message, connect};

type AgentSocket = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>;
const CONNECTOR_READ_TICK_SECONDS: u64 = 5;
const CONNECTOR_RECONNECT_BACKOFF_SECONDS: u64 = 2;
const AGENT_READY_RETRY_SECONDS: u64 = 10;
const APP_SERVER_INSTANCE_SUMMARY_SECONDS: u64 = 5 * 60;

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

#[derive(Debug, Default)]
struct AgentReadyState {
    last_sent: Option<String>,
    last_sent_at: Option<Instant>,
    last_acked: Option<String>,
}

#[derive(Debug, Default)]
struct HostSessionsSendState {
    last_sent: Option<String>,
    last_sent_at: Option<Instant>,
    last_acked: Option<String>,
}

#[derive(Debug, Default)]
struct AppServerInstancesSendState {
    last_sent: Option<String>,
    last_sent_at: Option<Instant>,
    last_acked: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CommandDispatch {
    command: CommandPayload,
    target_host_session: Option<CommandTargetHostSession>,
}

#[derive(Debug, Deserialize)]
struct CommandTargetHostSession {
    session_id: String,
    #[serde(default)]
    app_server_present: bool,
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ThreadCreateDispatch {
    request_id: String,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HostSessionBackfillDispatch {
    request_id: String,
    session_id: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct ThreadArchiveSyncDispatch {
    request_id: String,
    session_id: String,
    archived: bool,
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
    install_signal_handlers()?;
    let mut app_server = AppServerManager::new(config);
    if shutdown_requested() {
        return Ok(());
    }
    loop {
        match run_connected_session(config, &mut app_server, run_mode) {
            Ok(()) if run_mode == RunMode::Once => return Ok(()),
            Ok(()) if shutdown_requested() => return Ok(()),
            Ok(()) => {}
            Err(_) if shutdown_requested() => return Ok(()),
            Err(error) if run_mode == RunMode::Once => return Err(error),
            Err(error) => {
                eprintln!("connector connection ended: {error}; reconnecting");
            }
        }
        sleep_until_reconnect_or_shutdown();
        if shutdown_requested() {
            return Ok(());
        }
    }
}

fn run_connected_session(
    config: &AgentConfig,
    app_server: &mut AppServerManager,
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
    let mut runtime_config = app_server.runtime_config(config);
    let mut agent_ready_state = AgentReadyState::default();
    let mut host_sessions_state = HostSessionsSendState::default();
    let mut app_server_instances_state = AppServerInstancesSendState::default();
    let mut deferred_messages = VecDeque::<String>::new();
    if send_agent_ready(&mut socket, &runtime_config, &mut agent_ready_state, true)?
        .should_send_host_sessions()
    {
        send_app_server_instances(
            &mut socket,
            config,
            app_server,
            &mut app_server_instances_state,
            true,
            true,
        )?;
        send_host_sessions(&mut socket, &runtime_config, &mut host_sessions_state, true)?;
    }
    let mut next_host_sessions_at = Instant::now() + host_sessions_interval(&runtime_config);

    loop {
        if shutdown_requested() {
            let _ = socket.close(None);
            return Ok(());
        }
        let message = match deferred_messages.pop_front() {
            Some(text) => Message::Text(text.into()),
            None => match socket.read() {
                Ok(message) => message,
                Err(error) if is_read_timeout(&error) => {
                    if shutdown_requested() {
                        let _ = socket.close(None);
                        return Ok(());
                    }
                    runtime_config = app_server.runtime_config(config);
                    if send_agent_ready(
                        &mut socket,
                        &runtime_config,
                        &mut agent_ready_state,
                        false,
                    )?
                    .should_send_host_sessions()
                    {
                        send_app_server_instances(
                            &mut socket,
                            config,
                            app_server,
                            &mut app_server_instances_state,
                            true,
                            true,
                        )?;
                        send_host_sessions(
                            &mut socket,
                            &runtime_config,
                            &mut host_sessions_state,
                            true,
                        )?;
                        next_host_sessions_at =
                            Instant::now() + host_sessions_interval(&runtime_config);
                    } else if Instant::now() >= next_host_sessions_at {
                        send_app_server_instances(
                            &mut socket,
                            config,
                            app_server,
                            &mut app_server_instances_state,
                            false,
                            false,
                        )?;
                        send_host_sessions(
                            &mut socket,
                            &runtime_config,
                            &mut host_sessions_state,
                            false,
                        )?;
                        next_host_sessions_at =
                            Instant::now() + host_sessions_interval(&runtime_config);
                    } else {
                        send_app_server_instances(
                            &mut socket,
                            config,
                            app_server,
                            &mut app_server_instances_state,
                            false,
                            false,
                        )?;
                    }
                    continue;
                }
                Err(error) => return Err(error.into()),
            },
        };
        match message {
            Message::Text(text) => {
                if shutdown_requested() {
                    let _ = socket.close(None);
                    return Ok(());
                }
                if apply_agent_ready_ack_text(text.as_ref(), &mut agent_ready_state)? {
                    continue;
                }
                if apply_app_server_instances_ack_text(
                    text.as_ref(),
                    &mut app_server_instances_state,
                )? {
                    continue;
                }
                if apply_host_sessions_ack_text(text.as_ref(), &mut host_sessions_state)? {
                    continue;
                }
                runtime_config = app_server.runtime_config(config);
                if send_agent_ready(&mut socket, &runtime_config, &mut agent_ready_state, false)?
                    .should_send_host_sessions()
                {
                    send_app_server_instances(
                        &mut socket,
                        config,
                        app_server,
                        &mut app_server_instances_state,
                        true,
                        true,
                    )?;
                    send_host_sessions(
                        &mut socket,
                        &runtime_config,
                        &mut host_sessions_state,
                        true,
                    )?;
                    next_host_sessions_at =
                        Instant::now() + host_sessions_interval(&runtime_config);
                }
                if handle_text_message(
                    &mut socket,
                    text.as_ref(),
                    &runtime_config,
                    app_server,
                    &mut app_server_instances_state,
                    &mut agent_ready_state,
                    &mut host_sessions_state,
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

fn send_agent_ready(
    socket: &mut AgentSocket,
    config: &AgentConfig,
    state: &mut AgentReadyState,
    force: bool,
) -> Result<AgentReadySend, Box<dyn std::error::Error>> {
    let message = agent_ready_message(&config.capabilities());
    let now = Instant::now();
    if !should_send_agent_ready(&message, state, force, now) {
        return Ok(AgentReadySend::NotSent);
    }
    let changed = state.last_sent.as_deref() != Some(message.as_str());
    socket.send(Message::Text(message.clone().into()))?;
    state.last_sent = Some(message);
    state.last_sent_at = Some(now);
    Ok(if changed {
        AgentReadySend::SentChangedPayload
    } else {
        AgentReadySend::SentSamePayload
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentReadySend {
    NotSent,
    SentSamePayload,
    SentChangedPayload,
}

impl AgentReadySend {
    fn should_send_host_sessions(self) -> bool {
        matches!(self, Self::SentChangedPayload)
    }
}

fn should_send_agent_ready(
    message: &str,
    state: &AgentReadyState,
    force: bool,
    now: Instant,
) -> bool {
    if force {
        return true;
    }
    if state.last_acked.as_deref() == Some(message) {
        return false;
    }
    if state.last_sent.as_deref() == Some(message)
        && state.last_sent_at.is_some_and(|sent_at| {
            now.saturating_duration_since(sent_at) < agent_ready_retry_interval()
        })
    {
        return false;
    }
    true
}

fn acknowledge_agent_ready(state: &mut AgentReadyState, message: String) {
    state.last_sent = Some(message.clone());
    state.last_sent_at = None;
    state.last_acked = Some(message);
}

fn agent_ready_message(capabilities: &[String]) -> String {
    json!({
        "kind": "agent.ready",
        "payload": {
            "capabilities": capabilities
        }
    })
    .to_string()
}

fn send_host_sessions(
    socket: &mut AgentSocket,
    config: &AgentConfig,
    state: &mut HostSessionsSendState,
    force: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let message = host_sessions_message(config);
    let now = Instant::now();
    if !should_send_host_sessions(&message, state, force, now) {
        return Ok(());
    }
    socket.send(Message::Text(message.clone().into()))?;
    state.last_sent = Some(message);
    state.last_sent_at = Some(now);
    state.last_acked = None;
    Ok(())
}

fn should_send_host_sessions(
    message: &str,
    state: &HostSessionsSendState,
    force: bool,
    now: Instant,
) -> bool {
    if force {
        return true;
    }
    if state.last_acked.as_deref() == Some(message) {
        return false;
    }
    if state.last_sent.as_deref() == Some(message)
        && state.last_sent_at.is_some_and(|sent_at| {
            now.saturating_duration_since(sent_at) < host_sessions_retry_interval()
        })
    {
        return false;
    }
    true
}

fn acknowledge_host_sessions(state: &mut HostSessionsSendState) {
    let Some(message) = state.last_sent.clone() else {
        return;
    };
    state.last_sent_at = None;
    state.last_acked = Some(message);
}

fn send_app_server_instances(
    socket: &mut AgentSocket,
    config: &AgentConfig,
    app_server: &AppServerManager,
    state: &mut AppServerInstancesSendState,
    force: bool,
    snapshot: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let Some(message) = app_server_instances_message(config, app_server, snapshot) else {
        return Ok(());
    };
    let now = Instant::now();
    if !should_send_app_server_instances(&message, state, force, now) {
        return Ok(());
    }
    socket.send(Message::Text(message.clone().into()))?;
    state.last_sent = Some(message);
    state.last_sent_at = Some(now);
    state.last_acked = None;
    Ok(())
}

fn should_send_app_server_instances(
    message: &str,
    state: &AppServerInstancesSendState,
    force: bool,
    now: Instant,
) -> bool {
    if force {
        return true;
    }
    if state.last_acked.as_deref() == Some(message) {
        return state.last_sent_at.map_or(true, |sent_at| {
            now.saturating_duration_since(sent_at) >= app_server_instance_summary_interval()
        });
    }
    if state.last_sent.as_deref() == Some(message)
        && state.last_sent_at.is_some_and(|sent_at| {
            now.saturating_duration_since(sent_at) < agent_ready_retry_interval()
        })
    {
        return false;
    }
    true
}

fn acknowledge_app_server_instances(state: &mut AppServerInstancesSendState) {
    let Some(message) = state.last_sent.clone() else {
        return;
    };
    state.last_acked = Some(message);
}

fn app_server_instances_message(
    config: &AgentConfig,
    app_server: &AppServerManager,
    snapshot: bool,
) -> Option<String> {
    let instance = app_server.instance_snapshot(config)?;
    let mut instance_payload = json!({
        "instance_key": instance.instance_key,
        "scope": instance.scope,
        "endpoint_type": instance.endpoint_type,
        "state": instance.state,
        "active_turn_count": instance.active_turn_count,
        "generation": instance.generation
    });
    if let Some(status_summary) = instance.status_summary {
        instance_payload["status_summary"] = json!(status_summary);
    }
    if let Some(last_error) = instance.last_error {
        instance_payload["last_error"] = json!(last_error);
    }
    Some(
        json!({
            "kind": "agent.app_server_instances",
            "payload": {
                "snapshot": snapshot,
                "instances": [instance_payload]
            }
        })
        .to_string(),
    )
}

fn host_sessions_message(config: &AgentConfig) -> String {
    let report = build_host_sessions_report(config).unwrap_or_else(|error| {
        eprintln!("chaop-agent: host session inventory failed: {error}");
        fallback_host_sessions_report(config)
    });
    json!({
        "kind": "agent.host_sessions",
        "payload": report
    })
    .to_string()
}

fn fallback_host_sessions_report(config: &AgentConfig) -> AgentHostSessionsReport {
    AgentHostSessionsReport {
        sessions: Vec::new(),
        inventory_scope: InventoryScope::Incremental,
        app_server_inventory_ok: config
            .session_inventory
            .app_server_url
            .as_ref()
            .map(|_| false),
    }
}

fn app_server_instances_ack_message(envelope: &Envelope) -> bool {
    if envelope.kind != "server.ack" {
        return false;
    }
    envelope.payload.get("kind").and_then(Value::as_str) == Some("agent.app_server_instances")
}

fn apply_app_server_instances_ack_text(
    text: &str,
    state: &mut AppServerInstancesSendState,
) -> Result<bool, Box<dyn std::error::Error>> {
    let envelope: Envelope = serde_json::from_str(text)?;
    if !app_server_instances_ack_message(&envelope) {
        return Ok(false);
    }
    acknowledge_app_server_instances(state);
    Ok(true)
}

fn handle_text_message(
    socket: &mut AgentSocket,
    text: &str,
    config: &AgentConfig,
    app_server: &mut AppServerManager,
    app_server_instances_state: &mut AppServerInstancesSendState,
    agent_ready_state: &mut AgentReadyState,
    host_sessions_state: &mut HostSessionsSendState,
    deferred_messages: &mut VecDeque<String>,
) -> Result<bool, Box<dyn std::error::Error>> {
    let envelope: Envelope = serde_json::from_str(text)?;
    if envelope.kind == "host_sessions.refresh" {
        send_host_sessions(socket, config, host_sessions_state, true)?;
        return Ok(false);
    }

    if let Some(message) = agent_ready_ack_message(&envelope) {
        acknowledge_agent_ready(agent_ready_state, message);
        return Ok(false);
    }

    if app_server_instances_ack_message(&envelope) {
        acknowledge_app_server_instances(app_server_instances_state);
        return Ok(false);
    }

    if host_sessions_ack_message(&envelope) {
        acknowledge_host_sessions(host_sessions_state);
        return Ok(false);
    }

    if envelope.kind == "thread.create" {
        let dispatch: ThreadCreateDispatch = serde_json::from_value(envelope.payload)?;
        handle_thread_create(socket, &dispatch, config, host_sessions_state)?;
        return Ok(false);
    }

    if envelope.kind == "host_session.backfill" {
        let dispatch: HostSessionBackfillDispatch = serde_json::from_value(envelope.payload)?;
        handle_host_session_backfill(socket, &dispatch, config)?;
        return Ok(false);
    }

    if envelope.kind == "thread.archive_sync" {
        let dispatch: ThreadArchiveSyncDispatch = serde_json::from_value(envelope.payload)?;
        handle_thread_archive_sync(socket, &dispatch, config, host_sessions_state)?;
        return Ok(false);
    }

    if envelope.kind != "command.dispatch" {
        return Ok(false);
    }

    let dispatch: CommandDispatch = serde_json::from_value(envelope.payload)?;
    if requires_app_server_execution_mode(&dispatch)
        && config.execution.mode != ExecutionMode::AppServer
    {
        dispatch_events(
            socket,
            &dispatch.command,
            app_server_wrong_execution_mode_events(),
            config,
            app_server_instances_state,
            host_sessions_state,
            deferred_messages,
        )?;
        return Ok(true);
    }

    if dispatch.command.command_type == CommandType::Codex
        && config.execution.mode == ExecutionMode::CodexExec
    {
        if !dispatch_events(
            socket,
            &dispatch.command,
            vec![codex_exec_started_event(&config.workspace_root)],
            config,
            app_server_instances_state,
            host_sessions_state,
            deferred_messages,
        )? {
            return Ok(true);
        }
        let events = wait_for_codex_exec_events(
            socket,
            config,
            &dispatch.command.prompt,
            app_server_instances_state,
            host_sessions_state,
            deferred_messages,
        );
        dispatch_events(
            socket,
            &dispatch.command,
            events?,
            config,
            app_server_instances_state,
            host_sessions_state,
            deferred_messages,
        )?;
        return Ok(true);
    }

    if dispatch.command.command_type == CommandType::Codex
        && config.execution.mode == ExecutionMode::AppServer
    {
        let Some(target_host_session) = dispatch.target_host_session.as_ref() else {
            dispatch_events(
                socket,
                &dispatch.command,
                app_server_missing_target_events(),
                config,
                app_server_instances_state,
                host_sessions_state,
                deferred_messages,
            )?;
            return Ok(true);
        };
        if !target_host_session.app_server_present {
            dispatch_events(
                socket,
                &dispatch.command,
                app_server_non_app_server_target_events(&target_host_session.session_id),
                config,
                app_server_instances_state,
                host_sessions_state,
                deferred_messages,
            )?;
            return Ok(true);
        }
        if !dispatch_events_for_target_host_session(
            socket,
            &dispatch.command,
            vec![app_server_command_started_event(
                &target_host_session.session_id,
            )],
            Some(&target_host_session.session_id),
            config,
            app_server_instances_state,
            host_sessions_state,
            deferred_messages,
        )? {
            return Ok(true);
        }
        app_server.begin_turn();
        if let Err(error) = send_app_server_instances(
            socket,
            config,
            app_server,
            app_server_instances_state,
            true,
            false,
        ) {
            app_server.finish_turn();
            return Err(error);
        }
        let events = wait_for_app_server_command_events(
            socket,
            config,
            &target_host_session.session_id,
            target_host_session.cwd.as_deref(),
            &dispatch.command.id,
            &dispatch.command.prompt,
            app_server_instances_state,
            host_sessions_state,
            deferred_messages,
        );
        app_server.finish_turn();
        send_app_server_instances(
            socket,
            config,
            app_server,
            app_server_instances_state,
            true,
            false,
        )?;
        dispatch_events(
            socket,
            &dispatch.command,
            events?,
            config,
            app_server_instances_state,
            host_sessions_state,
            deferred_messages,
        )?;
        return Ok(true);
    }

    dispatch_events(
        socket,
        &dispatch.command,
        command_events(&dispatch.command),
        config,
        app_server_instances_state,
        host_sessions_state,
        deferred_messages,
    )?;
    Ok(true)
}

fn handle_thread_create(
    socket: &mut AgentSocket,
    dispatch: &ThreadCreateDispatch,
    config: &AgentConfig,
    host_sessions_state: &mut HostSessionsSendState,
) -> Result<(), Box<dyn std::error::Error>> {
    match create_app_server_thread(config, dispatch.title.as_deref()) {
        Ok(session) => {
            socket.send(Message::Text(
                json!({
                    "kind": "thread.create_result",
                    "payload": {
                        "request_id": dispatch.request_id,
                        "ok": true,
                        "session": session
                    }
                })
                .to_string()
                .into(),
            ))?;
            send_host_sessions(socket, config, host_sessions_state, true)?;
        }
        Err(error) => {
            socket.send(Message::Text(
                json!({
                    "kind": "thread.create_result",
                    "payload": {
                        "request_id": dispatch.request_id,
                        "ok": false,
                        "error": error.to_string()
                    }
                })
                .to_string()
                .into(),
            ))?;
        }
    }
    Ok(())
}

fn agent_ready_ack_message(envelope: &Envelope) -> Option<String> {
    if envelope.kind != "server.ack"
        || envelope
            .payload
            .get("kind")
            .and_then(|value| value.as_str())
            != Some("agent.ready")
    {
        return None;
    }

    envelope
        .payload
        .get("capabilities")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(ToOwned::to_owned))
                .collect::<Vec<_>>()
        })
        .map(|capabilities| agent_ready_message(&capabilities))
}

fn apply_agent_ready_ack_text(
    text: &str,
    state: &mut AgentReadyState,
) -> Result<bool, serde_json::Error> {
    let envelope: Envelope = serde_json::from_str(text)?;
    let Some(message) = agent_ready_ack_message(&envelope) else {
        return Ok(false);
    };
    acknowledge_agent_ready(state, message);
    Ok(true)
}

fn host_sessions_ack_message(envelope: &Envelope) -> bool {
    envelope.kind == "server.ack"
        && envelope
            .payload
            .get("kind")
            .and_then(|value| value.as_str())
            == Some("agent.host_sessions")
}

fn apply_host_sessions_ack_text(
    text: &str,
    state: &mut HostSessionsSendState,
) -> Result<bool, serde_json::Error> {
    let envelope: Envelope = serde_json::from_str(text)?;
    if !host_sessions_ack_message(&envelope) {
        return Ok(false);
    }
    acknowledge_host_sessions(state);
    Ok(true)
}

fn handle_host_session_backfill(
    socket: &mut AgentSocket,
    dispatch: &HostSessionBackfillDispatch,
    config: &AgentConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    match build_host_session_backfill(config, &dispatch.session_id, dispatch.limit.unwrap_or(30)) {
        Ok(backfill) => {
            socket.send(Message::Text(
                json!({
                    "kind": "host_session.backfill_result",
                    "payload": {
                        "request_id": dispatch.request_id,
                        "ok": true,
                        "events": backfill.events,
                        "truncated": backfill.truncated
                    }
                })
                .to_string()
                .into(),
            ))?;
        }
        Err(error) => {
            socket.send(Message::Text(
                json!({
                    "kind": "host_session.backfill_result",
                    "payload": {
                        "request_id": dispatch.request_id,
                        "ok": false,
                        "error": error.to_string()
                    }
                })
                .to_string()
                .into(),
            ))?;
        }
    }
    Ok(())
}

fn handle_thread_archive_sync(
    socket: &mut AgentSocket,
    dispatch: &ThreadArchiveSyncDispatch,
    config: &AgentConfig,
    host_sessions_state: &mut HostSessionsSendState,
) -> Result<(), Box<dyn std::error::Error>> {
    match set_app_server_thread_archived(config, &dispatch.session_id, dispatch.archived) {
        Ok(synced) => {
            socket.send(Message::Text(
                json!({
                    "kind": "thread.archive_sync_result",
                    "payload": {
                        "request_id": dispatch.request_id,
                        "ok": true,
                        "synced": synced
                    }
                })
                .to_string()
                .into(),
            ))?;
            send_host_sessions(socket, config, host_sessions_state, true)?;
        }
        Err(error) => {
            socket.send(Message::Text(
                json!({
                    "kind": "thread.archive_sync_result",
                    "payload": {
                        "request_id": dispatch.request_id,
                        "ok": false,
                        "error": error.to_string()
                    }
                })
                .to_string()
                .into(),
            ))?;
        }
    }
    Ok(())
}

fn wait_for_codex_exec_events(
    socket: &mut AgentSocket,
    config: &AgentConfig,
    prompt: &str,
    app_server_instances_state: &mut AppServerInstancesSendState,
    host_sessions_state: &mut HostSessionsSendState,
    deferred_messages: &mut VecDeque<String>,
) -> Result<Vec<ConnectorEvent>, Box<dyn std::error::Error>> {
    let execution = config.execution.clone();
    let workspace_root = config.workspace_root.clone();
    let prompt = prompt.to_owned();
    let (sender, receiver) = mpsc::channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel = Arc::clone(&cancel);
    let mut worker = Some(thread::spawn(move || {
        let events = codex_exec_result_events_with_cancel(
            &execution,
            &workspace_root,
            &prompt,
            worker_cancel,
        );
        let _ = sender.send(events);
    }));

    set_socket_read_timeout(socket, Some(connector_read_tick()))?;
    loop {
        if shutdown_requested() {
            cancel_codex_worker(&cancel, worker.take())?;
            return Err("connector shutdown requested while codex exec was running".into());
        }
        match receiver.try_recv() {
            Ok(events) => {
                join_codex_worker(worker.take())?;
                set_socket_read_timeout(socket, Some(connector_read_tick()))?;
                return Ok(events);
            }
            Err(TryRecvError::Disconnected) => {
                join_codex_worker(worker.take())?;
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
                    app_server_instances_state,
                    host_sessions_state,
                    deferred_messages,
                )?;
            }
            Ok(Message::Ping(payload)) => socket.send(Message::Pong(payload))?,
            Ok(Message::Close(_)) => {
                cancel_codex_worker(&cancel, worker.take())?;
                return Err("connection closed while codex exec was running".into());
            }
            Ok(_) => {}
            Err(error) if is_read_timeout(&error) => {}
            Err(error) => {
                cancel_codex_worker(&cancel, worker.take())?;
                return Err(error.into());
            }
        }
    }
}

fn wait_for_app_server_command_events(
    socket: &mut AgentSocket,
    config: &AgentConfig,
    session_id: &str,
    cwd: Option<&str>,
    command_id: &str,
    prompt: &str,
    app_server_instances_state: &mut AppServerInstancesSendState,
    host_sessions_state: &mut HostSessionsSendState,
    deferred_messages: &mut VecDeque<String>,
) -> Result<Vec<ConnectorEvent>, Box<dyn std::error::Error>> {
    let worker_config = config.clone();
    let session_id = session_id.to_owned();
    let cwd = cwd.map(ToOwned::to_owned);
    let command_id = command_id.to_owned();
    let prompt = prompt.to_owned();
    let (sender, receiver) = mpsc::channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel = Arc::clone(&cancel);
    let mut worker = Some(thread::spawn(move || {
        let events = app_server_command_result_events_with_cancel(
            &worker_config,
            &session_id,
            cwd.as_deref(),
            &command_id,
            &prompt,
            worker_cancel,
        );
        let _ = sender.send(events);
    }));

    set_socket_read_timeout(socket, Some(connector_read_tick()))?;
    loop {
        if shutdown_requested() {
            cancel_codex_worker(&cancel, worker.take())?;
            return Err("connector shutdown requested while app-server command was running".into());
        }
        match receiver.try_recv() {
            Ok(events) => {
                join_codex_worker(worker.take())?;
                set_socket_read_timeout(socket, Some(connector_read_tick()))?;
                return Ok(events);
            }
            Err(TryRecvError::Disconnected) => {
                join_codex_worker(worker.take())?;
                return Err("app-server command worker stopped before returning events".into());
            }
            Err(TryRecvError::Empty) => {}
        }

        match socket.read() {
            Ok(Message::Text(text)) => {
                handle_background_text_message(
                    socket,
                    text.as_ref(),
                    config,
                    app_server_instances_state,
                    host_sessions_state,
                    deferred_messages,
                )?;
            }
            Ok(Message::Ping(payload)) => socket.send(Message::Pong(payload))?,
            Ok(Message::Close(_)) => {
                cancel_codex_worker(&cancel, worker.take())?;
                return Err("connection closed while app-server command was running".into());
            }
            Ok(_) => {}
            Err(error) if is_read_timeout(&error) => {}
            Err(error) => {
                cancel_codex_worker(&cancel, worker.take())?;
                return Err(error.into());
            }
        }
    }
}

fn cancel_codex_worker(
    cancel: &AtomicBool,
    worker: Option<thread::JoinHandle<()>>,
) -> Result<(), Box<dyn std::error::Error>> {
    cancel.store(true, Ordering::Relaxed);
    join_codex_worker(worker)
}

fn join_codex_worker(
    worker: Option<thread::JoinHandle<()>>,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(worker) = worker {
        if worker.join().is_err() {
            return Err("codex exec worker panicked".into());
        }
    }
    Ok(())
}

fn handle_background_text_message(
    socket: &mut AgentSocket,
    text: &str,
    config: &AgentConfig,
    app_server_instances_state: &mut AppServerInstancesSendState,
    host_sessions_state: &mut HostSessionsSendState,
    deferred_messages: &mut VecDeque<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let envelope: Envelope = serde_json::from_str(text)?;
    if envelope.kind == "host_sessions.refresh" {
        send_host_sessions(socket, config, host_sessions_state, true)?;
    } else if handle_background_ack_message(
        &envelope,
        app_server_instances_state,
        host_sessions_state,
    ) {
    } else if envelope.kind == "thread.create" {
        let dispatch: ThreadCreateDispatch = serde_json::from_value(envelope.payload)?;
        handle_thread_create(socket, &dispatch, config, host_sessions_state)?;
    } else if envelope.kind == "host_session.backfill" {
        let dispatch: HostSessionBackfillDispatch = serde_json::from_value(envelope.payload)?;
        handle_host_session_backfill(socket, &dispatch, config)?;
    } else if envelope.kind == "thread.archive_sync" {
        let dispatch: ThreadArchiveSyncDispatch = serde_json::from_value(envelope.payload)?;
        handle_thread_archive_sync(socket, &dispatch, config, host_sessions_state)?;
    } else {
        deferred_messages.push_back(text.to_owned());
    }
    Ok(())
}

fn handle_background_ack_message(
    envelope: &Envelope,
    app_server_instances_state: &mut AppServerInstancesSendState,
    host_sessions_state: &mut HostSessionsSendState,
) -> bool {
    if app_server_instances_ack_message(envelope) {
        acknowledge_app_server_instances(app_server_instances_state);
        return true;
    }
    if host_sessions_ack_message(envelope) {
        acknowledge_host_sessions(host_sessions_state);
        return true;
    }
    false
}

fn requires_app_server_execution_mode(dispatch: &CommandDispatch) -> bool {
    dispatch.command.command_type == CommandType::Codex
        && dispatch
            .target_host_session
            .as_ref()
            .is_some_and(|target| target.app_server_present)
}

fn command_events(command: &CommandPayload) -> Vec<ConnectorEvent> {
    match command.command_type {
        CommandType::Placeholder => placeholder_event_stream(&command.prompt),
        CommandType::Codex => vec![
            ConnectorEvent {
                kind: "command.started".to_owned(),
                priority: "P1".to_owned(),
                summary: "Connector received a Codex command, but the CLI fallback is disabled."
                    .to_owned(),
            },
            ConnectorEvent {
                kind: "command.failed".to_owned(),
                priority: "P1".to_owned(),
                summary: "Codex CLI fallback is disabled in this connector config.".to_owned(),
            },
        ],
    }
}

fn app_server_missing_target_events() -> Vec<ConnectorEvent> {
    vec![ConnectorEvent {
        kind: "command.failed".to_owned(),
        priority: "P1".to_owned(),
        summary: "Codex app-server execution requires an attached local app-server session."
            .to_owned(),
    }]
}

fn app_server_wrong_execution_mode_events() -> Vec<ConnectorEvent> {
    vec![ConnectorEvent {
        kind: "command.failed".to_owned(),
        priority: "P1".to_owned(),
        summary: "Attached app-server sessions require execution.mode = \"app_server\".".to_owned(),
    }]
}

fn app_server_non_app_server_target_events(session_id: &str) -> Vec<ConnectorEvent> {
    vec![ConnectorEvent {
        kind: "command.failed".to_owned(),
        priority: "P1".to_owned(),
        summary: format!(
            "Attached local session {session_id} is not available through Codex app-server."
        ),
    }]
}

fn dispatch_events(
    socket: &mut AgentSocket,
    command: &CommandPayload,
    events: Vec<ConnectorEvent>,
    config: &AgentConfig,
    app_server_instances_state: &mut AppServerInstancesSendState,
    host_sessions_state: &mut HostSessionsSendState,
    deferred_messages: &mut VecDeque<String>,
) -> Result<bool, Box<dyn std::error::Error>> {
    dispatch_events_for_target_host_session(
        socket,
        command,
        events,
        None,
        config,
        app_server_instances_state,
        host_sessions_state,
        deferred_messages,
    )
}

fn dispatch_events_for_target_host_session(
    socket: &mut AgentSocket,
    command: &CommandPayload,
    events: Vec<ConnectorEvent>,
    target_host_session_id: Option<&str>,
    config: &AgentConfig,
    app_server_instances_state: &mut AppServerInstancesSendState,
    host_sessions_state: &mut HostSessionsSendState,
    deferred_messages: &mut VecDeque<String>,
) -> Result<bool, Box<dyn std::error::Error>> {
    for event in events {
        if event.kind == "command.accepted" {
            continue;
        }
        socket.send(Message::Text(
            agent_event_message(command, &event, target_host_session_id)
                .to_string()
                .into(),
        ))?;
        if !wait_for_ack(
            socket,
            &command.id,
            &event.kind,
            config,
            app_server_instances_state,
            host_sessions_state,
            deferred_messages,
        )? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn agent_event_message(
    command: &CommandPayload,
    event: &ConnectorEvent,
    target_host_session_id: Option<&str>,
) -> Value {
    match target_host_session_id.filter(|_| event.kind == "command.started") {
        Some(session_id) => json!({
            "kind": "agent.event",
            "payload": {
                "command_id": command.id,
                "target_host_session_id": session_id,
                "kind": event.kind,
                "priority": event.priority,
                "summary": event.summary
            }
        }),
        None => json!({
            "kind": "agent.event",
            "payload": {
                "command_id": command.id,
                "kind": event.kind,
                "priority": event.priority,
                "summary": event.summary
            }
        }),
    }
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

fn agent_ready_retry_interval() -> Duration {
    Duration::from_secs(AGENT_READY_RETRY_SECONDS)
}

fn app_server_instance_summary_interval() -> Duration {
    Duration::from_secs(APP_SERVER_INSTANCE_SUMMARY_SECONDS)
}

fn host_sessions_retry_interval() -> Duration {
    agent_ready_retry_interval()
}

fn sleep_until_reconnect_or_shutdown() {
    let deadline = Instant::now() + reconnect_backoff();
    while Instant::now() < deadline && !shutdown_requested() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        thread::sleep(remaining.min(Duration::from_millis(100)));
    }
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
    app_server_instances_state: &mut AppServerInstancesSendState,
    host_sessions_state: &mut HostSessionsSendState,
    deferred_messages: &mut VecDeque<String>,
) -> Result<bool, Box<dyn std::error::Error>> {
    set_socket_read_timeout(socket, Some(Duration::from_secs(10)))?;
    loop {
        if shutdown_requested() {
            set_socket_read_timeout(socket, Some(connector_read_tick()))?;
            return Err("connector shutdown requested before command acknowledgement".into());
        }
        match socket.read()? {
            Message::Text(text) => {
                match classify_ack_wait_text(text.as_ref(), command_id, event_kind)? {
                    AckWaitAction::Matched { accepted } => {
                        set_socket_read_timeout(socket, Some(connector_read_tick()))?;
                        return Ok(accepted);
                    }
                    AckWaitAction::HostSessionsRefresh => {
                        send_host_sessions(socket, config, host_sessions_state, true)?;
                    }
                    AckWaitAction::Defer => handle_background_text_message(
                        socket,
                        text.as_ref(),
                        config,
                        app_server_instances_state,
                        host_sessions_state,
                        deferred_messages,
                    )?,
                }
            }
            Message::Ping(payload) => socket.send(Message::Pong(payload))?,
            Message::Close(_) => {
                set_socket_read_timeout(socket, Some(connector_read_tick()))?;
                return Err("connection closed before command acknowledgement".into());
            }
            _ => {}
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AckWaitAction {
    Matched { accepted: bool },
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
        let accepted = envelope
            .payload
            .get("accepted")
            .and_then(|value| value.as_bool())
            .unwrap_or(true);
        return Ok(AckWaitAction::Matched { accepted });
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
        AckWaitAction, AgentReadyState, AppServerInstancesSendState, CommandDispatch,
        CommandPayload, CommandTargetHostSession, CommandType, Envelope, HostSessionsSendState,
        acknowledge_agent_ready, acknowledge_app_server_instances, acknowledge_host_sessions,
        agent_event_message, agent_ready_ack_message, agent_ready_message,
        agent_ready_retry_interval, app_server_instance_summary_interval,
        app_server_instances_message, apply_agent_ready_ack_text,
        apply_app_server_instances_ack_text, apply_host_sessions_ack_text, classify_ack_wait_text,
        command_events, handle_background_ack_message, host_sessions_ack_message,
        host_sessions_interval, host_sessions_message, host_sessions_retry_interval,
        is_read_timeout, requires_app_server_execution_mode, should_send_agent_ready,
        should_send_app_server_instances, should_send_host_sessions,
    };
    use crate::app_server_manager::AppServerManager;
    use crate::config::{AgentConfig, BootstrapConfig, ExecutionConfig, SessionInventoryConfig};
    use crate::placeholder::ConnectorEvent;
    use serde_json::Value;
    use std::fs;
    use std::io::{self, ErrorKind};
    use std::time::{Duration, Instant};
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
            Some("Codex CLI fallback is disabled in this connector config.")
        );
    }

    #[test]
    fn app_server_started_event_payload_identifies_target_host_session() {
        let command = CommandPayload {
            id: "command-1".to_owned(),
            command_type: CommandType::Codex,
            prompt: "continue".to_owned(),
        };
        let event = ConnectorEvent {
            kind: "command.started".to_owned(),
            priority: "P1".to_owned(),
            summary: "Connector started Codex app-server turn for local thread session-1."
                .to_owned(),
        };

        let message = agent_event_message(&command, &event, Some("session-1"));

        assert_eq!(
            message.pointer("/kind").and_then(|value| value.as_str()),
            Some("agent.event")
        );
        assert_eq!(
            message
                .pointer("/payload/target_host_session_id")
                .and_then(|value| value.as_str()),
            Some("session-1")
        );
    }

    #[test]
    fn non_started_event_payload_omits_target_host_session() {
        let command = CommandPayload {
            id: "command-1".to_owned(),
            command_type: CommandType::Codex,
            prompt: "continue".to_owned(),
        };
        let event = ConnectorEvent {
            kind: "command.output".to_owned(),
            priority: "P2".to_owned(),
            summary: "Progress".to_owned(),
        };

        let message = agent_event_message(&command, &event, Some("session-1"));

        assert!(message.pointer("/payload/target_host_session_id").is_none());
    }

    #[test]
    fn app_server_targets_require_app_server_execution_mode() {
        let dispatch = CommandDispatch {
            command: CommandPayload {
                id: "command-1".to_owned(),
                command_type: CommandType::Codex,
                prompt: "continue".to_owned(),
            },
            target_host_session: Some(CommandTargetHostSession {
                session_id: "session-1".to_owned(),
                app_server_present: true,
                cwd: None,
            }),
        };

        assert!(requires_app_server_execution_mode(&dispatch));
    }

    #[test]
    fn non_app_server_targets_do_not_require_app_server_execution_mode() {
        let dispatch = CommandDispatch {
            command: CommandPayload {
                id: "command-1".to_owned(),
                command_type: CommandType::Codex,
                prompt: "continue".to_owned(),
            },
            target_host_session: Some(CommandTargetHostSession {
                session_id: "session-1".to_owned(),
                app_server_present: false,
                cwd: None,
            }),
        };

        assert!(!requires_app_server_execution_mode(&dispatch));
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
    fn host_sessions_message_sends_incremental_fallback_on_inventory_error() {
        let temp = tempfile::tempdir().expect("tempdir");
        fs::create_dir(temp.path().join("history.jsonl")).expect("history dir");
        let mut config = test_config();
        config.session_inventory.codex_home = Some(temp.path().to_path_buf());

        let message = host_sessions_message(&config);
        let value: Value = serde_json::from_str(&message).expect("host sessions json");

        assert_eq!(
            value.pointer("/kind").and_then(Value::as_str),
            Some("agent.host_sessions")
        );
        assert_eq!(
            value
                .pointer("/payload/sessions")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );
        assert_eq!(
            value
                .pointer("/payload/inventory_scope")
                .and_then(Value::as_str),
            Some("incremental")
        );
        assert!(value.pointer("/payload/app_server_inventory_ok").is_none());
    }

    #[test]
    fn host_sessions_message_marks_app_server_inventory_untrusted_on_fallback() {
        let temp = tempfile::tempdir().expect("tempdir");
        fs::create_dir(temp.path().join("history.jsonl")).expect("history dir");
        let mut config = test_config();
        config.session_inventory.codex_home = Some(temp.path().to_path_buf());
        config.session_inventory.app_server_url = Some("ws://127.0.0.1:1".to_owned());

        let message = host_sessions_message(&config);
        let value: Value = serde_json::from_str(&message).expect("host sessions json");

        assert_eq!(
            value
                .pointer("/payload/app_server_inventory_ok")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            value
                .pointer("/payload/inventory_scope")
                .and_then(Value::as_str),
            Some("incremental")
        );
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

        assert_eq!(action, AckWaitAction::Matched { accepted: true });
    }

    #[test]
    fn ack_wait_matches_rejected_ack() {
        let action = classify_ack_wait_text(
            r#"{"kind":"server.ack","payload":{"command_id":"command-1","kind":"command.started","accepted":false}}"#,
            "command-1",
            "command.started",
        )
        .expect("classified");

        assert_eq!(action, AckWaitAction::Matched { accepted: false });
    }

    #[test]
    fn agent_ready_ack_records_acknowledged_capabilities() {
        let envelope: super::Envelope = serde_json::from_str(
            r#"{"kind":"server.ack","payload":{"kind":"agent.ready","capabilities":["placeholder_commands"]}}"#,
        )
        .expect("envelope");

        let expected = agent_ready_message(&["placeholder_commands".to_owned()]);
        assert_eq!(
            agent_ready_ack_message(&envelope).as_deref(),
            Some(expected.as_str())
        );
    }

    #[test]
    fn acknowledged_agent_ready_suppresses_same_payload_until_forced() {
        let mut state = AgentReadyState::default();
        let message = agent_ready_message(&["placeholder_commands".to_owned()]);
        let now = Instant::now();

        acknowledge_agent_ready(&mut state, message.clone());

        assert!(!should_send_agent_ready(
            &message,
            &state,
            false,
            now + Duration::from_secs(60)
        ));
        assert!(should_send_agent_ready(
            &message,
            &state,
            true,
            now + Duration::from_secs(60)
        ));
    }

    #[test]
    fn unacknowledged_agent_ready_retries_only_after_interval() {
        let mut state = AgentReadyState::default();
        let message = agent_ready_message(&["placeholder_commands".to_owned()]);
        let changed_message = agent_ready_message(&["codex_app_server_exec".to_owned()]);
        let now = Instant::now();

        state.last_sent = Some(message.clone());
        state.last_sent_at = Some(now);

        assert!(!should_send_agent_ready(
            &message,
            &state,
            false,
            now + (agent_ready_retry_interval() - Duration::from_secs(1))
        ));
        assert!(should_send_agent_ready(
            &message,
            &state,
            false,
            now + agent_ready_retry_interval()
        ));
        assert!(should_send_agent_ready(
            &changed_message,
            &state,
            false,
            now + Duration::from_secs(1)
        ));
    }

    #[test]
    fn acknowledged_app_server_instances_wait_for_summary_interval() {
        let message =
            r#"{"kind":"agent.app_server_instances","payload":{"instances":[]}}"#.to_owned();
        let now = Instant::now();
        let mut state = AppServerInstancesSendState {
            last_sent: Some(message.clone()),
            last_sent_at: Some(now),
            last_acked: None,
        };
        acknowledge_app_server_instances(&mut state);

        assert!(!should_send_app_server_instances(
            &message,
            &state,
            false,
            now + (app_server_instance_summary_interval() - Duration::from_secs(1))
        ));
        assert!(should_send_app_server_instances(
            &message,
            &state,
            false,
            now + app_server_instance_summary_interval()
        ));
    }

    #[test]
    fn unacknowledged_app_server_instances_retry_after_ready_interval() {
        let message = r#"{"kind":"agent.app_server_instances","payload":{"instances":[]}}"#;
        let now = Instant::now();
        let state = AppServerInstancesSendState {
            last_sent: Some(message.to_owned()),
            last_sent_at: Some(now),
            last_acked: None,
        };

        assert!(!should_send_app_server_instances(
            message,
            &state,
            false,
            now + (agent_ready_retry_interval() - Duration::from_secs(1))
        ));
        assert!(should_send_app_server_instances(
            message,
            &state,
            false,
            now + agent_ready_retry_interval()
        ));
    }

    #[test]
    fn app_server_instances_ack_text_updates_send_state() {
        let message =
            r#"{"kind":"agent.app_server_instances","payload":{"instances":[]}}"#.to_owned();
        let mut state = AppServerInstancesSendState {
            last_sent: Some(message.clone()),
            last_sent_at: Some(Instant::now()),
            last_acked: None,
        };

        let applied = apply_app_server_instances_ack_text(
            r#"{"kind":"server.ack","payload":{"kind":"agent.app_server_instances"}}"#,
            &mut state,
        )
        .expect("ack");

        assert!(applied);
        assert_eq!(state.last_acked.as_deref(), Some(message.as_str()));
    }

    #[test]
    fn background_app_server_instances_ack_is_consumed_without_defer() {
        let message =
            r#"{"kind":"agent.app_server_instances","payload":{"instances":[]}}"#.to_owned();
        let text = r#"{"kind":"server.ack","payload":{"kind":"agent.app_server_instances"}}"#;
        let envelope: Envelope = serde_json::from_str(text).expect("envelope");
        let mut app_server_instances_state = AppServerInstancesSendState {
            last_sent: Some(message.clone()),
            last_sent_at: Some(Instant::now()),
            last_acked: None,
        };
        let mut host_sessions_state = HostSessionsSendState::default();

        assert_eq!(
            classify_ack_wait_text(text, "command-1", "command.started").expect("classify"),
            AckWaitAction::Defer
        );
        assert!(handle_background_ack_message(
            &envelope,
            &mut app_server_instances_state,
            &mut host_sessions_state
        ));
        assert_eq!(
            app_server_instances_state.last_acked.as_deref(),
            Some(message.as_str())
        );
    }

    #[test]
    fn app_server_instances_message_reports_active_turn_count() {
        let mut config = test_config();
        config.session_inventory.managed_app_server.enabled = true;
        config.session_inventory.managed_app_server.listen_url =
            Some("ws://127.0.0.1:65530".to_owned());
        let mut manager = AppServerManager::new(&config);
        manager.begin_turn();

        let message = app_server_instances_message(&config, &manager, true).expect("message");
        let value: Value = serde_json::from_str(&message).expect("json");

        assert_eq!(
            value.pointer("/kind").and_then(Value::as_str),
            Some("agent.app_server_instances")
        );
        assert_eq!(
            value
                .pointer("/payload/instances/0/active_turn_count")
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            value.pointer("/payload/snapshot").and_then(Value::as_bool),
            Some(true)
        );
        assert!(value.pointer("/payload/instances/0/last_error").is_none());
    }

    #[test]
    fn agent_ready_ack_text_updates_sent_and_acked_state() {
        let mut state = AgentReadyState::default();

        let applied = apply_agent_ready_ack_text(
            r#"{"kind":"server.ack","payload":{"kind":"agent.ready","capabilities":["placeholder_commands"]}}"#,
            &mut state,
        )
        .expect("parsed ack");

        let expected = agent_ready_message(&["placeholder_commands".to_owned()]);
        assert!(applied);
        assert_eq!(state.last_sent.as_deref(), Some(expected.as_str()));
        assert!(state.last_sent_at.is_none());
        assert_eq!(state.last_acked.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn host_sessions_ack_records_latest_sent_payload() {
        let envelope: super::Envelope = serde_json::from_str(
            r#"{"kind":"server.ack","payload":{"kind":"agent.host_sessions"}}"#,
        )
        .expect("envelope");
        assert!(host_sessions_ack_message(&envelope));

        let mut state = HostSessionsSendState::default();
        let now = Instant::now();
        state.last_sent = Some("host-sessions-v1".to_owned());
        state.last_sent_at = Some(now);

        let applied = apply_host_sessions_ack_text(
            r#"{"kind":"server.ack","payload":{"kind":"agent.host_sessions"}}"#,
            &mut state,
        )
        .expect("parsed ack");

        assert!(applied);
        assert_eq!(state.last_sent.as_deref(), Some("host-sessions-v1"));
        assert!(state.last_sent_at.is_none());
        assert_eq!(state.last_acked.as_deref(), Some("host-sessions-v1"));
    }

    #[test]
    fn acknowledged_host_sessions_suppress_same_payload_until_forced() {
        let mut state = HostSessionsSendState::default();
        let message = r#"{"kind":"agent.host_sessions","payload":{"sessions":[]}}"#;
        let now = Instant::now();
        state.last_sent = Some(message.to_owned());

        acknowledge_host_sessions(&mut state);

        assert!(!should_send_host_sessions(
            message,
            &state,
            false,
            now + Duration::from_secs(60)
        ));
        assert!(should_send_host_sessions(
            message,
            &state,
            true,
            now + Duration::from_secs(60)
        ));
    }

    #[test]
    fn unacknowledged_host_sessions_retries_only_after_interval() {
        let mut state = HostSessionsSendState::default();
        let message = r#"{"kind":"agent.host_sessions","payload":{"sessions":[]}}"#;
        let changed_message =
            r#"{"kind":"agent.host_sessions","payload":{"sessions":[{"id":"session-1"}]}}"#;
        let now = Instant::now();

        state.last_sent = Some(message.to_owned());
        state.last_sent_at = Some(now);

        assert!(!should_send_host_sessions(
            message,
            &state,
            false,
            now + (host_sessions_retry_interval() - Duration::from_secs(1))
        ));
        assert!(should_send_host_sessions(
            message,
            &state,
            false,
            now + host_sessions_retry_interval()
        ));
        assert!(should_send_host_sessions(
            changed_message,
            &state,
            false,
            now + Duration::from_secs(1)
        ));
    }

    #[test]
    fn changed_agent_ready_payload_forces_host_session_refresh() {
        assert!(!super::AgentReadySend::NotSent.should_send_host_sessions());
        assert!(!super::AgentReadySend::SentSamePayload.should_send_host_sessions());
        assert!(super::AgentReadySend::SentChangedPayload.should_send_host_sessions());
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
