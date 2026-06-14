use crate::config::AgentConfig;
use crate::session_inventory::app_server_health_check;
use crate::shutdown::shutdown_requested;
use std::io::{self, ErrorKind};
use std::net::IpAddr;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::http::Uri;

const APP_SERVER_SPAWN_ATTEMPTS: usize = 3;
const APP_SERVER_SPAWN_RETRY_DELAY: Duration = Duration::from_millis(20);

#[derive(Debug)]
pub struct AppServerManager {
    enabled: bool,
    listen_url: Option<String>,
    child: Option<Child>,
    last_start_failure: Option<Instant>,
    shutdown_requested: fn() -> bool,
}

impl AppServerManager {
    pub fn new(config: &AgentConfig) -> Self {
        let managed = &config.session_inventory.managed_app_server;
        let listen_url = managed
            .listen_url
            .clone()
            .or_else(|| config.session_inventory.app_server_url.clone());
        Self {
            enabled: managed.enabled,
            listen_url,
            child: None,
            last_start_failure: None,
            shutdown_requested,
        }
    }

    #[cfg(test)]
    fn new_with_shutdown_requested(config: &AgentConfig, shutdown_requested: fn() -> bool) -> Self {
        let mut manager = Self::new(config);
        manager.shutdown_requested = shutdown_requested;
        manager
    }

    pub fn runtime_config(&mut self, config: &AgentConfig) -> AgentConfig {
        self.runtime_config_with_start_policy(config, true)
    }

    pub fn runtime_config_without_start(&mut self, config: &AgentConfig) -> AgentConfig {
        self.runtime_config_with_start_policy(config, false)
    }

    fn runtime_config_with_start_policy(
        &mut self,
        config: &AgentConfig,
        allow_start: bool,
    ) -> AgentConfig {
        if !self.enabled {
            return config.clone();
        }

        let mut runtime = config.clone();
        runtime.session_inventory.app_server_url = if allow_start {
            self.ensure_ready(config)
        } else {
            self.probe_ready(config)
        };
        runtime
    }

    fn probe_ready(&self, config: &AgentConfig) -> Option<String> {
        let Some(listen_url) = self.validated_listen_url() else {
            return None;
        };

        if app_server_health_check(
            &listen_url,
            config.session_inventory.app_server_timeout_seconds,
        )
        .is_ok()
        {
            Some(listen_url)
        } else {
            None
        }
    }

    fn ensure_ready(&mut self, config: &AgentConfig) -> Option<String> {
        let Some(listen_url) = self.validated_listen_url() else {
            return None;
        };

        self.clear_exited_child();
        if app_server_health_check(
            &listen_url,
            config.session_inventory.app_server_timeout_seconds,
        )
        .is_ok()
        {
            return Some(listen_url);
        }

        if !self.can_attempt_start(config) {
            return None;
        }
        if (self.shutdown_requested)() {
            return None;
        }
        if self.child.is_some() {
            self.stop_child("restarting unhealthy managed app-server");
        }

        match self.spawn_app_server(config, &listen_url) {
            Ok(child) => {
                self.child = Some(child);
                if self.wait_until_ready(config, &listen_url) {
                    Some(listen_url)
                } else {
                    self.stop_child(
                        "managed app-server did not become healthy before startup timeout",
                    );
                    self.record_start_failure();
                    None
                }
            }
            Err(error) => {
                eprintln!("failed to start managed app-server: {error}");
                self.record_start_failure();
                None
            }
        }
    }

    fn clear_exited_child(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        let should_cleanup = match child.try_wait() {
            Ok(Some(status)) => {
                eprintln!("managed app-server exited with status {status}");
                true
            }
            Ok(None) => false,
            Err(error) => {
                eprintln!("failed to inspect managed app-server status: {error}");
                true
            }
        };

        if should_cleanup {
            self.stop_child("managed app-server exited; cleaning up process group");
            self.record_start_failure();
        }
    }

    fn stop_child(&mut self, reason: &str) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        eprintln!("{reason}; stopping managed app-server");
        if let Err(error) = terminate_child(&mut child) {
            eprintln!("failed to stop managed app-server: {error}");
        }
    }

    fn can_attempt_start(&self, config: &AgentConfig) -> bool {
        match self.last_start_failure {
            Some(last_failure) => {
                last_failure.elapsed()
                    >= Duration::from_secs(
                        config
                            .session_inventory
                            .managed_app_server
                            .restart_backoff_seconds
                            .max(1),
                    )
            }
            None => true,
        }
    }

    fn record_start_failure(&mut self) {
        self.last_start_failure = Some(Instant::now());
    }

    fn validated_listen_url(&self) -> Option<String> {
        let Some(listen_url) = self.listen_url.clone() else {
            eprintln!(
                "managed app-server is enabled but no listen URL is configured; set session_inventory.managed_app_server.listen_url"
            );
            return None;
        };
        if !is_loopback_listen_url(&listen_url) {
            eprintln!(
                "managed app-server listen URL must use localhost or a loopback IP address: {listen_url}"
            );
            return None;
        }
        Some(listen_url)
    }

    fn spawn_app_server(&self, config: &AgentConfig, listen_url: &str) -> std::io::Result<Child> {
        let mut last_busy_error = None;
        for attempt in 1..=APP_SERVER_SPAWN_ATTEMPTS {
            let mut command = self.app_server_command(config, listen_url);
            match command.spawn() {
                Ok(child) => return Ok(child),
                Err(error)
                    if is_executable_file_busy(&error) && attempt < APP_SERVER_SPAWN_ATTEMPTS =>
                {
                    last_busy_error = Some(error);
                    thread::sleep(APP_SERVER_SPAWN_RETRY_DELAY);
                }
                Err(error) => return Err(error),
            }
        }

        Err(last_busy_error.unwrap_or_else(|| io::Error::other("app-server spawn failed")))
    }

    fn app_server_command(&self, config: &AgentConfig, listen_url: &str) -> Command {
        let mut command = Command::new(&config.execution.codex_command);
        if let Some(profile) = config.execution.codex_profile.as_deref() {
            command.args(["--profile", profile]);
        }
        if let Some(model) = config.execution.codex_model.as_deref() {
            command.args(["--model", model]);
        }
        command
            .arg("app-server")
            .args(&config.session_inventory.managed_app_server.extra_args)
            .args(["--listen", listen_url])
            .current_dir(&config.workspace_root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(codex_home) = &config.session_inventory.codex_home {
            command.env("CODEX_HOME", codex_home);
        }
        #[cfg(unix)]
        {
            command.process_group(0);
        }
        command
    }

    fn wait_until_ready(&mut self, config: &AgentConfig, listen_url: &str) -> bool {
        let timeout = Duration::from_secs(
            config
                .session_inventory
                .managed_app_server
                .startup_timeout_seconds
                .max(1),
        );
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if (self.shutdown_requested)() {
                return false;
            }
            self.clear_exited_child();
            if self.child.is_none() {
                return false;
            }
            if app_server_health_check(
                listen_url,
                config.session_inventory.app_server_timeout_seconds,
            )
            .is_ok()
            {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        false
    }
}

fn is_loopback_listen_url(listen_url: &str) -> bool {
    let Ok(uri) = listen_url.parse::<Uri>() else {
        return false;
    };
    match uri.scheme_str() {
        Some("ws") | Some("wss") => {}
        _ => return false,
    }
    let Some(host) = uri.host() else {
        return false;
    };
    is_loopback_host(host)
}

fn is_loopback_host(host: &str) -> bool {
    let normalised = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    normalised == "localhost"
        || normalised
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

impl Drop for AppServerManager {
    fn drop(&mut self) {
        self.stop_child("managed app-server manager is shutting down");
    }
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> io::Result<bool> {
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(unix)]
fn is_executable_file_busy(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ETXTBSY)
}

#[cfg(not(unix))]
fn is_executable_file_busy(_error: &io::Error) -> bool {
    false
}

#[cfg(unix)]
fn terminate_child(child: &mut Child) -> io::Result<()> {
    let child_pid = child.id() as libc::pid_t;
    if child.try_wait()?.is_none() {
        signal_process_group(child_pid, libc::SIGTERM)?;
        if !wait_for_child_exit(child, Duration::from_secs(2))? {
            signal_process_group(child_pid, libc::SIGKILL)?;
            let _ = child.kill();
            let _ = child.wait()?;
            return Ok(());
        }
    }

    signal_process_group(child_pid, libc::SIGTERM)?;
    signal_process_group(child_pid, libc::SIGKILL)?;
    let _ = child.wait()?;
    Ok(())
}

#[cfg(unix)]
fn signal_process_group(process_group_id: libc::pid_t, signal: libc::c_int) -> io::Result<()> {
    if unsafe { libc::kill(-process_group_id, signal) } != 0 {
        let error = io::Error::last_os_error();
        if error.kind() != ErrorKind::InvalidInput && error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn terminate_child(child: &mut Child) -> io::Result<()> {
    match child.kill() {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::InvalidInput => {}
        Err(error) => return Err(error),
    }
    let _ = child.wait()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{AppServerManager, is_loopback_listen_url, terminate_child};
    use crate::config::{
        AgentConfig, BootstrapConfig, ExecutionConfig, ExecutionMode, ManagedAppServerConfig,
        SessionInventoryConfig,
    };
    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    static TEST_SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

    #[test]
    fn managed_listen_url_requires_loopback_host() {
        assert!(is_loopback_listen_url("ws://localhost:65530"));
        assert!(is_loopback_listen_url("ws://127.0.0.1:65530"));
        assert!(is_loopback_listen_url("ws://[::1]:65530"));
        assert!(!is_loopback_listen_url("ws://0.0.0.0:65530"));
        assert!(!is_loopback_listen_url("ws://192.168.1.20:65530"));
        assert!(!is_loopback_listen_url("ws://codex.example.test:65530"));
    }

    #[test]
    fn unmanaged_runtime_config_preserves_external_app_server_url() {
        let config = config_with_managed(false);
        let mut manager = AppServerManager::new(&config);

        let runtime = manager.runtime_config(&config);

        assert_eq!(
            runtime.session_inventory.app_server_url.as_deref(),
            Some("ws://127.0.0.1:65530")
        );
        assert!(
            runtime
                .capabilities()
                .contains(&"codex_app_server_exec".to_owned())
        );
    }

    #[test]
    fn managed_runtime_config_rejects_non_loopback_listen_url_without_spawning() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let marker = tempdir.path().join("spawned");
        let command = tempdir.path().join("codex-stub");
        write_executable(
            &command,
            &format!(
                "#!/bin/sh\nprintf spawned > '{}'\nsleep 30\n",
                marker.display()
            ),
        );
        let mut config = config_with_managed(true);
        config.execution.codex_command = command.to_string_lossy().into_owned();
        config.session_inventory.managed_app_server.listen_url =
            Some("ws://0.0.0.0:65530".to_owned());
        let mut manager = AppServerManager::new(&config);

        let runtime = manager.runtime_config(&config);

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert!(manager.child.is_none());
        assert!(!marker.exists());
    }

    #[test]
    fn managed_runtime_config_omits_app_server_capabilities_when_unhealthy() {
        let mut config = config_with_managed(true);
        config.execution.codex_command = "/path/that/does/not/exist/codex".to_owned();
        config
            .session_inventory
            .managed_app_server
            .restart_backoff_seconds = 60;
        let mut manager = AppServerManager::new(&config);

        let runtime = manager.runtime_config(&config);

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert!(
            !runtime
                .capabilities()
                .contains(&"codex_app_server_exec".to_owned())
        );
        assert!(
            !runtime
                .capabilities()
                .contains(&"app_server_threads".to_owned())
        );
        assert!(
            !runtime
                .capabilities()
                .contains(&"app_server_archive".to_owned())
        );
    }

    #[test]
    fn managed_probe_runtime_config_does_not_start_unhealthy_listener() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let marker = tempdir.path().join("spawned");
        let command = tempdir.path().join("codex-stub");
        write_executable(
            &command,
            &format!(
                "#!/bin/sh\nprintf spawned > '{}'\nsleep 5\n",
                marker.display()
            ),
        );
        let mut config = config_with_managed(true);
        config.execution.codex_command = command.to_string_lossy().into_owned();
        config
            .session_inventory
            .managed_app_server
            .restart_backoff_seconds = 60;
        let mut manager = AppServerManager::new(&config);

        let runtime = manager.runtime_config_without_start(&config);

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert!(!marker.exists());
    }

    #[test]
    fn managed_app_server_spawn_inherits_codex_home() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let codex_home = tempdir.path().join("codex-home");
        let marker = tempdir.path().join("codex-home-marker");
        let command = tempdir.path().join("codex-stub");
        write_executable(
            &command,
            &format!(
                "#!/bin/sh\nprintf '%s' \"$CODEX_HOME\" > '{}'\nsleep 5\n",
                marker.display()
            ),
        );
        let mut config = config_with_managed(true);
        config.execution.codex_command = command.to_string_lossy().into_owned();
        config.session_inventory.codex_home = Some(codex_home.clone());
        let manager = AppServerManager::new(&config);
        let mut child = manager
            .spawn_app_server(&config, "ws://127.0.0.1:65530")
            .expect("spawn app-server");

        let recorded = wait_for_file_content(&marker);
        child.kill().expect("kill child");
        child.wait().expect("wait child");

        assert_eq!(recorded, codex_home.to_string_lossy());
    }

    #[test]
    fn managed_app_server_spawn_forwards_codex_app_server_args() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let marker = tempdir.path().join("args-marker");
        let command = tempdir.path().join("codex-stub");
        write_executable(
            &command,
            &format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nsleep 5\n",
                marker.display()
            ),
        );
        let mut config = config_with_managed(true);
        config.execution.codex_command = command.to_string_lossy().into_owned();
        config.execution.codex_profile = Some("work".to_owned());
        config.execution.codex_model = Some("gpt-5.5".to_owned());
        config.execution.extra_args = vec!["--skip-git-repo-check".to_owned()];
        config.session_inventory.managed_app_server.extra_args =
            vec!["--ws-project-doc-max-bytes".to_owned(), "131072".to_owned()];
        let manager = AppServerManager::new(&config);
        let mut child = manager
            .spawn_app_server(&config, "ws://127.0.0.1:65530")
            .expect("spawn app-server");

        let recorded = wait_for_file_content(&marker);
        child.kill().expect("kill child");
        child.wait().expect("wait child");

        assert_eq!(
            recorded.lines().collect::<Vec<_>>(),
            vec![
                "--profile",
                "work",
                "--model",
                "gpt-5.5",
                "app-server",
                "--ws-project-doc-max-bytes",
                "131072",
                "--listen",
                "ws://127.0.0.1:65530",
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn managed_app_server_spawn_uses_dedicated_process_group() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let marker = tempdir.path().join("spawned");
        let command = tempdir.path().join("codex-stub");
        write_executable(
            &command,
            &format!(
                "#!/bin/sh\nprintf spawned > '{}'\nsleep 5\n",
                marker.display()
            ),
        );
        let mut config = config_with_managed(true);
        config.execution.codex_command = command.to_string_lossy().into_owned();
        let manager = AppServerManager::new(&config);
        let mut child = manager
            .spawn_app_server(&config, "ws://127.0.0.1:65530")
            .expect("spawn app-server");

        wait_for_path(&marker);
        let child_pid = child.id() as libc::pid_t;
        let process_group_id = unsafe { libc::getpgid(child_pid) };
        child.kill().expect("kill child");
        child.wait().expect("wait child");

        assert_eq!(process_group_id, child_pid);
    }

    #[cfg(unix)]
    #[test]
    fn terminate_child_kills_process_group_descendant_after_child_exit() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let descendant_pid_file = tempdir.path().join("descendant.pid");
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "(trap '' TERM; sleep 30) & echo $! > '{}'; exit 0",
                descendant_pid_file.display()
            ))
            .process_group(0)
            .spawn()
            .expect("spawn child with descendant");
        let descendant_pid = wait_for_file_content(&descendant_pid_file)
            .trim()
            .parse::<libc::pid_t>()
            .expect("descendant pid");

        terminate_child(&mut child).expect("terminate process group");

        wait_for_process_exit(descendant_pid);
    }

    #[cfg(unix)]
    #[test]
    fn clear_exited_child_kills_process_group_descendant_after_child_exit() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let descendant_pid_file = tempdir.path().join("descendant.pid");
        let child = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "(trap '' TERM; sleep 30) & echo $! > '{}'; exit 0",
                descendant_pid_file.display()
            ))
            .process_group(0)
            .spawn()
            .expect("spawn child with descendant");
        let descendant_pid = wait_for_file_content(&descendant_pid_file)
            .trim()
            .parse::<libc::pid_t>()
            .expect("descendant pid");
        let mut config = config_with_managed(true);
        config
            .session_inventory
            .managed_app_server
            .restart_backoff_seconds = 60;
        let mut manager = AppServerManager::new(&config);
        manager.child = Some(child);

        for _ in 0..250 {
            manager.clear_exited_child();
            if manager.child.is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        assert!(manager.child.is_none());
        assert!(!manager.can_attempt_start(&config));
        wait_for_process_exit(descendant_pid);
    }

    #[test]
    fn managed_app_server_startup_timeout_stops_child() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let marker = tempdir.path().join("spawned");
        let command = tempdir.path().join("codex-stub");
        write_executable(
            &command,
            &format!(
                "#!/bin/sh\nprintf spawned > '{}'\nsleep 30\n",
                marker.display()
            ),
        );
        let mut config = config_with_managed(true);
        config.execution.codex_command = command.to_string_lossy().into_owned();
        config
            .session_inventory
            .managed_app_server
            .startup_timeout_seconds = 1;
        config
            .session_inventory
            .managed_app_server
            .restart_backoff_seconds = 60;
        let mut manager = AppServerManager::new(&config);

        let runtime = manager.runtime_config(&config);

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert!(manager.child.is_none());
        assert!(!manager.can_attempt_start(&config));
    }

    #[test]
    fn managed_app_server_restart_backoff_starts_after_startup_failure() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let marker = tempdir.path().join("spawned");
        let command = tempdir.path().join("codex-stub");
        write_executable(
            &command,
            &format!(
                "#!/bin/sh\nprintf spawned > '{}'\nsleep 30\n",
                marker.display()
            ),
        );
        let mut config = config_with_managed(true);
        config.execution.codex_command = command.to_string_lossy().into_owned();
        config
            .session_inventory
            .managed_app_server
            .startup_timeout_seconds = 1;
        config
            .session_inventory
            .managed_app_server
            .restart_backoff_seconds = 1;
        let mut manager = AppServerManager::new(&config);

        let runtime = manager.runtime_config(&config);

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert!(!manager.can_attempt_start(&config));
    }

    #[test]
    fn managed_app_server_restart_backoff_starts_after_child_exit() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let respawn_marker = tempdir.path().join("respawned");
        let exited_child_command = tempdir.path().join("exited-child");
        let respawn_command = tempdir.path().join("codex-stub");
        write_executable(&exited_child_command, "#!/bin/sh\nexit 0\n");
        write_executable(
            &respawn_command,
            &format!(
                "#!/bin/sh\nprintf respawned > '{}'\nsleep 30\n",
                respawn_marker.display()
            ),
        );
        let mut exited_child = std::process::Command::new(&exited_child_command)
            .spawn()
            .expect("spawn exited child");
        exited_child.wait().expect("wait exited child");
        let mut config = config_with_managed(true);
        config.execution.codex_command = respawn_command.to_string_lossy().into_owned();
        config
            .session_inventory
            .managed_app_server
            .restart_backoff_seconds = 60;
        let mut manager = AppServerManager::new(&config);
        manager.child = Some(exited_child);

        let runtime = manager.runtime_config(&config);

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert!(!respawn_marker.exists());
        assert!(manager.child.is_none());
        assert!(!manager.can_attempt_start(&config));
    }

    #[test]
    fn managed_app_server_startup_wait_stops_child_after_shutdown() {
        TEST_SHUTDOWN_REQUESTED.store(false, Ordering::SeqCst);
        let tempdir = tempfile::tempdir().expect("tempdir");
        let marker = tempdir.path().join("spawned");
        let command = tempdir.path().join("codex-stub");
        write_executable(
            &command,
            &format!(
                "#!/bin/sh\nprintf spawned > '{}'\nsleep 30\n",
                marker.display()
            ),
        );
        let mut config = config_with_managed(true);
        config.execution.codex_command = command.to_string_lossy().into_owned();
        config
            .session_inventory
            .managed_app_server
            .startup_timeout_seconds = 10;
        config
            .session_inventory
            .managed_app_server
            .restart_backoff_seconds = 60;
        let mut manager =
            AppServerManager::new_with_shutdown_requested(&config, test_shutdown_requested);
        let worker = std::thread::spawn({
            let marker = marker.clone();
            move || {
                wait_for_path(&marker);
                TEST_SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
            }
        });

        let started_at = Instant::now();
        let runtime = manager.runtime_config(&config);
        worker.join().expect("shutdown worker");
        TEST_SHUTDOWN_REQUESTED.store(false, Ordering::SeqCst);

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert!(started_at.elapsed() < Duration::from_secs(5));
        assert!(manager.child.is_none());
        assert!(!manager.can_attempt_start(&config));
    }

    fn config_with_managed(enabled: bool) -> AgentConfig {
        AgentConfig {
            connector_name: "mac-studio".to_owned(),
            control_url: "wss://api.example.com/ws/agent".to_owned(),
            bootstrap_url: "https://api.example.com/connector/bootstrap".to_owned(),
            workspace_root: "/tmp".into(),
            token_file: "/tmp/connector.token".into(),
            spool_db: "/tmp/connector-spool.sqlite".into(),
            bootstrap: BootstrapConfig {
                secret_file: "/tmp/bootstrap.secret".into(),
            },
            execution: ExecutionConfig {
                mode: ExecutionMode::AppServer,
                ..ExecutionConfig::default()
            },
            session_inventory: SessionInventoryConfig {
                app_server_url: Some("ws://127.0.0.1:65530".to_owned()),
                app_server_timeout_seconds: 1,
                managed_app_server: ManagedAppServerConfig {
                    enabled,
                    listen_url: None,
                    extra_args: Vec::new(),
                    startup_timeout_seconds: 1,
                    restart_backoff_seconds: 1,
                },
                ..SessionInventoryConfig::default()
            },
        }
    }

    fn write_executable(path: &std::path::Path, content: &str) {
        std::fs::write(path, content).expect("write executable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(path).expect("metadata").permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(path, permissions).expect("permissions");
        }
    }

    fn wait_for_path(path: &std::path::Path) {
        for _ in 0..250 {
            if path.exists() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("timed out waiting for {}", path.display());
    }

    fn wait_for_file_content(path: &std::path::Path) -> String {
        for _ in 0..250 {
            if let Ok(content) = std::fs::read_to_string(path) {
                if !content.is_empty() {
                    return content;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("timed out waiting for content in {}", path.display());
    }

    #[cfg(unix)]
    fn wait_for_process_exit(pid: libc::pid_t) {
        for _ in 0..250 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    return;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("process still exists: {pid}");
    }

    fn test_shutdown_requested() -> bool {
        TEST_SHUTDOWN_REQUESTED.load(Ordering::SeqCst)
    }
}
