-- The values of unique properties, one row per value an object holds. Every object write keeps
-- them current, so a write that would give a value to a second object of the type is refused.
-- Values are keyed by their SHA-256: a long string stays under the btree key limit, and a lookup
-- still compares `value_key` itself.
CREATE TABLE object_unique_values (
  project_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  value_hash BYTEA NOT NULL,
  value_key TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  PRIMARY KEY (project_id, object_type_id, property_id, value_hash)
);

-- The unique properties whose values were built from the objects already stored, and how their
-- keys were computed. A claim made with other keys is refused until they are built again.
CREATE TABLE object_unique_properties (
  project_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  key_kind TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  prepared_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, object_type_id, property_id)
);
