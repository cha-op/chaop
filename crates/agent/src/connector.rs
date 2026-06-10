use crate::config::AgentConfig;
use crate::placeholder::placeholder_event_stream;
use serde::Deserialize;
use serde_json::json;
use std::fs;
use std::net::TcpStream;
use std::time::Duration;
use tungstenite::client::IntoClientRequest;
use tungstenite::{Message, connect};

type AgentSocket = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>;

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
    prompt: String,
}

pub fn run_connector(
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
    socket.send(Message::Text(
        json!({ "kind": "agent.ready" }).to_string().into(),
    ))?;

    loop {
        let message = socket.read()?;
        match message {
            Message::Text(text) => {
                if handle_text_message(&mut socket, text.as_ref())? && run_mode == RunMode::Once {
                    socket.close(None)?;
                    return Ok(());
                }
            }
            Message::Ping(payload) => socket.send(Message::Pong(payload))?,
            Message::Close(_) => return Ok(()),
            _ => {}
        }
    }
}

fn handle_text_message(
    socket: &mut AgentSocket,
    text: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    let envelope: Envelope = serde_json::from_str(text)?;
    if envelope.kind != "command.dispatch" {
        return Ok(false);
    }

    let dispatch: CommandDispatch = serde_json::from_value(envelope.payload)?;
    for event in placeholder_event_stream(&dispatch.command.prompt) {
        if event.kind == "command.accepted" {
            continue;
        }
        socket.send(Message::Text(
            json!({
                "kind": "agent.event",
                "payload": {
                    "command_id": dispatch.command.id,
                    "kind": event.kind,
                    "priority": event.priority,
                    "summary": event.summary
                }
            })
            .to_string()
            .into(),
        ))?;
        wait_for_ack(socket, &dispatch.command.id, &event.kind)?;
    }
    Ok(true)
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

fn wait_for_ack(
    socket: &mut AgentSocket,
    command_id: &str,
    event_kind: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    set_socket_read_timeout(socket, Some(Duration::from_secs(10)))?;
    loop {
        match socket.read()? {
            Message::Text(text) => {
                let envelope: Envelope = serde_json::from_str(text.as_ref())?;
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
                    set_socket_read_timeout(socket, None)?;
                    return Ok(());
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
