import type { Database } from "bun:sqlite"
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
import { insertActionRunCommitDiff } from "./action-run-commit-diff"
import { installFreshSqliteSchema } from "./migrations"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteEditStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}
// TODO: remove in next PR
export class SqliteEditStorage implements EditStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  constructor(options: SqliteEditStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.db)
    }
  }

  async commit(input: CommitEditBatchInput): Promise<EditCommitResult> {
    return this.db.transaction(() => {
      const run = this.loadActionRun(input.projectId, input.runId)
      assertCommitRunMatchesInput(run, input)

      const existingCommit = this.loadCommitRecord(input.projectId, input.runId)
      if (existingCommit) {
        return {
          diff: existingCommit.diff,
          committedAt: existingCommit.committedAt,
          created: false,
        }
      }

      if (run.status !== "running") {
        throw new EditStorageError(
          `[SixbSqlite] Action run '${input.runId}' cannot commit edits from status '${run.status}'.`
        )
      }

      const committedAt = input.committedAt ?? new Date()
      const plan = this.plan(input)
      this.applyPlan(input.projectId, plan, committedAt)
      this.insertCommit(input.projectId, input.runId, committedAt, plan.diff)
      this.db
        .query("UPDATE action_runs SET phase = ? WHERE project_id = ? AND id = ?")
        .run("commit", input.projectId, input.runId)

      return {
        diff: plan.diff,
        committedAt,
        created: true,
      }
    })()
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private plan(input: CommitEditBatchInput): EditCommitPlan {
    const requests = collectEditBatchLoadRequests(input.batch)
    const existingObjects = new Map<string, ObjectRow>()
    const getObject = this.db.query(
      "SELECT * FROM objects WHERE project_id = ? AND object_type_id = ? AND primary_id = ?"
    )
    for (const item of requests.objects) {
      const row = getObject.get(
        input.projectId,
        item.objectTypeId,
        item.primaryId
      ) as ObjectDatabaseRow | null
      if (row) {
        existingObjects.set(`${item.objectTypeId}:${item.primaryId}`, rowToObject(row))
      }
    }

    const existingLinks = new Map<string, ObjectLinkRow[]>()
    const getSourceLinks = this.db.query(
      "SELECT * FROM links WHERE project_id = ? AND source_type_id = ? AND source_id = ? AND link_id = ?"
    )
    for (const item of requests.sourceLinks) {
      const rows = getSourceLinks.all(
        input.projectId,
        item.objectTypeId,
        item.objectId,
        item.linkId
      ) as LinkDatabaseRow[]
      if (rows.length > 0) {
        existingLinks.set(
          `${item.objectTypeId}:${item.objectId}:${item.linkId}`,
          rows.map(rowToLink)
        )
      }
    }

    const getIncidentLinks = this.db.query(`
      SELECT * FROM links
      WHERE project_id = ?
        AND (
          (source_type_id = ? AND source_id = ?)
          OR (target_type_id = ? AND target_id = ?)
        )
    `)
    for (const item of requests.incidentLinks) {
      const rows = getIncidentLinks.all(
        input.projectId,
        item.objectTypeId,
        item.objectId,
        item.objectTypeId,
        item.objectId
      ) as LinkDatabaseRow[]
      if (rows.length > 0) {
        existingLinks.set(`incident:${item.objectTypeId}:${item.objectId}`, rows.map(rowToLink))
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

  private applyPlan(projectId: string, plan: EditCommitPlan, committedAt: Date): void {
    for (const linkDelete of plan.links.deletes) {
      this.db
        .query(
          `
          DELETE FROM links
          WHERE project_id = ?
            AND source_type_id = ?
            AND source_id = ?
            AND link_id = ?
            AND target_type_id = ?
            AND target_id = ?
        `
        )
        .run(
          projectId,
          linkDelete.source.objectTypeId,
          linkDelete.source.primaryId,
          linkDelete.linkId,
          linkDelete.target.objectTypeId,
          linkDelete.target.primaryId
        )
    }

    for (const objectDelete of plan.objects.deletes) {
      this.db
        .query("DELETE FROM objects WHERE project_id = ? AND object_type_id = ? AND primary_id = ?")
        .run(projectId, objectDelete.objectTypeId, objectDelete.primaryId)
    }

    const insertObject = this.db.query(`
      INSERT INTO objects (
        project_id, object_type_id, primary_id, properties, created_at, updated_at, version,
        source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL)
    `)
    const updateObject = this.db.query(`
      UPDATE objects
      SET properties = ?, updated_at = ?, version = version + 1, source_event_id = NULL
      WHERE project_id = ? AND object_type_id = ? AND primary_id = ?
    `)
    for (const objectUpsert of plan.objects.upserts) {
      if (objectUpsert.operation === "create") {
        insertObject.run(
          projectId,
          objectUpsert.objectTypeId,
          objectUpsert.primaryId,
          JSON.stringify(objectUpsert.properties),
          committedAt.toISOString(),
          committedAt.toISOString()
        )
        continue
      }

      const result = updateObject.run(
        JSON.stringify(objectUpsert.properties),
        committedAt.toISOString(),
        projectId,
        objectUpsert.objectTypeId,
        objectUpsert.primaryId
      )
      if (result.changes !== 1) {
        throw new EditStorageError(
          `[SixbSqlite] Edit commit cannot update missing object '${objectUpsert.objectTypeId}:${objectUpsert.primaryId}'.`
        )
      }
    }

    const insertLink = this.db.query(`
      INSERT INTO links (
        project_id, source_type_id, source_id, link_id, target_type_id, target_id, properties,
        created_at, updated_at, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `)
    const updateLink = this.db.query(`
      UPDATE links
      SET properties = ?, updated_at = ?, source_event_id = NULL
      WHERE project_id = ?
        AND source_type_id = ?
        AND source_id = ?
        AND link_id = ?
        AND target_type_id = ?
        AND target_id = ?
    `)
    for (const linkUpsert of plan.links.upserts) {
      const properties = linkUpsert.properties ? JSON.stringify(linkUpsert.properties) : null
      if (linkUpsert.operation === "create") {
        insertLink.run(
          projectId,
          linkUpsert.source.objectTypeId,
          linkUpsert.source.primaryId,
          linkUpsert.linkId,
          linkUpsert.target.objectTypeId,
          linkUpsert.target.primaryId,
          properties,
          committedAt.toISOString(),
          committedAt.toISOString()
        )
        continue
      }

      const result = updateLink.run(
        properties,
        committedAt.toISOString(),
        projectId,
        linkUpsert.source.objectTypeId,
        linkUpsert.source.primaryId,
        linkUpsert.linkId,
        linkUpsert.target.objectTypeId,
        linkUpsert.target.primaryId
      )
      if (result.changes !== 1) {
        throw new EditStorageError(
          `[SixbSqlite] Edit commit cannot update missing link '${linkUpsert.source.objectTypeId}:${linkUpsert.source.primaryId}:${linkUpsert.linkId}:${linkUpsert.target.objectTypeId}:${linkUpsert.target.primaryId}'.`
        )
      }
    }
  }

  private loadActionRun(projectId: string, runId: string): ActionRunDatabaseRow {
    const row = this.db
      .query("SELECT * FROM action_runs WHERE project_id = ? AND id = ?")
      .get(projectId, runId) as ActionRunDatabaseRow | null

    if (!row) {
      throw new EditStorageError(
        `[SixbSqlite] Action run '${runId}' not found for project '${projectId}'.`
      )
    }

    return row
  }

  private insertCommit(
    projectId: string,
    runId: string,
    committedAt: Date,
    diff: ActionRunCommitDiff
  ): void {
    this.db
      .query("INSERT INTO action_run_commits (project_id, run_id, committed_at) VALUES (?, ?, ?)")
      .run(projectId, runId, committedAt.toISOString())
    insertActionRunCommitDiff(this.db, projectId, runId, diff)
  }

  private loadCommitRecord(projectId: string, runId: string): ActionRunCommitRecord | undefined {
    const commitRows = this.db
      .query("SELECT * FROM action_run_commits WHERE project_id = ? AND run_id = ?")
      .all(projectId, runId) as CommitRow[]
    if (commitRows.length === 0) return undefined

    const objectRows = this.db
      .query("SELECT * FROM action_run_object_diffs WHERE project_id = ? AND run_id = ?")
      .all(projectId, runId) as ObjectDiffRow[]
    const propertyRows = this.db
      .query("SELECT * FROM action_run_object_diff_properties WHERE project_id = ? AND run_id = ?")
      .all(projectId, runId) as ObjectDiffPropertyRow[]
    const linkRows = this.db
      .query("SELECT * FROM action_run_link_diffs WHERE project_id = ? AND run_id = ?")
      .all(projectId, runId) as LinkDiffRow[]

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
      `[SixbSqlite] Action run '${input.runId}' belongs to action '${row.action_id}', not '${input.actionId}'.`
    )
  }

  if (!actionSubjectsEqual(rowToActionSubject(row), input.subject)) {
    throw new EditStorageError(
      `[SixbSqlite] Action run '${input.runId}' cannot commit edits for a different subject.`
    )
  }

  if (input.idempotencyKey !== undefined && row.idempotency_key !== input.idempotencyKey) {
    throw new EditStorageError(
      `[SixbSqlite] Action run '${input.runId}' cannot commit edits with a different idempotency key.`
    )
  }
}

function rowToObject(row: ObjectDatabaseRow): ObjectRow {
  return {
    projectId: row.project_id,
    objectTypeId: row.object_type_id,
    primaryId: row.primary_id,
    properties: JSON.parse(row.properties) as Record<string, unknown>,
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
    properties: row.properties
      ? (JSON.parse(row.properties) as Record<string, unknown>)
      : undefined,
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
    throw new EditStorageError(`[SixbSqlite] Action run '${row.id}' has an invalid object subject.`)
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
  properties: string
  created_at: string
  updated_at: string
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
  properties: string | null
  created_at: string
  updated_at: string
  source_event_id: string | null
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
  committed_at: string
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
