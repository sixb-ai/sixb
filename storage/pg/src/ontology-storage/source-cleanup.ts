import type {
  CleanupTerminalSourceMaterializationsInput,
  CleanupTerminalSourceMaterializationsResult,
  PurgeAbandonedSourceMaterializationsInput,
} from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"

/**
 * Superseded versions can still hold live roots (a delta keeps unchanged roots where they were),
 * so they are cleaned root by root once retired. An abandoned candidate was never published:
 * everything it holds goes, one whole version at a time, each delete on its own version prefix.
 */
export async function purgeAbandonedSourceVersions(
  sql: SQLClient,
  input: PurgeAbandonedSourceMaterializationsInput
): Promise<CleanupTerminalSourceMaterializationsResult> {
  let remaining = input.limit
  let rowsDeleted = 0
  let materializationsDeleted = 0
  while (remaining > 0) {
    const [candidate] = await sql<{ readonly version_id: string }[]>`
      SELECT version_id FROM ontology_sources
      WHERE project_id = ${input.projectId} AND status = 'abandoned'
      ORDER BY terminal_at, source_id, materialization_id
      LIMIT 1 FOR UPDATE SKIP LOCKED
    `
    if (!candidate) break
    const rows = await sql`
      DELETE FROM ontology_source_rows WHERE ctid IN (
        SELECT rows.ctid FROM ontology_source_roots AS roots
        JOIN ontology_source_rows AS rows ON rows.root_id = roots.id
        WHERE roots.version_id = ${candidate.version_id} LIMIT ${remaining}
      )
    `
    rowsDeleted += rows.count
    remaining -= rows.count
    if (remaining === 0) break
    const roots = await sql`
      DELETE FROM ontology_source_roots WHERE ctid IN (
        SELECT ctid FROM ontology_source_roots
        WHERE version_id = ${candidate.version_id} LIMIT ${remaining}
      )
    `
    rowsDeleted += roots.count
    remaining -= roots.count
    if (remaining === 0) break
    const manifest = await sql`
      DELETE FROM ontology_sources
      WHERE version_id = ${candidate.version_id} AND status = 'abandoned'
    `
    if (manifest.count === 0) break
    materializationsDeleted += manifest.count
    remaining -= manifest.count
  }
  return { rowsDeleted, materializationsDeleted }
}

export async function cleanupSourceVersions(
  sql: SQLClient,
  input: CleanupTerminalSourceMaterializationsInput
): Promise<CleanupTerminalSourceMaterializationsResult> {
  let remaining = input.limit
  const retired = sql`roots.project_id = ${input.projectId}
    AND roots.retired_at < ${input.terminalBefore} AND versions.status = 'superseded'`
  const removedRows = await sql`
    WITH selected AS (
      SELECT rows.ctid FROM ontology_source_roots AS roots
      JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
      JOIN ontology_source_rows AS rows ON rows.root_id = roots.id
      WHERE ${retired}
      ORDER BY roots.retired_at, roots.id
      LIMIT ${remaining} FOR UPDATE OF rows SKIP LOCKED
    ) DELETE FROM ontology_source_rows AS rows USING selected WHERE rows.ctid = selected.ctid RETURNING 1
  `
  let rowsDeleted = removedRows.length
  remaining -= rowsDeleted
  if (remaining > 0) {
    const removed = await sql`
      WITH selected AS (
        SELECT roots.ctid FROM ontology_source_roots AS roots
        JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
        WHERE ${retired}
          AND NOT EXISTS (SELECT 1 FROM ontology_source_rows AS rows WHERE rows.root_id = roots.id)
        ORDER BY roots.retired_at, roots.id
        LIMIT ${remaining} FOR UPDATE OF roots SKIP LOCKED
      ) DELETE FROM ontology_source_roots AS roots USING selected WHERE roots.ctid = selected.ctid RETURNING 1
    `
    rowsDeleted += removed.length
    remaining -= removed.length
  }
  const removedManifests =
    remaining === 0
      ? []
      : await sql`
    WITH selected AS (
      SELECT versions.ctid FROM ontology_sources AS versions
      WHERE project_id = ${input.projectId} AND status = 'superseded'
        AND terminal_at < ${input.terminalBefore}
        AND NOT EXISTS (SELECT 1 FROM ontology_source_roots AS roots
          WHERE roots.version_id = versions.version_id)
      ORDER BY terminal_at, source_id, materialization_id LIMIT ${remaining} FOR UPDATE SKIP LOCKED
    ) DELETE FROM ontology_sources AS versions USING selected WHERE versions.ctid = selected.ctid RETURNING 1
  `
  return { rowsDeleted, materializationsDeleted: removedManifests.length }
}
