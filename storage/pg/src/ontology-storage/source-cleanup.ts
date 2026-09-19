import type {
  CleanupTerminalSourceMaterializationsInput,
  CleanupTerminalSourceMaterializationsResult,
} from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"

export async function cleanupSourceVersions(
  sql: SQLClient,
  input: CleanupTerminalSourceMaterializationsInput
): Promise<CleanupTerminalSourceMaterializationsResult> {
  let remaining = input.limit
  const removedRows = await sql`
    WITH selected AS (
      SELECT rows.ctid FROM ontology_source_roots AS roots
      JOIN ontology_sources AS sources USING (project_id, source_id, materialization_id)
      JOIN ontology_source_rows AS rows
        ON rows.project_id = roots.project_id AND rows.source_id = roots.source_id
        AND rows.materialization_id = roots.materialization_id AND rows.root_sort_key = roots.root_sort_key
      WHERE roots.project_id = ${input.projectId} AND NOT roots.active AND roots.retired_at < ${input.terminalBefore}
        AND sources.status IN ('superseded', 'abandoned')
      ORDER BY roots.retired_at, roots.source_id, roots.materialization_id, roots.root_sort_key, rows.entity_sort_key
      LIMIT ${remaining} FOR UPDATE OF rows SKIP LOCKED
    ) DELETE FROM ontology_source_rows AS rows USING selected WHERE rows.ctid = selected.ctid RETURNING 1
  `
  let rowsDeleted = removedRows.length
  remaining -= rowsDeleted
  if (remaining > 0) {
    const removed = await sql`
      WITH selected AS (
        SELECT roots.ctid FROM ontology_source_roots AS roots
        JOIN ontology_sources AS sources USING (project_id, source_id, materialization_id)
        WHERE roots.project_id = ${input.projectId} AND NOT roots.active AND roots.retired_at < ${input.terminalBefore}
          AND sources.status IN ('superseded', 'abandoned')
          AND NOT EXISTS (SELECT 1 FROM ontology_source_rows AS rows
            WHERE rows.project_id = roots.project_id AND rows.source_id = roots.source_id
              AND rows.materialization_id = roots.materialization_id AND rows.root_sort_key = roots.root_sort_key)
        ORDER BY roots.retired_at, roots.source_id, roots.materialization_id, roots.root_sort_key
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
      SELECT sources.ctid FROM ontology_sources AS sources
      WHERE project_id = ${input.projectId} AND status IN ('superseded', 'abandoned') AND terminal_at < ${input.terminalBefore}
        AND NOT EXISTS (SELECT 1 FROM ontology_source_roots AS roots
          WHERE roots.project_id = sources.project_id AND roots.source_id = sources.source_id
            AND roots.materialization_id = sources.materialization_id)
        AND NOT EXISTS (SELECT 1 FROM ontology_source_rows AS rows
          WHERE rows.project_id = sources.project_id AND rows.source_id = sources.source_id
            AND rows.materialization_id = sources.materialization_id)
      ORDER BY terminal_at, source_id, materialization_id LIMIT ${remaining} FOR UPDATE SKIP LOCKED
    ) DELETE FROM ontology_sources AS sources USING selected WHERE sources.ctid = selected.ctid RETURNING 1
  `
  return { rowsDeleted, materializationsDeleted: removedManifests.length }
}
