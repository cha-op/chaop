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

async function readMigration(fileName: string): Promise<string> {
  return await readFile(new URL(fileName, migrationsDir), "utf8");
}
