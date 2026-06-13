ALTER TABLE host_sessions ADD COLUMN app_server_present INTEGER NOT NULL DEFAULT 0;

UPDATE host_sessions
SET app_server_present = 1
WHERE title_source = 'app_server';
