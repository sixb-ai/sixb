CREATE TABLE agent_runs_v4 (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'conversation' CHECK (kind IN ('conversation', 'subagent')),
  thread_id TEXT,
  agent_id TEXT,
  trigger_message_id TEXT,
  parent_run_id TEXT,
  spawn_key TEXT,
  spec TEXT CHECK (spec IS NULL OR json_valid(spec)),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  requester_group_ids TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(requester_group_ids) AND json_type(requester_group_ids) = 'array'),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  model_id TEXT,
  finish_reason TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  diagnostics TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  execution_token TEXT,
  execution_queue_lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, execution_id),
  UNIQUE (project_id, parent_run_id, spawn_key),
  FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id, parent_run_id)
    -- Use the final name: Bun's legacy ALTER mode preserves references when foreign keys are off.
    REFERENCES agent_runs (project_id, id)
    ON DELETE RESTRICT,
  CHECK ((execution_token IS NULL) = (execution_queue_lease_expires_at IS NULL)),
  CHECK (
    (
      kind = 'conversation'
      AND thread_id IS NOT NULL
      AND agent_id IS NOT NULL
      AND trigger_message_id IS NOT NULL
      AND parent_run_id IS NULL
      AND spawn_key IS NULL
      AND result IS NULL
    )
    OR
    (
      kind = 'subagent'
      AND thread_id IS NULL
      AND agent_id IS NULL
      AND trigger_message_id IS NULL
      AND parent_run_id IS NOT NULL
      AND spawn_key IS NOT NULL
      AND spec IS NOT NULL
    )
  ),
  CHECK (kind <> 'subagent' OR status <> 'succeeded' OR result IS NOT NULL)
);

INSERT INTO agent_runs_v4 SELECT * FROM agent_runs;
DROP TABLE agent_runs;
ALTER TABLE agent_runs_v4 RENAME TO agent_runs;

CREATE INDEX idx_agent_runs_project_thread_started
  ON agent_runs (project_id, thread_id, COALESCE(started_at, created_at) DESC, id DESC);
CREATE INDEX idx_agent_runs_project_status_created
  ON agent_runs (project_id, status, created_at, id);
CREATE INDEX idx_agent_runs_project_parent_started
  ON agent_runs (
    project_id,
    parent_run_id,
    status,
    COALESCE(started_at, created_at) DESC,
    id DESC
  );

-- Preserve immutable historical estimates; reported amounts use the same per-call ledger.
CREATE TABLE ai_model_call_valuations_v2 (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  usage_record_id TEXT NOT NULL CHECK (length(trim(usage_record_id)) > 0),
  status TEXT NOT NULL CHECK (status IN ('reported', 'rated', 'unpriceable')),
  provider_id TEXT CHECK (provider_id IS NULL OR length(trim(provider_id)) > 0),
  model_id TEXT CHECK (model_id IS NULL OR length(trim(model_id)) > 0),
  currency TEXT CHECK (
    currency IS NULL OR (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]')
  ),
  amount_nanos INTEGER CHECK (
    amount_nanos IS NULL OR (typeof(amount_nanos) = 'integer' AND amount_nanos >= 0)
  ),
  reason TEXT CHECK (
    reason IS NULL OR reason IN (
      'missingBillingIdentity',
      'missingCatalogEntry',
      'missingUsageMeter',
      'unsupportedPricingDimension',
      'invalidUsageForFormula'
    )
  ),
  details TEXT NOT NULL CHECK (json_valid(details) AND json_type(details) = 'object'),
  rated_at TEXT NOT NULL CHECK (length(trim(rated_at)) > 0),
  PRIMARY KEY (project_id, usage_record_id),
  FOREIGN KEY (project_id, usage_record_id)
    REFERENCES ai_model_call_usage(project_id, id)
    ON DELETE RESTRICT,
  CHECK (
    (
      status IN ('reported', 'rated')
      AND provider_id IS NOT NULL
      AND model_id IS NOT NULL
      AND currency IS NOT NULL
      AND amount_nanos IS NOT NULL
      AND reason IS NULL
    )
    OR
    (
      status = 'unpriceable'
      AND currency IS NULL
      AND amount_nanos IS NULL
      AND reason IS NOT NULL
      AND (
        (reason = 'missingBillingIdentity' AND provider_id IS NULL AND model_id IS NULL)
        OR
        (reason <> 'missingBillingIdentity' AND provider_id IS NOT NULL AND model_id IS NOT NULL)
      )
    )
  )
);

INSERT INTO ai_model_call_valuations_v2
  SELECT * FROM ai_model_call_valuations;
DROP TABLE ai_model_call_valuations;
ALTER TABLE ai_model_call_valuations_v2 RENAME TO ai_model_call_valuations;

CREATE INDEX idx_ai_model_call_valuations_summary
  ON ai_model_call_valuations (project_id, status, currency, usage_record_id);
