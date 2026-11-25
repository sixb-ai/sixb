import { runTypeShapesContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createPgClient } from "../src/pg-client"
import { createTestStorage, disposeTestStorage, type TestStorage } from "./helpers"

const connections = new WeakMap<PostgresStorage, TestStorage>()

runTypeShapesContractSuite("PostgreSQL type shapes", {
  createStorage: async () => {
    const created = await createTestStorage()
    connections.set(created.storage, created)
    return created.storage
  },
  cleanup: (storage) => disposeTestStorage(storage),
  writeLegacyLinkConflict: async (storage, slot) => {
    const { connectionString, schemaName } = connections.get(storage)!
    const sql = createPgClient({ connectionString, schemaName, max: 1 })
    try {
      await sql`
        INSERT INTO ontology_link_overrides (project_id, identity_kind, identity_key,
          source_type_id, source_primary_id, link_id, target_type_id, target_primary_id, value,
          last_commit_id, updated_at)
        VALUES (${slot.projectId}, 'slot',
          ${sql.json([slot.sourceTypeId, slot.sourcePrimaryId, slot.linkId])},
          ${slot.sourceTypeId}, ${slot.sourcePrimaryId}, ${slot.linkId}, ${slot.sourceTypeId}, 'x',
          ${sql.json({ kind: "legacy-conflict" })}, 'c', '2026-01-01T00:00:00.000Z')
      `
    } finally {
      await sql.end()
    }
  },
})
