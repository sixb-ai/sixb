-- The threads an artifact is shared in: everyone who reads one of them reads the artifact. An
-- Agent turn publishing a version links its thread, for as long as a version from it remains; a
-- forked thread links its copies, `copied`, for as long as they last. Existing versions published
-- from a thread link it here.
CREATE TABLE artifact_threads (
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  thread_id TEXT NOT NULL CHECK (length(thread_id) > 0),
  shared_at TEXT NOT NULL,
  copied INTEGER NOT NULL DEFAULT 0 CHECK (copied IN (0, 1)),
  PRIMARY KEY (project_id, artifact_id, thread_id),
  FOREIGN KEY (project_id, artifact_id) REFERENCES artifacts (project_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_artifact_threads_thread ON artifact_threads (project_id, thread_id, artifact_id);

INSERT INTO artifact_threads (project_id, artifact_id, thread_id, shared_at)
SELECT project_id, artifact_id, origin_thread_id, MIN(created_at)
FROM artifact_versions
WHERE origin_thread_id IS NOT NULL
GROUP BY project_id, artifact_id, origin_thread_id;
