ALTER TABLE action_runs ADD COLUMN writeback_error TEXT
  CHECK (writeback_error IS NULL OR json_valid(writeback_error));
ALTER TABLE action_runs ADD COLUMN effects_error TEXT
  CHECK (effects_error IS NULL OR json_valid(effects_error));
ALTER TABLE action_runs ADD COLUMN error TEXT CHECK (error IS NULL OR json_valid(error));

UPDATE action_runs
SET writeback_error = json_object(
  'code', 'internal.unexpected',
  'message', 'An unexpected internal error occurred.',
  'retryable', json('false'),
  'at', COALESCE(writeback_completed_at, finished_at, queued_at),
  'details', json_object('actionId', action_id, 'runId', id, 'phase', 'writeback')
)
WHERE writeback_error_name IS NOT NULL OR writeback_error_message IS NOT NULL;

UPDATE action_runs
SET effects_error = json_object(
  'code', 'internal.unexpected',
  'message', 'An unexpected internal error occurred.',
  'retryable', json('false'),
  'at', COALESCE(effects_completed_at, finished_at, queued_at),
  'details', json_object('actionId', action_id, 'runId', id, 'phase', 'effects')
)
WHERE effects_error_name IS NOT NULL OR effects_error_message IS NOT NULL;

UPDATE action_runs
SET error = json_object(
  'code', CASE
    WHEN error_phase = 'enqueue' THEN 'queue.enqueue_failed'
    WHEN error_phase = 'cancelled' OR status = 'cancelled' THEN 'runtime.cancelled'
    ELSE 'internal.unexpected'
  END,
  'message', CASE
    WHEN error_phase = 'enqueue' THEN 'The job could not be enqueued.'
    WHEN error_phase = 'cancelled' OR status = 'cancelled' THEN 'Execution was cancelled.'
    ELSE 'An unexpected internal error occurred.'
  END,
  'retryable', json(CASE WHEN error_phase = 'enqueue' THEN 'true' ELSE 'false' END),
  'at', COALESCE(finished_at, queued_at),
  'details', json_object(
    'actionId', action_id,
    'runId', id,
    'phase', COALESCE(error_phase, phase, 'request')
  )
)
WHERE error_name IS NOT NULL OR error_message IS NOT NULL;

ALTER TABLE action_runs DROP COLUMN writeback_error_name;
ALTER TABLE action_runs DROP COLUMN writeback_error_message;
ALTER TABLE action_runs DROP COLUMN writeback_error_phase;
ALTER TABLE action_runs DROP COLUMN effects_error_name;
ALTER TABLE action_runs DROP COLUMN effects_error_message;
ALTER TABLE action_runs DROP COLUMN effects_error_phase;
ALTER TABLE action_runs DROP COLUMN error_name;
ALTER TABLE action_runs DROP COLUMN error_message;
ALTER TABLE action_runs DROP COLUMN error_phase;
