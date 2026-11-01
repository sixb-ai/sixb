-- One index serves incoming links of every type, where each type had its own. Every index on links
-- costs each expansion and traversal planning time, and these all said the same thing.
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT c.relname AS name
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'links'::regclass AND c.relname LIKE 'sixb\_query\_%'
  LOOP
    EXECUTE format('DROP INDEX %I', item.name);
  END LOOP;
END $$;

DROP INDEX idx_links_target;
CREATE INDEX idx_links_target
  ON links (project_id, target_type_id, target_id, link_id, source_type_id, source_id);
