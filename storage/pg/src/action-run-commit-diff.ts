import type { ActionRunCommitDiff } from "@sixb/core/storage"
import { normalizeActionRunCommitDiff } from "@sixb/core/storage"
import type { SQLClient } from "./pg-client"

export async function insertActionRunCommitDiff(
  tx: SQLClient,
  projectId: string,
  runId: string,
  diff: ActionRunCommitDiff
): Promise<void> {
  const normalized = normalizeActionRunCommitDiff(diff)
  const objectRows = normalized.objects.map((objectDiff) => ({
    project_id: projectId,
    run_id: runId,
    object_type_id: objectDiff.objectTypeId,
    primary_id: objectDiff.primaryId,
    operation: objectDiff.operation,
  }))
  if (objectRows.length > 0) {
    await tx`
      INSERT INTO action_run_object_diffs ${tx(objectRows)}
    `
  }

  const propertyRows = normalized.objects.flatMap((objectDiff) =>
    objectDiff.changedProperties.map((propertyId) => ({
      project_id: projectId,
      run_id: runId,
      object_type_id: objectDiff.objectTypeId,
      primary_id: objectDiff.primaryId,
      property_id: propertyId,
    }))
  )
  if (propertyRows.length > 0) {
    await tx`
      INSERT INTO action_run_object_diff_properties ${tx(propertyRows)}
    `
  }

  const linkRows = normalized.links.map((linkDiff) => ({
    project_id: projectId,
    run_id: runId,
    operation: linkDiff.operation,
    source_object_type_id: linkDiff.source.objectTypeId,
    source_primary_id: linkDiff.source.primaryId,
    link_id: linkDiff.linkId,
    target_object_type_id: linkDiff.target.objectTypeId,
    target_primary_id: linkDiff.target.primaryId,
  }))
  if (linkRows.length > 0) {
    await tx`
      INSERT INTO action_run_link_diffs ${tx(linkRows)}
    `
  }
}
