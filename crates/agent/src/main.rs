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
        let url = app_server_health_target(&config)
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

fn app_server_health_target(config: &AgentConfig) -> Option<&str> {
    if config.session_inventory.managed_app_server.enabled {
        config
            .session_inventory
            .managed_app_server
            .listen_url
            .as_deref()
            .or(config.session_inventory.app_server_url.as_deref())
    } else {
        config.session_inventory.app_server_url.as_deref()
    }
}

fn arg_value<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.windows(2).find_map(|pair| {
        (pair.first()? == key)
            .then(|| pair.get(1).map(String::as_str))
            .flatten()
    })
}

#[cfg(test)]
mod tests {
    use super::app_server_health_target;
    use chaop_agent::config::{AgentConfig, BootstrapConfig};

    #[test]
    fn app_server_health_target_prefers_managed_listener() {
        let mut config = AgentConfig {
            connector_name: "test-connector".to_owned(),
            control_url: "wss://api.example.test/ws/agent".to_owned(),
            bootstrap_url: "https://api.example.test/connector/bootstrap".to_owned(),
            workspace_root: "/tmp/chaop".into(),
            token_file: "/tmp/connector.token".into(),
            spool_db: "/tmp/connector.sqlite".into(),
            bootstrap: BootstrapConfig {
                secret_file: "/tmp/bootstrap.secret".into(),
            },
            execution: Default::default(),
            session_inventory: Default::default(),
        };
        config.session_inventory.app_server_url = Some("wss://external.example.test".to_owned());
        config.session_inventory.managed_app_server.enabled = true;
        config.session_inventory.managed_app_server.listen_url =
            Some("unix:///tmp/managed.sock".to_owned());

        assert_eq!(
            app_server_health_target(&config),
            Some("unix:///tmp/managed.sock")
        );

        config.session_inventory.managed_app_server.listen_url = None;
        assert_eq!(
            app_server_health_target(&config),
            Some("wss://external.example.test")
        );

        config.session_inventory.managed_app_server.enabled = false;
        assert_eq!(
            app_server_health_target(&config),
            Some("wss://external.example.test")
        );
    }
}
