ALTER TABLE action_runs
  ADD COLUMN writeback_error JSONB,
  ADD COLUMN effects_error JSONB,
  ADD COLUMN error JSONB;

UPDATE action_runs
SET writeback_error = jsonb_build_object(
  'code', 'internal.unexpected',
  'message', 'An unexpected internal error occurred.',
  'retryable', false,
  'at', to_char(COALESCE(writeback_completed_at, finished_at, queued_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'details', jsonb_build_object(
    'actionId', action_id,
    'runId', id,
    'phase', 'writeback'
  )
)
WHERE writeback_error_name IS NOT NULL OR writeback_error_message IS NOT NULL;

UPDATE action_runs
SET effects_error = jsonb_build_object(
  'code', 'internal.unexpected',
  'message', 'An unexpected internal error occurred.',
  'retryable', false,
  'at', to_char(COALESCE(effects_completed_at, finished_at, queued_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'details', jsonb_build_object(
    'actionId', action_id,
    'runId', id,
    'phase', 'effects'
  )
)
WHERE effects_error_name IS NOT NULL OR effects_error_message IS NOT NULL;

UPDATE action_runs
SET error = jsonb_build_object(
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
  'retryable', COALESCE(error_phase = 'enqueue', false),
  'at', to_char(COALESCE(finished_at, queued_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'details', jsonb_build_object(
    'actionId', action_id,
    'runId', id,
    'phase', COALESCE(error_phase, phase, 'request')
  )
)
WHERE error_name IS NOT NULL OR error_message IS NOT NULL;

ALTER TABLE action_runs
  DROP COLUMN writeback_error_name,
  DROP COLUMN writeback_error_message,
  DROP COLUMN writeback_error_phase,
  DROP COLUMN effects_error_name,
  DROP COLUMN effects_error_message,
  DROP COLUMN effects_error_phase,
  DROP COLUMN error_name,
  DROP COLUMN error_message,
  DROP COLUMN error_phase;
