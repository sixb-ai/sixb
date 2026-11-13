-- A guest's comment keeps the shared link they came through, by its grant: whoever opens that link,
-- in any session, reads the threads its guests started, and no other. Comments written before take
-- it from their session, which keeps its grant.
ALTER TABLE artifact_comments ADD COLUMN author_grant_id TEXT;

UPDATE artifact_comments AS comment
SET author_grant_id = session.grant_id
FROM share_sessions AS session
WHERE comment.author_principal_type = 'guest'
  AND session.project_id = comment.project_id
  AND session.id = comment.author_principal_id;

ALTER TABLE artifact_comments
  ADD CONSTRAINT artifact_comments_author_grant_check CHECK (
    (author_principal_type = 'guest') = (author_grant_id IS NOT NULL)
    AND (author_grant_id IS NULL OR length(author_grant_id) > 0)
  );
