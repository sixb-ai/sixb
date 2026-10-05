-- Every commit records the entities whose plan inputs it changed, so a replacement plan's refresh
-- rechecks only what the commits since it was last fresh touched, instead of the whole plan.
CREATE TABLE ontology_commit_touches (
  project_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('object', 'link', 'scope')),
  -- `objectRefKey`, `linkRefKey` or `linkScopeKey`.
  identity_key TEXT NOT NULL
);
CREATE INDEX idx_ontology_commit_touches_commit ON ontology_commit_touches (project_id, commit_id);

-- Existing plans predate the touches of the commits since their watermark: they plan again.
DELETE FROM ontology_replacement_plan_work;
DELETE FROM ontology_replacement_plan_identities;
DELETE FROM ontology_replacement_plans;

-- Link expansion starts only from what changed since it last ran: `expansions` counts the runs,
-- and an identity's `expand_at` is the run that has yet to start from it (an object once planned,
-- a link once it needs a diff). `source_key` and `target_key` find a link from either endpoint.
ALTER TABLE ontology_replacement_plans ADD COLUMN expansions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ontology_replacement_plan_identities ADD COLUMN expand_at INTEGER;
ALTER TABLE ontology_replacement_plan_identities ADD COLUMN source_key TEXT;
ALTER TABLE ontology_replacement_plan_identities ADD COLUMN target_key TEXT;
CREATE INDEX idx_ontology_replacement_plan_identities_expand
  ON ontology_replacement_plan_identities (version_id, entity_kind, expand_at);
CREATE INDEX idx_ontology_replacement_plan_identities_source
  ON ontology_replacement_plan_identities (version_id, source_key)
  WHERE source_key IS NOT NULL;
CREATE INDEX idx_ontology_replacement_plan_identities_target
  ON ontology_replacement_plan_identities (version_id, target_key)
  WHERE target_key IS NOT NULL;
