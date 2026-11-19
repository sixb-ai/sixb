-- What a video renders to, kept under a key that hashes what it is made of: a scene's segment of
-- its export, the whole video's sound, a scene's still, or the export itself. Versions and
-- artifacts that hold the same share it, so no artifact owns one and deleting an artifact leaves
-- them. The first file kept under a key stays. When one could not be made, why is kept in its
-- place, with what the project lacks when the video is not why, until it is made or someone asks
-- for it again.
CREATE TABLE artifact_video_renders (
  project_id TEXT NOT NULL,
  key TEXT NOT NULL CHECK (length(key) > 0),
  file TEXT CHECK (json_valid(file)),
  failure TEXT,
  lacks TEXT CHECK (lacks IN ('sandboxes', 'sandbox_tools')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, key),
  -- A file, or why there is none.
  CHECK ((failure IS NULL) <> (file IS NULL)),
  CHECK (lacks IS NULL OR failure IS NOT NULL)
);
