-- A shared link's visitor has no account: they give a name once, which their session keeps.
ALTER TABLE share_sessions
  ADD COLUMN guest_name TEXT CHECK (guest_name IS NULL OR length(guest_name) > 0);

-- They comment as a guest: the author's id is their session, and the comment keeps the name they
-- gave, whatever becomes of the session.
ALTER TABLE artifact_comments
  DROP CONSTRAINT artifact_comments_author_principal_type_check;

ALTER TABLE artifact_comments
  ADD COLUMN author_name TEXT,
  ADD CONSTRAINT artifact_comments_author_principal_type_check
    CHECK (author_principal_type IN ('user', 'serviceAccount', 'system', 'guest')),
  ADD CONSTRAINT artifact_comments_author_name_check CHECK (
    (author_principal_type = 'guest') = (author_name IS NOT NULL)
    AND (author_name IS NULL OR length(author_name) > 0)
  );
