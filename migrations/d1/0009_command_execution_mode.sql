ALTER TABLE commands ADD COLUMN execution_mode TEXT CHECK (execution_mode IN ('app_server', 'codex_cli_fallback'));
