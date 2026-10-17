-- What a frame link may show from other artifacts: each address a deck embeds that its reader could
-- read when the link was issued, with the version it shows. A JSON array of
-- { "address": text, "artifactId": text, "version": integer }.
ALTER TABLE artifact_frame_grants ADD COLUMN targets JSONB NOT NULL DEFAULT '[]'::jsonb;
