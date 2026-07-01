use chaop_agent::app_server_manager::AppServerManager;
use chaop_agent::config::AgentConfig;
use chaop_agent::connector::{RunMode, run_connector};
use chaop_agent::placeholder::placeholder_event_stream;
use chaop_agent::session_inventory::app_server_health_check_with_auth;
use std::env;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    let config_path = arg_value(&args, "--config").unwrap_or("agent.toml");
    let connect = args.iter().any(|arg| arg == "--connect");
    let run_once = args.iter().any(|arg| arg == "--run-once");
    let print_placeholder = args.iter().any(|arg| arg == "--print-placeholder-events");
    let app_server_health_check = args.iter().any(|arg| arg == "--app-server-health-check");

    let config = AgentConfig::load(config_path)?;

    if app_server_health_check {
        let url = config
            .session_inventory
            .app_server_url
            .as_deref()
            .or_else(|| {
                config
                    .session_inventory
                    .managed_app_server
                    .enabled
                    .then_some(
                        config
                            .session_inventory
                            .managed_app_server
                            .listen_url
                            .as_deref(),
                    )
                    .flatten()
            })
            .ok_or("connector config does not define an app-server URL")?;
        app_server_health_check_with_auth(
            url,
            config.session_inventory.app_server_timeout_seconds,
            config
                .session_inventory
                .app_server_auth_token_file
                .as_deref(),
        )?;
        println!("app-server health: PASS");
        return Ok(());
    }

    if print_placeholder {
        let prompt = arg_value(&args, "--prompt").unwrap_or("placeholder command");
        let events = placeholder_event_stream(prompt);
        println!("{}", serde_json::to_string_pretty(&events)?);
        return Ok(());
    }

    if connect {
        let run_mode = if run_once {
            RunMode::Once
        } else {
            RunMode::Continuous
        };
        return run_connector(&config, run_mode);
    }

    let hostname = arg_value(&args, "--hostname").unwrap_or("localhost");
    let mut app_server = AppServerManager::new(&config);
    let runtime_config = app_server.runtime_config_without_start(&config);
    let request = runtime_config.bootstrap_request(hostname);
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
