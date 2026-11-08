-- An artifact's latest version is open until someone creates a version, which freezes it: a write
-- replaces an open version's content, and the first write after a freeze opens the next version.
-- `revision` counts every change to an artifact and only grows; a version's is the artifact's
-- when it last changed. Every existing version was published to stay as it is, so each is frozen
-- when it was published, and an address pinned to one keeps naming what it named. SQLite adds a
-- NOT NULL column only with a default, which every write replaces.
ALTER TABLE artifacts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
UPDATE artifacts SET revision = latest_version;

-- `created_at` is when a version opened, `updated_at` when its content was last written.
ALTER TABLE artifact_versions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE artifact_versions ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE artifact_versions ADD COLUMN frozen_at TEXT;
UPDATE artifact_versions SET revision = version, updated_at = created_at, frozen_at = created_at;

-- At most one open version: the latest, which storage keeps so.
CREATE UNIQUE INDEX idx_artifact_versions_open
  ON artifact_versions (project_id, artifact_id) WHERE frozen_at IS NULL;

-- A retry no longer finds what a turn wrote by its versions' origins, which the next write
-- replaces: `artifact_turn_writes` keeps it.
DROP INDEX idx_artifact_versions_origin_run;
DROP INDEX idx_artifact_versions_origin_thread;

-- A frame link serves one revision of its version, and of each file it lends. The links issued
-- before revisions name none, and expire within the hour: they go now, and the app asks again.
DELETE FROM artifact_frame_grants;
ALTER TABLE artifact_frame_grants
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);

-- The Agent turn whose write shared an artifact in a thread: a retry of the turn takes the link
-- back. Links made before turns were kept stay for as long as the artifact lasts.
ALTER TABLE artifact_threads ADD COLUMN linked_by_run_id TEXT;
CREATE INDEX idx_artifact_threads_linked_by_run
  ON artifact_threads (project_id, linked_by_run_id) WHERE linked_by_run_id IS NOT NULL;

-- What an artifact's latest version held before a change that can be undone: an Agent turn's
-- first write to it, one per turn, or a restore. Kept by the revision whose content it holds; each
-- artifact keeps its newest 20. `refs`, as in `artifact_versions`.
CREATE TABLE artifact_restore_points (
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  version INTEGER NOT NULL CHECK (version > 0),
  frozen INTEGER NOT NULL CHECK (frozen IN (0, 1)),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  entry TEXT NOT NULL CHECK (length(entry) > 0),
  files TEXT NOT NULL CHECK (json_type(files) = 'array'),
  outline TEXT NOT NULL CHECK (json_type(outline) = 'object'),
  refs TEXT NOT NULL CHECK (json_type(refs) = 'array'),
  author_principal_type TEXT NOT NULL
    CHECK (author_principal_type IN ('user', 'serviceAccount', 'system')),
  author_principal_id TEXT NOT NULL CHECK (length(author_principal_id) > 0),
  origin_thread_id TEXT,
  origin_run_id TEXT,
  updated_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('turn', 'restore')),
  turn_run_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, artifact_id, revision),
  FOREIGN KEY (project_id, artifact_id) REFERENCES artifacts (project_id, id) ON DELETE CASCADE,
  CHECK ((origin_thread_id IS NULL) = (origin_run_id IS NULL)),
  CHECK ((reason = 'turn') = (turn_run_id IS NOT NULL))
);

CREATE UNIQUE INDEX idx_artifact_restore_points_turn
  ON artifact_restore_points (project_id, artifact_id, turn_run_id) WHERE turn_run_id IS NOT NULL;

-- The artifacts each Agent turn wrote, its sub-agents' writes among them, and the revision its
-- last write left: a retry of the turn undoes them while nobody changed the artifact since. Each
-- artifact keeps its newest 20 turns.
CREATE TABLE artifact_turn_writes (
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  turn_run_id TEXT NOT NULL CHECK (length(turn_run_id) > 0),
  created INTEGER NOT NULL CHECK (created IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (project_id, artifact_id, turn_run_id),
  FOREIGN KEY (project_id, artifact_id) REFERENCES artifacts (project_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_artifact_turn_writes_turn ON artifact_turn_writes (project_id, turn_run_id);
