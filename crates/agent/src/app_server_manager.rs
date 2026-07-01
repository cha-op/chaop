use crate::config::AgentConfig;
use crate::session_inventory::{app_server_explicit_port, app_server_health_check_with_auth};
use crate::shutdown::shutdown_requested;
use std::io::{self, ErrorKind};
use std::net::{IpAddr, Ipv4Addr, TcpListener};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
#[cfg(unix)]
use std::time::UNIX_EPOCH;
use std::time::{Duration, Instant, SystemTime};
use tungstenite::http::Uri;

const APP_SERVER_SPAWN_ATTEMPTS: usize = 3;
const APP_SERVER_SPAWN_RETRY_DELAY: Duration = Duration::from_millis(20);
const APP_SERVER_EXTERNAL_PROBE_INTERVAL: Duration = Duration::from_secs(30);
const APP_SERVER_DRAIN_TIMEOUT_DETAIL: &str =
    "Drain timeout elapsed while active turns were still running.";
#[cfg(any(target_os = "linux", target_os = "android"))]
const UNIX_SOCKET_PATH_MAX_BYTES: usize = 107;
#[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
const UNIX_SOCKET_PATH_MAX_BYTES: usize = 103;

#[derive(Debug)]
pub struct AppServerManager {
    enabled: bool,
    listen_url: Option<String>,
    child: Option<Child>,
    last_start_failure: Option<Instant>,
    last_external_probe: Option<Instant>,
    shutdown_requested: fn() -> bool,
    terminate_child: fn(&mut Child) -> io::Result<()>,
    state: AppServerInstanceState,
    generation: u64,
    active_turn_count: u32,
    status_summary: Option<String>,
    last_error: Option<String>,
    pending_restart: Option<PendingAppServerRestart>,
    next_scheduled_restart_at: Option<Instant>,
    last_upgrade_marker_modified: Option<SystemTime>,
}

impl AppServerManager {
    pub fn new(config: &AgentConfig) -> Self {
        let managed = &config.session_inventory.managed_app_server;
        let listen_url = managed
            .listen_url
            .clone()
            .or_else(|| config.session_inventory.app_server_url.clone());
        let last_upgrade_marker_modified =
            upgrade_marker_modified(managed.upgrade_marker_file.as_ref());
        Self {
            enabled: managed.enabled,
            listen_url,
            child: None,
            last_start_failure: None,
            last_external_probe: None,
            shutdown_requested,
            terminate_child,
            state: AppServerInstanceState::Stopped,
            generation: 0,
            active_turn_count: 0,
            status_summary: None,
            last_error: None,
            pending_restart: None,
            next_scheduled_restart_at: None,
            last_upgrade_marker_modified,
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

    pub fn runtime_config_during_active_turn(&mut self, config: &AgentConfig) -> AgentConfig {
        if !self.enabled {
            return config.clone();
        }

        let mut runtime = config.clone();
        runtime.session_inventory.app_server_url = self.active_turn_app_server_url(config);
        runtime
    }

    pub fn preflight_managed_app_server(config: &AgentConfig) -> io::Result<()> {
        let mut manager = Self::new(config);
        if !manager.enabled {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "managed app-server preflight requires managed mode",
            ));
        }
        let configured_listen_url = manager.validated_listen_url().ok_or_else(|| {
            io::Error::new(
                ErrorKind::InvalidInput,
                "managed app-server preflight requires a local listen URL",
            )
        })?;
        let endpoint = AppServerPreflightEndpoint::new(&configured_listen_url)?;
        manager.child = Some(manager.spawn_app_server(config, &endpoint.listen_url)?);
        if !manager.wait_until_ready(config, &endpoint.listen_url) {
            manager.stop_child("managed app-server preflight failed");
            return Err(io::Error::other(
                "managed app-server preflight did not become healthy",
            ));
        }
        manager.stop_child_checked("managed app-server preflight passed")?;
        Ok(())
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
            self.runtime_app_server_url(config)
        } else {
            self.probe_ready(config)
        };
        runtime
    }

    pub fn instance_snapshot(&mut self, config: &AgentConfig) -> Option<AppServerInstanceSnapshot> {
        if !self.enabled && config.session_inventory.app_server_url.is_none() {
            return None;
        }
        if !self.enabled {
            self.refresh_external_state(config);
        }
        Some(AppServerInstanceSnapshot {
            instance_key: "default".to_owned(),
            scope: "connector".to_owned(),
            endpoint_type: if self.enabled { "managed" } else { "external" }.to_owned(),
            state: self.state.as_str().to_owned(),
            active_turn_count: self.active_turn_count,
            generation: self.generation,
            status_summary: self.status_summary.clone().or_else(|| {
                Some(if self.enabled {
                    "Managed app-server state is available.".to_owned()
                } else {
                    "External app-server endpoint is configured.".to_owned()
                })
            }),
            last_error: self.last_error.clone(),
        })
    }

    pub fn begin_turn(&mut self) {
        self.active_turn_count = self.active_turn_count.saturating_add(1);
    }

    pub fn finish_turn(&mut self) {
        self.active_turn_count = self.active_turn_count.saturating_sub(1);
    }

    fn runtime_app_server_url(&mut self, config: &AgentConfig) -> Option<String> {
        self.schedule_configured_restart_requests(config);
        if self.pending_restart.is_some() {
            return self.advance_pending_restart(config);
        }

        self.ensure_ready(config)
    }

    fn active_turn_app_server_url(&mut self, config: &AgentConfig) -> Option<String> {
        self.schedule_configured_restart_requests(config);
        if self.pending_restart.is_some() {
            return self.advance_pending_restart(config);
        }

        config.session_inventory.app_server_url.clone()
    }

    fn schedule_configured_restart_requests(&mut self, config: &AgentConfig) {
        self.schedule_periodic_restart(config);
        self.schedule_upgrade_marker_restart(config);
    }

    fn schedule_periodic_restart(&mut self, config: &AgentConfig) {
        let interval = Duration::from_secs(
            config
                .session_inventory
                .managed_app_server
                .scheduled_restart_interval_seconds,
        );
        if interval.is_zero() {
            self.next_scheduled_restart_at = None;
            return;
        }

        let now = Instant::now();
        let Some(next_restart_at) = self.next_scheduled_restart_at else {
            self.next_scheduled_restart_at = now.checked_add(interval);
            return;
        };
        if now >= next_restart_at {
            if self.child.is_none()
                && self
                    .start_backoff_deadline(config)
                    .is_some_and(|deadline| now < deadline)
            {
                self.next_scheduled_restart_at = self.start_backoff_deadline(config);
                return;
            }
            self.request_restart(AppServerRestartReason::Scheduled);
        }
    }

    fn schedule_upgrade_marker_restart(&mut self, config: &AgentConfig) {
        let marker = config
            .session_inventory
            .managed_app_server
            .upgrade_marker_file
            .as_ref();
        let modified = upgrade_marker_modified(marker);
        match (self.last_upgrade_marker_modified, modified) {
            (Some(previous), Some(current)) if current > previous => {
                self.last_upgrade_marker_modified = Some(current);
                self.request_restart(AppServerRestartReason::UpgradeMarker);
            }
            (None, Some(current)) => {
                self.last_upgrade_marker_modified = Some(current);
                self.request_restart(AppServerRestartReason::UpgradeMarker);
            }
            _ => {}
        }
    }

    fn request_restart(&mut self, reason: AppServerRestartReason) {
        if let Some(pending) = self.pending_restart {
            if !reason.supersedes(pending.reason) {
                return;
            }
        }
        self.pending_restart = Some(PendingAppServerRestart {
            reason,
            requested_at: Instant::now(),
        });
        if self.active_turn_count > 0 {
            self.set_state(
                AppServerInstanceState::Draining,
                reason.draining_summary(),
                None,
            );
        } else {
            self.set_state(
                AppServerInstanceState::Restarting,
                reason.restarting_summary(false),
                None,
            );
        }
    }

    fn advance_pending_restart(&mut self, config: &AgentConfig) -> Option<String> {
        let pending = self.pending_restart?;
        self.clear_exited_child();
        let drain_timeout = Duration::from_secs(
            config
                .session_inventory
                .managed_app_server
                .drain_timeout_seconds
                .max(1),
        );
        let force_restart =
            self.active_turn_count > 0 && pending.requested_at.elapsed() >= drain_timeout;
        let scheduled_backoff_deadline = self.scheduled_restart_backoff_deadline(config, pending);
        if self.active_turn_count > 0 {
            if let Some(deadline) = scheduled_backoff_deadline {
                self.next_scheduled_restart_at = Some(deadline);
                self.set_state(
                    AppServerInstanceState::Draining,
                    pending.reason.draining_summary(),
                    None,
                );
                return None;
            }
        }
        if self.active_turn_count > 0 && !force_restart {
            self.set_state(
                AppServerInstanceState::Draining,
                pending.reason.draining_summary(),
                None,
            );
            return None;
        }
        if self.block_unowned_listener_restart(config, pending.reason) {
            return None;
        }
        if let Some(deadline) = scheduled_backoff_deadline {
            self.pending_restart = None;
            self.next_scheduled_restart_at = Some(deadline);
            return self.ensure_ready(config);
        }

        self.pending_restart = None;
        self.arm_next_scheduled_restart(config);
        if self.child.is_some() || force_restart || pending.reason.overrides_start_backoff() {
            self.last_start_failure = None;
        }
        self.set_state(
            AppServerInstanceState::Restarting,
            pending.reason.restarting_summary(force_restart),
            force_restart.then_some("Drain timeout elapsed while active turns were still running."),
        );
        if let Err(error) = self.stop_child_checked(pending.reason.stop_reason(force_restart)) {
            eprintln!("failed to stop managed app-server for restart: {error}");
            self.pending_restart = Some(pending);
            self.set_state(
                AppServerInstanceState::Degraded,
                "Failed to stop managed app-server for restart.",
                Some(&error.to_string()),
            );
            return None;
        }
        if self.block_unowned_listener_restart(config, pending.reason) {
            self.pending_restart = Some(pending);
            return None;
        }
        let url = self.ensure_ready(config);
        if url.is_some() {
            self.arm_next_scheduled_restart(config);
        }
        if force_restart {
            self.record_forced_restart_result(pending.reason, url.is_some());
        }
        url
    }

    fn scheduled_restart_backoff_deadline(
        &self,
        config: &AgentConfig,
        pending: PendingAppServerRestart,
    ) -> Option<Instant> {
        if pending.reason != AppServerRestartReason::Scheduled || self.child.is_some() {
            return None;
        }
        let deadline = self.start_backoff_deadline(config)?;
        (Instant::now() < deadline).then_some(deadline)
    }

    fn block_unowned_listener_restart(
        &mut self,
        config: &AgentConfig,
        reason: AppServerRestartReason,
    ) -> bool {
        if self.child.is_some() || self.probe_ready(config).is_none() {
            return false;
        }

        self.set_state(
            AppServerInstanceState::Degraded,
            reason.unowned_listener_summary(),
            Some("Restart cannot stop the listening app-server because this connector did not start it."),
        );
        true
    }

    fn record_forced_restart_result(&mut self, reason: AppServerRestartReason, healthy: bool) {
        if healthy {
            self.set_state(
                AppServerInstanceState::Healthy,
                reason.forced_healthy_summary(),
                None,
            );
            return;
        }

        let error = self
            .last_error
            .as_deref()
            .map(|last_error| {
                format!("{APP_SERVER_DRAIN_TIMEOUT_DETAIL} Last restart error: {last_error}")
            })
            .unwrap_or_else(|| APP_SERVER_DRAIN_TIMEOUT_DETAIL.to_owned());
        self.set_state(
            AppServerInstanceState::Degraded,
            reason.forced_degraded_summary(),
            Some(&error),
        );
    }

    fn should_preserve_forced_restart_backoff_summary(&self) -> bool {
        self.state == AppServerInstanceState::Degraded
            && self
                .last_error
                .as_deref()
                .is_some_and(|error| error.starts_with(APP_SERVER_DRAIN_TIMEOUT_DETAIL))
    }

    fn arm_next_scheduled_restart(&mut self, config: &AgentConfig) {
        let interval = Duration::from_secs(
            config
                .session_inventory
                .managed_app_server
                .scheduled_restart_interval_seconds,
        );
        self.next_scheduled_restart_at = if interval.is_zero() {
            None
        } else {
            Instant::now().checked_add(interval)
        };
    }

    fn refresh_external_state(&mut self, config: &AgentConfig) {
        let Some(url) = config.session_inventory.app_server_url.as_deref() else {
            return;
        };
        let now = Instant::now();
        if self.last_external_probe.is_some_and(|last_probe| {
            now.saturating_duration_since(last_probe) < APP_SERVER_EXTERNAL_PROBE_INTERVAL
        }) {
            return;
        }
        self.last_external_probe = Some(now);
        match app_server_health_check_with_auth(
            url,
            config.session_inventory.app_server_timeout_seconds,
            config
                .session_inventory
                .app_server_auth_token_file
                .as_deref(),
        ) {
            Ok(()) => self.set_state(
                AppServerInstanceState::Healthy,
                "External app-server is healthy.",
                None,
            ),
            Err(error) => self.set_state(
                AppServerInstanceState::Degraded,
                "External app-server health check failed.",
                Some(&error.to_string()),
            ),
        }
    }

    fn probe_ready(&self, config: &AgentConfig) -> Option<String> {
        let Some(listen_url) = self.validated_listen_url() else {
            return None;
        };

        if app_server_health_check_with_auth(
            &listen_url,
            config.session_inventory.app_server_timeout_seconds,
            config
                .session_inventory
                .app_server_auth_token_file
                .as_deref(),
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
            self.set_state(
                AppServerInstanceState::Degraded,
                "Managed app-server listen URL is missing or not local.",
                Some("Invalid managed app-server listen URL."),
            );
            return None;
        };

        self.clear_exited_child();
        if app_server_health_check_with_auth(
            &listen_url,
            config.session_inventory.app_server_timeout_seconds,
            config
                .session_inventory
                .app_server_auth_token_file
                .as_deref(),
        )
        .is_ok()
        {
            self.set_state(
                AppServerInstanceState::Healthy,
                "Managed app-server is healthy.",
                None,
            );
            return Some(listen_url);
        }

        if !self.can_attempt_start(config) {
            if self.should_preserve_forced_restart_backoff_summary() {
                return None;
            }
            self.set_state(
                AppServerInstanceState::Degraded,
                "Managed app-server restart backoff is active.",
                Some("Health check failed while restart backoff is active."),
            );
            return None;
        }
        if (self.shutdown_requested)() {
            self.set_state(
                AppServerInstanceState::Stopped,
                "Connector shutdown requested before managed app-server start.",
                None,
            );
            return None;
        }
        if self.child.is_some() {
            self.set_state(
                AppServerInstanceState::Restarting,
                "Restarting unhealthy managed app-server.",
                None,
            );
            if let Err(error) = self.stop_child_checked("restarting unhealthy managed app-server") {
                eprintln!("failed to stop unhealthy managed app-server: {error}");
                self.record_start_failure();
                self.set_state(
                    AppServerInstanceState::Degraded,
                    "Failed to stop unhealthy managed app-server.",
                    Some(&error.to_string()),
                );
                return None;
            }
        }

        match self.spawn_app_server(config, &listen_url) {
            Ok(child) => {
                self.child = Some(child);
                if self.wait_until_ready(config, &listen_url) {
                    self.set_state(
                        AppServerInstanceState::Healthy,
                        "Managed app-server is healthy.",
                        None,
                    );
                    Some(listen_url)
                } else {
                    self.stop_child(
                        "managed app-server did not become healthy before startup timeout",
                    );
                    self.record_start_failure();
                    self.set_state(
                        AppServerInstanceState::Degraded,
                        "Managed app-server did not become healthy before startup timeout.",
                        Some("Startup health check timed out."),
                    );
                    None
                }
            }
            Err(error) => {
                eprintln!("failed to start managed app-server: {error}");
                self.record_start_failure();
                self.set_state(
                    AppServerInstanceState::Degraded,
                    "Failed to start managed app-server.",
                    Some(&error.to_string()),
                );
                None
            }
        }
    }

    fn set_state(
        &mut self,
        state: AppServerInstanceState,
        summary: &str,
        last_error: Option<&str>,
    ) {
        if self.state != state {
            self.generation = self.generation.saturating_add(1);
        }
        self.state = state;
        self.status_summary = Some(summary.to_owned());
        self.last_error = last_error.map(str::to_owned);
    }

    fn clear_exited_child(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        let cleanup_reason = match child.try_wait() {
            Ok(Some(status)) => {
                eprintln!("managed app-server exited with status {status}");
                Some((
                    "Managed app-server exited unexpectedly.",
                    format!("Process exited with status {status}."),
                ))
            }
            Ok(None) => None,
            Err(error) => {
                eprintln!("failed to inspect managed app-server status: {error}");
                Some((
                    "Failed to inspect managed app-server status.",
                    error.to_string(),
                ))
            }
        };

        if let Some((summary, error)) = cleanup_reason {
            self.set_state(AppServerInstanceState::Degraded, summary, Some(&error));
            self.stop_child("managed app-server exited; cleaning up process group");
            self.record_start_failure();
        }
    }

    fn stop_child(&mut self, reason: &str) {
        if let Err(error) = self.stop_child_checked(reason) {
            eprintln!("failed to stop managed app-server: {error}");
        }
    }

    fn stop_child_checked(&mut self, reason: &str) -> io::Result<()> {
        let Some(child) = self.child.as_mut() else {
            return Ok(());
        };
        eprintln!("{reason}; stopping managed app-server");
        (self.terminate_child)(child)?;
        self.child.take();
        Ok(())
    }

    fn can_attempt_start(&self, config: &AgentConfig) -> bool {
        self.start_backoff_deadline(config)
            .is_none_or(|deadline| Instant::now() >= deadline)
    }

    fn start_backoff_deadline(&self, config: &AgentConfig) -> Option<Instant> {
        let backoff = Duration::from_secs(
            config
                .session_inventory
                .managed_app_server
                .restart_backoff_seconds
                .max(1),
        );
        self.last_start_failure
            .and_then(|last_failure| last_failure.checked_add(backoff))
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
        if !is_managed_listen_url(&listen_url) {
            eprintln!(
                "managed app-server listen URL must use an absolute unix:// socket path or a loopback IP address: {listen_url}"
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
            if app_server_health_check_with_auth(
                listen_url,
                config.session_inventory.app_server_timeout_seconds,
                config
                    .session_inventory
                    .app_server_auth_token_file
                    .as_deref(),
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

#[derive(Debug)]
struct AppServerPreflightEndpoint {
    listen_url: String,
    cleanup_path: Option<PathBuf>,
    cleanup_dir: Option<PathBuf>,
}

impl AppServerPreflightEndpoint {
    fn new(configured_listen_url: &str) -> io::Result<Self> {
        #[cfg(unix)]
        if let Some(path) = strip_unix_scheme(configured_listen_url) {
            let configured_path = Path::new(path);
            validate_managed_unix_socket_path(configured_path)?;
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos();
            let cleanup_dir =
                Path::new("/tmp").join(format!("chaop-pf-{}-{nonce:x}", std::process::id()));
            std::fs::create_dir(&cleanup_dir)?;
            if let Err(error) =
                std::fs::set_permissions(&cleanup_dir, std::fs::Permissions::from_mode(0o700))
            {
                let _ = std::fs::remove_dir(&cleanup_dir);
                return Err(error);
            }
            let cleanup_path = cleanup_dir.join("s");
            return Ok(Self {
                listen_url: format!("unix://{}", cleanup_path.display()),
                cleanup_path: Some(cleanup_path),
                cleanup_dir: Some(cleanup_dir),
            });
        }

        let uri = configured_listen_url
            .parse::<Uri>()
            .map_err(|error| io::Error::new(ErrorKind::InvalidInput, error))?;
        let scheme = uri.scheme_str().ok_or_else(|| {
            io::Error::new(
                ErrorKind::InvalidInput,
                "managed app-server listen URL has no scheme",
            )
        })?;
        let host = uri.host().ok_or_else(|| {
            io::Error::new(
                ErrorKind::InvalidInput,
                "managed app-server listen URL has no host",
            )
        })?;
        let bind_ip = if host.eq_ignore_ascii_case("localhost") {
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        } else {
            host.trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<IpAddr>()
                .map_err(|error| io::Error::new(ErrorKind::InvalidInput, error))?
        };
        let listener = TcpListener::bind((bind_ip, 0))?;
        let address = listener.local_addr()?;
        drop(listener);
        Ok(Self {
            listen_url: format!("{scheme}://{address}"),
            cleanup_path: None,
            cleanup_dir: None,
        })
    }
}

#[cfg(unix)]
fn validate_managed_unix_socket_path(path: &Path) -> io::Result<()> {
    if !is_valid_unix_socket_path(path) {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "managed app-server Unix socket path is invalid or too long",
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            ErrorKind::InvalidInput,
            "managed app-server Unix socket has no parent directory",
        )
    })?;
    if !std::fs::metadata(parent)?.is_dir() {
        return Err(io::Error::new(
            ErrorKind::NotADirectory,
            "managed app-server Unix socket parent is not a directory",
        ));
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let probe_dir = parent.join(format!(".chaop-pf-check-{}-{nonce:x}", std::process::id()));
    std::fs::create_dir(&probe_dir)?;
    let result = std::fs::set_permissions(&probe_dir, std::fs::Permissions::from_mode(0o700))
        .and_then(|()| std::fs::remove_dir(&probe_dir));
    if result.is_err() {
        let _ = std::fs::remove_dir(&probe_dir);
    }
    result
}

impl Drop for AppServerPreflightEndpoint {
    fn drop(&mut self) {
        if let Some(path) = &self.cleanup_path {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => eprintln!(
                    "failed to remove managed app-server preflight socket {}: {error}",
                    path.display()
                ),
            }
        }
        if let Some(path) = &self.cleanup_dir {
            match std::fs::remove_dir(path) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => eprintln!(
                    "failed to remove managed app-server preflight directory {}: {error}",
                    path.display()
                ),
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppServerInstanceSnapshot {
    pub instance_key: String,
    pub scope: String,
    pub endpoint_type: String,
    pub state: String,
    pub active_turn_count: u32,
    pub generation: u64,
    pub status_summary: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AppServerInstanceState {
    Healthy,
    Degraded,
    Draining,
    Restarting,
    Stopped,
}

impl AppServerInstanceState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Healthy => "healthy",
            Self::Degraded => "degraded",
            Self::Draining => "draining",
            Self::Restarting => "restarting",
            Self::Stopped => "stopped",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingAppServerRestart {
    reason: AppServerRestartReason,
    requested_at: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AppServerRestartReason {
    Scheduled,
    UpgradeMarker,
}

impl AppServerRestartReason {
    fn draining_summary(self) -> &'static str {
        match self {
            Self::Scheduled => "Managed app-server scheduled restart is draining active turns.",
            Self::UpgradeMarker => "Managed app-server upgrade restart is draining active turns.",
        }
    }

    fn restarting_summary(self, forced: bool) -> &'static str {
        match (self, forced) {
            (Self::Scheduled, false) => "Managed app-server scheduled restart is in progress.",
            (Self::Scheduled, true) => {
                "Managed app-server scheduled restart is forcing after drain timeout."
            }
            (Self::UpgradeMarker, false) => "Managed app-server upgrade restart is in progress.",
            (Self::UpgradeMarker, true) => {
                "Managed app-server upgrade restart is forcing after drain timeout."
            }
        }
    }

    fn stop_reason(self, forced: bool) -> &'static str {
        match (self, forced) {
            (Self::Scheduled, false) => "scheduled managed app-server restart",
            (Self::Scheduled, true) => "forced scheduled managed app-server restart",
            (Self::UpgradeMarker, false) => "upgrade marker managed app-server restart",
            (Self::UpgradeMarker, true) => "forced upgrade marker managed app-server restart",
        }
    }

    fn forced_healthy_summary(self) -> &'static str {
        match self {
            Self::Scheduled => {
                "Managed app-server scheduled restart forced after drain timeout and is healthy."
            }
            Self::UpgradeMarker => {
                "Managed app-server upgrade restart forced after drain timeout and is healthy."
            }
        }
    }

    fn forced_degraded_summary(self) -> &'static str {
        match self {
            Self::Scheduled => {
                "Managed app-server scheduled restart forced after drain timeout and did not become healthy."
            }
            Self::UpgradeMarker => {
                "Managed app-server upgrade restart forced after drain timeout and did not become healthy."
            }
        }
    }

    fn overrides_start_backoff(self) -> bool {
        matches!(self, Self::UpgradeMarker)
    }

    fn supersedes(self, existing: Self) -> bool {
        matches!((self, existing), (Self::UpgradeMarker, Self::Scheduled))
    }

    fn unowned_listener_summary(self) -> &'static str {
        match self {
            Self::Scheduled => {
                "Managed app-server scheduled restart is blocked by an unowned listener."
            }
            Self::UpgradeMarker => {
                "Managed app-server upgrade restart is blocked by an unowned listener."
            }
        }
    }
}

fn upgrade_marker_modified(marker: Option<&std::path::PathBuf>) -> Option<SystemTime> {
    marker
        .and_then(|path| std::fs::metadata(path).ok())
        .and_then(|metadata| metadata.modified().ok())
}

pub fn is_app_server_url(url: &str) -> bool {
    #[cfg(unix)]
    if let Some(path) = strip_unix_scheme(url) {
        let path = std::path::Path::new(path);
        return is_valid_unix_socket_path(path);
    }
    app_server_websocket_uri(url).is_some()
}

pub fn is_local_listen_url(listen_url: &str) -> bool {
    #[cfg(unix)]
    if let Some(path) = strip_unix_scheme(listen_url) {
        let path = std::path::Path::new(path);
        return is_valid_unix_socket_path(path);
    }
    let Some(uri) = app_server_websocket_uri(listen_url) else {
        return false;
    };
    let Some(host) = uri.host() else {
        return false;
    };
    is_loopback_host(host)
}

pub fn is_managed_listen_url(listen_url: &str) -> bool {
    #[cfg(unix)]
    if let Some(path) = strip_unix_scheme(listen_url) {
        return is_valid_unix_socket_path(Path::new(path));
    }
    let Some(uri) = app_server_websocket_uri(listen_url) else {
        return false;
    };
    if !uri
        .scheme_str()
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("ws"))
        || uri.path() != "/"
        || uri.query().is_some()
    {
        return false;
    }
    let Some(host) = uri.host() else {
        return false;
    };
    let Ok(ip) = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    else {
        return false;
    };
    if !ip.is_loopback() {
        return false;
    }
    app_server_explicit_port(&uri)
        .and_then(|port| port.parse::<u16>().ok())
        .is_some_and(|port| port > 0)
}

#[cfg(unix)]
fn is_valid_unix_socket_path(path: &Path) -> bool {
    path.is_absolute()
        && path != Path::new("/")
        && path.as_os_str().as_bytes().len() <= UNIX_SOCKET_PATH_MAX_BYTES
}

fn app_server_websocket_uri(url: &str) -> Option<Uri> {
    let uri = url.parse::<Uri>().ok()?;
    let scheme = uri.scheme_str()?;
    if !scheme.eq_ignore_ascii_case("ws") && !scheme.eq_ignore_ascii_case("wss") {
        return None;
    }
    uri.host()?;
    if let Some(port) = app_server_explicit_port(&uri) {
        if port.parse::<u16>().ok()? == 0 {
            return None;
        }
    }
    Some(uri)
}

#[cfg(unix)]
fn strip_unix_scheme(url: &str) -> Option<&str> {
    const PREFIX: &str = "unix://";
    url.get(..PREFIX.len())
        .filter(|prefix| prefix.eq_ignore_ascii_case(PREFIX))
        .map(|_| &url[PREFIX.len()..])
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
    use super::{
        AppServerInstanceState, AppServerManager, AppServerPreflightEndpoint,
        AppServerRestartReason, is_app_server_url, is_local_listen_url, is_managed_listen_url,
        terminate_child,
    };
    use crate::config::{
        AgentConfig, BootstrapConfig, ExecutionConfig, ExecutionMode, ManagedAppServerConfig,
        SessionInventoryConfig,
    };
    use std::net::TcpListener;
    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};
    use tungstenite::Message;

    static TEST_SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

    #[test]
    fn managed_listen_url_requires_local_endpoint() {
        assert!(is_local_listen_url("ws://localhost:65530"));
        assert!(is_local_listen_url("WS://localhost:65530"));
        assert!(is_local_listen_url("ws://127.0.0.1:65530"));
        assert!(is_local_listen_url("ws://[::1]:65530"));
        #[cfg(unix)]
        assert!(is_local_listen_url("unix:///tmp/chaop-app-server.sock"));
        #[cfg(unix)]
        assert!(is_local_listen_url("UNIX:///tmp/chaop-app-server.sock"));
        assert!(!is_local_listen_url("unix://relative.sock"));
        assert!(!is_local_listen_url("ws://0.0.0.0:65530"));
        assert!(!is_local_listen_url("ws://192.168.1.20:65530"));
        assert!(!is_local_listen_url("ws://codex.example.test:65530"));
        assert!(!is_local_listen_url("ws://127.0.0.1:99999"));
        assert!(!is_local_listen_url("http://127.0.0.1:65530"));
        #[cfg(unix)]
        assert!(!is_local_listen_url(&format!(
            "unix:///tmp/{}",
            "x".repeat(super::UNIX_SOCKET_PATH_MAX_BYTES)
        )));
    }

    #[test]
    fn managed_listen_url_matches_codex_listener_contract() {
        assert!(is_managed_listen_url("ws://127.0.0.1:65530"));
        assert!(is_managed_listen_url("WS://[::1]:65530"));
        #[cfg(unix)]
        assert!(is_managed_listen_url("unix:///tmp/chaop-app-server.sock"));
        assert!(!is_managed_listen_url("ws://localhost:65530"));
        assert!(!is_managed_listen_url("wss://127.0.0.1:65530"));
        assert!(!is_managed_listen_url("ws://127.0.0.1"));
        assert!(!is_managed_listen_url("ws://127.0.0.1:0"));
        assert!(!is_managed_listen_url("ws://127.0.0.1:65530/path"));
        assert!(!is_managed_listen_url("ws://127.0.0.1:65530?query"));
    }

    #[test]
    fn app_server_url_requires_supported_transport_and_valid_port() {
        assert!(is_app_server_url("ws://127.0.0.1:65530"));
        assert!(is_app_server_url("wss://codex.example.test"));
        #[cfg(unix)]
        assert!(is_app_server_url("unix:///tmp/chaop-app-server.sock"));
        assert!(!is_app_server_url("ws://127.0.0.1:99999"));
        assert!(!is_app_server_url("ws://127.0.0.1:0"));
        assert!(!is_app_server_url("http://codex.example.test"));
    }

    #[cfg(unix)]
    #[test]
    fn managed_app_server_preflight_uses_bounded_private_unix_socket() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let configured_path = tempdir.path().join("configured.sock");
        let configured_url = format!("unix://{}", configured_path.display());

        let endpoint = AppServerPreflightEndpoint::new(&configured_url).expect("endpoint");
        let cleanup_dir = endpoint.cleanup_dir.clone().expect("cleanup directory");

        assert_ne!(endpoint.listen_url, configured_url);
        assert_eq!(cleanup_dir.parent(), Some(std::path::Path::new("/tmp")));
        assert!(endpoint.listen_url.len() < 80);
        assert!(cleanup_dir.exists());
        assert!(!configured_path.exists());
        drop(endpoint);
        assert!(!cleanup_dir.exists());

        let missing_parent_url = format!(
            "unix://{}",
            tempdir.path().join("missing/configured.sock").display()
        );
        assert_eq!(
            AppServerPreflightEndpoint::new(&missing_parent_url)
                .expect_err("missing configured parent must fail")
                .kind(),
            std::io::ErrorKind::NotFound
        );
    }

    #[test]
    fn managed_app_server_stop_propagates_termination_failure() {
        fn fail_termination(_child: &mut std::process::Child) -> std::io::Result<()> {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected termination failure",
            ))
        }

        let config = config_with_managed(true);
        let mut manager = AppServerManager::new(&config);
        manager.terminate_child = fail_termination;
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "sleep 30"]);
        #[cfg(unix)]
        {
            command.process_group(0);
        }
        manager.child = Some(command.spawn().expect("spawn child"));

        let error = manager
            .stop_child_checked("test termination failure")
            .expect_err("termination failure must propagate");

        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(error.to_string(), "injected termination failure");
        assert!(manager.child.is_some());
        manager.terminate_child = terminate_child;
        manager
            .stop_child_checked("clean up retained child")
            .expect("retained child can be stopped");
        assert!(manager.child.is_none());
    }

    #[test]
    fn pending_restart_stops_when_child_termination_fails() {
        fn fail_termination(_child: &mut std::process::Child) -> std::io::Result<()> {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected restart termination failure",
            ))
        }

        let config = config_with_managed(true);
        let mut manager = AppServerManager::new(&config);
        manager.terminate_child = fail_termination;
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "sleep 30"]);
        #[cfg(unix)]
        {
            command.process_group(0);
        }
        let child = command.spawn().expect("spawn child");
        let child_id = child.id();
        manager.child = Some(child);
        manager.request_restart(AppServerRestartReason::UpgradeMarker);

        assert_eq!(manager.advance_pending_restart(&config), None);

        assert_eq!(
            manager.child.as_ref().map(std::process::Child::id),
            Some(child_id)
        );
        assert_eq!(
            manager.pending_restart.map(|pending| pending.reason),
            Some(AppServerRestartReason::UpgradeMarker)
        );
        assert_eq!(manager.state, AppServerInstanceState::Degraded);
        assert_eq!(
            manager.last_error.as_deref(),
            Some("injected restart termination failure")
        );
        manager.terminate_child = terminate_child;
        manager
            .stop_child_checked("clean up retained restart child")
            .expect("retained restart child can be stopped");
    }

    #[test]
    fn managed_app_server_preflight_rejects_candidate_that_exits() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let command = tempdir.path().join("codex-stub");
        write_executable(&command, "#!/bin/sh\nexit 2\n");
        let mut config = config_with_managed(true);
        config.execution.codex_command = command.to_string_lossy().into_owned();
        config
            .session_inventory
            .managed_app_server
            .startup_timeout_seconds = 1;
        #[cfg(unix)]
        {
            config.session_inventory.managed_app_server.listen_url = Some(format!(
                "unix://{}",
                tempdir.path().join("configured.sock").display()
            ));
        }

        let error = AppServerManager::preflight_managed_app_server(&config)
            .expect_err("exited candidate must fail preflight");

        assert_eq!(error.kind(), std::io::ErrorKind::Other);
        assert_eq!(
            error.to_string(),
            "managed app-server preflight did not become healthy"
        );
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
    fn external_instance_snapshot_reports_unreachable_endpoint_as_degraded() {
        let mut config = config_with_managed(false);
        config.session_inventory.app_server_url = Some("not-a-url".to_owned());
        let mut manager = AppServerManager::new(&config);

        let snapshot = manager.instance_snapshot(&config).expect("snapshot");

        assert_eq!(snapshot.endpoint_type, "external");
        assert_eq!(snapshot.state, "degraded");
        assert_eq!(
            snapshot.status_summary.as_deref(),
            Some("External app-server health check failed.")
        );
        assert!(snapshot.last_error.is_some());
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
    fn scheduled_restart_interval_drains_active_turns_and_hides_capabilities() {
        let mut config = config_with_managed(true);
        config
            .session_inventory
            .managed_app_server
            .scheduled_restart_interval_seconds = 60;
        let mut manager = AppServerManager::new(&config);
        manager.active_turn_count = 1;
        manager.next_scheduled_restart_at = Some(Instant::now() - Duration::from_secs(1));

        let runtime = manager.runtime_config(&config);

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert_eq!(manager.state, AppServerInstanceState::Draining);
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
        assert_eq!(
            manager.status_summary.as_deref(),
            Some("Managed app-server scheduled restart is draining active turns.")
        );
    }

    #[test]
    fn scheduled_restart_interval_keeps_existing_deadline() {
        let mut config = config_with_managed(true);
        config
            .session_inventory
            .managed_app_server
            .scheduled_restart_interval_seconds = 60;
        let mut manager = AppServerManager::new(&config);

        manager.schedule_periodic_restart(&config);
        let first_deadline = manager.next_scheduled_restart_at;
        manager.schedule_periodic_restart(&config);

        assert!(first_deadline.is_some());
        assert_eq!(manager.next_scheduled_restart_at, first_deadline);
    }

    #[test]
    fn active_turn_runtime_config_preserves_url_without_health_restart() {
        let mut config = config_with_managed(true);
        config.execution.codex_command = "/path/that/does/not/exist/codex".to_owned();
        config
            .session_inventory
            .managed_app_server
            .restart_backoff_seconds = 60;
        let mut manager = AppServerManager::new(&config);
        manager.begin_turn();

        let runtime = manager.runtime_config_during_active_turn(&config);

        assert_eq!(
            runtime.session_inventory.app_server_url.as_deref(),
            Some("ws://127.0.0.1:65530")
        );
        assert_eq!(manager.state, AppServerInstanceState::Stopped);
        assert_eq!(manager.last_error, None);
        assert!(manager.can_attempt_start(&config));
    }

    #[test]
    fn upgrade_marker_change_drains_active_turns() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let marker = tempdir.path().join("upgrade.marker");
        std::fs::write(&marker, "before").expect("write marker");
        let mut config = config_with_managed(true);
        config
            .session_inventory
            .managed_app_server
            .upgrade_marker_file = Some(marker.clone());
        let mut manager = AppServerManager::new(&config);
        manager.active_turn_count = 1;
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&marker, "after").expect("touch marker");

        let runtime = manager.runtime_config(&config);

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert_eq!(manager.state, AppServerInstanceState::Draining);
        assert_eq!(
            manager.status_summary.as_deref(),
            Some("Managed app-server upgrade restart is draining active turns.")
        );
    }

    #[test]
    fn upgrade_marker_creation_drains_active_turns() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let marker = tempdir.path().join("upgrade.marker");
        let mut config = config_with_managed(true);
        config
            .session_inventory
            .managed_app_server
            .upgrade_marker_file = Some(marker.clone());
        let mut manager = AppServerManager::new(&config);
        manager.active_turn_count = 1;
        std::fs::write(&marker, "created").expect("create marker");

        let runtime = manager.runtime_config(&config);

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert_eq!(manager.state, AppServerInstanceState::Draining);
        assert_eq!(
            manager.status_summary.as_deref(),
            Some("Managed app-server upgrade restart is draining active turns.")
        );
    }

    #[test]
    fn upgrade_marker_supersedes_scheduled_restart_request() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let marker = tempdir.path().join("upgrade.marker");
        std::fs::write(&marker, "before").expect("write marker");
        let mut config = config_with_managed(true);
        config
            .session_inventory
            .managed_app_server
            .scheduled_restart_interval_seconds = 60;
        config
            .session_inventory
            .managed_app_server
            .upgrade_marker_file = Some(marker.clone());
        let mut manager = AppServerManager::new(&config);
        manager.active_turn_count = 1;
        manager.next_scheduled_restart_at = Some(Instant::now() - Duration::from_secs(1));
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&marker, "after").expect("touch marker");

        let runtime = manager.runtime_config(&config);

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert_eq!(manager.state, AppServerInstanceState::Draining);
        assert_eq!(
            manager.pending_restart.map(|pending| pending.reason),
            Some(AppServerRestartReason::UpgradeMarker)
        );
        assert_eq!(
            manager.status_summary.as_deref(),
            Some("Managed app-server upgrade restart is draining active turns.")
        );
    }

    #[test]
    fn managed_app_server_restarts_after_active_turns_drain() {
        let mut config = config_with_managed(true);
        config.execution.codex_command = "/path/that/does/not/exist/codex".to_owned();
        config
            .session_inventory
            .managed_app_server
            .restart_backoff_seconds = 60;
        let mut manager = AppServerManager::new(&config);
        manager.begin_turn();
        manager.request_restart(AppServerRestartReason::Scheduled);

        let draining_runtime = manager.runtime_config(&config);
        manager.finish_turn();
        let restart_runtime = manager.runtime_config(&config);

        assert_eq!(draining_runtime.session_inventory.app_server_url, None);
        assert_eq!(restart_runtime.session_inventory.app_server_url, None);
        assert_eq!(manager.pending_restart, None);
        assert_eq!(manager.state, AppServerInstanceState::Degraded);
        assert_eq!(
            manager.status_summary.as_deref(),
            Some("Failed to start managed app-server.")
        );
        assert!(!manager.can_attempt_start(&config));
    }

    #[test]
    fn scheduled_restart_respects_start_backoff_after_failure() {
        let mut config = config_with_managed(true);
        config.execution.codex_command = "/path/that/does/not/exist/codex".to_owned();
        config
            .session_inventory
            .managed_app_server
            .restart_backoff_seconds = 60;
        config
            .session_inventory
            .managed_app_server
            .scheduled_restart_interval_seconds = 1;
        let mut manager = AppServerManager::new(&config);
        manager.last_start_failure = Some(Instant::now());
        manager.next_scheduled_restart_at = Some(Instant::now() - Duration::from_secs(1));

        let runtime = manager.runtime_config(&config);

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert_eq!(manager.pending_restart, None);
        assert_eq!(manager.state, AppServerInstanceState::Degraded);
        assert_eq!(
            manager.status_summary.as_deref(),
            Some("Managed app-server restart backoff is active.")
        );
        assert_eq!(
            manager.last_error.as_deref(),
            Some("Health check failed while restart backoff is active.")
        );
        assert!(!manager.can_attempt_start(&config));
    }

    #[test]
    fn scheduled_restart_backoff_tick_keeps_instance_generation_stable() {
        let mut config = config_with_managed(true);
        config.execution.codex_command = "/path/that/does/not/exist/codex".to_owned();
        config
            .session_inventory
            .managed_app_server
            .restart_backoff_seconds = 60;
        config
            .session_inventory
            .managed_app_server
            .scheduled_restart_interval_seconds = 1;
        let mut manager = AppServerManager::new(&config);
        manager.last_start_failure = Some(Instant::now());
        manager.next_scheduled_restart_at = Some(Instant::now() - Duration::from_secs(1));

        let first_runtime = manager.runtime_config(&config);
        let first_generation = manager.generation;
        let deferred_deadline = manager.next_scheduled_restart_at;
        let second_runtime = manager.runtime_config(&config);

        assert_eq!(first_runtime.session_inventory.app_server_url, None);
        assert_eq!(second_runtime.session_inventory.app_server_url, None);
        assert_eq!(manager.pending_restart, None);
        assert_eq!(manager.state, AppServerInstanceState::Degraded);
        assert_eq!(manager.generation, first_generation);
        assert_eq!(manager.next_scheduled_restart_at, deferred_deadline);
        assert!(
            manager
                .next_scheduled_restart_at
                .is_some_and(|deadline| deadline > Instant::now())
        );
    }

    #[test]
    fn scheduled_restart_respects_backoff_after_child_exit() {
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
        config
            .session_inventory
            .managed_app_server
            .scheduled_restart_interval_seconds = 1;
        let mut manager = AppServerManager::new(&config);
        manager.child = Some(exited_child);
        manager.next_scheduled_restart_at = Some(Instant::now() - Duration::from_secs(1));

        let runtime = manager.runtime_config(&config);

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert!(!respawn_marker.exists());
        assert!(manager.child.is_none());
        assert_eq!(manager.pending_restart, None);
        assert_eq!(manager.state, AppServerInstanceState::Degraded);
        assert_eq!(
            manager.status_summary.as_deref(),
            Some("Managed app-server restart backoff is active.")
        );
        assert!(!manager.can_attempt_start(&config));
    }

    #[test]
    fn scheduled_active_turn_restart_respects_backoff_after_child_exit() {
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
            .drain_timeout_seconds = 1;
        config
            .session_inventory
            .managed_app_server
            .restart_backoff_seconds = 60;
        let mut manager = AppServerManager::new(&config);
        manager.child = Some(exited_child);
        manager.active_turn_count = 1;
        manager.pending_restart = Some(super::PendingAppServerRestart {
            reason: AppServerRestartReason::Scheduled,
            requested_at: Instant::now() - Duration::from_secs(2),
        });

        let runtime = manager.runtime_config(&config);

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert!(!respawn_marker.exists());
        assert!(manager.child.is_none());
        assert_eq!(
            manager.pending_restart.map(|pending| pending.reason),
            Some(AppServerRestartReason::Scheduled)
        );
        assert_eq!(manager.state, AppServerInstanceState::Draining);
        assert_eq!(
            manager.status_summary.as_deref(),
            Some("Managed app-server scheduled restart is draining active turns.")
        );
        assert_eq!(manager.last_error, None);
        assert!(!manager.can_attempt_start(&config));

        manager.finish_turn();
        let post_turn_runtime = manager.runtime_config(&config);

        assert_eq!(post_turn_runtime.session_inventory.app_server_url, None);
        assert!(!respawn_marker.exists());
        assert_eq!(manager.state, AppServerInstanceState::Degraded);
        assert_eq!(
            manager.status_summary.as_deref(),
            Some("Managed app-server restart backoff is active.")
        );
        assert_eq!(
            manager.last_error.as_deref(),
            Some("Health check failed while restart backoff is active.")
        );
    }

    #[test]
    fn upgrade_marker_restart_overrides_scheduled_backoff_deferral() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let marker = tempdir.path().join("upgrade.marker");
        std::fs::write(&marker, "before").expect("write marker");
        let mut config = config_with_managed(true);
        config.execution.codex_command = "/path/that/does/not/exist/codex".to_owned();
        config
            .session_inventory
            .managed_app_server
            .restart_backoff_seconds = 60;
        config
            .session_inventory
            .managed_app_server
            .scheduled_restart_interval_seconds = 1;
        config
            .session_inventory
            .managed_app_server
            .upgrade_marker_file = Some(marker.clone());
        let mut manager = AppServerManager::new(&config);
        manager.last_start_failure = Some(Instant::now());
        manager.next_scheduled_restart_at = Some(Instant::now() - Duration::from_secs(1));
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&marker, "after").expect("touch marker");

        let runtime = manager.runtime_config(&config);

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert_eq!(manager.pending_restart, None);
        assert_eq!(manager.state, AppServerInstanceState::Degraded);
        assert_eq!(
            manager.status_summary.as_deref(),
            Some("Failed to start managed app-server.")
        );
        assert_eq!(
            manager.last_error.as_deref(),
            Some("No such file or directory (os error 2)")
        );
        assert!(!manager.can_attempt_start(&config));
    }

    #[test]
    fn restart_request_blocks_when_healthy_listener_is_not_owned() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let spawn_marker = tempdir.path().join("spawned");
        let command = tempdir.path().join("codex-stub");
        write_executable(
            &command,
            &format!(
                "#!/bin/sh\nprintf spawned > '{}'\nsleep 30\n",
                spawn_marker.display()
            ),
        );
        let (listen_url, fake_app_server) = spawn_one_healthcheck_app_server();
        let mut config = config_with_managed(true);
        config.execution.codex_command = command.to_string_lossy().into_owned();
        config.session_inventory.app_server_url = Some(listen_url.clone());
        config.session_inventory.managed_app_server.listen_url = Some(listen_url);
        let mut manager = AppServerManager::new(&config);
        manager.request_restart(AppServerRestartReason::UpgradeMarker);

        let runtime = manager.runtime_config(&config);
        fake_app_server.join().expect("fake app-server");

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert!(!spawn_marker.exists());
        assert_eq!(
            manager.pending_restart.map(|pending| pending.reason),
            Some(AppServerRestartReason::UpgradeMarker)
        );
        assert_eq!(manager.state, AppServerInstanceState::Degraded);
        assert_eq!(
            manager.status_summary.as_deref(),
            Some("Managed app-server upgrade restart is blocked by an unowned listener.")
        );
        assert_eq!(
            manager.last_error.as_deref(),
            Some(
                "Restart cannot stop the listening app-server because this connector did not start it."
            )
        );
    }

    #[test]
    fn restart_request_blocks_when_stopped_child_leaves_unowned_listener() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let spawn_marker = tempdir.path().join("spawned");
        let command = tempdir.path().join("codex-stub");
        write_executable(
            &command,
            &format!(
                "#!/bin/sh\nprintf spawned > '{}'\nsleep 30\n",
                spawn_marker.display()
            ),
        );
        let mut owned_child_command = std::process::Command::new("sh");
        owned_child_command.arg("-c").arg("sleep 30");
        #[cfg(unix)]
        {
            owned_child_command.process_group(0);
        }
        let owned_child = owned_child_command
            .spawn()
            .expect("spawn owned child placeholder");
        let (listen_url, fake_app_server) = spawn_one_healthcheck_app_server();
        let mut config = config_with_managed(true);
        config.execution.codex_command = command.to_string_lossy().into_owned();
        config.session_inventory.app_server_url = Some(listen_url.clone());
        config.session_inventory.managed_app_server.listen_url = Some(listen_url);
        let mut manager = AppServerManager::new(&config);
        manager.child = Some(owned_child);
        manager.request_restart(AppServerRestartReason::Scheduled);

        let runtime = manager.runtime_config(&config);
        fake_app_server.join().expect("fake app-server");

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert!(!spawn_marker.exists());
        assert!(manager.child.is_none());
        assert_eq!(
            manager.pending_restart.map(|pending| pending.reason),
            Some(AppServerRestartReason::Scheduled)
        );
        assert_eq!(manager.state, AppServerInstanceState::Degraded);
        assert_eq!(
            manager.status_summary.as_deref(),
            Some("Managed app-server scheduled restart is blocked by an unowned listener.")
        );
        assert_eq!(
            manager.last_error.as_deref(),
            Some(
                "Restart cannot stop the listening app-server because this connector did not start it."
            )
        );
    }

    #[test]
    fn drain_timeout_forces_managed_app_server_restart_attempt() {
        let mut config = config_with_managed(true);
        config.execution.codex_command = "/path/that/does/not/exist/codex".to_owned();
        config
            .session_inventory
            .managed_app_server
            .drain_timeout_seconds = 1;
        config
            .session_inventory
            .managed_app_server
            .restart_backoff_seconds = 60;
        let mut manager = AppServerManager::new(&config);
        manager.begin_turn();
        manager.pending_restart = Some(super::PendingAppServerRestart {
            reason: AppServerRestartReason::UpgradeMarker,
            requested_at: Instant::now() - Duration::from_secs(2),
        });

        let runtime = manager.runtime_config(&config);

        assert_eq!(runtime.session_inventory.app_server_url, None);
        assert_eq!(manager.pending_restart, None);
        assert_eq!(manager.state, AppServerInstanceState::Degraded);
        assert_eq!(
            manager.status_summary.as_deref(),
            Some(
                "Managed app-server upgrade restart forced after drain timeout and did not become healthy."
            )
        );
        assert_eq!(
            manager.last_error.as_deref(),
            Some(
                "Drain timeout elapsed while active turns were still running. Last restart error: No such file or directory (os error 2)"
            )
        );
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

        let expected = codex_home.to_string_lossy().into_owned();
        let recorded = wait_for_file_content_matching(&marker, |content| content == expected);
        child.kill().expect("kill child");
        child.wait().expect("wait child");

        assert_eq!(recorded, expected);
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

        let recorded =
            wait_for_file_content_matching(&marker, |content| content.lines().count() >= 9);
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
                    lock_cwd_to_workspace_root: false,
                    startup_timeout_seconds: 1,
                    restart_backoff_seconds: 1,
                    drain_timeout_seconds: 300,
                    scheduled_restart_interval_seconds: 0,
                    upgrade_marker_file: None,
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

    fn wait_for_file_content_matching(
        path: &std::path::Path,
        predicate: impl Fn(&str) -> bool,
    ) -> String {
        for _ in 0..250 {
            if let Ok(content) = std::fs::read_to_string(path) {
                if predicate(&content) {
                    return content;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!(
            "timed out waiting for matching content in {}",
            path.display()
        );
    }

    fn spawn_one_healthcheck_app_server() -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake app-server");
        let address = listener.local_addr().expect("fake app-server address");
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept fake app-server client");
            let mut socket = tungstenite::accept(stream).expect("accept websocket");
            let initialize = read_fake_app_server_message(&mut socket);
            assert_eq!(
                initialize.get("id").and_then(serde_json::Value::as_i64),
                Some(0)
            );
            assert_eq!(
                initialize.get("method").and_then(serde_json::Value::as_str),
                Some("initialize")
            );
            socket
                .send(Message::Text(
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": 0,
                        "result": {}
                    })
                    .to_string()
                    .into(),
                ))
                .expect("send initialize response");
            let initialized = read_fake_app_server_message(&mut socket);
            assert_eq!(
                initialized
                    .get("method")
                    .and_then(serde_json::Value::as_str),
                Some("initialized")
            );
        });
        (format!("ws://{address}"), handle)
    }

    fn read_fake_app_server_message(
        socket: &mut tungstenite::WebSocket<std::net::TcpStream>,
    ) -> serde_json::Value {
        let message = socket.read().expect("read app-server request");
        let Message::Text(text) = message else {
            panic!("expected app-server text message");
        };
        serde_json::from_str(text.as_ref()).expect("valid app-server json")
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
