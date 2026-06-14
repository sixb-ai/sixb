import type { Database } from "bun:sqlite"
import type { ActionRunCommitDiff } from "@sixb/core"
import { normalizeActionRunCommitDiff } from "@sixb/core"

export function insertActionRunCommitDiff(
  db: Database,
  projectId: string,
  runId: string,
  diff: ActionRunCommitDiff
): void {
  const normalized = normalizeActionRunCommitDiff(diff)

  for (const objectDiff of normalized.objects) {
    db.query(
      `
      INSERT INTO action_run_object_diffs (
        project_id, run_id, object_type_id, primary_id, operation
      ) VALUES (?, ?, ?, ?, ?)
    `
    ).run(projectId, runId, objectDiff.objectTypeId, objectDiff.primaryId, objectDiff.operation)

    for (const propertyId of objectDiff.changedProperties) {
      db.query(
        `
        INSERT INTO action_run_object_diff_properties (
          project_id, run_id, object_type_id, primary_id, property_id
        ) VALUES (?, ?, ?, ?, ?)
      `
      ).run(projectId, runId, objectDiff.objectTypeId, objectDiff.primaryId, propertyId)
    }
  }

  for (const linkDiff of normalized.links) {
    db.query(
      `
      INSERT INTO action_run_link_diffs (
        project_id,
        run_id,
        operation,
        source_object_type_id,
        source_primary_id,
        link_id,
        target_object_type_id,
        target_primary_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      projectId,
      runId,
      linkDiff.operation,
      linkDiff.source.objectTypeId,
      linkDiff.source.primaryId,
      linkDiff.linkId,
      linkDiff.target.objectTypeId,
      linkDiff.target.primaryId
    )
  }
}
