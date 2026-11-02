-- What each model's tokenizer measured on a project's agent runs, one row per run: the bytes of a
-- request's text as the Agent's context estimator weighs them, against the text tokens the
-- provider counted. A record deletes the model's rows past its newest 20, so the table stays small.
-- Timestamps are ISO-8601 UTC text and compare lexicographically.
CREATE TABLE agent_token_rates (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  run_id TEXT NOT NULL CHECK (length(trim(run_id)) > 0),
  provider_id TEXT NOT NULL CHECK (length(trim(provider_id)) > 0),
  model_id TEXT NOT NULL CHECK (length(trim(model_id)) > 0),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  tokens INTEGER NOT NULL CHECK (tokens > 0),
  measured_at TEXT NOT NULL,
  PRIMARY KEY (project_id, run_id)
);

CREATE INDEX idx_agent_token_rates_model
  ON agent_token_rates (project_id, provider_id, model_id, measured_at DESC, run_id DESC);
