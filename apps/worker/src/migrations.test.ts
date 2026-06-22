import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationsDir = new URL("../../../migrations/d1/", import.meta.url);

test("host session app-server presence is added only by forward migration", async () => {
  const initialHostSessionsMigration = await readMigration("0003_task_archive_host_sessions.sql");
  const appServerPresenceMigration = await readMigration("0006_host_session_app_server_present.sql");

  assert.doesNotMatch(initialHostSessionsMigration, /app_server_present/);
  assert.match(
    appServerPresenceMigration,
    /ALTER TABLE host_sessions ADD COLUMN app_server_present INTEGER NOT NULL DEFAULT 0/
  );
  assert.match(appServerPresenceMigration, /UPDATE host_sessions\s+SET app_server_present = 1/);
  assert.doesNotMatch(
    appServerPresenceMigration,
    /attached_task_id IS NOT NULL|attached_thread_id IS NOT NULL/
  );
});

test("command lease target host session is added by forward migration", async () => {
  const migration = await readMigration("0007_command_lease_target_host_session.sql");

  assert.match(migration, /ALTER TABLE commands ADD COLUMN lease_target_host_session_id TEXT/);
});

test("command target connector source is added by forward migration", async () => {
  const migration = await readMigration("0008_command_target_connector_source.sql");

  assert.match(
    migration,
    /ALTER TABLE commands ADD COLUMN target_connector_id_source TEXT NOT NULL DEFAULT 'auto'/
  );
  assert.match(
    migration,
    /SET target_connector_id_source = 'explicit'\s+WHERE target_connector_id IS NOT NULL/
  );
  assert.doesNotMatch(migration, /target_connector_id_source = 'attached'/);
  assert.doesNotMatch(migration, /lease_target_host_session_id =/);
});

test("command execution mode is added by forward migration", async () => {
  const migration = await readMigration("0009_command_execution_mode.sql");

  assert.match(
    migration,
    /ALTER TABLE commands ADD COLUMN execution_mode TEXT CHECK \(execution_mode IN \('app_server', 'codex_cli_fallback'\)\)/
  );
});

test("app-server instances are added by forward migration", async () => {
  const migration = await readMigration("0010_app_server_instances.sql");

  assert.match(migration, /CREATE TABLE app_server_instances/);
  assert.match(
    migration,
    /state TEXT NOT NULL CHECK \(state IN \('healthy', 'degraded', 'draining', 'restarting', 'stopped'\)\)/
  );
  assert.match(migration, /UNIQUE\(connector_id, instance_key\)/);
  assert.match(migration, /CREATE INDEX idx_app_server_instances_connector_state/);
  assert.match(migration, /CREATE INDEX idx_app_server_instances_state_updated/);
	assert.match(migration, /CREATE INDEX idx_app_server_instances_last_seen/);
});

test("app-server instance placement targets are added by forward migration", async () => {
  const migration = await readMigration("0011_app_server_instance_placement.sql");

  assert.match(migration, /CREATE TABLE app_server_instances_next/);
  assert.match(migration, /workspace_id TEXT/);
  assert.match(migration, /thread_id TEXT/);
  assert.match(migration, /placement_key TEXT NOT NULL/);
  assert.match(migration, /scope = 'connector'\s+AND workspace_id IS NULL\s+AND thread_id IS NULL\s+AND placement_key = 'connector'/);
  assert.match(migration, /scope = 'workspace'\s+AND workspace_id IS NOT NULL\s+AND length\(workspace_id\) > 0\s+AND thread_id IS NULL\s+AND placement_key = 'workspace:' \|\| workspace_id/);
  assert.match(migration, /scope = 'thread'\s+AND thread_id IS NOT NULL\s+AND length\(thread_id\) > 0\s+AND \(workspace_id IS NULL OR length\(workspace_id\) > 0\)\s+AND placement_key = 'thread:' \|\| thread_id/);
  assert.match(migration, /UNIQUE\(connector_id, instance_key, placement_key\)/);
  assert.match(migration, /CASE WHEN scope = 'connector' THEN state ELSE 'stopped' END/);
  assert.match(migration, /Legacy placement metadata was reset during migration/);
  assert.match(migration, /migration-0011-legacy-placement-reset/);
  assert.match(migration, /DROP TABLE app_server_instances/);
  assert.match(migration, /ALTER TABLE app_server_instances_next RENAME TO app_server_instances/);
  assert.match(migration, /CREATE INDEX idx_app_server_instances_connector_state/);
  assert.match(migration, /CREATE INDEX idx_app_server_instances_state_updated/);
  assert.match(migration, /CREATE INDEX idx_app_server_instances_last_seen/);
  assert.match(migration, /CREATE INDEX idx_app_server_instances_workspace_state/);
  assert.match(migration, /CREATE INDEX idx_app_server_instances_thread_state/);
});

test("usage window latest index is added by forward migration", async () => {
  const migration = await readMigration("0012_usage_window_latest_index.sql");

  assert.match(
    migration,
    /CREATE INDEX idx_usage_windows_type_end ON usage_windows\(window_type, window_end DESC, updated_at DESC, id DESC\)/
  );
});

test("budget telemetry samples are added by forward migration", async () => {
  const migration = await readMigration("0013_budget_telemetry_samples.sql");

  assert.match(migration, /CREATE TABLE budget_telemetry_samples/);
  assert.match(migration, /sample_type TEXT NOT NULL/);
  assert.match(migration, /d1_rows_written_daily INTEGER/);
  assert.match(
    migration,
    /CREATE INDEX idx_budget_telemetry_samples_type_sampled_at\s+ON budget_telemetry_samples\(sample_type, sampled_at\)/
  );
});

async function readMigration(fileName: string): Promise<string> {
	return await readFile(new URL(fileName, migrationsDir), "utf8");
}
