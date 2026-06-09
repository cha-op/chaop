use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentConfig {
    pub connector_name: String,
    pub control_url: String,
    pub bootstrap_url: String,
    pub workspace_root: PathBuf,
    pub token_file: PathBuf,
    pub spool_db: PathBuf,
    pub bootstrap: BootstrapConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BootstrapConfig {
    pub secret_file: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BootstrapRequest {
    pub connector_name: String,
    pub hostname: String,
    pub workspace_root: String,
    pub capabilities: Vec<String>,
}

impl AgentConfig {
    pub fn load(path: impl AsRef<Path>) -> Result<Self, ConfigError> {
        let content = fs::read_to_string(path).map_err(ConfigError::Read)?;
        toml::from_str(&content).map_err(ConfigError::Parse)
    }

    pub fn bootstrap_request(&self, hostname: &str) -> BootstrapRequest {
        BootstrapRequest {
            connector_name: self.connector_name.clone(),
            hostname: hostname.to_owned(),
            workspace_root: self.workspace_root.to_string_lossy().into_owned(),
            capabilities: vec![
                "placeholder_commands".to_owned(),
                "event_stream_summary".to_owned(),
                "local_spool_skeleton".to_owned(),
            ],
        }
    }

    pub fn read_bootstrap_secret(&self) -> Result<String, ConfigError> {
        let value = fs::read_to_string(&self.bootstrap.secret_file).map_err(ConfigError::Read)?;
        Ok(value.trim().to_owned())
    }
}

#[derive(Debug)]
pub enum ConfigError {
    Read(std::io::Error),
    Parse(toml::de::Error),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read(error) => write!(formatter, "failed to read connector config: {error}"),
            Self::Parse(error) => write!(formatter, "failed to parse connector config: {error}"),
        }
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests {
    use super::AgentConfig;
    use std::fs;

    #[test]
    fn loads_connector_config() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let config_path = tempdir.path().join("agent.toml");
        fs::write(
            &config_path,
            r#"
connector_name = "mac-studio"
control_url = "wss://api.example.com/ws/agent"
bootstrap_url = "https://api.example.com/api/agent/bootstrap"
workspace_root = "/Users/you/Program"
token_file = "/Users/you/.chaop/connector.token"
spool_db = "/Users/you/.chaop/connector-spool.sqlite"

[bootstrap]
secret_file = "/Users/you/.chaop/bootstrap.secret"
"#,
        )
        .expect("write config");

        let config = AgentConfig::load(config_path).expect("load config");

        assert_eq!(config.connector_name, "mac-studio");
        assert_eq!(
            config.bootstrap.secret_file.to_string_lossy(),
            "/Users/you/.chaop/bootstrap.secret"
        );
    }

    #[test]
    fn builds_bootstrap_request() {
        let config = AgentConfig {
            connector_name: "mac-studio".to_owned(),
            control_url: "wss://api.example.com/ws/agent".to_owned(),
            bootstrap_url: "https://api.example.com/api/agent/bootstrap".to_owned(),
            workspace_root: "/Users/you/Program".into(),
            token_file: "/Users/you/.chaop/connector.token".into(),
            spool_db: "/Users/you/.chaop/connector-spool.sqlite".into(),
            bootstrap: super::BootstrapConfig {
                secret_file: "/Users/you/.chaop/bootstrap.secret".into(),
            },
        };

        let request = config.bootstrap_request("mac-studio.local");

        assert_eq!(request.connector_name, "mac-studio");
        assert_eq!(request.hostname, "mac-studio.local");
        assert!(
            request
                .capabilities
                .contains(&"placeholder_commands".to_owned())
        );
    }
}
