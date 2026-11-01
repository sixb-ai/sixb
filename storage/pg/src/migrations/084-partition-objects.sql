-- Partition objects by object type, so a query plans against its own type's indexes alone instead
-- of every index of every type. Query indexes and extended statistics go with the old table:
-- preparation builds them again on the new partitions, right after this migration.
DO $$
DECLARE
  item record;
  columns_list text;
  restore_constraints text[] := '{}';
  restore_indexes text[] := '{}';
  statement text;
BEGIN
  LOCK TABLE objects IN ACCESS EXCLUSIVE MODE;

  FOR item IN
    SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE confrelid = 'objects'::regclass AND contype = 'f' AND conparentid = 0
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', item.table_name, item.conname);
    restore_constraints := restore_constraints || format(
      'ALTER TABLE %s ADD CONSTRAINT %I %s', item.table_name, item.conname, item.definition
    );
  END LOOP;

  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO columns_list
  FROM pg_attribute
  WHERE attrelid = 'objects'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';

  -- The table's general indexes stay on the parent under their names; prepared ones do not.
  FOR item IN
    SELECT c.relname AS name, pg_get_indexdef(c.oid) AS definition
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'objects'::regclass
      AND NOT i.indisprimary
      AND c.relname NOT LIKE 'sixb\_query\_%'
      AND c.relname NOT LIKE 'sixb\_text\_count\_%'
  LOOP
    restore_indexes := restore_indexes || item.definition;
    EXECUTE format('DROP INDEX %I', item.name);
  END LOOP;

  ALTER TABLE objects RENAME TO objects_unpartitioned;
  ALTER INDEX objects_pkey RENAME TO objects_unpartitioned_pkey;

  CREATE TABLE objects (
    LIKE objects_unpartitioned
    INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS INCLUDING STORAGE INCLUDING COMMENTS,
    PRIMARY KEY (project_id, object_type_id, primary_id)
  ) PARTITION BY LIST (object_type_id);

  -- Holds a type until its first preparation gives it a partition.
  CREATE TABLE objects_default PARTITION OF objects DEFAULT;

  FOR item IN SELECT DISTINCT object_type_id AS id FROM objects_unpartitioned LOOP
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF objects FOR VALUES IN (%L)',
      'objects_' || left(md5(item.id), 24),
      item.id
    );
  END LOOP;

  EXECUTE format(
    'INSERT INTO objects (%s) SELECT %s FROM objects_unpartitioned', columns_list, columns_list
  );
  DROP TABLE objects_unpartitioned;

  FOREACH statement IN ARRAY restore_indexes LOOP
    EXECUTE statement;
  END LOOP;
  FOREACH statement IN ARRAY restore_constraints LOOP
    EXECUTE statement;
  END LOOP;
END $$;

ANALYZE objects;
