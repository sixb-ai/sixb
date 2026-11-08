-- A frame link names the files it serves, as a SHA-256 hex of their paths and digests, in place of
-- the revision it was issued at: a canvas edited live is written every few seconds, and a link
-- stays good while its boards' files are the same. Links last an hour, so those issued before are
-- dropped.
DELETE FROM artifact_frame_grants;
ALTER TABLE artifact_frame_grants DROP COLUMN revision;
ALTER TABLE artifact_frame_grants
  ADD COLUMN files_digest TEXT NOT NULL DEFAULT '' CHECK (length(files_digest) = 64);
