-- A planned object's existence, and whether the plan flips it, move from work rows to its identity:
-- an identity planned unchanged then stages no work at all. Existing plans keep them as work rows,
-- so they plan again.
TRUNCATE ontology_replacement_plan_work, ontology_replacement_plan_identities,
  ontology_replacement_plans;

-- `planned_exists`: whether a planned object exists once the plan applies; NULL until planned, and
-- for links. `flips`: whether that differs from its effective existence, which link expansion
-- starts from.
ALTER TABLE ontology_replacement_plan_identities
  ADD COLUMN planned_exists BOOLEAN,
  ADD COLUMN flips BOOLEAN NOT NULL DEFAULT FALSE;

DROP INDEX idx_ontology_replacement_plan_work_incident;
CREATE INDEX idx_ontology_replacement_plan_identities_flips
  ON ontology_replacement_plan_identities (version_id) WHERE flips;

-- A plan's work is keyed by its record keys alone, which are unique by themselves.
ALTER TABLE ontology_replacement_plan_work DROP COLUMN unique_key;
