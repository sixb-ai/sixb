import type { Database } from "bun:sqlite"
import type {
  CleanupTerminalSourceMaterializationsInput,
  CleanupTerminalSourceMaterializationsResult,
} from "@sixb/core/storage"

export function cleanupSourceVersions(
  db: Database,
  input: CleanupTerminalSourceMaterializationsInput
): CleanupTerminalSourceMaterializationsResult {
  let remaining = input.limit
  let rowsDeleted = db
    .query(`DELETE FROM ontology_source_rows WHERE rowid IN (
    SELECT rows.rowid FROM ontology_source_roots AS roots
    JOIN ontology_sources AS sources USING (project_id, source_id, materialization_id)
    CROSS JOIN ontology_source_rows AS rows
      ON rows.project_id = roots.project_id AND rows.source_id = roots.source_id
      AND rows.materialization_id = roots.materialization_id AND rows.root_sort_key = roots.root_sort_key
    WHERE roots.project_id = ? AND roots.active = 0 AND roots.retired_at < ?
      AND sources.status IN ('superseded', 'abandoned')
    ORDER BY roots.retired_at, roots.source_id, roots.materialization_id, roots.root_sort_key, rows.entity_sort_key
    LIMIT ?
  )`)
    .run(input.projectId, input.terminalBefore, remaining).changes
  remaining -= rowsDeleted
  if (remaining > 0) {
    const removed = db
      .query(`DELETE FROM ontology_source_roots WHERE rowid IN (
      SELECT roots.rowid FROM ontology_source_roots AS roots
      JOIN ontology_sources AS sources USING (project_id, source_id, materialization_id)
      WHERE roots.project_id = ? AND roots.active = 0 AND roots.retired_at < ?
        AND sources.status IN ('superseded', 'abandoned')
        AND NOT EXISTS (SELECT 1 FROM ontology_source_rows AS rows
          WHERE rows.project_id = roots.project_id AND rows.source_id = roots.source_id
            AND rows.materialization_id = roots.materialization_id AND rows.root_sort_key = roots.root_sort_key)
      ORDER BY roots.retired_at, roots.source_id, roots.materialization_id, roots.root_sort_key LIMIT ?
    )`)
      .run(input.projectId, input.terminalBefore, remaining).changes
    rowsDeleted += removed
    remaining -= removed
  }
  const materializationsDeleted =
    remaining === 0
      ? 0
      : db
          .query(`DELETE FROM ontology_sources WHERE rowid IN (
    SELECT sources.rowid FROM ontology_sources AS sources
    WHERE project_id = ? AND status IN ('superseded', 'abandoned') AND terminal_at < ?
      AND NOT EXISTS (SELECT 1 FROM ontology_source_roots AS roots
        WHERE roots.project_id = sources.project_id AND roots.source_id = sources.source_id
          AND roots.materialization_id = sources.materialization_id)
      AND NOT EXISTS (SELECT 1 FROM ontology_source_rows AS rows
        WHERE rows.project_id = sources.project_id AND rows.source_id = sources.source_id
          AND rows.materialization_id = sources.materialization_id)
    ORDER BY terminal_at, source_id, materialization_id LIMIT ?
  )`)
          .run(input.projectId, input.terminalBefore, remaining).changes
  return { rowsDeleted, materializationsDeleted }
}
