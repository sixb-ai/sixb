import type { Database } from "bun:sqlite"
import type {
  CleanupTerminalSourceMaterializationsInput,
  CleanupTerminalSourceMaterializationsResult,
  PurgeAbandonedSourceMaterializationsInput,
} from "@sixb/core/storage"

/**
 * Superseded versions can still hold live roots (a delta keeps unchanged roots where they were),
 * so they are cleaned root by root once retired. An abandoned candidate was never published:
 * everything it holds goes, one whole version at a time, each delete on its own version prefix.
 */
export function purgeAbandonedSourceVersions(
  db: Database,
  input: PurgeAbandonedSourceMaterializationsInput
): CleanupTerminalSourceMaterializationsResult {
  let remaining = input.limit
  let rowsDeleted = 0
  let materializationsDeleted = 0
  const nextCandidate = db.query(`
    SELECT version_id FROM ontology_sources
    WHERE project_id = ? AND status = 'abandoned'
    ORDER BY terminal_at, source_id, materialization_id LIMIT 1
  `)
  const deleteRows = db.query(`DELETE FROM ontology_source_rows WHERE rowid IN (
    SELECT rows.rowid FROM ontology_source_roots AS roots
    CROSS JOIN ontology_source_rows AS rows ON rows.root_id = roots.id
    WHERE roots.version_id = ? LIMIT ?)`)
  const deleteRoots = db.query(`DELETE FROM ontology_source_roots WHERE id IN (
    SELECT id FROM ontology_source_roots WHERE version_id = ? LIMIT ?)`)
  const deleteManifest = db.query(
    "DELETE FROM ontology_sources WHERE version_id = ? AND status = 'abandoned'"
  )
  while (remaining > 0) {
    const candidate = nextCandidate.get(input.projectId) as { readonly version_id: number } | null
    if (!candidate) break
    const rows = deleteRows.run(candidate.version_id, remaining).changes
    rowsDeleted += rows
    remaining -= rows
    if (remaining === 0) break
    const roots = deleteRoots.run(candidate.version_id, remaining).changes
    rowsDeleted += roots
    remaining -= roots
    if (remaining === 0) break
    const manifest = deleteManifest.run(candidate.version_id).changes
    if (manifest === 0) break
    materializationsDeleted += manifest
    remaining -= manifest
  }
  return { rowsDeleted, materializationsDeleted }
}

export function cleanupSourceVersions(
  db: Database,
  input: CleanupTerminalSourceMaterializationsInput
): CleanupTerminalSourceMaterializationsResult {
  let remaining = input.limit
  const retired = `roots.project_id = ? AND roots.retired_at < ? AND versions.status = 'superseded'`
  let rowsDeleted = db
    .query(`DELETE FROM ontology_source_rows WHERE rowid IN (
    SELECT rows.rowid FROM ontology_source_roots AS roots
    JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
    CROSS JOIN ontology_source_rows AS rows ON rows.root_id = roots.id
    WHERE ${retired}
    ORDER BY roots.retired_at, roots.id
    LIMIT ?
  )`)
    .run(input.projectId, input.terminalBefore, remaining).changes
  remaining -= rowsDeleted
  if (remaining > 0) {
    const removed = db
      .query(`DELETE FROM ontology_source_roots WHERE id IN (
      SELECT roots.id FROM ontology_source_roots AS roots
      JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
      WHERE ${retired}
        AND NOT EXISTS (SELECT 1 FROM ontology_source_rows AS rows WHERE rows.root_id = roots.id)
      ORDER BY roots.retired_at, roots.id LIMIT ?
    )`)
      .run(input.projectId, input.terminalBefore, remaining).changes
    rowsDeleted += removed
    remaining -= removed
  }
  const materializationsDeleted =
    remaining === 0
      ? 0
      : db
          .query(`DELETE FROM ontology_sources WHERE version_id IN (
    SELECT versions.version_id FROM ontology_sources AS versions
    WHERE project_id = ? AND status = 'superseded' AND terminal_at < ?
      AND NOT EXISTS (SELECT 1 FROM ontology_source_roots AS roots
        WHERE roots.version_id = versions.version_id)
    ORDER BY terminal_at, source_id, materialization_id LIMIT ?
  )`)
          .run(input.projectId, input.terminalBefore, remaining).changes
  return { rowsDeleted, materializationsDeleted }
}
