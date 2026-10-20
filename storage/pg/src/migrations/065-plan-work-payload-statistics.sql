-- A plan's work is analyzed whenever a stream has staged enough of it, and most of that ANALYZE
-- went into the statistics of `payload`, which no query reads: the plan queries filter on the
-- typed columns and only extract values from `payload`, and an extracted value has no statistics.
-- A query that filters `payload` itself (`@>`, `?`) would need them back.
ALTER TABLE ontology_replacement_plan_work ALTER COLUMN payload SET STATISTICS 0;
