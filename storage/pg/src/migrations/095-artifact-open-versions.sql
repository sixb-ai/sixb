-- An artifact's latest version is open until someone creates a version, which freezes it: a write
-- replaces an open version's content, and the first write after a freeze opens the next version.
-- `revision` counts every change to an artifact and only grows; a version's is the artifact's
-- when it last changed. Every existing version was published to stay as it is, so each is frozen
-- when it was published, and an address pinned to one keeps naming what it named.
ALTER TABLE artifacts ADD COLUMN revision INTEGER;
UPDATE artifacts SET revision = latest_version;
ALTER TABLE artifacts
  ALTER COLUMN revision SET NOT NULL,
  ADD CONSTRAINT artifacts_revision_check CHECK (revision > 0);

-- `created_at` is when a version opened, `updated_at` when its content was last written, and
-- `frozen_at` when someone created it, `frozen_by_*`: an existing version by whoever published it.
ALTER TABLE artifact_versions
  ADD COLUMN revision INTEGER,
  ADD COLUMN updated_at TIMESTAMPTZ,
  ADD COLUMN frozen_at TIMESTAMPTZ,
  ADD COLUMN frozen_by_principal_type TEXT
    CHECK (frozen_by_principal_type IN ('user', 'serviceAccount', 'system')),
  ADD COLUMN frozen_by_principal_id TEXT CHECK (length(frozen_by_principal_id) > 0);
UPDATE artifact_versions
SET revision = version, updated_at = created_at, frozen_at = created_at,
    frozen_by_principal_type = author_principal_type, frozen_by_principal_id = author_principal_id;
ALTER TABLE artifact_versions
  ALTER COLUMN revision SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL,
  ADD CONSTRAINT artifact_versions_revision_check CHECK (revision > 0),
  ADD CONSTRAINT artifact_versions_frozen_by_check CHECK (
    (frozen_at IS NULL) = (frozen_by_principal_type IS NULL)
    AND (frozen_by_principal_type IS NULL) = (frozen_by_principal_id IS NULL)
  );

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
  ADD COLUMN revision INTEGER NOT NULL CHECK (revision > 0);

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
  frozen BOOLEAN NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  entry TEXT NOT NULL CHECK (length(entry) > 0),
  files JSONB NOT NULL CHECK (jsonb_typeof(files) = 'array'),
  outline JSONB NOT NULL CHECK (jsonb_typeof(outline) = 'object'),
  refs JSONB NOT NULL CHECK (jsonb_typeof(refs) = 'array'),
  author_principal_type TEXT NOT NULL
    CHECK (author_principal_type IN ('user', 'serviceAccount', 'system')),
  author_principal_id TEXT NOT NULL CHECK (length(author_principal_id) > 0),
  origin_thread_id TEXT,
  origin_run_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('turn', 'restore')),
  turn_run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
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
  created BOOLEAN NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (project_id, artifact_id, turn_run_id),
  FOREIGN KEY (project_id, artifact_id) REFERENCES artifacts (project_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_artifact_turn_writes_turn ON artifact_turn_writes (project_id, turn_run_id);
