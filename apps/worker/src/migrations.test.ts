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

async function readMigration(fileName: string): Promise<string> {
  return await readFile(new URL(fileName, migrationsDir), "utf8");
}
