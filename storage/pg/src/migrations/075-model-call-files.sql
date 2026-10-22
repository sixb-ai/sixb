-- The files a model call produced. The execution that made the call decides who may read them.
CREATE TABLE ai_model_call_files (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  call_id TEXT NOT NULL CHECK (length(trim(call_id)) > 0),
  execution_id TEXT NOT NULL CHECK (length(trim(execution_id)) > 0),
  files JSONB NOT NULL CHECK (jsonb_typeof(files) = 'array' AND jsonb_array_length(files) > 0),
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, call_id),
  FOREIGN KEY (project_id, execution_id)
    REFERENCES executions(project_id, id)
);
