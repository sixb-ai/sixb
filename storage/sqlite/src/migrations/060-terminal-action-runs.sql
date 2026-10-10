-- Actions run in the request that asks for them and record their run once, when it ends. No run
-- is queued, running, or cancelled any more, and every run has started and finished. SQLite cannot
-- alter a CHECK constraint, so the table is rebuilt.
CREATE TABLE action_runs_v2 (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('none', 'object')),
  object_type_id TEXT,
  primary_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  phase TEXT NOT NULL CHECK (phase IN ('validation', 'writeback', 'edits', 'commit', 'effects')),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  params TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  writeback_status TEXT CHECK (writeback_status IS NULL OR writeback_status IN ('succeeded', 'failed')),
  writeback_completed_at TEXT,
  writeback_result TEXT,
  writeback_error TEXT CHECK (writeback_error IS NULL OR json_valid(writeback_error)),
  effects_status TEXT CHECK (effects_status IS NULL OR effects_status IN ('succeeded', 'failed')),
  effects_completed_at TEXT,
  effects_error TEXT CHECK (effects_error IS NULL OR json_valid(effects_error)),
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  CHECK (
    (subject_kind = 'none' AND object_type_id IS NULL AND primary_id IS NULL)
    OR (subject_kind = 'object' AND object_type_id IS NOT NULL AND primary_id IS NOT NULL)
  ),
  CHECK ((status = 'failed') = (error IS NOT NULL)),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, execution_id)
);

INSERT INTO action_runs_v2 (
  project_id, id, execution_id, action_id, subject_kind, object_type_id, primary_id, status,
  phase, started_at, finished_at, params, idempotency_key, writeback_status,
  writeback_completed_at, writeback_result, writeback_error, effects_status,
  effects_completed_at, effects_error, error
)
SELECT
  project_id, id, execution_id, action_id, subject_kind, object_type_id, primary_id,
  migrated_status, migrated_phase,
  -- A run starts when it was queued at the latest.
  COALESCE(started_at, queued_at),
  migrated_finished_at,
  params, idempotency_key, writeback_status,
  CASE
    WHEN writeback_status IS NULL THEN NULL
    ELSE COALESCE(writeback_completed_at, migrated_finished_at)
  END,
  writeback_result, writeback_error,
  CASE WHEN effects_abandoned THEN 'failed' ELSE effects_status END,
  CASE
    WHEN effects_abandoned THEN migrated_at
    WHEN effects_status IS NULL THEN NULL
    ELSE COALESCE(effects_completed_at, migrated_finished_at)
  END,
  CASE
    WHEN effects_abandoned THEN json_object(
      'code', 'internal.unexpected',
      'message', 'Abandoned: Actions now run synchronously; these effects never finished.',
      'retryable', json('false'),
      'at', migrated_at,
      'details', json_object('actionId', action_id, 'runId', id, 'phase', 'effects')
    )
    ELSE effects_error
  END,
  -- A failure names the phase its run ended in.
  CASE
    WHEN migrated_error IS NULL THEN NULL
    WHEN json_extract(migrated_error, '$.details.phase') IS migrated_phase THEN migrated_error
    ELSE json_set(migrated_error, '$.details.phase', migrated_phase)
  END
FROM (
  SELECT
    *,
    CASE
      WHEN status = 'succeeded' OR edits_committed THEN 'succeeded'
      ELSE 'failed'
    END AS migrated_status,
    CASE
      WHEN edits_committed THEN CASE WHEN phase = 'effects' THEN 'effects' ELSE 'commit' END
      -- The phases `request`, `enqueue`, and `cancelled` are gone: a run that stopped in one of
      -- them never got past validation.
      WHEN phase IN ('validation', 'writeback', 'edits', 'commit', 'effects') THEN phase
      ELSE 'validation'
    END AS migrated_phase,
    CASE
      WHEN edits_committed THEN committed_at
      WHEN status IN ('queued', 'running') THEN migrated_at
      ELSE COALESCE(finished_at, migrated_at)
    END AS migrated_finished_at,
    edits_committed AND phase = 'effects' AND effects_status IS NULL AS effects_abandoned,
    CASE
      WHEN edits_committed THEN NULL
      WHEN status IN ('queued', 'running') THEN json_object(
        'code', 'internal.unexpected',
        'message', 'Abandoned: Actions now run synchronously; this run never finished.',
        'retryable', json('false'),
        'at', migrated_at,
        'details', json_object('actionId', action_id, 'runId', id)
      )
      -- Every failed run carries a failure. One recorded before failures were kept explains
      -- itself.
      WHEN status IN ('failed', 'cancelled') AND error IS NULL THEN json_object(
        'code', 'internal.unexpected',
        'message', 'This run failed before Sixb recorded why.',
        'retryable', json('false'),
        'at', COALESCE(finished_at, migrated_at),
        'details', json_object('actionId', action_id, 'runId', id)
      )
      -- An enqueue failure, which no run can meet any more, reads as the unexpected error it
      -- now is.
      WHEN json_extract(error, '$.code') = 'queue.enqueue_failed'
        THEN json_set(error, '$.code', 'internal.unexpected', '$.retryable', json('false'))
      ELSE error
    END AS migrated_error
  FROM (
    SELECT
      run.*,
      committed.committed_at,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS migrated_at,
      -- A run left running after its edits committed, as a crash between the commit and the end
      -- of the run left it, succeeded: its edits and their outbox facts are in the commit. A run
      -- that stopped during its effects keeps that phase, and records effects that never ended.
      -- Any other run left queued or running never finished, and nothing will resume it. A
      -- cancelled run failed, and keeps the failure it recorded.
      run.status IN ('queued', 'running') AND committed.committed_at IS NOT NULL
        AS edits_committed
    FROM action_runs AS run
    LEFT JOIN ontology_commits AS committed
      ON committed.origin_kind = 'action'
      AND committed.project_id = run.project_id
      AND committed.origin_run_id = run.id
  )
);

DROP TABLE action_runs;
ALTER TABLE action_runs_v2 RENAME TO action_runs;

CREATE INDEX idx_action_runs_project_started
  ON action_runs(project_id, started_at DESC);
CREATE INDEX idx_action_runs_project_action_started
  ON action_runs(project_id, action_id, started_at DESC);
CREATE INDEX idx_action_runs_project_object_started
  ON action_runs(project_id, object_type_id, primary_id, started_at DESC);
CREATE INDEX idx_action_runs_project_status_started
  ON action_runs(project_id, status, started_at DESC);
