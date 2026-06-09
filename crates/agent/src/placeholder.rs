use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlaceholderEvent {
    pub kind: String,
    pub priority: String,
    pub summary: String,
}

pub fn placeholder_event_stream(prompt: &str) -> Vec<PlaceholderEvent> {
    vec![
        PlaceholderEvent {
            kind: "command.accepted".to_owned(),
            priority: "P1".to_owned(),
            summary: format!("Accepted placeholder command: {}", prompt.trim()),
        },
        PlaceholderEvent {
            kind: "command.started".to_owned(),
            priority: "P1".to_owned(),
            summary: "Connector acquired the placeholder lease.".to_owned(),
        },
        PlaceholderEvent {
            kind: "command.output".to_owned(),
            priority: "P2".to_owned(),
            summary: "Summary stream is current; full log detail is deferred.".to_owned(),
        },
        PlaceholderEvent {
            kind: "command.finished".to_owned(),
            priority: "P1".to_owned(),
            summary: "Placeholder command completed successfully.".to_owned(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::placeholder_event_stream;

    #[test]
    fn placeholder_stream_preserves_command_lifecycle() {
        let events = placeholder_event_stream("check status");
        let kinds: Vec<&str> = events.iter().map(|event| event.kind.as_str()).collect();

        assert_eq!(
            kinds,
            vec![
                "command.accepted",
                "command.started",
                "command.output",
                "command.finished"
            ]
        );
    }
}
