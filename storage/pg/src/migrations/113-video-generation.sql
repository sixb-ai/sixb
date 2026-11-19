ALTER TABLE ai_model_call_usage
  ADD COLUMN output_video_ms BIGINT
  CHECK (output_video_ms IS NULL OR output_video_ms >= 0);

-- A model call the provider keeps running after the request that started it, such as a video
-- generation. It is kept before the provider starts it, then takes the provider's handle, which a
-- later request reads to check on the call and record how it ended, under the execution attempt
-- that admitted it.
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
  operation JSONB,
  request JSONB NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  reserved BOOLEAN NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  error TEXT,
  result JSONB CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, call_id),
  FOREIGN KEY (project_id, execution_id)
    REFERENCES executions(project_id, id),
  CHECK ((status = 'pending') = (settled_at IS NULL)),
  CHECK ((status = 'pending') = (result IS NULL)),
  CHECK (operation IS NOT NULL OR status <> 'completed'),
  CHECK (error IS NULL OR status = 'failed')
);
