-- Existing commits cannot be assigned honest execution authority retroactively.
SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM ontology_commits) THEN 0 ELSE 1 END;

ALTER TABLE ontology_commits
  ADD COLUMN execution_id TEXT NOT NULL,
  ADD CONSTRAINT fk_ontology_commits_execution
    FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT;

CREATE INDEX idx_ontology_commits_execution
  ON ontology_commits (project_id, execution_id);
