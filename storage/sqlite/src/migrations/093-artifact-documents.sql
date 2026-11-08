-- A canvas's content as the Yjs document everyone editing it shares: its whole encoded state, in a
-- blob, replaced by each write that changes the content, and the revision whose content it holds.
-- It is not a journal of changes, only the document's own encoding, so a write merges into the
-- same history wherever it is made. One whose revision is not the artifact's was left behind by a
-- write that stored none: it is brought up to the content before it is used. Null until a write
-- stores one, and for kinds that are not edited live. SQLite adds a column at a time, so the pair
-- is checked by storage.
ALTER TABLE artifacts ADD COLUMN document TEXT CHECK (document IS NULL OR json_valid(document));
ALTER TABLE artifacts ADD COLUMN document_revision INTEGER CHECK (document_revision > 0);
