-- A picture of a canvas's board in one mode, kept under its render key: a hash of what the board
-- shows, which its version's outline names. Versions that keep a board as it was share its
-- picture, so no artifact owns one and deleting an artifact leaves them. The first picture kept
-- under a key stays.
CREATE TABLE artifact_board_previews (
  project_id TEXT NOT NULL,
  render_key TEXT NOT NULL CHECK (length(render_key) > 0),
  theme TEXT NOT NULL CHECK (theme IN ('light', 'dark')),
  file JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, render_key, theme)
);
