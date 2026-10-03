-- The plan of a ready replacement candidate, built outside its commit transaction. Its rows are a
-- cache the commit verifies again, keyed by the candidate's source version, which outlives it:
-- maintenance deletes a plan once its candidate is no longer ready, and only then the version.
-- UNLOGGED: they cost no WAL, and a crash that truncates them only makes the run plan again.
CREATE UNLOGGED TABLE ontology_replacement_plans (
  version_id BIGINT PRIMARY KEY REFERENCES ontology_sources (version_id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  -- The commit the plan's work carries, at the time fixed when the plan opened.
  commit_id TEXT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL,
  -- The active source the plan replaces, NULL when none was: a plan resumed once that moved
  -- starts over.
  replaced_materialization_id TEXT,
  replaced_last_commit_id TEXT,
  -- Every commit visible in this snapshot was seen by every planned identity.
  watermark pg_snapshot NOT NULL
);

-- One row per entity the plan decides. `read_revision` is the revision of the inputs its state was
-- last read at; `planned_revision` the one its work was planned from, NULL while still to plan.
-- `classified` and `change` summarize that work for the commit's change counts.
CREATE UNLOGGED TABLE ontology_replacement_plan_identities (
  version_id BIGINT NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('object', 'link')),
  identity_key TEXT COLLATE "C" NOT NULL,
  sort_key TEXT COLLATE "C" NOT NULL,
  diff_required BOOLEAN NOT NULL,
  read_revision TEXT,
  planned_revision TEXT,
  classified BOOLEAN NOT NULL DEFAULT FALSE,
  change TEXT CHECK (change IN ('created', 'updated', 'deleted')),
  PRIMARY KEY (version_id, entity_kind, identity_key)
);
-- The identities still to plan, in planning order: a round that plans a few again finds them
-- without walking the rest.
CREATE INDEX idx_ontology_replacement_plan_identities_unplanned
  ON ontology_replacement_plan_identities (version_id, entity_kind, sort_key)
  WHERE planned_revision IS NULL;

-- Planned work, with the same columns as a session's work table plus the identity it belongs to.
CREATE UNLOGGED TABLE ontology_replacement_plan_work (
  work_id BIGINT NOT NULL,
  entity_kind TEXT NOT NULL,
  identity_key TEXT COLLATE "C" NOT NULL,
  record_key TEXT COLLATE "C" NOT NULL,
  unique_key TEXT COLLATE "C" NOT NULL,
  kind TEXT NOT NULL,
  lane TEXT NOT NULL,
  major_order INTEGER NOT NULL,
  minor_order INTEGER NOT NULL,
  sort_one TEXT COLLATE "C" NOT NULL,
  sort_two TEXT COLLATE "C" NOT NULL,
  cardinality_occupied BOOLEAN,
  payload JSONB NOT NULL,
  PRIMARY KEY (work_id, record_key),
  UNIQUE (work_id, unique_key)
);
CREATE INDEX idx_ontology_replacement_plan_work_identity
  ON ontology_replacement_plan_work (work_id, entity_kind, identity_key);
-- The few objects whose existence the plan flips, which link expansion starts from.
CREATE INDEX idx_ontology_replacement_plan_work_incident
  ON ontology_replacement_plan_work (work_id) WHERE kind = 'incident-object';
CREATE INDEX idx_ontology_replacement_plan_work_lane
  ON ontology_replacement_plan_work (
    work_id, lane, major_order, minor_order, sort_one, sort_two, record_key
  );

-- The transaction that wrote each commit, so a plan can tell whether any commit landed after it
-- read its state: one not visible in the plan's snapshot. The default is stable, so existing rows
-- take this migration's transaction, which precedes every plan, without a table rewrite.
ALTER TABLE ontology_commits ADD COLUMN xact_id xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE INDEX idx_ontology_commits_xact ON ontology_commits (project_id, xact_id);
