-- The artifacts objects hold: one row per artifact an object property holds, wherever it sits in
-- the property's value. Every object write keeps them current in its own transaction, so whoever
-- reaches an artifact through the objects that hold it finds them here.
CREATE TABLE object_artifact_refs (
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  PRIMARY KEY (project_id, artifact_id, object_type_id, primary_id, property_id)
);
