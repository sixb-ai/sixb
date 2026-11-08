-- A canvas's content as the Yjs document everyone editing it shares: the encoded state of its
-- latest version, in a blob, replaced by each write that changes the content. It is not a journal
-- of changes, only the document's own encoding, so a write merges into the same history wherever
-- it is made. Null until a write stores one, and for kinds that are not edited live.
ALTER TABLE artifacts ADD COLUMN document TEXT CHECK (document IS NULL OR json_valid(document));
