import type { EditCommitResult, NewDomainEvent, ObjectLinkRow, ObjectRow } from "@sixb/core"
import type { RunActionJobInput } from "../types"

export async function emitLocalCommitEvents(
  runtime: RunActionJobInput["runtime"],
  runId: string,
  commit: EditCommitResult
): Promise<void> {
  try {
    const events = await buildDomainEventsFromEditCommit(runtime, runId, commit)
    if (events.length === 0) {
      return
    }
    await runtime.events.append({ events })
  } catch (error) {
    console.error("[SixbActionWorker] Failed to emit action commit events:", error)
  }
}

async function buildDomainEventsFromEditCommit(
  runtime: RunActionJobInput["runtime"],
  runId: string,
  commit: EditCommitResult
): Promise<NewDomainEvent[]> {
  const events: NewDomainEvent[] = []
  const objectRows = await loadCommittedObjectRows(runtime, commit)
  const linkRows = await loadCommittedLinkRows(runtime, commit)

  for (const diff of commit.diff.objects) {
    if (diff.operation === "delete") {
      events.push({
        type: "object.deleted",
        idempotencyKey: `action.commit.object.deleted:${runId}:${diff.objectTypeId}:${diff.primaryId}`,
        payload: {
          objectTypeId: diff.objectTypeId,
          primaryId: diff.primaryId,
        },
      })
      continue
    }

    const row = objectRows.get(objectRowKey(diff.objectTypeId, diff.primaryId))
    if (!row) continue
    events.push({
      type: "object.upserted",
      idempotencyKey: `action.commit.object.upserted:${runId}:${diff.objectTypeId}:${diff.primaryId}`,
      payload: {
        objectTypeId: row.objectTypeId,
        primaryId: row.primaryId,
        properties: row.properties,
      },
    })
  }

  for (const diff of commit.diff.links) {
    if (diff.operation === "delete") {
      events.push({
        type: "link.removed",
        idempotencyKey: `action.commit.link.removed:${runId}:${linkDiffKey(diff)}`,
        payload: {
          sourceTypeId: diff.source.objectTypeId,
          sourceId: diff.source.primaryId,
          linkId: diff.linkId,
          targetTypeId: diff.target.objectTypeId,
          targetId: diff.target.primaryId,
        },
      })
      continue
    }

    const row = linkRows.get(linkDiffKey(diff))
    if (!row) continue
    events.push({
      type: "link.upserted",
      idempotencyKey: `action.commit.link.upserted:${runId}:${linkDiffKey(diff)}`,
      payload: {
        sourceTypeId: row.sourceTypeId,
        sourceId: row.sourceId,
        linkId: row.linkId,
        targetTypeId: row.targetTypeId,
        targetId: row.targetId,
        ...(row.properties !== undefined ? { properties: row.properties } : {}),
      },
    })
  }

  return events
}

async function loadCommittedObjectRows(
  runtime: RunActionJobInput["runtime"],
  commit: EditCommitResult
): Promise<Map<string, ObjectRow>> {
  const items = commit.diff.objects
    .filter((diff) => diff.operation !== "delete")
    .map((diff) => ({ objectTypeId: diff.objectTypeId, primaryId: diff.primaryId }))

  if (items.length === 0) {
    return new Map()
  }

  return runtime.storage.objects.getByPrimaryIdBatch({
    projectId: runtime.id,
    items,
  })
}

async function loadCommittedLinkRows(
  runtime: RunActionJobInput["runtime"],
  commit: EditCommitResult
): Promise<Map<string, ObjectLinkRow>> {
  const items = commit.diff.links
    .filter((diff) => diff.operation !== "delete")
    .map((diff) => ({
      objectTypeId: diff.source.objectTypeId,
      objectId: diff.source.primaryId,
      linkId: diff.linkId,
    }))

  if (items.length === 0) {
    return new Map()
  }

  const rowsBySource = await runtime.storage.objects.listLinksBatch({
    projectId: runtime.id,
    items,
  })
  const rows = new Map<string, ObjectLinkRow>()
  for (const diff of commit.diff.links) {
    if (diff.operation === "delete") continue
    const sourceRows =
      rowsBySource.get(`${diff.source.objectTypeId}:${diff.source.primaryId}:${diff.linkId}`) ?? []
    const row = sourceRows.find(
      (candidate) =>
        candidate.targetTypeId === diff.target.objectTypeId &&
        candidate.targetId === diff.target.primaryId
    )
    if (row) {
      rows.set(linkDiffKey(diff), row)
    }
  }
  return rows
}

function objectRowKey(objectTypeId: string, primaryId: string): string {
  return `${objectTypeId}:${primaryId}`
}

function linkDiffKey(diff: {
  readonly source: { readonly objectTypeId: string; readonly primaryId: string }
  readonly linkId: string
  readonly target: { readonly objectTypeId: string; readonly primaryId: string }
}): string {
  return `${diff.source.objectTypeId}:${diff.source.primaryId}:${diff.linkId}:${diff.target.objectTypeId}:${diff.target.primaryId}`
}
