import { runTypeShapesContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"
import { getSqliteStorageTestingAdapter } from "../src/testing"

runTypeShapesContractSuite("SQLite type shapes", {
  createStorage: () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
  writeLegacyLinkConflict: async (storage, slot) => {
    getSqliteStorageTestingAdapter(storage)
      .db.query(
        `INSERT INTO ontology_link_overrides (project_id, identity_kind, identity_key, source_type_id,
           source_primary_id, link_id, target_type_id, target_primary_id, value, last_commit_id,
           updated_at)
         VALUES (?, 'slot', ?, ?, ?, ?, ?, 'x', '{"kind":"legacy-conflict"}', 'c',
           '2026-01-01T00:00:00.000Z')`
      )
      .run(
        slot.projectId,
        JSON.stringify([slot.sourceTypeId, slot.sourcePrimaryId, slot.linkId]),
        slot.sourceTypeId,
        slot.sourcePrimaryId,
        slot.linkId,
        slot.sourceTypeId
      )
  },
})
