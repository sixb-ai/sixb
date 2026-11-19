ALTER TABLE ai_model_call_usage
  ADD COLUMN output_video_ms INTEGER
  CHECK (output_video_ms IS NULL OR output_video_ms >= 0);

-- A model call the provider keeps running after the request that started it, such as a video
-- generation. It is kept before the provider starts it, then takes the provider's handle, which a
-- later request reads to check on the call and record how it ended, under the execution attempt
-- that admitted it. A pending call keeps its result once it is in the ledger, before its files
-- are stored.
CREATE TABLE ai_model_call_operations (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  call_id TEXT NOT NULL CHECK (length(trim(call_id)) > 0),
  execution_id TEXT NOT NULL CHECK (length(trim(execution_id)) > 0),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  model_kind TEXT NOT NULL CHECK (
    model_kind IN (
      'language', 'image', 'video', 'embedding', 'decision', 'transcription', 'speech', 'reranking',
      'web-search'
    )
  ),
  provider_id TEXT NOT NULL CHECK (length(trim(provider_id)) > 0),
  model_id TEXT NOT NULL CHECK (length(trim(model_id)) > 0),
  operation TEXT CHECK (operation IS NULL OR json_valid(operation)),
  request TEXT NOT NULL CHECK (json_type(request) = 'object'),
  reserved INTEGER NOT NULL CHECK (reserved IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  error TEXT,
  result TEXT CHECK (result IS NULL OR json_type(result) = 'object'),
  created_at TEXT NOT NULL,
  settled_at TEXT,
  PRIMARY KEY (project_id, call_id),
  FOREIGN KEY (project_id, execution_id)
    REFERENCES executions(project_id, id),
  CHECK ((status = 'pending') = (settled_at IS NULL)),
  CHECK (status = 'pending' OR result IS NOT NULL),
  CHECK (operation IS NOT NULL OR status <> 'completed'),
  CHECK (error IS NULL OR status = 'failed')
);
