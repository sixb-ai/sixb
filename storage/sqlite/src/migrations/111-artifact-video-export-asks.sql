-- That someone asked for a video's export, under the export's key, so that reading it without
-- asking tells an export no one asked for from one rendering. What is kept under its segments'
-- keys says neither: they may have been rendered for another video made in part the same. The
-- first ask stays. No artifact owns one, as no artifact owns what a video renders to.
CREATE TABLE artifact_video_export_asks (
  project_id TEXT NOT NULL,
  key TEXT NOT NULL CHECK (length(key) > 0),
  asked_at TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);
