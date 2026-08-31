CREATE TABLE agent_context_checkpoints (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  created_by_run_id TEXT NOT NULL,
  previous_checkpoint_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('threshold', 'overflow')),
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
  summary_format_version INTEGER NOT NULL CHECK (summary_format_version = 1),
  summarized_through_seq INTEGER NOT NULL CHECK (summarized_through_seq >= 1),
  observed_head_seq INTEGER NOT NULL,
  estimated_input_tokens_before BIGINT NOT NULL CHECK (estimated_input_tokens_before >= 0),
  estimated_input_tokens_after BIGINT NOT NULL CHECK (estimated_input_tokens_after >= 0),
  summary_model_id TEXT NOT NULL CHECK (length(trim(summary_model_id)) > 0),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, created_by_run_id),
  FOREIGN KEY (project_id, thread_id)
    REFERENCES agent_threads(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, created_by_run_id)
    REFERENCES agent_runs(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, previous_checkpoint_id)
    REFERENCES agent_context_checkpoints(project_id, id) ON DELETE RESTRICT,
  CHECK (summarized_through_seq < observed_head_seq)
);

CREATE INDEX idx_agent_context_checkpoints_thread_latest
  ON agent_context_checkpoints (
    project_id,
    thread_id,
    summarized_through_seq DESC,
    created_at DESC,
    id DESC
  );
