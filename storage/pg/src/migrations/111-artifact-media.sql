-- What Sixb derives once from a video or a sound, kept under the digest of its bytes: every file
-- that holds them, in any version of any artifact, shares it, so no artifact owns a row and
-- deleting one leaves them. `parts` holds each part as it stands: ready, pending, or why not.
CREATE TABLE artifact_media (
  project_id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) > 0),
  parts JSONB NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, digest)
);

-- Transcribing a media runs as the kernel operation `artifacts.transcribeMedia`, on the project's
-- model budget. The check is `NOT VALID`: a widened list cannot break a row that exists, and
-- validating would scan `executions` under this lock.
ALTER TABLE executions DROP CONSTRAINT executions_authority_kernel_operation_check;
ALTER TABLE executions ADD CONSTRAINT executions_authority_kernel_operation_check
  CHECK (
    authority_kernel_operation IS NULL
      OR authority_kernel_operation IN (
        'ontology.recover', 'ontology.indexVectors', 'artifacts.transcribeMedia'
      )
  ) NOT VALID;
