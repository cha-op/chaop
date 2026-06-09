use chaop_agent::config::AgentConfig;
use chaop_agent::placeholder::placeholder_event_stream;
use std::env;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    let config_path = arg_value(&args, "--config").unwrap_or("agent.toml");
    let print_placeholder = args.iter().any(|arg| arg == "--print-placeholder-events");

    let config = AgentConfig::load(config_path)?;

    if print_placeholder {
        let prompt = arg_value(&args, "--prompt").unwrap_or("placeholder command");
        let events = placeholder_event_stream(prompt);
        println!("{}", serde_json::to_string_pretty(&events)?);
        return Ok(());
    }

    let hostname = arg_value(&args, "--hostname").unwrap_or("localhost");
    let request = config.bootstrap_request(hostname);
    println!("{}", serde_json::to_string_pretty(&request)?);
    Ok(())
}

fn arg_value<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.windows(2).find_map(|pair| {
        (pair.first()? == key)
            .then(|| pair.get(1).map(String::as_str))
            .flatten()
    })
}
