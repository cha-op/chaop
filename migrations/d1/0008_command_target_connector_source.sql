ALTER TABLE commands ADD COLUMN target_connector_id_source TEXT NOT NULL DEFAULT 'auto';

UPDATE commands
SET target_connector_id_source = 'explicit'
WHERE target_connector_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM host_sessions hs
    WHERE hs.id = COALESCE(
      (
        SELECT hs_task.id
        FROM host_sessions hs_task
        WHERE hs_task.workspace_id = commands.workspace_id
          AND commands.task_id IS NOT NULL
          AND hs_task.attached_task_id = commands.task_id
        ORDER BY hs_task.updated_at DESC, hs_task.id DESC
        LIMIT 1
      ),
      (
        SELECT hs_thread.id
        FROM host_sessions hs_thread
        WHERE hs_thread.workspace_id = commands.workspace_id
          AND commands.thread_id IS NOT NULL
          AND hs_thread.attached_thread_id = commands.thread_id
          AND (
            commands.task_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM host_sessions hst
              WHERE hst.workspace_id = commands.workspace_id
                AND hst.attached_task_id = commands.task_id
            )
          )
        ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
        LIMIT 1
      )
    )
  );

UPDATE commands
SET target_connector_id_source = 'attached',
    lease_target_host_session_id = (
      SELECT CASE WHEN COALESCE(hs.app_server_present, 0) = 1 THEN hs.session_id ELSE NULL END
      FROM host_sessions hs
      WHERE hs.id = COALESCE(
        (
          SELECT hs_task.id
          FROM host_sessions hs_task
          WHERE hs_task.workspace_id = commands.workspace_id
            AND commands.task_id IS NOT NULL
            AND hs_task.attached_task_id = commands.task_id
          ORDER BY hs_task.updated_at DESC, hs_task.id DESC
          LIMIT 1
        ),
        (
          SELECT hs_thread.id
          FROM host_sessions hs_thread
          WHERE hs_thread.workspace_id = commands.workspace_id
            AND commands.thread_id IS NOT NULL
            AND hs_thread.attached_thread_id = commands.thread_id
            AND (
              commands.task_id IS NULL
              OR NOT EXISTS (
                SELECT 1
                FROM host_sessions hst
                WHERE hst.workspace_id = commands.workspace_id
                  AND hst.attached_task_id = commands.task_id
              )
            )
          ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
          LIMIT 1
        )
      )
    )
WHERE target_connector_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM host_sessions hs
    WHERE hs.id = COALESCE(
      (
        SELECT hs_task.id
        FROM host_sessions hs_task
        WHERE hs_task.workspace_id = commands.workspace_id
          AND commands.task_id IS NOT NULL
          AND hs_task.attached_task_id = commands.task_id
        ORDER BY hs_task.updated_at DESC, hs_task.id DESC
        LIMIT 1
      ),
      (
        SELECT hs_thread.id
        FROM host_sessions hs_thread
        WHERE hs_thread.workspace_id = commands.workspace_id
          AND commands.thread_id IS NOT NULL
          AND hs_thread.attached_thread_id = commands.thread_id
          AND (
            commands.task_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM host_sessions hst
              WHERE hst.workspace_id = commands.workspace_id
                AND hst.attached_task_id = commands.task_id
            )
          )
        ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
        LIMIT 1
      )
    )
      AND hs.connector_id = commands.target_connector_id
  );
