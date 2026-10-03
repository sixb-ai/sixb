-- The plan of a ready replacement candidate, built outside its commit transaction. Its rows are a
-- cache the commit verifies again, keyed by the candidate's source version, which outlives it:
-- maintenance deletes a plan once its candidate is no longer ready, and only then the version.
CREATE TABLE ontology_replacement_plans (
  version_id INTEGER PRIMARY KEY REFERENCES ontology_sources (version_id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  -- The commit the plan's work carries, at the time fixed when the plan opened.
  commit_id TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  -- The active source the plan replaces, NULL when none was: a plan resumed once that moved
  -- starts over.
  replaced_materialization_id TEXT,
  replaced_last_commit_id TEXT,
  -- The last commit row every planned identity is known fresh against.
  watermark INTEGER NOT NULL
);

-- One row per entity the plan decides. `read_revision` is the revision of the inputs its state was
-- last read at; `planned_revision` the one its work was planned from, NULL while still to plan.
-- `classified` and `change` summarize that work for the commit's change counts.
CREATE TABLE ontology_replacement_plan_identities (
  version_id INTEGER NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('object', 'link')),
  identity_key TEXT NOT NULL,
  sort_key TEXT NOT NULL,
  diff_required INTEGER NOT NULL CHECK (diff_required IN (0, 1)),
  read_revision TEXT,
  planned_revision TEXT,
  classified INTEGER NOT NULL DEFAULT 0 CHECK (classified IN (0, 1)),
  change TEXT CHECK (change IN ('created', 'updated', 'deleted')),
  PRIMARY KEY (version_id, entity_kind, identity_key)
);
-- The identities still to plan, in planning order: a round that plans a few again finds them
-- without walking the rest.
CREATE INDEX idx_ontology_replacement_plan_identities_unplanned
  ON ontology_replacement_plan_identities (version_id, entity_kind, sort_key)
  WHERE planned_revision IS NULL;

-- Planned work, with the same columns as a session's work table plus the identity it belongs to.
CREATE TABLE ontology_replacement_plan_work (
  work_id INTEGER NOT NULL,
  entity_kind TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  record_key TEXT NOT NULL,
  unique_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  lane TEXT NOT NULL,
  major_order INTEGER NOT NULL,
  minor_order INTEGER NOT NULL,
  sort_one TEXT NOT NULL,
  sort_two TEXT NOT NULL,
  classification_entity_kind TEXT,
  classification_identity_key TEXT,
  cardinality_view TEXT,
  cardinality_occupied INTEGER,
  cardinality_source_type_id TEXT,
  cardinality_source_primary_id TEXT,
  cardinality_link_id TEXT,
  cardinality_target_type_id TEXT,
  cardinality_target_primary_id TEXT,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
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
