-- Object predicates use typed property expressions, not containment on the whole JSON document.
-- The whole-document index accelerates none of the compiler paths and amplifies every write.
DROP INDEX IF EXISTS idx_objects_properties;

-- Completion is recorded only after all non-transactional index builds and generated-column backfills finish.
CREATE TABLE object_query_preparation (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  fingerprint TEXT NOT NULL,
  result JSONB NOT NULL,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
