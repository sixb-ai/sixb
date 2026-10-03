-- An outbox event stores what changed and nothing it can be rebuilt from: delivery rebuilds the
-- event from its commit and the execution that commit ran under. The commit also stops copying
-- `requested_by` and `executor` from that execution (047): the execution is canonical, immutable,
-- and already referenced by the commit. The migration step checks beforehand that every stored
-- event rebuilds exactly as it was stored.
--
-- SQLite cannot add a NOT NULL column without a default; every insert supplies the event, and the
-- UPDATE below replaces the placeholder on every row.
ALTER TABLE ontology_outbox ADD COLUMN event TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(event));
UPDATE ontology_outbox SET event = json_object(
  'payload', CASE
    WHEN envelope ->> '$.type' IN ('object.created', 'link.created')
      THEN json_remove(envelope -> '$.payload', '$.propertyChanges')
    ELSE envelope -> '$.payload'
  END,
  'type', envelope ->> '$.type'
);
ALTER TABLE ontology_outbox DROP COLUMN envelope;

ALTER TABLE ontology_commits DROP COLUMN requested_by;
ALTER TABLE ontology_commits DROP COLUMN executor;
