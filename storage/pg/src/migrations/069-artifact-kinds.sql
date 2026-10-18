-- Artifacts take two more kinds: pages, and the canvases that lay pages out.
ALTER TABLE artifacts DROP CONSTRAINT artifacts_kind_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check
  CHECK (kind IN ('document', 'sheet', 'slides', 'page', 'canvas', 'file'));
