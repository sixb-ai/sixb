DROP INDEX idx_ontology_source_rows_root;

CREATE INDEX idx_ontology_source_rows_root
  ON ontology_source_rows(project_id, source_id, materialization_id, root_sort_key);
