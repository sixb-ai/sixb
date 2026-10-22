-- A forked thread copies the checkpoint its history needs, and the copy keeps the run that wrote
-- the summary. A run's checkpoint is therefore unique within a thread, not within the project.
-- The project-wide constraint was unnamed: drop the one unique on exactly those two columns, and
-- stop if it is not there rather than leave the old rule in place.
DO $$
DECLARE run_constraint TEXT;
BEGIN
  SELECT conname INTO run_constraint
  FROM pg_constraint
  WHERE conrelid = 'agent_context_checkpoints'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) = 'UNIQUE (project_id, created_by_run_id)';

  IF run_constraint IS NULL THEN
    RAISE EXCEPTION 'agent_context_checkpoints has no UNIQUE (project_id, created_by_run_id) to drop';
  END IF;

  EXECUTE format('ALTER TABLE agent_context_checkpoints DROP CONSTRAINT %I', run_constraint);
END $$;

ALTER TABLE agent_context_checkpoints
  ADD CONSTRAINT uq_agent_context_checkpoints_thread_run
  UNIQUE (project_id, thread_id, created_by_run_id);
