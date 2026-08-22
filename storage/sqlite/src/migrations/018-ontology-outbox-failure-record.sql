-- SQLite cannot add the JSON constraint while changing the legacy column, so rebuild the table.
-- The legacy record has no failure timestamp. Use its next availability time as the closest
-- durable timestamp and mark that approximation explicitly in details.
DROP INDEX idx_ontology_outbox_claim;
DROP INDEX idx_ontology_outbox_published;

ALTER TABLE ontology_outbox RENAME TO ontology_outbox_before_failure_record;

CREATE TABLE ontology_outbox (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  commit_ordinal INTEGER NOT NULL CHECK (commit_ordinal >= 0),
  envelope TEXT NOT NULL CHECK (json_valid(envelope)),
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_id TEXT,
  lease_expires_at TEXT,
  published_at TEXT,
  last_failure TEXT CHECK (last_failure IS NULL OR json_valid(last_failure)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, commit_id, commit_ordinal),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL))
);

INSERT INTO ontology_outbox (
  project_id,
  id,
  commit_id,
  commit_ordinal,
  envelope,
  available_at,
  attempts,
  lease_id,
  lease_expires_at,
  published_at,
  last_failure,
  created_at
)
SELECT
  project_id,
  id,
  commit_id,
  commit_ordinal,
  envelope,
  available_at,
  attempts,
  lease_id,
  lease_expires_at,
  published_at,
  CASE
    WHEN last_error IS NULL
      OR last_error = 'Outbox dispatcher stopped before publication completed.'
    THEN NULL
    ELSE json_object(
      'code', 'event.delivery_failed',
      'message', 'Event delivery failed.',
      'retryable', json('true'),
      'at', available_at,
      'details', json_object(
        'attempts', attempts,
        'eventIds', json_array(id),
        'eventTypes', json_array(json_extract(envelope, '$.type')),
        'migratedFromLegacyLastError', json('true'),
        'timestampSource', 'availableAt'
      )
    )
  END,
  created_at
FROM ontology_outbox_before_failure_record;

DROP TABLE ontology_outbox_before_failure_record;

CREATE INDEX idx_ontology_outbox_claim
  ON ontology_outbox(project_id, available_at, lease_expires_at, created_at, commit_id, commit_ordinal)
  WHERE published_at IS NULL;
CREATE INDEX idx_ontology_outbox_published
  ON ontology_outbox(project_id, published_at, id)
  WHERE published_at IS NOT NULL;
