DROP INDEX idx_ontology_commits_action_origin;
DROP INDEX idx_ontology_commits_projection_origin;
DROP INDEX idx_ontology_commits_telemetry_origin;
DROP INDEX idx_ontology_commits_history;
DROP INDEX idx_ontology_commits_origin;

CREATE TABLE ontology_commits_v2 (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('action', 'runtime', 'projection', 'telemetry')),
  origin_run_id TEXT,
  origin_batch_ordinal INTEGER CHECK (
    origin_batch_ordinal IS NULL OR origin_batch_ordinal >= 0
  ),
  origin TEXT NOT NULL CHECK (json_valid(origin)),
  actor TEXT CHECK (actor IS NULL OR json_valid(actor)),
  ontology_revision TEXT NOT NULL,
  projection_revision TEXT,
  ownership_hash TEXT,
  intent TEXT NOT NULL CHECK (json_valid(intent)),
  result TEXT NOT NULL CHECK (json_valid(result)),
  committed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, idempotency_key),
  FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT,
  CHECK (
    (origin_kind IN ('action', 'projection') AND origin_run_id IS NOT NULL AND origin_batch_ordinal IS NULL)
    OR (origin_kind = 'telemetry' AND (
      (origin_run_id IS NULL AND origin_batch_ordinal IS NULL)
      OR (origin_run_id IS NOT NULL AND origin_batch_ordinal IS NOT NULL)
    ))
    OR (origin_kind = 'runtime' AND origin_run_id IS NULL AND origin_batch_ordinal IS NULL)
  )
);

DROP TABLE ontology_commits;
ALTER TABLE ontology_commits_v2 RENAME TO ontology_commits;

CREATE UNIQUE INDEX idx_ontology_commits_action_origin
  ON ontology_commits(project_id, origin_run_id)
  WHERE origin_kind = 'action';
CREATE UNIQUE INDEX idx_ontology_commits_projection_origin
  ON ontology_commits(project_id, origin_run_id)
  WHERE origin_kind = 'projection';
CREATE UNIQUE INDEX idx_ontology_commits_telemetry_origin
  ON ontology_commits(project_id, origin_run_id, origin_batch_ordinal)
  WHERE origin_kind = 'telemetry' AND origin_run_id IS NOT NULL;
CREATE INDEX idx_ontology_commits_history
  ON ontology_commits(project_id, committed_at, id);
CREATE INDEX idx_ontology_commits_origin
  ON ontology_commits(project_id, origin_kind, origin_run_id, origin_batch_ordinal);
CREATE INDEX idx_ontology_commits_execution
  ON ontology_commits(project_id, execution_id);
