-- Artifacts take one more kind: videos, a HyperFrames project of HTML scenes and the media they
-- play.
ALTER TABLE artifacts DROP CONSTRAINT artifacts_kind_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check
  CHECK (kind IN ('document', 'sheet', 'slides', 'page', 'canvas', 'video', 'file'));
