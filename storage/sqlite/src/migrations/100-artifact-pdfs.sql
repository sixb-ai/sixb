-- A designed document printed to PDF, kept under its render key: a hash of what it prints, which
-- its version names. Versions that print the same share it, so no artifact owns one and deleting
-- an artifact leaves them. The first PDF kept under a key stays. When it could not be printed, why
-- is kept in its place, until it prints or someone asks for it again.
CREATE TABLE artifact_pdfs (
  project_id TEXT NOT NULL,
  render_key TEXT NOT NULL CHECK (length(render_key) > 0),
  file TEXT CHECK (json_valid(file)),
  pages INTEGER CHECK (pages > 0),
  failure TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, render_key),
  -- A PDF with its pages, or why there is none.
  CHECK (
    (failure IS NULL AND file IS NOT NULL AND pages IS NOT NULL)
    OR (failure IS NOT NULL AND file IS NULL AND pages IS NULL)
  )
);
