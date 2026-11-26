import type { Database, SQLQueryBindings } from "bun:sqlite"
import {
  addMigrationCounts,
  type CompiledMigrationSteps,
  compileMigrationSteps,
  migrationBatchConflict,
  migrationLanes,
  migrationRunAlreadyOpen,
  migrationRunType,
  movedVectorFingerprint,
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
  OntologyMigrationRunType,
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
 * applies the same ranges as PostgreSQL with `json_remove` and `json_set`, on the rows that hold a
 * key.
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
    const type = migrationRunType(plan, lane.objectTypeId)
    const compiled = compileMigrationSteps(type)
    const after = cursor.afterPrimaryId
    const through = laneThrough(lane)

    const ofType = "project_id = ? AND object_type_id = ?"
    const afterSql = after === undefined ? "" : "AND primary_id > ?"
    const afterParams = after === undefined ? [] : [after]
    const laneEnd = through === undefined ? "" : "AND primary_id <= ?"
    const laneEndParams = through === undefined ? [] : [through]
    const nth = (table: string) =>
      `(SELECT primary_id FROM ${table} WHERE ${ofType} ${afterSql} ${laneEnd}
        ORDER BY primary_id LIMIT 1 OFFSET ?)`
    const nthParams = [projectId, type.objectTypeId, ...afterParams, ...laneEndParams]
    const bound = this.db
      .query(
        `SELECT CASE WHEN o IS NULL THEN e WHEN e IS NULL OR o < e THEN o ELSE e END AS through
         FROM (SELECT ${nth("objects")} AS o, ${nth("ontology_object_overrides")} AS e)`
      )
      .get(...nthParams, input.batchRows - 1, ...nthParams, input.batchRows - 1) as {
      readonly through: string | null
    }
    const last = bound.through ?? undefined

    const end = last ?? through
    const range = (column: string) =>
      `${after === undefined ? "" : `AND ${column} > ?`} ${end === undefined ? "" : `AND ${column} <= ?`}`
    const rangeParams = [...afterParams, ...(end === undefined ? [] : [end])]
    const batch = {
      sql: `${ofType} ${range("primary_id")}`,
      params: [projectId, type.objectTypeId, ...rangeParams],
    }

    // Before the objects: a moved vector, or queued indexing, is checked against the values it
    // was built or asked for.
    const moved =
      this.moveVectors(projectId, type, batch) + this.moveIndexingWork(projectId, type, batch)
    const { objects, edits, vectors } = this.rewriteObjects(input, compiled, batch)
    const links = this.deleteLinks(projectId, type.objectTypeId, compiled, range, rangeParams)

    // No touch: `startRun` dropped every plan that would read one.
    if (objects + edits > 0) insertSqliteRuntimeCommit(this.db, input.commit)

    return {
      counts: { objects, edits, links, vectors: vectors + moved },
      cursor: last === undefined ? null : { kind: "objects", afterPrimaryId: last },
    }
  }

  /** Objects and edits that hold a key, and the vectors whose source held one. */
  private rewriteObjects(
    input: ApplyOntologyMigrationBatchInput,
    compiled: CompiledMigrationSteps,
    batch: { readonly sql: string; readonly params: readonly SQLQueryBindings[] }
  ): { readonly objects: number; readonly edits: number; readonly vectors: number } {
    const { keys } = compiled
    if (keys.length === 0) return { objects: 0, edits: 0, vectors: 0 }

    const keyList = keys.map(quote).join(", ")
    const commitId = input.commit.id

    const objects = this.db
      .query(
        `UPDATE objects
         SET properties = ${moved("objects.properties", compiled)}, version = version + 1,
           last_commit_id = ?
         WHERE ${batch.sql} AND ${holdsKey("objects.properties", keys)}`
      )
      .run(commitId, ...batch.params).changes

    // Qualified: inside `json_each(...)`, a bare `value` is json_each's own column.
    const edit = "ontology_object_overrides.value"
    const unset = `${edit} -> '$.unset'`
    const unsetHolds = `EXISTS (SELECT 1 FROM json_each(${unset}) AS item
      WHERE item.value IN (${keyList}))`
    const edits = this.db
      .query(
        `UPDATE ontology_object_overrides
         SET value = CASE json_extract(value, '$.kind')
             WHEN 'create' THEN
               json_set(value, '$.properties', ${moved(`${edit} -> '$.properties'`, compiled)})
             WHEN 'patch' THEN json_set(
               value, '$.set', ${moved(`${edit} -> '$.set'`, compiled)},
               '$.unset', ${movedList(unset, compiled)}
             )
             ELSE value
           END,
           edited_at = ${moved("ontology_object_overrides.edited_at", compiled)},
           last_commit_id = ?
         WHERE ${batch.sql} AND (${holdsKey(`${edit} -> '$.properties'`, keys)}
           OR ${holdsKey(`${edit} -> '$.set'`, keys)} OR ${unsetHolds}
           OR ${holdsKey("ontology_object_overrides.edited_at", keys)})`
      )
      .run(commitId, ...batch.params).changes

    const vectors = this.db
      .query(
        `DELETE FROM object_vectors WHERE ${batch.sql}
         AND EXISTS (SELECT 1 FROM json_each(source) AS item WHERE item.value IN (${keyList}))`
      )
      .run(...batch.params).changes

    return { objects, edits, vectors }
  }

  /**
   * The batch's vectors of a moved profile: their fingerprint hashes key names, so it is computed
   * again here, from the values the object holds before the batch, for these rows only. A vector
   * that no longer matches them is left for the delete that follows.
   */
  private moveVectors(
    projectId: string,
    type: OntologyMigrationRunType,
    batch: { readonly sql: string; readonly params: readonly SQLQueryBindings[] }
  ): number {
    const moves = type.vectors ?? []
    if (moves.length === 0) return 0

    const rows = this.db
      .query(
        `SELECT vectors.primary_id, vectors.profile, vectors.configuration,
           vectors.source_fingerprint, objects.properties
         FROM object_vectors AS vectors
         JOIN objects USING (project_id, object_type_id, primary_id)
         WHERE vectors.${batch.sql} AND vectors.profile IN (${moves.map(() => "?").join(", ")})`
      )
      .all(...batch.params, ...moves.map((move) => move.profile)) as {
      readonly primary_id: string
      readonly profile: string
      readonly configuration: string
      readonly source_fingerprint: string
      readonly properties: string
    }[]

    const update = this.db.query(
      `UPDATE object_vectors SET source = ?, configuration = ?, source_fingerprint = ?
       WHERE project_id = ? AND object_type_id = ? AND primary_id = ? AND profile = ?`
    )
    let rewritten = 0
    for (const row of rows) {
      const move = moves.find(
        (candidate) =>
          candidate.profile === row.profile && candidate.fromConfiguration === row.configuration
      )
      const fingerprint =
        move && movedVectorFingerprint(move, row.source_fingerprint, JSON.parse(row.properties))
      if (!move || !fingerprint) continue

      update.run(
        JSON.stringify(move.toSource),
        move.toConfiguration,
        fingerprint,
        projectId,
        type.objectTypeId,
        row.primary_id,
        row.profile
      )
      rewritten += 1
    }
    return rewritten
  }

  /**
   * The batch's queued indexing of a moved profile, asked for under the old keys: it takes the
   * profile's new configuration and the fingerprint of the same values under the new keys, or
   * goes when its object no longer holds the values it was asked for.
   */
  private moveIndexingWork(
    projectId: string,
    type: OntologyMigrationRunType,
    batch: { readonly sql: string; readonly params: readonly SQLQueryBindings[] }
  ): number {
    const moves = type.vectors ?? []
    if (moves.length === 0) return 0

    const rows = this.db
      .query(
        `SELECT work.id, work.profile, json_extract(work.request, '$.configuration') AS configuration,
           json_extract(work.request, '$.sourceFingerprint') AS source_fingerprint,
           objects.properties
         FROM object_vector_indexing AS work
         JOIN objects USING (project_id, object_type_id, primary_id)
         WHERE work.${batch.sql} AND work.profile IN (${moves.map(() => "?").join(", ")})`
      )
      .all(...batch.params, ...moves.map((move) => move.profile)) as {
      readonly id: string
      readonly profile: string
      readonly configuration: string
      readonly source_fingerprint: string
      readonly properties: string
    }[]

    const update = this.db.query(
      `UPDATE object_vector_indexing
       SET request = json_set(request, '$.configuration', ?, '$.sourceFingerprint', ?)
       WHERE project_id = ? AND id = ?`
    )
    const remove = this.db.query(
      `DELETE FROM object_vector_indexing WHERE project_id = ? AND id = ?`
    )
    let rewritten = 0
    for (const row of rows) {
      const move = moves.find(
        (candidate) =>
          candidate.profile === row.profile && candidate.fromConfiguration === row.configuration
      )
      if (!move) continue

      const fingerprint = movedVectorFingerprint(
        move,
        row.source_fingerprint,
        JSON.parse(row.properties)
      )
      if (fingerprint) update.run(move.toConfiguration, fingerprint, projectId, row.id)
      else remove.run(projectId, row.id)
      rewritten += 1
    }
    return rewritten
  }

  /** The batch's links of a removed link, by source, and their edits: edges and every slot. */
  private deleteLinks(
    projectId: string,
    objectTypeId: string,
    compiled: CompiledMigrationSteps,
    range: (column: string) => string,
    rangeParams: readonly SQLQueryBindings[]
  ): number {
    const linkIds = compiled.removedLinkIds
    if (linkIds.length === 0) return 0

    const ofLink = `project_id = ? AND source_type_id = ?
      AND link_id IN (${linkIds.map(() => "?").join(", ")})`
    const params = [projectId, objectTypeId, ...linkIds, ...rangeParams]

    const links = this.db
      .query(`DELETE FROM links WHERE ${ofLink} ${range("source_id")}`)
      .run(...params).changes
    const edits = this.db
      .query(`DELETE FROM ontology_link_overrides WHERE ${ofLink} ${range("source_primary_id")}`)
      .run(...params).changes

    return links + edits
  }

  /**
   * Up to `batchRows` unique values, then artifact refs, of the removed and renamed properties,
   * then source rows of removed links. A renamed property's refs move to its new id; its unique
   * values move when the plan says they compare as the new id's do, and go otherwise, to be built
   * after the run. The properties' preparation follows with the last unique values. SQLite
   * rewrites rows in place, so a value batch seeks the key prefix again; refs, keyed by artifact
   * first, walk by rowid.
   */
  private applyDerived(
    plan: OntologyMigrationRunPlan,
    objectTypeId: string,
    cursor: Extract<OntologyMigrationLaneCursor, { kind: "derived" }>,
    input: ApplyOntologyMigrationBatchInput
  ): LaneOutcome {
    const { projectId, batchRows } = input
    const compiled = compileMigrationSteps(migrationRunType(plan, objectTypeId))
    const ofType = "project_id = ? AND object_type_id = ?"
    const ofProperties = (ids: readonly string[]) =>
      `${ofType} AND property_id IN (${ids.map(quote).join(", ")})`
    const renamed = (pairs: readonly { readonly from: string; readonly to: string }[]) =>
      `CASE property_id ${pairs.map(({ from, to }) => `WHEN ${quote(from)} THEN ${quote(to)}`).join(" ")} END`
    const moves = compiled.uniqueMoves
    const dropped = compiled.keys.filter((key) => !moves.some((move) => move.from === key))

    if (cursor.store === "sourceLinks") {
      const sources = this.deleteSourceLinks(projectId, objectTypeId, compiled, batchRows)
      return { counts: { sources }, cursor: sources === batchRows ? cursor : null }
    }

    if (cursor.store === "uniqueValues") {
      // What a moved property's new id may already hold goes first, before any value moves there.
      const toIds = moves.map((move) => move.to)
      if (cursor.after === undefined && moves.length > 0) {
        for (const table of ["object_unique_values", "object_unique_properties"]) {
          this.db
            .query(`DELETE FROM ${table} WHERE ${ofProperties(toIds)}`)
            .run(projectId, objectTypeId)
        }
      }

      const batch = `SELECT rowid FROM object_unique_values WHERE ${ofProperties(compiled.keys)} LIMIT ?`
      const rows = this.db
        .query(`SELECT json_group_array(rowid) AS ids, count(*) AS rows FROM (${batch})`)
        .get(projectId, objectTypeId, batchRows) as { readonly ids: string; readonly rows: number }
      const inBatch = "rowid IN (SELECT value FROM json_each(?))"
      if (moves.length > 0) {
        this.db
          .query(
            `UPDATE object_unique_values SET property_id = ${renamed(moves)}
             WHERE ${inBatch} AND ${ofProperties(moves.map((move) => move.from))}`
          )
          .run(rows.ids, projectId, objectTypeId)
      }
      this.db
        .query(`DELETE FROM object_unique_values WHERE ${inBatch} AND ${ofProperties(dropped)}`)
        .run(rows.ids, projectId, objectTypeId)

      // Moved rows leave the keys, dropped ones go: the next batch seeks the prefix again.
      const uniqueValues = rows.rows
      if (uniqueValues === batchRows) {
        return {
          counts: { uniqueValues },
          cursor: { kind: "derived", store: "uniqueValues", after: [] },
        }
      }

      if (moves.length > 0) {
        this.db
          .query(
            `UPDATE object_unique_properties SET property_id = ${renamed(moves)}
             WHERE ${ofProperties(moves.map((move) => move.from))}`
          )
          .run(projectId, objectTypeId)
      }
      this.db
        .query(`DELETE FROM object_unique_properties WHERE ${ofProperties(dropped)}`)
        .run(projectId, objectTypeId)
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
    const window = "rowid > ? AND rowid <= ?"

    let artifactRefs = 0
    if (batch.last !== null) {
      artifactRefs += this.db
        .query(
          `DELETE FROM object_artifact_refs
           WHERE ${window} AND ${ofProperties(compiled.removedPropertyIds)}`
        )
        .run(after, batch.last, projectId, objectTypeId).changes
      if (compiled.renames.length > 0) {
        artifactRefs += this.db
          .query(
            `UPDATE object_artifact_refs SET property_id = ${renamed(compiled.renames)}
             WHERE ${window} AND ${ofProperties(compiled.renames.map((rename) => rename.from))}`
          )
          .run(after, batch.last, projectId, objectTypeId).changes
      }
    }

    if (batch.rows === batchRows && batch.last !== null) {
      return {
        counts: { artifactRefs },
        cursor: { kind: "derived", store: "artifactRefs", after: [String(batch.last)] },
      }
    }

    const links = compiled.removedLinkIds.length > 0
    return {
      counts: { artifactRefs },
      cursor: links ? { kind: "derived", store: "sourceLinks" } : null,
    }
  }

  /**
   * Up to `batchRows` source rows, of every version, of a removed link whose source is of the
   * type, through the link-source index, and their versions' assertion counts with them. The rows
   * go, so the next batch starts where this one left off without a cursor.
   */
  private deleteSourceLinks(
    projectId: string,
    objectTypeId: string,
    compiled: CompiledMigrationSteps,
    batchRows: number
  ): number {
    const linkIds = compiled.removedLinkIds
    const batch = this.db
      .query(
        `SELECT json_group_array(rowid) AS ids, count(*) AS rows FROM (
           SELECT rows.rowid FROM ontology_source_rows AS rows
           JOIN ontology_source_roots AS roots ON roots.id = rows.root_id
           WHERE rows.entity_kind = 'link' AND rows.source_type_id = ?
             AND rows.link_id IN (${linkIds.map(() => "?").join(", ")}) AND roots.project_id = ?
           LIMIT ?
         )`
      )
      .get(objectTypeId, ...linkIds, projectId, batchRows) as {
      readonly ids: string
      readonly rows: number
    }
    const inBatch = "SELECT value FROM json_each(?)"

    this.db
      .query(
        `UPDATE ontology_sources SET assertion_count = assertion_count - removed.rows
         FROM (
           SELECT roots.version_id, count(*) AS rows FROM ontology_source_rows AS rows
           JOIN ontology_source_roots AS roots ON roots.id = rows.root_id
           WHERE rows.rowid IN (${inBatch}) GROUP BY roots.version_id
         ) AS removed
         WHERE ontology_sources.version_id = removed.version_id`
      )
      .run(batch.ids)
    this.db.query(`DELETE FROM ontology_source_rows WHERE rowid IN (${inBatch})`).run(batch.ids)

    return batch.rows
  }

  /**
   * Up to `batchRows` source roots of the lane's root-key range in one version, by root key, every
   * version in turn (active, candidates and retired, deletions included), found through
   * `(version_id, root_key)`. Their rows lose the keys from their values and from
   * `absentSourcePropertyIds`, renamed ones under their new id, and the list goes once empty, as a
   * staged row never holds an empty one.
   */
  private applySources(
    plan: OntologyMigrationRunPlan,
    lane: OntologyMigrationLane,
    cursor: Extract<OntologyMigrationLaneCursor, { kind: "sources" }>,
    input: ApplyOntologyMigrationBatchInput
  ): LaneOutcome {
    const { projectId, batchRows } = input
    const { objectTypeId } = lane
    const compiled = compileMigrationSteps(migrationRunType(plan, objectTypeId))
    const versionId = cursor.versionId ?? this.nextVersion(projectId, undefined)
    if (versionId === undefined || compiled.keys.length === 0) return { counts: {}, cursor: null }

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

    const { keys } = compiled
    const removedList = keys.map(quote).join(", ")
    const absentKept = movedList(
      "ontology_source_rows.payload -> '$.absentSourcePropertyIds'",
      compiled
    )
    const values = `json_set(payload, '$.properties',
      ${moved("coalesce(ontology_source_rows.payload -> '$.properties', '{}')", compiled)})`
    const holds = holdsKey("ontology_source_rows.payload -> '$.properties'", keys)

    const sources = bound.last
      ? this.db
          .query(
            `UPDATE ontology_source_rows
             SET payload = CASE
               WHEN json_array_length(${absentKept}) = 0
                 THEN json_remove(${values}, '$.absentSourcePropertyIds')
               ELSE json_set(${values}, '$.absentSourcePropertyIds', ${absentKept})
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

/**
 * A JSON object with the compiled keys dropped and each renamed value under its new id, rebuilt
 * from its members once: the expression grows by one `WHEN` per rename, where wrapping it once per
 * rename overflowed SQLite's parser at a dozen. Only a member the object holds moves, so an absent
 * one stays absent, and a `to` the object holds beside its `from` gives way to it. `column` must
 * be qualified: inside `json_each`, a bare `value` or `key` is json_each's own.
 */
function moved(column: string, compiled: CompiledMigrationSteps): string {
  const { renames } = compiled
  if (renames.length === 0) return removeKeys(column, compiled.keys)

  const cases = (value: (rename: { readonly from: string; readonly to: string }) => string) =>
    renames.map((rename) => `WHEN ${quote(rename.from)} THEN ${value(rename)}`).join(" ")
  const key = `CASE item.key ${cases(({ to }) => quote(to))} ELSE item.key END`
  // A `to` gives way to its `from`, found through one flat `CASE`: an `OR` per rename reaches
  // SQLite's expression depth of 1,000 at a few hundred.
  const fromOf = `CASE item.key ${renames
    .map(({ from, to }) => `WHEN ${quote(to)} THEN ${quote(jsonPath(from))}`)
    .join(" ")} END`

  return `(SELECT json_group_object(${key}, ${column} -> item.fullkey)
    FROM json_each(${column}) AS item
    WHERE item.key NOT IN (${compiled.removedPropertyIds.map(quote).join(", ")})
      AND NOT (item.key IN (${renames.map(({ to }) => quote(to)).join(", ")})
        AND json_type(${column}, ${fromOf}) IS NOT NULL))`
}

/** A JSON array of property ids with the compiled keys dropped and renamed ones replaced. */
function movedList(column: string, compiled: CompiledMigrationSteps): string {
  const renamed = compiled.renames
    .map(({ from, to }) => `WHEN ${quote(from)} THEN ${quote(to)}`)
    .join(" ")
  const value = renamed ? `CASE item.value ${renamed} ELSE item.value END` : "item.value"

  return `json((SELECT json_group_array(${value}) FROM json_each(${column}) AS item
    WHERE item.value NOT IN (${compiled.removedPropertyIds.map(quote).join(", ")})))`
}
