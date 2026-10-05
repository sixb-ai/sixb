-- Every commit records the entities whose plan inputs it changed, so a replacement plan's refresh
-- rechecks only what the commits since it was last fresh touched, instead of the whole plan.
-- UNLOGGED like the plans they serve: a crash truncates both together.
CREATE UNLOGGED TABLE ontology_commit_touches (
  project_id TEXT NOT NULL,
  -- The transaction of the commit, compared with a plan's watermark snapshot like `xact_id` on
  -- `ontology_commits`.
  xact_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('object', 'link', 'scope')),
  -- `objectRefKey`, `linkRefKey` or `linkScopeKey`.
  identity_key TEXT COLLATE "C" NOT NULL
);
CREATE INDEX idx_ontology_commit_touches_xact ON ontology_commit_touches (project_id, xact_id);

-- Touches of the project's commits before this transaction may have been purged: a plan whose
-- watermark does not see them all checks every identity.
CREATE UNLOGGED TABLE ontology_commit_touch_horizons (
  project_id TEXT PRIMARY KEY,
  xact_id xid8 NOT NULL
);

-- Existing plans predate the touches of the commits since their watermark: they plan again.
TRUNCATE ontology_replacement_plan_work, ontology_replacement_plan_identities,
  ontology_replacement_plans;

-- Link expansion starts only from what changed since it last ran: `expansions` counts the runs,
-- and an identity's `expand_at` is the run that has yet to start from it (an object once planned,
-- a link once it needs a diff). `source_key` and `target_key` find a link from either endpoint.
ALTER TABLE ontology_replacement_plans ADD COLUMN expansions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ontology_replacement_plan_identities
  ADD COLUMN expand_at INTEGER,
  ADD COLUMN source_key TEXT COLLATE "C",
  ADD COLUMN target_key TEXT COLLATE "C";
CREATE INDEX idx_ontology_replacement_plan_identities_expand
  ON ontology_replacement_plan_identities (version_id, entity_kind, expand_at);
CREATE INDEX idx_ontology_replacement_plan_identities_source
  ON ontology_replacement_plan_identities (version_id, source_key)
  WHERE source_key IS NOT NULL;
CREATE INDEX idx_ontology_replacement_plan_identities_target
  ON ontology_replacement_plan_identities (version_id, target_key)
  WHERE target_key IS NOT NULL;
