import type {
  ActionRunCommitDiff,
  ActionRunCommitRecord,
  ActionRunCommitSourceRow,
  ActionRunLinkDiffSourceRow,
  ActionRunObjectDiffPropertySourceRow,
  ActionRunObjectDiffSourceRow,
  ActionSubject,
  CommitEditBatchInput,
  EditCommitPlan,
  EditCommitResult,
  EditStorage,
  ObjectLinkRow,
  ObjectRow,
} from "@sixb/core"
import {
  actionSubjectsEqual,
  buildActionRunCommitRecords,
  collectEditBatchLoadRequests,
  EditStorageError,
  planEditBatchFromLoadedState,
} from "@sixb/core"
import type { SQL, SQLClient } from "./pg-client"

export class PgEditStorage implements EditStorage {
  constructor(private readonly sql: SQL) {}

  async commit(input: CommitEditBatchInput): Promise<EditCommitResult> {
    return this.sql.begin(async (tx) => {
      const run = await this.loadActionRun(tx, input.projectId, input.runId)
      assertCommitRunMatchesInput(run, input)

      const existingCommit = await this.loadCommitRecord(tx, input.projectId, input.runId)
      if (existingCommit) {
        return {
          diff: existingCommit.diff,
          committedAt: existingCommit.committedAt,
          created: false,
        }
      }

      if (run.status !== "running") {
        throw new EditStorageError(
          `[SixbPg] Action run '${input.runId}' cannot commit edits from status '${run.status}'.`
        )
      }

      const committedAt = new Date(input.committedAt ?? new Date())
      const plan = await this.plan(tx, input)
      await this.applyPlan(tx, input.projectId, plan, committedAt)
      await this.insertCommit(tx, input.projectId, input.runId, committedAt, plan.diff)
      await tx`
        UPDATE action_runs
        SET phase = ${"commit"}
        WHERE project_id = ${input.projectId} AND id = ${input.runId}
      `

      return {
        diff: plan.diff,
        committedAt,
        created: true,
      }
    })
  }

  private async plan(tx: SQLClient, input: CommitEditBatchInput): Promise<EditCommitPlan> {
    const requests = collectEditBatchLoadRequests(input.batch)
    const existingObjects = new Map<string, ObjectRow>()

    if (requests.objects.length > 0) {
      const objectRows = await tx<ObjectDatabaseRow[]>`
        WITH requested AS (
          SELECT *
          FROM jsonb_to_recordset(${JSON.stringify(
            requests.objects.map((item) => ({
              object_type_id: item.objectTypeId,
              primary_id: item.primaryId,
            }))
          )}::text::jsonb) AS requested(object_type_id text, primary_id text)
        )
        SELECT o.*
        FROM objects o
        JOIN requested r
          ON r.object_type_id = o.object_type_id
         AND r.primary_id = o.primary_id
        WHERE o.project_id = ${input.projectId}
        FOR UPDATE OF o
      `

      for (const row of objectRows) {
        existingObjects.set(`${row.object_type_id}:${row.primary_id}`, rowToObject(row))
      }
    }

    const existingLinks = new Map<string, ObjectLinkRow[]>()

    if (requests.sourceLinks.length > 0) {
      const sourceLinkRows = await tx<LinkDatabaseRow[]>`
        WITH requested AS (
          SELECT *
          FROM jsonb_to_recordset(${JSON.stringify(
            requests.sourceLinks.map((item) => ({
              object_type_id: item.objectTypeId,
              object_id: item.objectId,
              link_id: item.linkId,
            }))
          )}::text::jsonb) AS requested(
            object_type_id text,
            object_id text,
            link_id text
          )
        )
        SELECT l.*
        FROM links l
        JOIN requested r
          ON r.object_type_id = l.source_type_id
         AND r.object_id = l.source_id
         AND r.link_id = l.link_id
        WHERE l.project_id = ${input.projectId}
        FOR UPDATE OF l
      `

      for (const row of sourceLinkRows) {
        appendLinkRow(
          existingLinks,
          `${row.source_type_id}:${row.source_id}:${row.link_id}`,
          rowToLink(row)
        )
      }
    }

    if (requests.incidentLinks.length > 0) {
      const incidentLinkRows = await tx<IncidentLinkDatabaseRow[]>`
        WITH requested AS (
          SELECT *
          FROM jsonb_to_recordset(${JSON.stringify(
            requests.incidentLinks.map((item) => ({
              object_type_id: item.objectTypeId,
              object_id: item.objectId,
            }))
          )}::text::jsonb) AS requested(object_type_id text, object_id text)
        )
        SELECT
          l.*,
          r.object_type_id AS request_object_type_id,
          r.object_id AS request_object_id
        FROM links l
        JOIN requested r
          ON (r.object_type_id = l.source_type_id AND r.object_id = l.source_id)
          OR (r.object_type_id = l.target_type_id AND r.object_id = l.target_id)
        WHERE l.project_id = ${input.projectId}
        FOR UPDATE OF l
      `

      for (const row of incidentLinkRows) {
        appendLinkRow(
          existingLinks,
          `incident:${row.request_object_type_id}:${row.request_object_id}`,
          rowToLink(row)
        )
      }
    }

    return planEditBatchFromLoadedState({
      projectId: input.projectId,
      ontology: input.ontology,
      batch: input.batch,
      existingObjects,
      existingLinks,
    })
  }

  private async applyPlan(
    tx: SQLClient,
    projectId: string,
    plan: EditCommitPlan,
    committedAt: Date
  ): Promise<void> {
    await deleteLinks(tx, projectId, plan.links.deletes)
    await deleteObjects(tx, projectId, plan.objects.deletes)
    await createObjects(tx, projectId, plan.objects.upserts, committedAt)
    await updateObjects(tx, projectId, plan.objects.upserts, committedAt)
    await createLinks(tx, projectId, plan.links.upserts, committedAt)
    await updateLinks(tx, projectId, plan.links.upserts, committedAt)
  }

  private async loadActionRun(
    tx: SQLClient,
    projectId: string,
    runId: string
  ): Promise<ActionRunDatabaseRow> {
    const [row] = await tx<ActionRunDatabaseRow[]>`
      SELECT * FROM action_runs
      WHERE project_id = ${projectId} AND id = ${runId}
      FOR UPDATE
    `

    if (!row) {
      throw new EditStorageError(
        `[SixbPg] Action run '${runId}' not found for project '${projectId}'.`
      )
    }

    return row
  }

  private async insertCommit(
    tx: SQLClient,
    projectId: string,
    runId: string,
    committedAt: Date,
    diff: ActionRunCommitDiff
  ): Promise<void> {
    await tx`
      INSERT INTO action_run_commits (project_id, run_id, committed_at)
      VALUES (${projectId}, ${runId}, ${committedAt})
    `
    await insertCommitDiff(tx, projectId, runId, diff)
  }

  private async loadCommitRecord(
    tx: SQLClient,
    projectId: string,
    runId: string
  ): Promise<ActionRunCommitRecord | undefined> {
    const commitRows = await tx<CommitRow[]>`
      SELECT * FROM action_run_commits
      WHERE project_id = ${projectId} AND run_id = ${runId}
    `
    if (commitRows.length === 0) return undefined

    const objectRows = await tx<ObjectDiffRow[]>`
      SELECT * FROM action_run_object_diffs
      WHERE project_id = ${projectId} AND run_id = ${runId}
    `
    const propertyRows = await tx<ObjectDiffPropertyRow[]>`
      SELECT * FROM action_run_object_diff_properties
      WHERE project_id = ${projectId} AND run_id = ${runId}
    `
    const linkRows = await tx<LinkDiffRow[]>`
      SELECT * FROM action_run_link_diffs
      WHERE project_id = ${projectId} AND run_id = ${runId}
    `

    return buildActionRunCommitRecords(
      commitRows.map(toCommitSourceRow),
      objectRows.map(toObjectDiffSourceRow),
      propertyRows.map(toObjectDiffPropertySourceRow),
      linkRows.map(toLinkDiffSourceRow)
    ).get(runId)
  }
}

function assertCommitRunMatchesInput(row: ActionRunDatabaseRow, input: CommitEditBatchInput): void {
  if (row.action_id !== input.actionId) {
    throw new EditStorageError(
      `[SixbPg] Action run '${input.runId}' belongs to action '${row.action_id}', not '${input.actionId}'.`
    )
  }

  if (!actionSubjectsEqual(rowToActionSubject(row), input.subject)) {
    throw new EditStorageError(
      `[SixbPg] Action run '${input.runId}' cannot commit edits for a different subject.`
    )
  }

  if (input.idempotencyKey !== undefined && row.idempotency_key !== input.idempotencyKey) {
    throw new EditStorageError(
      `[SixbPg] Action run '${input.runId}' cannot commit edits with a different idempotency key.`
    )
  }
}

async function insertCommitDiff(
  tx: SQLClient,
  projectId: string,
  runId: string,
  diff: ActionRunCommitDiff
): Promise<void> {
  const objectRows = diff.objects.map((objectDiff) => ({
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

  const propertyRows = diff.objects.flatMap((objectDiff) =>
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

  const linkRows = diff.links.map((linkDiff) => ({
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

function appendLinkRow(
  linksByRequest: Map<string, ObjectLinkRow[]>,
  key: string,
  row: ObjectLinkRow
): void {
  const existing = linksByRequest.get(key)
  if (existing) {
    existing.push(row)
    return
  }

  linksByRequest.set(key, [row])
}

async function deleteLinks(
  tx: SQLClient,
  projectId: string,
  deletes: EditCommitPlan["links"]["deletes"]
): Promise<void> {
  if (deletes.length === 0) return

  await tx`
    WITH requested AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(
        deletes.map((linkDelete) => ({
          source_object_type_id: linkDelete.source.objectTypeId,
          source_primary_id: linkDelete.source.primaryId,
          link_id: linkDelete.linkId,
          target_object_type_id: linkDelete.target.objectTypeId,
          target_primary_id: linkDelete.target.primaryId,
        }))
      )}::text::jsonb) AS requested(
        source_object_type_id text,
        source_primary_id text,
        link_id text,
        target_object_type_id text,
        target_primary_id text
      )
    )
    DELETE FROM links l
    USING requested r
    WHERE l.project_id = ${projectId}
      AND l.source_type_id = r.source_object_type_id
      AND l.source_id = r.source_primary_id
      AND l.link_id = r.link_id
      AND l.target_type_id = r.target_object_type_id
      AND l.target_id = r.target_primary_id
  `
}

async function deleteObjects(
  tx: SQLClient,
  projectId: string,
  deletes: EditCommitPlan["objects"]["deletes"]
): Promise<void> {
  if (deletes.length === 0) return

  await tx`
    WITH requested AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(
        deletes.map((objectDelete) => ({
          object_type_id: objectDelete.objectTypeId,
          primary_id: objectDelete.primaryId,
        }))
      )}::text::jsonb) AS requested(object_type_id text, primary_id text)
    )
    DELETE FROM objects o
    USING requested r
    WHERE o.project_id = ${projectId}
      AND o.object_type_id = r.object_type_id
      AND o.primary_id = r.primary_id
  `
}

async function createObjects(
  tx: SQLClient,
  projectId: string,
  upserts: EditCommitPlan["objects"]["upserts"],
  committedAt: Date
): Promise<void> {
  const creates = upserts.filter((upsert) => upsert.operation === "create")
  if (creates.length === 0) return

  await tx`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(
        creates.map((objectCreate) => ({
          object_type_id: objectCreate.objectTypeId,
          primary_id: objectCreate.primaryId,
          properties: objectCreate.properties,
        }))
      )}::text::jsonb) AS input(
        object_type_id text,
        primary_id text,
        properties jsonb
      )
    )
    INSERT INTO objects (
      project_id, object_type_id, primary_id, properties, created_at, updated_at, version,
      source_event_id
    )
    SELECT
      ${projectId},
      input.object_type_id,
      input.primary_id,
      input.properties,
      ${committedAt},
      ${committedAt},
      1,
      NULL
    FROM input
  `
}

async function updateObjects(
  tx: SQLClient,
  projectId: string,
  upserts: EditCommitPlan["objects"]["upserts"],
  committedAt: Date
): Promise<void> {
  const updates = upserts.filter((upsert) => upsert.operation === "update")
  if (updates.length === 0) return

  const updated = await tx<{ object_type_id: string; primary_id: string }[]>`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(
        updates.map((objectUpdate) => ({
          object_type_id: objectUpdate.objectTypeId,
          primary_id: objectUpdate.primaryId,
          properties: objectUpdate.properties,
        }))
      )}::text::jsonb) AS input(
        object_type_id text,
        primary_id text,
        properties jsonb
      )
    )
    UPDATE objects o
    SET properties = input.properties,
        updated_at = ${committedAt},
        version = o.version + 1,
        source_event_id = NULL
    FROM input
    WHERE o.project_id = ${projectId}
      AND o.object_type_id = input.object_type_id
      AND o.primary_id = input.primary_id
    RETURNING o.object_type_id, o.primary_id
  `

  if (updated.length !== updates.length) {
    throw new EditStorageError(`[SixbPg] Edit commit cannot update one or more missing objects.`)
  }
}

async function createLinks(
  tx: SQLClient,
  projectId: string,
  upserts: EditCommitPlan["links"]["upserts"],
  committedAt: Date
): Promise<void> {
  const creates = upserts.filter((upsert) => upsert.operation === "create")
  if (creates.length === 0) return

  await tx`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(
        creates.map((linkCreate) => ({
          source_object_type_id: linkCreate.source.objectTypeId,
          source_primary_id: linkCreate.source.primaryId,
          link_id: linkCreate.linkId,
          target_object_type_id: linkCreate.target.objectTypeId,
          target_primary_id: linkCreate.target.primaryId,
          properties: linkCreate.properties ?? null,
        }))
      )}::text::jsonb) AS input(
        source_object_type_id text,
        source_primary_id text,
        link_id text,
        target_object_type_id text,
        target_primary_id text,
        properties jsonb
      )
    )
    INSERT INTO links (
      project_id, source_type_id, source_id, link_id, target_type_id, target_id, properties,
      created_at, updated_at, source_event_id
    )
    SELECT
      ${projectId},
      input.source_object_type_id,
      input.source_primary_id,
      input.link_id,
      input.target_object_type_id,
      input.target_primary_id,
      input.properties,
      ${committedAt},
      ${committedAt},
      NULL
    FROM input
  `
}

async function updateLinks(
  tx: SQLClient,
  projectId: string,
  upserts: EditCommitPlan["links"]["upserts"],
  committedAt: Date
): Promise<void> {
  const updates = upserts.filter((upsert) => upsert.operation === "update")
  if (updates.length === 0) return

  const updated = await tx<
    {
      source_type_id: string
      source_id: string
      link_id: string
      target_type_id: string
      target_id: string
    }[]
  >`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(
        updates.map((linkUpdate) => ({
          source_object_type_id: linkUpdate.source.objectTypeId,
          source_primary_id: linkUpdate.source.primaryId,
          link_id: linkUpdate.linkId,
          target_object_type_id: linkUpdate.target.objectTypeId,
          target_primary_id: linkUpdate.target.primaryId,
          properties: linkUpdate.properties ?? null,
        }))
      )}::text::jsonb) AS input(
        source_object_type_id text,
        source_primary_id text,
        link_id text,
        target_object_type_id text,
        target_primary_id text,
        properties jsonb
      )
    )
    UPDATE links l
    SET properties = input.properties,
        updated_at = ${committedAt},
        source_event_id = NULL
    FROM input
    WHERE l.project_id = ${projectId}
      AND l.source_type_id = input.source_object_type_id
      AND l.source_id = input.source_primary_id
      AND l.link_id = input.link_id
      AND l.target_type_id = input.target_object_type_id
      AND l.target_id = input.target_primary_id
    RETURNING l.source_type_id, l.source_id, l.link_id, l.target_type_id, l.target_id
  `

  if (updated.length !== updates.length) {
    throw new EditStorageError(`[SixbPg] Edit commit cannot update one or more missing links.`)
  }
}

function rowToObject(row: ObjectDatabaseRow): ObjectRow {
  return {
    projectId: row.project_id,
    objectTypeId: row.object_type_id,
    primaryId: row.primary_id,
    properties: row.properties as Record<string, unknown>,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    version: row.version,
    sourceEventId: row.source_event_id ?? undefined,
  }
}

function rowToLink(row: LinkDatabaseRow): ObjectLinkRow {
  return {
    projectId: row.project_id,
    sourceTypeId: row.source_type_id,
    sourceId: row.source_id,
    linkId: row.link_id,
    targetTypeId: row.target_type_id,
    targetId: row.target_id,
    properties: row.properties ? (row.properties as Record<string, unknown>) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    sourceEventId: row.source_event_id ?? undefined,
  }
}

function rowToActionSubject(row: ActionRunDatabaseRow): ActionSubject {
  if (row.subject_kind === "none") {
    return { kind: "none" }
  }

  if (!row.object_type_id || !row.primary_id) {
    throw new EditStorageError(`[SixbPg] Action run '${row.id}' has an invalid object subject.`)
  }

  return {
    kind: "object",
    objectTypeId: row.object_type_id,
    primaryId: row.primary_id,
  }
}

function toCommitSourceRow(row: CommitRow): ActionRunCommitSourceRow {
  return {
    runId: row.run_id,
    committedAt: row.committed_at,
  }
}

function toObjectDiffSourceRow(row: ObjectDiffRow): ActionRunObjectDiffSourceRow {
  return {
    runId: row.run_id,
    objectTypeId: row.object_type_id,
    primaryId: row.primary_id,
    operation: row.operation,
  }
}

function toObjectDiffPropertySourceRow(
  row: ObjectDiffPropertyRow
): ActionRunObjectDiffPropertySourceRow {
  return {
    runId: row.run_id,
    objectTypeId: row.object_type_id,
    primaryId: row.primary_id,
    propertyId: row.property_id,
  }
}

function toLinkDiffSourceRow(row: LinkDiffRow): ActionRunLinkDiffSourceRow {
  return {
    runId: row.run_id,
    operation: row.operation,
    sourceObjectTypeId: row.source_object_type_id,
    sourcePrimaryId: row.source_primary_id,
    linkId: row.link_id,
    targetObjectTypeId: row.target_object_type_id,
    targetPrimaryId: row.target_primary_id,
  }
}

interface ObjectDatabaseRow {
  project_id: string
  object_type_id: string
  primary_id: string
  properties: unknown
  created_at: Date | string
  updated_at: Date | string
  version: number
  source_event_id: string | null
}

interface LinkDatabaseRow {
  project_id: string
  source_type_id: string
  source_id: string
  link_id: string
  target_type_id: string
  target_id: string
  properties: unknown | null
  created_at: Date | string
  updated_at: Date | string
  source_event_id: string | null
}

interface IncidentLinkDatabaseRow extends LinkDatabaseRow {
  request_object_type_id: string
  request_object_id: string
}

interface ActionRunDatabaseRow {
  project_id: string
  id: string
  action_id: string
  subject_kind: ActionSubject["kind"]
  object_type_id: string | null
  primary_id: string | null
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled"
  idempotency_key: string
}

interface CommitRow {
  project_id: string
  run_id: string
  committed_at: Date | string
}

interface ObjectDiffRow {
  project_id: string
  run_id: string
  object_type_id: string
  primary_id: string
  operation: ActionRunCommitDiff["objects"][number]["operation"]
}

interface ObjectDiffPropertyRow {
  project_id: string
  run_id: string
  object_type_id: string
  primary_id: string
  property_id: string
}

interface LinkDiffRow {
  project_id: string
  run_id: string
  operation: ActionRunCommitDiff["links"][number]["operation"]
  source_object_type_id: string
  source_primary_id: string
  link_id: string
  target_object_type_id: string
  target_primary_id: string
}
