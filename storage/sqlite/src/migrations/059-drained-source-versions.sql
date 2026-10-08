-- A superseded version's `root_count` counts the roots it still holds: cleanup lowers it as it
-- deletes them. A version that reaches zero is found through this index, instead of every
-- superseded version being walked and probed for roots on every maintenance pass.
UPDATE ontology_sources
SET root_count = (SELECT count(*) FROM ontology_source_roots AS roots
  WHERE roots.version_id = ontology_sources.version_id)
WHERE status = 'superseded' AND root_count <> (SELECT count(*) FROM ontology_source_roots AS roots
  WHERE roots.version_id = ontology_sources.version_id);
CREATE INDEX idx_ontology_sources_drained
  ON ontology_sources (project_id, terminal_at, source_id, materialization_id)
  WHERE status = 'superseded' AND root_count = 0;
