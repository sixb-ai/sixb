import type { Database, SQLQueryBindings } from "bun:sqlite"
import {
  addMigrationCounts,
  compileMigrationSteps,
  migrationBatchConflict,
  migrationLanes,
  migrationRunAlreadyOpen,
  migrationRunType,
  rootKeyEnd,
  rootKeyPrefix,
} from "@sixb/core/internal/storage"
import type {
  ApplyOntologyMigrationBatchInput,
  OntologyMigrationCounts,
  OntologyMigrationLane,
  OntologyMigrationLaneCursor,
  OntologyMigrationLaneRecord,
  OntologyMigrationRunPlan,
  OntologyMigrationRunRecord,
  OntologyMigrationStorage,
  SettledMigration,
  StartOntologyMigrationRunInput,
} from "@sixb/core/storage"
import { insertSqliteRuntimeCommit } from "./commits"
import type { SqliteRootOperation } from "./shared"

interface SqliteRunRow {
  readonly project_id: string
  readonly id: string
  readonly execution_id: string
  readonly status: OntologyMigrationRunRecord["status"]
  readonly started_at: string
  readonly applied_at: string | null
  readonly plan: string
}

interface SqliteLaneRow {
  readonly ordinal: number
  readonly lane: string
  readonly cursor: string | null
  readonly batches: number
  readonly counts: string
}

interface LaneOutcome {
  readonly counts: Partial<OntologyMigrationCounts>
  /** Where the lane's next batch starts, or `null` once it is done. */
  readonly cursor: OntologyMigrationLaneCursor | null
}

/**
 * Each root call runs in its own write transaction (the root ontology scope opens one), or in the
 * caller's. SQLite has one writer, so lanes run one after another and a type is one range. A batch
 * applies the same ranges as PostgreSQL with `json_remove`, on the rows that hold a removed key;
 * touches are selected back from the rows the batch stamped.
 */
export class SqliteOntologyMigrationStorage implements OntologyMigrationStorage {
  readonly parallelism = 1

  constructor(
    private readonly db: Database,
    private readonly runRootOperation: SqliteRootOperation
  ) {}

  async getOpenRun(input: { readonly projectId: string }) {
    return this.runRootOperation(() => {
      const row = this.db
        .query(`SELECT * FROM ontology_migration_runs WHERE project_id = ? AND status = 'applying'`)
        .get(input.projectId) as SqliteRunRow | null
      return row ? this.runRecord(row) : null
    })
  }

  async listSettled(input: { readonly projectId: string }): Promise<readonly SettledMigration[]> {
    return this.runRootOperation(() => {
      const rows = this.db
        .query(
          `SELECT object_type_id, migration_id FROM ontology_migrations_settled
           WHERE project_id = ? ORDER BY object_type_id, migration_id`
        )
        .all(input.projectId) as {
        readonly object_type_id: string
        readonly migration_id: string
      }[]
      return rows.map((row) => ({
        objectTypeId: row.object_type_id,
        migrationId: row.migration_id,
      }))
    })
  }

  async settle(input: {
    readonly projectId: string
    readonly migrations: readonly SettledMigration[]
    readonly settledAt: string
  }): Promise<void> {
    await this.runRootOperation(() => this.writeSettled(input))
  }

  async startRun(input: StartOntologyMigrationRunInput): Promise<OntologyMigrationRunRecord> {
    const { projectId, plan } = input

    return this.runRootOperation(() => {
      const open = this.db
        .query(
          `SELECT id FROM ontology_migration_runs WHERE project_id = ? AND status = 'applying'`
        )
        .get(projectId) as { readonly id: string } | null
      if (open) throw migrationRunAlreadyOpen(open.id)

      const run: OntologyMigrationRunRecord = {
        projectId,
        id: input.id,
        executionId: input.executionId,
        status: "applying",
        startedAt: input.startedAt,
        plan,
        lanes: migrationLanes(plan, { objects: new Map(), sources: new Map() }),
      }

      this.db
        .query(
          `INSERT INTO ontology_migration_runs (project_id, id, execution_id, status, started_at, plan)
           VALUES (?, ?, ?, 'applying', ?, ?)`
        )
        .run(projectId, run.id, run.executionId, run.startedAt, JSON.stringify(plan))
      const insertLane = this.db.query(
        `INSERT INTO ontology_migration_run_lanes (project_id, run_id, ordinal, lane, cursor, counts)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      for (const lane of run.lanes) {
        insertLane.run(
          projectId,
          run.id,
          lane.ordinal,
          JSON.stringify(lane.lane),
          JSON.stringify(lane.cursor),
          JSON.stringify(lane.counts)
        )
      }

      // A type with data and no shape yet takes the baseline it starts from.
      for (const type of plan.types) {
        this.db
          .query(
            `INSERT INTO ontology_type_shapes (project_id, object_type_id, shape, state, updated_at)
             VALUES (?, ?, ?, 'migrating', ?)
             ON CONFLICT (project_id, object_type_id)
             DO UPDATE SET state = 'migrating', previous_shape = NULL`
          )
          .run(projectId, type.objectTypeId, JSON.stringify(type.fromShape), run.startedAt)
      }

      // Plans are caches, and one built before the run may hold a key it removes.
      const plans = `SELECT version_id FROM ontology_replacement_plans WHERE project_id = ?`
      this.db
        .query(`DELETE FROM ontology_replacement_plan_work WHERE work_id IN (${plans})`)
        .run(projectId)
      this.db
        .query(`DELETE FROM ontology_replacement_plan_identities WHERE version_id IN (${plans})`)
        .run(projectId)
      this.db.query(`DELETE FROM ontology_replacement_plans WHERE project_id = ?`).run(projectId)

      return run
    })
  }

  async applyBatch(input: ApplyOntologyMigrationBatchInput): Promise<OntologyMigrationLaneRecord> {
    return this.runRootOperation(() => {
      const run = this.db
        .query(`SELECT status, plan FROM ontology_migration_runs WHERE project_id = ? AND id = ?`)
        .get(input.projectId, input.runId) as {
        readonly status: string
        readonly plan: string
      } | null
      const row = this.db
        .query(
          `SELECT * FROM ontology_migration_run_lanes
           WHERE project_id = ? AND run_id = ? AND ordinal = ?`
        )
        .get(input.projectId, input.runId, input.ordinal) as SqliteLaneRow | null
      const lane = row ? laneRecord(row) : null
      if (!run || !lane || run.status !== "applying" || lane.batches !== input.batches) {
        throw migrationBatchConflict(input.runId)
      }
      if (!lane.cursor) throw migrationBatchConflict(input.runId)

      const plan = JSON.parse(run.plan) as OntologyMigrationRunPlan
      const outcome = this.applyLane(plan, lane.lane, lane.cursor, input)
      const next: OntologyMigrationLaneRecord = {
        ...lane,
        cursor: outcome.cursor,
        batches: lane.batches + 1,
        counts: addMigrationCounts(lane.counts, outcome.counts),
      }

      this.db
        .query(
          `UPDATE ontology_migration_run_lanes SET cursor = ?, batches = ?, counts = ?
           WHERE project_id = ? AND run_id = ? AND ordinal = ?`
        )
        .run(
          next.cursor ? JSON.stringify(next.cursor) : null,
          next.batches,
          JSON.stringify(next.counts),
          input.projectId,
          input.runId,
          input.ordinal
        )
      return next
    })
  }

  async finishRun(input: {
    readonly projectId: string
    readonly runId: string
    readonly appliedAt: string
  }): Promise<OntologyMigrationRunRecord> {
    return this.runRootOperation(() => {
      const row = this.db
        .query(`SELECT * FROM ontology_migration_runs WHERE project_id = ? AND id = ?`)
        .get(input.projectId, input.runId) as SqliteRunRow | null
      const run = row ? this.runRecord(row) : null
      if (!run || run.status !== "applying" || run.lanes.some((lane) => lane.cursor !== null)) {
        throw migrationBatchConflict(input.runId)
      }

      for (const type of run.plan.types) {
        this.db
          .query(
            `UPDATE ontology_type_shapes
             SET shape = ?, previous_shape = NULL, state = 'current', updated_at = ?
             WHERE project_id = ? AND object_type_id = ?`
          )
          .run(JSON.stringify(type.toShape), input.appliedAt, run.projectId, type.objectTypeId)
      }
      this.writeSettled({
        projectId: run.projectId,
        migrations: run.plan.types.flatMap((type) =>
          type.steps.map((step) => ({
            objectTypeId: type.objectTypeId,
            migrationId: step.migrationId,
          }))
        ),
        settledAt: input.appliedAt,
      })
      this.db
        .query(
          `UPDATE ontology_migration_runs SET status = 'applied', applied_at = ?
           WHERE project_id = ? AND id = ?`
        )
        .run(input.appliedAt, run.projectId, run.id)

      return { ...run, status: "applied", appliedAt: input.appliedAt }
    })
  }

  private applyLane(
    plan: OntologyMigrationRunPlan,
    lane: OntologyMigrationLane,
    cursor: OntologyMigrationLaneCursor,
    input: ApplyOntologyMigrationBatchInput
  ): LaneOutcome {
    switch (cursor.kind) {
      case "objects":
        return this.applyObjects(plan, lane, cursor, input)
      case "sources":
        return this.applySources(plan, lane, cursor, input)
      case "derived":
        return this.applyDerived(plan, lane.objectTypeId, cursor, input)
    }
  }

  /**
   * One batch of the lane's range: up to `batchRows` objects and edits after the cursor, ending at
   * the lower of the two last keys, or at the range's end on its last batch.
   */
  private applyObjects(
    plan: OntologyMigrationRunPlan,
    lane: OntologyMigrationLane,
    cursor: Extract<OntologyMigrationLaneCursor, { kind: "objects" }>,
    input: ApplyOntologyMigrationBatchInput
  ): LaneOutcome {
    const { projectId } = input
    const type = lane.objectTypeId
    const through = laneThrough(lane)
    const keys = compileMigrationSteps(migrationRunType(plan, type)).removedPropertyIds
    const after = cursor.afterPrimaryId

    const ofType = "project_id = ? AND object_type_id = ?"
    const afterSql = after === undefined ? "" : "AND primary_id > ?"
    const afterParams = after === undefined ? [] : [after]
    const laneEnd = through === undefined ? "" : "AND primary_id <= ?"
    const laneEndParams = through === undefined ? [] : [through]
    const nth = (table: string) =>
      `(SELECT primary_id FROM ${table} WHERE ${ofType} ${afterSql} ${laneEnd}
        ORDER BY primary_id LIMIT 1 OFFSET ?)`
    const nthParams = [projectId, type, ...afterParams, ...laneEndParams, input.batchRows - 1]
    const bound = this.db
      .query(
        `SELECT CASE WHEN o IS NULL THEN e WHEN e IS NULL OR o < e THEN o ELSE e END AS through
         FROM (SELECT ${nth("objects")} AS o, ${nth("ontology_object_overrides")} AS e)`
      )
      .get(...nthParams, ...nthParams) as { readonly through: string | null }
    const last = bound.through ?? undefined

    const end = last ?? through
    const range = `${ofType} ${afterSql} ${end === undefined ? "" : "AND primary_id <= ?"}`
    const rangeParams = [projectId, type, ...afterParams, ...(end === undefined ? [] : [end])]
    const removedList = keys.map(quote).join(", ")
    const commitId = input.commit.id

    const objects = this.db
      .query(
        `UPDATE objects
         SET properties = ${removeKeys("objects.properties", keys)}, version = version + 1,
           last_commit_id = ?
         WHERE ${range} AND ${holdsKey("objects.properties", keys)}`
      )
      .run(commitId, ...rangeParams).changes

    // Qualified: inside `json_each(...)`, a bare `value` is json_each's own column.
    const edit = "ontology_object_overrides.value"
    const unsetKept = `(SELECT json_group_array(item.value) FROM json_each(${edit}, '$.unset') AS item
      WHERE item.value NOT IN (${removedList}))`
    const unsetHolds = `EXISTS (SELECT 1 FROM json_each(${edit}, '$.unset') AS item
      WHERE item.value IN (${removedList}))`
    const edits = this.db
      .query(
        `UPDATE ontology_object_overrides
         SET value = CASE json_extract(value, '$.kind')
             WHEN 'create' THEN json_set(
               value, '$.properties', ${removeKeys(`${edit} -> '$.properties'`, keys)}
             )
             WHEN 'patch' THEN json_set(
               value, '$.set', ${removeKeys(`${edit} -> '$.set'`, keys)},
               '$.unset', json(${unsetKept})
             )
             ELSE value
           END,
           edited_at = ${removeKeys("ontology_object_overrides.edited_at", keys)},
           last_commit_id = ?
         WHERE ${range} AND (${holdsKey(`${edit} -> '$.properties'`, keys)}
           OR ${holdsKey(`${edit} -> '$.set'`, keys)} OR ${unsetHolds}
           OR ${holdsKey("ontology_object_overrides.edited_at", keys)})`
      )
      .run(commitId, ...rangeParams).changes

    const vectors = this.db
      .query(
        `DELETE FROM object_vectors WHERE ${range}
         AND EXISTS (SELECT 1 FROM json_each(source) AS item WHERE item.value IN (${removedList}))`
      )
      .run(...rangeParams).changes

    // No touch: `startRun` dropped every plan that would read one.
    if (objects + edits > 0) insertSqliteRuntimeCommit(this.db, input.commit)

    return {
      counts: { objects, edits, vectors },
      cursor: last === undefined ? null : { kind: "objects", afterPrimaryId: last },
    }
  }

  /**
   * Up to `batchRows` unique values, then artifact refs, of the removed properties; the
   * properties' preparation goes with the last unique values. SQLite deletes rows in place, so a
   * value batch seeks the key prefix again; refs, keyed by artifact first, walk by rowid.
   */
  private applyDerived(
    plan: OntologyMigrationRunPlan,
    objectTypeId: string,
    cursor: Extract<OntologyMigrationLaneCursor, { kind: "derived" }>,
    input: ApplyOntologyMigrationBatchInput
  ): LaneOutcome {
    const { projectId, batchRows } = input
    const keys = compileMigrationSteps(migrationRunType(plan, objectTypeId)).removedPropertyIds
    const ofProperty = `project_id = ? AND object_type_id = ?
      AND property_id IN (${keys.map(() => "?").join(", ")})`
    const params: SQLQueryBindings[] = [projectId, objectTypeId, ...keys]

    if (cursor.store === "uniqueValues") {
      const uniqueValues = this.db
        .query(
          `DELETE FROM object_unique_values WHERE rowid IN (
             SELECT rowid FROM object_unique_values WHERE ${ofProperty} LIMIT ?
           )`
        )
        .run(...params, batchRows).changes
      if (uniqueValues === batchRows) {
        return { counts: { uniqueValues }, cursor: { kind: "derived", store: "uniqueValues" } }
      }

      this.db.query(`DELETE FROM object_unique_properties WHERE ${ofProperty}`).run(...params)
      return { counts: { uniqueValues }, cursor: { kind: "derived", store: "artifactRefs" } }
    }

    const after = Number(cursor.after?.[0] ?? 0)
    const batch = this.db
      .query(
        `SELECT count(*) AS rows, max(rowid) AS last FROM (
           SELECT rowid FROM object_artifact_refs WHERE rowid > ? ORDER BY rowid LIMIT ?
         )`
      )
      .get(after, batchRows) as { readonly rows: number; readonly last: number | null }
    const artifactRefs =
      batch.last === null
        ? 0
        : this.db
            .query(
              `DELETE FROM object_artifact_refs WHERE rowid > ? AND rowid <= ? AND ${ofProperty}`
            )
            .run(after, batch.last, ...params).changes

    if (batch.rows < batchRows || batch.last === null)
      return { counts: { artifactRefs }, cursor: null }
    return {
      counts: { artifactRefs },
      cursor: { kind: "derived", store: "artifactRefs", after: [String(batch.last)] },
    }
  }

  /**
   * Up to `batchRows` source roots of the lane's root-key range in one version, by root key, every
   * version in turn (active, candidates and retired, deletions included), found through
   * `(version_id, root_key)`. Their rows lose the keys from their values and from
   * `absentSourcePropertyIds`, which goes once empty, as a staged row never holds an empty one.
   */
  private applySources(
    plan: OntologyMigrationRunPlan,
    lane: OntologyMigrationLane,
    cursor: Extract<OntologyMigrationLaneCursor, { kind: "sources" }>,
    input: ApplyOntologyMigrationBatchInput
  ): LaneOutcome {
    const { projectId, batchRows } = input
    const { objectTypeId } = lane
    const versionId = cursor.versionId ?? this.nextVersion(projectId, undefined)
    if (versionId === undefined) return { counts: {}, cursor: null }

    // One lower and one upper bound each: SQLite seeks the index on one of each, and a second
    // upper bound would leave the rest of the type's keys to scan.
    const through = laneThrough(lane)
    const lower = cursor.afterRootKey === undefined ? "root_key >= ?" : "root_key > ?"
    const lowerKey = cursor.afterRootKey ?? rootKeyPrefix(objectTypeId)
    const upper = through === undefined ? "root_key < ?" : "root_key <= ?"
    const upperKey = through ?? rootKeyEnd(objectTypeId)
    const bound = this.db
      .query(
        `SELECT count(*) AS roots, max(root_key) AS last FROM (
           SELECT root_key FROM ontology_source_roots
           WHERE version_id = ? AND ${lower} AND ${upper}
           ORDER BY root_key LIMIT ?
         )`
      )
      .get(Number(versionId), lowerKey, upperKey, batchRows) as {
      readonly roots: number
      readonly last: string | null
    }

    const keys = compileMigrationSteps(migrationRunType(plan, objectTypeId)).removedPropertyIds
    const removedList = keys.map(quote).join(", ")
    const absentKept = `(SELECT json_group_array(item.value)
      FROM json_each(payload, '$.absentSourcePropertyIds') AS item
      WHERE item.value NOT IN (${removedList}))`
    const values = `json_set(payload, '$.properties',
      ${removeKeys("coalesce(ontology_source_rows.payload -> '$.properties', '{}')", keys)})`
    const holds = holdsKey("ontology_source_rows.payload -> '$.properties'", keys)

    const sources = bound.last
      ? this.db
          .query(
            `UPDATE ontology_source_rows
             SET payload = CASE
               WHEN json_array_length(${absentKept}) = 0
                 THEN json_remove(${values}, '$.absentSourcePropertyIds')
               ELSE json_set(${values}, '$.absentSourcePropertyIds', json(${absentKept}))
             END
             WHERE root_id IN (
                 SELECT id FROM ontology_source_roots
                 WHERE version_id = ? AND ${lower} AND root_key <= ?
               )
               AND entity_kind = 'object' AND object_type_id = ?
               AND (${holds} OR EXISTS (
                 SELECT 1 FROM json_each(payload, '$.absentSourcePropertyIds') AS item
                 WHERE item.value IN (${removedList})
               ))`
          )
          .run(Number(versionId), lowerKey, bound.last, objectTypeId).changes
      : 0

    if (bound.roots === batchRows && bound.last) {
      return {
        counts: { sources },
        cursor: { kind: "sources", versionId, afterRootKey: bound.last },
      }
    }

    // The next version starts over at the lane's range.
    const next = this.nextVersion(projectId, versionId)
    if (next === undefined) return { counts: { sources }, cursor: null }
    const start = "after" in lane && lane.after !== undefined ? { afterRootKey: lane.after } : {}
    return { counts: { sources }, cursor: { kind: "sources", versionId: next, ...start } }
  }

  /** The project's next object source version after `after`, by id. */
  private nextVersion(projectId: string, after: string | undefined): string | undefined {
    const row = this.db
      .query(
        `SELECT min(version_id) AS version_id FROM ontology_sources
         WHERE project_id = ? AND projection_kind = 'object'
           ${after === undefined ? "" : "AND version_id > ?"}`
      )
      .get(projectId, ...(after === undefined ? [] : [Number(after)])) as {
      readonly version_id: number | null
    }
    return row.version_id === null ? undefined : String(row.version_id)
  }

  private writeSettled(input: {
    readonly projectId: string
    readonly migrations: readonly SettledMigration[]
    readonly settledAt: string
  }): void {
    const insert = this.db.query(
      `INSERT INTO ontology_migrations_settled (project_id, object_type_id, migration_id, settled_at)
       VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`
    )
    for (const { objectTypeId, migrationId } of input.migrations) {
      insert.run(input.projectId, objectTypeId, migrationId, input.settledAt)
    }
  }

  private runRecord(row: SqliteRunRow): OntologyMigrationRunRecord {
    const lanes = this.db
      .query(
        `SELECT * FROM ontology_migration_run_lanes WHERE project_id = ? AND run_id = ?
         ORDER BY ordinal`
      )
      .all(row.project_id, row.id) as SqliteLaneRow[]

    return {
      projectId: row.project_id,
      id: row.id,
      executionId: row.execution_id,
      status: row.status,
      startedAt: row.started_at,
      ...(row.applied_at === null ? {} : { appliedAt: row.applied_at }),
      plan: JSON.parse(row.plan),
      lanes: lanes.map(laneRecord),
    }
  }
}

/** A range's end, when the lane has one. */
function laneThrough(lane: OntologyMigrationLane): string | undefined {
  return "through" in lane ? lane.through : undefined
}

function laneRecord(row: SqliteLaneRow): OntologyMigrationLaneRecord {
  return {
    ordinal: Number(row.ordinal),
    lane: JSON.parse(row.lane),
    cursor: row.cursor === null ? null : JSON.parse(row.cursor),
    batches: Number(row.batches),
    counts: JSON.parse(row.counts),
  }
}

/** Paths one `json_remove` takes at most: SQLite refuses a function call of 127 arguments. */
const REMOVED_PATHS_PER_CALL = 100

/**
 * `column` without `keys`, in nested `json_remove` calls of at most
 * {@link REMOVED_PATHS_PER_CALL} paths, so any number of removed keys fits.
 */
function removeKeys(column: string, keys: readonly string[]): string {
  let expression = column
  for (let start = 0; start < keys.length; start += REMOVED_PATHS_PER_CALL) {
    const paths = keys
      .slice(start, start + REMOVED_PATHS_PER_CALL)
      .map(jsonPath)
      .map(quote)
    expression = `json_remove(${expression}, ${paths.join(", ")})`
  }
  return expression
}

/**
 * Whether the JSON object holds one of `keys`, as one flat condition: an `OR` per key reaches
 * SQLite's expression depth of 1,000 at a few hundred keys. `column` must be qualified: inside
 * `json_each`, a bare `value` or `key` is json_each's own.
 */
function holdsKey(column: string, keys: readonly string[]): string {
  return `EXISTS (SELECT 1 FROM json_each(${column}) AS item
    WHERE item.key IN (${keys.map(quote).join(", ")}))`
}

/** `$."gate"`: a quoted label, so any property id is one path step. */
function jsonPath(propertyId: string): string {
  return `$."${propertyId.replace(/["\\]/g, "\\$&")}"`
}

/** A SQL string literal: property ids are definition data, never input, and few. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
