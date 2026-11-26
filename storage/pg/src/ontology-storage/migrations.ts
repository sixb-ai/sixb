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
import { objectPartitionName } from "../objects/partitions"
import type { SQL, SQLClient } from "../pg-client"
import { insertPgRuntimeCommit } from "./commits"
import { dropMigratedQueryStructures } from "./migration-query-structures"
import { jsonParameter as json, type PgRootOperation, toIsoString } from "./shared"

type Fragment = ReturnType<SQL["unsafe"]>

interface PgRunRow {
  readonly project_id: string
  readonly id: string
  readonly execution_id: string
  readonly status: OntologyMigrationRunRecord["status"]
  readonly started_at: Date | string
  readonly applied_at: Date | string | null
  readonly plan: OntologyMigrationRunPlan
}

interface PgLaneRow {
  readonly ordinal: number
  readonly lane: OntologyMigrationLane
  readonly cursor: OntologyMigrationLaneCursor | null
  readonly batches: number
  readonly counts: OntologyMigrationCounts
}

interface LaneOutcome {
  readonly counts: Partial<OntologyMigrationCounts>
  /** Where the lane's next batch starts, or `null` once it is done. */
  readonly cursor: OntologyMigrationLaneCursor | null
}

/**
 * Lanes side by side at most, and ranges per type and lane kind. Measured on 8 CPUs, 1M objects:
 * 1 lane 10.5 s, 2 → 7.7 s, 4 → 5.9 s, 6 → 5.9 s, 8 → 5.6 s; 10M: 4 → 66.5 s, 6 → 59.5 s. A
 * 2-CPU database pays for it: 1M, 4 → 7.8 s, 6 → 9.4 s; 10M, 4 → 86 s, 6 → 97 s.
 */
const MAX_PARALLELISM = 6

/** Keys sampled per range to place its boundaries. */
const SAMPLE_ROWS_PER_RANGE = 500

/** Rows a page of 8 kB holds at least, to estimate a table never analyzed from its size. */
const MIN_ROWS_PER_PAGE = 20

/**
 * Each call is a transaction of its own, or runs in the caller's. A batch rewrites, set-based and
 * in place, only the rows of its lane that hold a removed key: one statement per store, whatever
 * the number of steps. A type's objects split into ranges of primary ids, fixed when the run
 * starts: objects and edits are keyed by `(project_id, object_type_id, primary_id)` in one
 * collation, so the ranges partition every object-keyed store alike, and lanes on connections of
 * their own never touch the same rows. Each lane's row is the lock and the progress of its
 * batches.
 */
export class PgOntologyMigrationStorage implements OntologyMigrationStorage {
  /**
   * Lanes applied side by side, one connection each, leaving one of the pool to anything else, up
   * to {@link MAX_PARALLELISM}.
   */
  readonly parallelism: number

  constructor(
    private readonly runRootOperation: PgRootOperation,
    poolSize: number
  ) {
    this.parallelism = Math.max(1, Math.min(MAX_PARALLELISM, poolSize - 1))
  }

  async getOpenRun(input: { readonly projectId: string }) {
    return this.runRootOperation(async (sql) => {
      const [row] = await sql<PgRunRow[]>`
        SELECT * FROM ontology_migration_runs
        WHERE project_id = ${input.projectId} AND status = 'applying'
      `
      return row ? runRecord(row, await lanes(sql, row)) : null
    })
  }

  async listSettled(input: { readonly projectId: string }): Promise<readonly SettledMigration[]> {
    return this.runRootOperation(async (sql) => {
      const rows = await sql<{ readonly object_type_id: string; readonly migration_id: string }[]>`
        SELECT object_type_id, migration_id FROM ontology_migrations_settled
        WHERE project_id = ${input.projectId}
        ORDER BY object_type_id, migration_id
      `
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
    await this.runRootOperation((sql) => settle(sql, input))
  }

  async startRun(input: StartOntologyMigrationRunInput): Promise<OntologyMigrationRunRecord> {
    const { projectId, plan } = input

    return this.runRootOperation(async (sql) => {
      const [open] = await sql<{ readonly id: string }[]>`
        SELECT id FROM ontology_migration_runs
        WHERE project_id = ${projectId} AND status = 'applying'
      `
      if (open) throw migrationRunAlreadyOpen(open.id)

      const objects = new Map<string, string[]>()
      const sources = new Map<string, string[]>()
      for (const { objectTypeId } of plan.types) {
        objects.set(objectTypeId, await objectBoundaries(sql, projectId, objectTypeId, input.parts))
        sources.set(objectTypeId, await sourceBoundaries(sql, projectId, objectTypeId, input.parts))
      }
      const run: OntologyMigrationRunRecord = {
        projectId,
        id: input.id,
        executionId: input.executionId,
        status: "applying",
        startedAt: input.startedAt,
        plan,
        lanes: migrationLanes(plan, { objects, sources }),
      }

      await sql`
        INSERT INTO ontology_migration_runs (project_id, id, execution_id, status, started_at, plan)
        VALUES (
          ${projectId}, ${run.id}, ${run.executionId}, 'applying', ${run.startedAt},
          ${json(sql, plan)}
        )
      `
      await sql`
        INSERT INTO ontology_migration_run_lanes (project_id, run_id, ordinal, lane, cursor, counts)
        SELECT ${projectId}, ${run.id}, lane.ordinal, lane.lane, lane.cursor, lane.counts
        FROM jsonb_to_recordset(${json(sql, run.lanes)})
          AS lane (ordinal integer, lane jsonb, cursor jsonb, counts jsonb)
      `

      // A type with data and no shape yet takes the baseline it starts from.
      for (const type of plan.types) {
        await sql`
          INSERT INTO ontology_type_shapes (project_id, object_type_id, shape, state, updated_at)
          VALUES (
            ${projectId}, ${type.objectTypeId}, ${json(sql, type.fromShape)}, 'migrating',
            ${run.startedAt}
          )
          ON CONFLICT (project_id, object_type_id)
          DO UPDATE SET state = 'migrating', previous_shape = NULL
        `
      }

      await dropMigratedQueryStructures(sql, plan)

      // Plans are caches, and one built before the run may hold a key it removes.
      const versions = await sql<{ readonly version_id: string }[]>`
        SELECT version_id FROM ontology_replacement_plans WHERE project_id = ${projectId}
      `
      const ids = versions.map((version) => version.version_id)
      if (ids.length > 0) {
        await sql`DELETE FROM ontology_replacement_plan_work WHERE work_id = ANY(${ids}::bigint[])`
        await sql`
          DELETE FROM ontology_replacement_plan_identities WHERE version_id = ANY(${ids}::bigint[])
        `
        await sql`DELETE FROM ontology_replacement_plans WHERE version_id = ANY(${ids}::bigint[])`
      }

      return run
    })
  }

  async applyBatch(input: ApplyOntologyMigrationBatchInput): Promise<OntologyMigrationLaneRecord> {
    return this.runRootOperation(async (sql) => {
      // The lane's row, locked until the transaction ends: a second applier waits, then sees it
      // moved. Other lanes go on beside it.
      const [lane] = await sql<PgLaneRow[]>`
        SELECT ordinal, lane, cursor, batches, counts FROM ontology_migration_run_lanes
        WHERE project_id = ${input.projectId} AND run_id = ${input.runId}
          AND ordinal = ${input.ordinal}
        FOR UPDATE
      `
      const [run] = await sql<
        { readonly status: string; readonly plan: OntologyMigrationRunPlan }[]
      >`
        SELECT status, plan FROM ontology_migration_runs
        WHERE project_id = ${input.projectId} AND id = ${input.runId}
      `
      if (!lane || !run || run.status !== "applying" || lane.batches !== input.batches) {
        throw migrationBatchConflict(input.runId)
      }
      if (!lane.cursor) throw migrationBatchConflict(input.runId)

      const outcome = await applyLane(sql, run.plan, lane.lane, lane.cursor, input)
      const next: OntologyMigrationLaneRecord = {
        ordinal: lane.ordinal,
        lane: lane.lane,
        cursor: outcome.cursor,
        batches: lane.batches + 1,
        counts: addMigrationCounts(lane.counts, outcome.counts),
      }

      await sql`
        UPDATE ontology_migration_run_lanes
        SET cursor = ${next.cursor ? json(sql, next.cursor) : null}, batches = ${next.batches},
          counts = ${json(sql, next.counts)}
        WHERE project_id = ${input.projectId} AND run_id = ${input.runId}
          AND ordinal = ${input.ordinal}
      `
      return next
    })
  }

  async finishRun(input: {
    readonly projectId: string
    readonly runId: string
    readonly appliedAt: string
  }): Promise<OntologyMigrationRunRecord> {
    const finished = await this.runRootOperation(async (sql) => {
      const [row] = await sql<PgRunRow[]>`
        SELECT * FROM ontology_migration_runs
        WHERE project_id = ${input.projectId} AND id = ${input.runId}
        FOR UPDATE
      `
      const all = row ? await lanes(sql, row) : []
      if (!row || row.status !== "applying" || all.some((lane) => lane.cursor !== null)) {
        throw migrationBatchConflict(input.runId)
      }

      for (const type of row.plan.types) {
        await sql`
          UPDATE ontology_type_shapes
          SET shape = ${json(sql, type.toShape)}, previous_shape = NULL, state = 'current',
            updated_at = ${input.appliedAt}
          WHERE project_id = ${row.project_id} AND object_type_id = ${type.objectTypeId}
        `
      }
      await settle(sql, {
        projectId: row.project_id,
        migrations: row.plan.types.flatMap((type) =>
          type.steps.map((step) => ({
            objectTypeId: type.objectTypeId,
            migrationId: step.migrationId,
          }))
        ),
        settledAt: input.appliedAt,
      })
      await sql`
        UPDATE ontology_migration_runs SET status = 'applied', applied_at = ${input.appliedAt}
        WHERE project_id = ${row.project_id} AND id = ${row.id}
      `

      return { ...runRecord(row, all), status: "applied" as const, appliedAt: input.appliedAt }
    })

    // The rewritten rows changed the tables' statistics: refresh those of what the run touched.
    // The run is applied already, so a failure here only leaves the planner older statistics.
    try {
      await this.runRootOperation(async (sql) => {
        const partitions = finished.plan.types.map((type) => objectPartitionName(type.objectTypeId))
        const [existing] = await sql<{ readonly names: string[] }[]>`
          SELECT coalesce(array_agg(name), '{}') AS names FROM unnest(${partitions}::text[]) AS name
          WHERE to_regclass(name) IS NOT NULL
        `
        const tables = [
          ...(existing?.names ?? []),
          "ontology_object_overrides",
          "ontology_source_rows",
        ]
        await sql.unsafe(`ANALYZE ${tables.map((table) => `"${table}"`).join(", ")}`)
      })
    } catch (error) {
      console.warn(
        `[SixbPg] Migration run ${finished.id} is applied, but analyzing the tables it rewrote ` +
          `failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    return finished
  }
}

async function lanes(sql: SQLClient, run: PgRunRow): Promise<OntologyMigrationLaneRecord[]> {
  const rows = await sql<PgLaneRow[]>`
    SELECT ordinal, lane, cursor, batches, counts FROM ontology_migration_run_lanes
    WHERE project_id = ${run.project_id} AND run_id = ${run.id}
    ORDER BY ordinal
  `
  return rows.map((row) => ({ ...row, batches: Number(row.batches) }))
}

/** Up to `parts - 1` primary ids splitting the type's objects into ranges of about equal size. */
async function objectBoundaries(
  sql: SQLClient,
  projectId: string,
  objectTypeId: string,
  parts: number
): Promise<string[]> {
  if (parts <= 1) return []

  const percent = await samplePercent(sql, objectPartitionName(objectTypeId), parts)
  const [row] = await sql<{ readonly boundaries: string[] | null }[]>`
    SELECT percentile_disc(${fractions(parts)}::float8[]) WITHIN GROUP (ORDER BY primary_id)
      AS boundaries
    FROM objects TABLESAMPLE SYSTEM (${percent})
    WHERE project_id = ${projectId} AND object_type_id = ${objectTypeId}
  `
  return distinct(row?.boundaries)
}

/** Up to `parts - 1` root keys splitting the type's source roots, across versions, alike. */
async function sourceBoundaries(
  sql: SQLClient,
  projectId: string,
  objectTypeId: string,
  parts: number
): Promise<string[]> {
  if (parts <= 1) return []

  const percent = await samplePercent(sql, "ontology_source_roots", parts)
  const [row] = await sql<{ readonly boundaries: string[] | null }[]>`
    SELECT percentile_disc(${fractions(parts)}::float8[]) WITHIN GROUP (ORDER BY root_key)
      AS boundaries
    FROM ontology_source_roots TABLESAMPLE SYSTEM (${percent})
    WHERE project_id = ${projectId}
      AND root_key >= ${rootKeyPrefix(objectTypeId)} AND root_key < ${rootKeyEnd(objectTypeId)}
  `
  return distinct(row?.boundaries)
}

/**
 * The share of a table's pages to sample for enough keys per range: from its rows as analyzed, or
 * from its size when it never was, as after a bulk load. The boundaries are computed in SQL, so a
 * large sample costs reads, never rows sent back.
 */
async function samplePercent(sql: SQLClient, table: string, parts: number): Promise<number> {
  const [estimate] = await sql<{ readonly rows: number | null; readonly pages: string | null }[]>`
    SELECT reltuples AS rows, pg_relation_size(oid) / 8192 AS pages FROM pg_class
    WHERE oid = to_regclass(${table})
  `
  const analyzed = Number(estimate?.rows ?? -1)
  const rows = analyzed > 0 ? analyzed : Number(estimate?.pages ?? 0) * MIN_ROWS_PER_PAGE
  return rows > 0 ? Math.min(100, (100 * SAMPLE_ROWS_PER_RANGE * parts) / rows) : 100
}

/** `[1/parts, 2/parts, …]`, the fractions whose keys end each range but the last. */
function fractions(parts: number): number[] {
  return Array.from({ length: parts - 1 }, (_, index) => (index + 1) / parts)
}

function distinct(keys: readonly string[] | null | undefined): string[] {
  return (keys ?? []).filter((key, index, all) => key !== null && key !== all[index - 1])
}

function applyLane(
  sql: SQLClient,
  plan: OntologyMigrationRunPlan,
  lane: OntologyMigrationLane,
  cursor: OntologyMigrationLaneCursor,
  input: ApplyOntologyMigrationBatchInput
): Promise<LaneOutcome> {
  switch (cursor.kind) {
    case "objects":
      return applyObjects(sql, plan, lane, cursor, input)
    case "sources":
      return applySources(sql, plan, lane, cursor, input)
    case "derived":
      return applyDerived(sql, plan, lane.objectTypeId, cursor, input)
  }
}

/** A range's end, when the lane has one. */
function laneThrough(lane: OntologyMigrationLane): string | undefined {
  return "through" in lane ? lane.through : undefined
}

/**
 * One batch of the lane's range: up to `batchRows` objects and edits after the cursor, ending at
 * the lower of the two last keys, or at the range's end on its last batch. Objects, edits and the
 * vectors whose source held a key go in one statement, after the vectors of moved profiles, then
 * the links of removed links; the commit follows only when an object or an edit changed. No
 * touch: `startRun` dropped every plan that would read one.
 */
async function applyObjects(
  sql: SQLClient,
  plan: OntologyMigrationRunPlan,
  lane: OntologyMigrationLane,
  cursor: Extract<OntologyMigrationLaneCursor, { kind: "objects" }>,
  input: ApplyOntologyMigrationBatchInput
): Promise<LaneOutcome> {
  const { projectId } = input
  const type = migrationRunType(plan, lane.objectTypeId)
  const compiled = compileMigrationSteps(type)
  const through = laneThrough(lane)
  const ofType = sql`project_id = ${projectId} AND object_type_id = ${type.objectTypeId}`
  const offset = input.batchRows - 1

  const [bound] = await sql<{ readonly through: string | null }[]>`
    SELECT LEAST(
      (SELECT primary_id FROM objects
       WHERE ${ofType} ${within(sql, "primary_id", cursor.afterPrimaryId, through)}
       ORDER BY primary_id OFFSET ${offset} LIMIT 1),
      (SELECT primary_id FROM ontology_object_overrides
       WHERE ${ofType} ${within(sql, "primary_id", cursor.afterPrimaryId, through)}
       ORDER BY primary_id OFFSET ${offset} LIMIT 1)
    ) AS through
  `
  const last = bound?.through ?? undefined
  const range = (column: string) => within(sql, column, cursor.afterPrimaryId, last ?? through)
  const batch = sql`${ofType} ${range("primary_id")}`

  // Before the objects: a moved vector, or queued indexing, is checked against the values it was
  // built or asked for.
  const moved =
    (await moveVectors(sql, projectId, type, batch)) +
    (await moveIndexingWork(sql, projectId, type, batch))
  const { objects, edits, vectors } = await rewriteObjects(sql, input, compiled, batch)
  const links = await deleteLinks(sql, projectId, type.objectTypeId, compiled, range)
  if (objects + edits > 0) await insertPgRuntimeCommit(sql, input.commit)

  return {
    counts: { objects, edits, links, vectors: vectors + moved },
    cursor: last === undefined ? null : { kind: "objects", afterPrimaryId: last },
  }
}

/** `AND column > after AND column <= through`, either bound left out when absent. */
function within(
  sql: SQLClient,
  column: string,
  after: string | undefined,
  through: string | undefined
): Fragment {
  return sql`
    ${after === undefined ? sql`` : sql`AND ${sql(column)} > ${after}`}
    ${through === undefined ? sql`` : sql`AND ${sql(column)} <= ${through}`}
  `
}

/** Objects and edits that hold a key, and the vectors whose source held one. */
async function rewriteObjects(
  sql: SQLClient,
  input: ApplyOntologyMigrationBatchInput,
  compiled: CompiledMigrationSteps,
  range: Fragment
): Promise<{ readonly objects: number; readonly edits: number; readonly vectors: number }> {
  if (compiled.keys.length === 0) return { objects: 0, edits: 0, vectors: 0 }

  const keys = sql`${compiled.keys}::text[]`
  const value = (path: string) => sql`(value -> ${path})`

  const [row] = await sql<
    { readonly objects: string; readonly edits: string; readonly vectors: string }[]
  >`
    WITH objects_changed AS (
      UPDATE objects
      SET properties = ${moved(sql, sql`properties`, compiled)}, version = version + 1,
        last_commit_id = ${input.commit.id}
      WHERE ${range} AND properties ?| ${keys}
      RETURNING 1
    ), edits_changed AS (
      UPDATE ontology_object_overrides
      SET value = CASE value ->> 'kind'
          WHEN 'create' THEN
            jsonb_set(value, '{properties}', ${moved(sql, value("properties"), compiled)})
          WHEN 'patch' THEN jsonb_set(
            jsonb_set(value, '{set}', ${moved(sql, value("set"), compiled)}),
            '{unset}', ${movedList(sql, value("unset"), compiled)}
          )
          ELSE value
        END,
        edited_at = ${moved(sql, sql`edited_at`, compiled)},
        last_commit_id = ${input.commit.id}
      WHERE ${range}
        AND (value -> 'properties' ?| ${keys} OR value -> 'set' ?| ${keys}
          OR value -> 'unset' ?| ${keys} OR edited_at ?| ${keys})
      RETURNING 1
    ), vectors_dropped AS (
      DELETE FROM object_vectors WHERE ${range} AND source && ${keys}
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM objects_changed) AS objects,
      (SELECT count(*) FROM edits_changed) AS edits,
      (SELECT count(*) FROM vectors_dropped) AS vectors
  `

  return {
    objects: Number(row?.objects ?? 0),
    edits: Number(row?.edits ?? 0),
    vectors: Number(row?.vectors ?? 0),
  }
}

/**
 * The batch's vectors of a moved profile: their fingerprint hashes key names, so it is computed
 * again here, from the values the object holds before the batch, for these rows only. A vector
 * that no longer matches them is left for the delete that follows.
 */
async function moveVectors(
  sql: SQLClient,
  projectId: string,
  type: OntologyMigrationRunType,
  range: Fragment
): Promise<number> {
  const moves = type.vectors ?? []
  if (moves.length === 0) return 0

  const rows = await sql<
    {
      readonly primary_id: string
      readonly profile: string
      readonly source_fingerprint: string
      readonly properties: Readonly<Record<string, unknown>>
    }[]
  >`
    SELECT vectors.primary_id, vectors.profile, vectors.source_fingerprint, objects.properties
    FROM object_vectors AS vectors
    JOIN objects USING (project_id, object_type_id, primary_id)
    JOIN unnest(
      ${moves.map((move) => move.profile)}::text[],
      ${moves.map((move) => move.fromConfiguration)}::text[]
    ) AS moved (profile, configuration)
      ON moved.profile = vectors.profile AND moved.configuration = vectors.configuration
    WHERE vectors.${range}
  `

  const updates = rows.flatMap((row) => {
    const move = moves.find((candidate) => candidate.profile === row.profile)!
    const fingerprint = movedVectorFingerprint(move, row.source_fingerprint, row.properties)
    return fingerprint === null ? [] : [{ ...row, move, fingerprint }]
  })
  if (updates.length === 0) return 0

  await sql`
    UPDATE object_vectors AS vectors
    SET source = moved.source::text[], configuration = moved.configuration,
      source_fingerprint = moved.fingerprint
    FROM jsonb_to_recordset(${json(
      sql,
      updates.map((update) => ({
        primary_id: update.primary_id,
        profile: update.profile,
        configuration: update.move.toConfiguration,
        source: `{${update.move.toSource.map((id) => JSON.stringify(id)).join(",")}}`,
        fingerprint: update.fingerprint,
      }))
    )}) AS moved (primary_id text, profile text, configuration text, source text, fingerprint text)
    WHERE vectors.project_id = ${projectId} AND vectors.object_type_id = ${type.objectTypeId}
      AND vectors.primary_id = moved.primary_id AND vectors.profile = moved.profile
  `
  return updates.length
}

/**
 * The batch's queued indexing of a moved profile, asked for under the old keys: it takes the
 * profile's new configuration and the fingerprint of the same values under the new keys, or goes
 * when its object no longer holds the values it was asked for.
 */
async function moveIndexingWork(
  sql: SQLClient,
  projectId: string,
  type: OntologyMigrationRunType,
  range: Fragment
): Promise<number> {
  const moves = type.vectors ?? []
  if (moves.length === 0) return 0

  const rows = await sql<
    {
      readonly id: string
      readonly profile: string
      readonly source_fingerprint: string
      readonly properties: Readonly<Record<string, unknown>>
    }[]
  >`
    SELECT work.id, work.profile, work.request ->> 'sourceFingerprint' AS source_fingerprint,
      objects.properties
    FROM object_vector_indexing AS work
    JOIN objects USING (project_id, object_type_id, primary_id)
    JOIN unnest(
      ${moves.map((move) => move.profile)}::text[],
      ${moves.map((move) => move.fromConfiguration)}::text[]
    ) AS moved (profile, configuration)
      ON moved.profile = work.profile AND moved.configuration = work.request ->> 'configuration'
    WHERE work.${range}
  `
  if (rows.length === 0) return 0

  const kept: { id: string; configuration: string; fingerprint: string }[] = []
  const dropped: string[] = []
  for (const row of rows) {
    const move = moves.find((candidate) => candidate.profile === row.profile)!
    const fingerprint = movedVectorFingerprint(move, row.source_fingerprint, row.properties)
    if (fingerprint) kept.push({ id: row.id, configuration: move.toConfiguration, fingerprint })
    else dropped.push(row.id)
  }

  await sql`
    UPDATE object_vector_indexing AS work
    SET request = work.request || jsonb_build_object(
      'configuration', moved.configuration, 'sourceFingerprint', moved.fingerprint
    )
    FROM jsonb_to_recordset(${json(sql, kept)}) AS moved (id text, configuration text, fingerprint text)
    WHERE work.project_id = ${projectId} AND work.id = moved.id
  `
  await sql`
    DELETE FROM object_vector_indexing WHERE project_id = ${projectId} AND id = ANY(${dropped})
  `
  return rows.length
}

/** The batch's links of a removed link, by source, and their edits: edges and every slot. */
async function deleteLinks(
  sql: SQLClient,
  projectId: string,
  objectTypeId: string,
  compiled: CompiledMigrationSteps,
  range: (column: string) => Fragment
): Promise<number> {
  if (compiled.removedLinkIds.length === 0) return 0

  const ofLink = sql`
    project_id = ${projectId} AND source_type_id = ${objectTypeId}
    AND link_id = ANY(${compiled.removedLinkIds}::text[])
  `
  const [row] = await sql<{ readonly links: string }[]>`
    WITH links_deleted AS (
      DELETE FROM links WHERE ${ofLink} ${range("source_id")} RETURNING 1
    ), edits_deleted AS (
      DELETE FROM ontology_link_overrides WHERE ${ofLink} ${range("source_primary_id")}
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM links_deleted) + (SELECT count(*) FROM edits_deleted) AS links
  `
  return Number(row?.links ?? 0)
}

/**
 * Up to `batchRows` unique values, then artifact refs, of the removed and renamed properties, each
 * in its key order after the cursor, then source rows of removed links. A renamed property's refs
 * move to its new id; its unique values move when the plan says they compare as the new id's do,
 * and go otherwise, to be built after the run. The properties' preparation follows with the last
 * unique values.
 */
async function applyDerived(
  sql: SQLClient,
  plan: OntologyMigrationRunPlan,
  objectTypeId: string,
  cursor: Extract<OntologyMigrationLaneCursor, { kind: "derived" }>,
  input: ApplyOntologyMigrationBatchInput
): Promise<LaneOutcome> {
  const { projectId, batchRows } = input
  const compiled = compileMigrationSteps(migrationRunType(plan, objectTypeId))
  const ofType = sql`project_id = ${projectId} AND object_type_id = ${objectTypeId}`
  const [first, second, third] = cursor.after ?? []

  if (cursor.store === "sourceLinks") {
    return deleteSourceLinks(sql, projectId, objectTypeId, compiled, cursor.after?.[0], batchRows)
  }

  if (cursor.store === "uniqueValues") {
    return applyUniqueValues(sql, ofType, compiled, cursor.after, batchRows)
  }

  // Refs are keyed by artifact first: the batch walks the project's refs in key order once.
  const renames = compiled.renames
  const after =
    first === undefined
      ? sql``
      : sql`AND (artifact_id, object_type_id, primary_id, property_id)
          > (${first}, ${objectTypeId}, ${second!}, ${third!})`
  const rows = await sql<
    { readonly artifact_id: string; readonly primary_id: string; readonly property_id: string }[]
  >`
    WITH batch AS MATERIALIZED (
      SELECT artifact_id, primary_id, property_id FROM object_artifact_refs
      WHERE ${ofType} AND property_id = ANY(${compiled.keys}::text[]) ${after}
      ORDER BY artifact_id, object_type_id, primary_id, property_id
      LIMIT ${batchRows}
    ), moved AS (
      UPDATE object_artifact_refs AS stored SET property_id = renamed.to_id
      FROM batch JOIN unnest(
        ${renames.map((rename) => rename.from)}::text[], ${renames.map((rename) => rename.to)}::text[]
      ) AS renamed (from_id, to_id) ON renamed.from_id = batch.property_id
      WHERE stored.project_id = ${projectId} AND stored.artifact_id = batch.artifact_id
        AND stored.object_type_id = ${objectTypeId} AND stored.primary_id = batch.primary_id
        AND stored.property_id = batch.property_id
    ), dropped AS (
      DELETE FROM object_artifact_refs AS stored USING batch
      WHERE stored.project_id = ${projectId} AND stored.artifact_id = batch.artifact_id
        AND stored.object_type_id = ${objectTypeId} AND stored.primary_id = batch.primary_id
        AND stored.property_id = batch.property_id
        AND batch.property_id = ANY(${compiled.removedPropertyIds}::text[])
    )
    SELECT artifact_id, primary_id, property_id FROM batch
    ORDER BY artifact_id, primary_id, property_id
  `
  const counts = { artifactRefs: rows.length }
  const last = rows.at(-1)
  if (rows.length === batchRows && last) {
    return {
      counts,
      cursor: {
        kind: "derived",
        store: "artifactRefs",
        after: [last.artifact_id, last.primary_id, last.property_id],
      },
    }
  }

  const links = compiled.removedLinkIds.length > 0
  return { counts, cursor: links ? { kind: "derived", store: "sourceLinks" } : null }
}

/**
 * One batch of the unique values of the removed and renamed properties: moved to a rename's new
 * id when the plan moves them, deleted otherwise. The first batch picks the walk, which the cursor
 * then carries:
 *
 * - `pages`: up to the table's size at the first batch, in ranges of heap pages sized to
 *   `batchRows`, so each page is read once; what a rewrite of the table moved below the cursor
 *   is then walked by key. Values in `value_hash` order lie on random pages, so
 *   a walk by key reads about one random page per value, and every page again and again.
 * - `values`: one property at a time in `value_hash` order, when the properties hold fewer values
 *   than a quarter of the table's pages: a walk by key then reads less than a walk of every page.
 *
 * The properties' preparation goes with the last batch.
 */
async function applyUniqueValues(
  sql: SQLClient,
  ofType: Fragment,
  compiled: CompiledMigrationSteps,
  cursorAfter: readonly string[] | undefined,
  batchRows: number
): Promise<LaneOutcome> {
  const moves = compiled.uniqueMoves
  let walk = cursorAfter

  if (walk === undefined) {
    // What a moved property's new id may already hold goes first, before any value moves there.
    if (moves.length > 0) {
      const toIds = moves.map((move) => move.to)
      await sql`DELETE FROM object_unique_values WHERE ${ofType} AND property_id = ANY(${toIds})`
      await sql`
        DELETE FROM object_unique_properties WHERE ${ofType} AND property_id = ANY(${toIds})
      `
    }
    walk = await firstUniqueWalk(sql, ofType, compiled)
  }

  const step =
    walk[0] === "pages"
      ? await uniqueValuesByPages(sql, ofType, compiled, walk, batchRows)
      : await uniqueValuesByProperty(sql, ofType, compiled, walk, batchRows)
  if (step.next) {
    return {
      counts: { uniqueValues: step.rows },
      cursor: { kind: "derived", store: "uniqueValues", after: step.next },
    }
  }

  await finishUniqueProperties(sql, ofType, compiled)
  return {
    counts: { uniqueValues: step.rows },
    cursor: { kind: "derived", store: "artifactRefs" },
  }
}

interface UniqueValuesStep {
  readonly rows: number
  /** The walk's next cursor, or none once every value moved or went. */
  readonly next?: readonly string[]
}

/** `pages` with the table's size, or `values` from the first property; counted only as needed. */
async function firstUniqueWalk(
  sql: SQLClient,
  ofType: Fragment,
  compiled: CompiledMigrationSteps
): Promise<readonly string[]> {
  const [size] = await sql<{ readonly pages: string }[]>`
    SELECT pg_relation_size('object_unique_values') / current_setting('block_size')::int AS pages
  `
  const pages = Number(size?.pages ?? 0)

  const enough = Math.ceil(pages / 4)
  const [held] = await sql<{ readonly values: string }[]>`
    SELECT count(*) AS values FROM (
      SELECT 1 FROM object_unique_values
      WHERE ${ofType} AND property_id = ANY(${compiled.keys}::text[])
      LIMIT ${enough}
    ) AS held
  `
  if (Number(held?.values ?? 0) >= enough) return ["pages", "0", String(pages)]
  return ["values", ...[...compiled.keys].sort().slice(0, 1)]
}

/** One range of heap pages, `[page, end)` bounding the walk. */
async function uniqueValuesByPages(
  sql: SQLClient,
  ofType: Fragment,
  compiled: CompiledMigrationSteps,
  walk: readonly string[],
  batchRows: number
): Promise<UniqueValuesStep> {
  const page = Number(walk[1])
  const end = Number(walk[2])
  if (page >= end) return { rows: 0 }

  const [density] = await sql<{ readonly rows_per_page: number | null }[]>`
    SELECT reltuples / NULLIF(relpages, 0) AS rows_per_page FROM pg_class
    WHERE oid = 'object_unique_values'::regclass
  `
  const pages = Math.max(1, Math.ceil(batchRows / Math.max(1, density?.rows_per_page ?? 100)))
  const through = Math.min(end, page + pages)
  const range = sql`ctid >= ${`(${page},0)`}::tid AND ctid < ${`(${through},0)`}::tid AND ${ofType}`
  const moves = compiled.uniqueMoves
  const fromIds = moves.map((move) => move.from)

  const [row] = await sql<{ readonly moved: string; readonly dropped: string }[]>`
    WITH moved AS (
      UPDATE object_unique_values SET property_id = renamed.to_id
      FROM unnest(${fromIds}::text[], ${moves.map((move) => move.to)}::text[])
        AS renamed (from_id, to_id)
      WHERE ${range} AND property_id = renamed.from_id
      RETURNING 1
    ), dropped AS (
      DELETE FROM object_unique_values
      WHERE ${range} AND property_id = ANY(${compiled.keys}::text[])
        AND property_id <> ALL(${fromIds}::text[])
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM moved) AS moved, (SELECT count(*) FROM dropped) AS dropped
  `
  const rows = Number(row?.moved ?? 0) + Number(row?.dropped ?? 0)
  if (through < end) return { rows, next: ["pages", String(through), String(end)] }
  return { rows, ...(await leftAfterPages(sql, ofType, compiled.keys)) }
}

/**
 * The walk by key for what a walk by page left: a table rewritten between two batches (`VACUUM
 * FULL`, `CLUSTER`, `pg_repack`, a restore) moves values not yet walked below the page cursor.
 * Read through the primary key, so a page walk that missed nothing costs one lookup.
 */
async function leftAfterPages(
  sql: SQLClient,
  ofType: Fragment,
  keys: readonly string[]
): Promise<{ readonly next?: readonly string[] }> {
  const [left] = await sql`
    SELECT 1 FROM object_unique_values
    WHERE ${ofType} AND property_id = ANY(${keys}::text[])
    LIMIT 1
  `
  return left ? { next: ["values", ...[...keys].sort().slice(0, 1)] } : {}
}

/**
 * One property's values in `value_hash` order after the cursor, then the next property's. One
 * property at a time, so the batch is a range of the primary key the index seeks:
 * `property_id = ANY(...)` would leave the bound on `value_hash` a filter, and every batch would
 * scan the values from the first again.
 */
async function uniqueValuesByProperty(
  sql: SQLClient,
  ofType: Fragment,
  compiled: CompiledMigrationSteps,
  walk: readonly string[],
  batchRows: number
): Promise<UniqueValuesStep> {
  const [, property, afterHash] = walk
  if (property === undefined) return { rows: 0 }

  const after = afterHash === undefined ? sql`` : sql`AND value_hash > decode(${afterHash}, 'hex')`
  const ofValues = sql`${ofType} AND property_id = ${property} ${after}`
  const [bound] = await sql<{ readonly value_hash: string }[]>`
    SELECT encode(value_hash, 'hex') AS value_hash FROM object_unique_values
    WHERE ${ofValues}
    ORDER BY value_hash OFFSET ${batchRows - 1} LIMIT 1
  `
  const range = sql`${ofValues} ${
    bound ? sql`AND value_hash <= decode(${bound.value_hash}, 'hex')` : sql``
  }`

  const move = compiled.uniqueMoves.find((candidate) => candidate.from === property)
  const [row] = move
    ? await sql<{ readonly count: string }[]>`
        WITH moved AS (
          UPDATE object_unique_values SET property_id = ${move.to} WHERE ${range} RETURNING 1
        )
        SELECT count(*) AS count FROM moved
      `
    : await sql<{ readonly count: string }[]>`
        WITH dropped AS (DELETE FROM object_unique_values WHERE ${range} RETURNING 1)
        SELECT count(*) AS count FROM dropped
      `
  const rows = Number(row?.count ?? 0)

  if (bound) return { rows, next: ["values", property, bound.value_hash] }
  const properties = [...compiled.keys].sort()
  const nextProperty = properties[properties.indexOf(property) + 1]
  return nextProperty === undefined ? { rows } : { rows, next: ["values", nextProperty] }
}

/** The properties' preparation, once their values moved or went: moved with them, or dropped. */
async function finishUniqueProperties(
  sql: SQLClient,
  ofType: Fragment,
  compiled: CompiledMigrationSteps
): Promise<void> {
  const moves = compiled.uniqueMoves
  const fromIds = moves.map((move) => move.from)

  await sql`
    WITH moved AS (
      UPDATE object_unique_properties AS stored SET property_id = renamed.to_id
      FROM unnest(${fromIds}::text[], ${moves.map((move) => move.to)}::text[])
        AS renamed (from_id, to_id)
      WHERE stored.${ofType} AND stored.property_id = renamed.from_id
    )
    DELETE FROM object_unique_properties
    WHERE ${ofType} AND property_id = ANY(${compiled.keys}::text[])
      AND property_id <> ALL(${fromIds}::text[])
  `
}

/**
 * The next source rows, of every version, of a removed link whose source is of the type: those of
 * the next `batchRows` source ids after the cursor, in the order of the link-source index
 * `(source_type_id, source_primary_id, link_id)`, and their versions' assertion counts with them.
 * The batch is a range of that index: a batch that only took the first rows left would walk past
 * every entry the batches before it deleted.
 */
async function deleteSourceLinks(
  sql: SQLClient,
  projectId: string,
  objectTypeId: string,
  compiled: CompiledMigrationSteps,
  after: string | undefined,
  batchRows: number
): Promise<LaneOutcome> {
  const ofLink = sql`
    rows.entity_kind = 'link' AND rows.source_type_id = ${objectTypeId}
    AND rows.link_id = ANY(${compiled.removedLinkIds}::text[])
  `
  const lower = after === undefined ? sql`` : sql`AND rows.source_primary_id > ${after}`

  // Read in the index alone: another project's rows only make a batch larger. The last batch
  // ends at the last id, so no statement leaves its upper bound open.
  const [bound] = await sql<{ readonly through: string | null; readonly last: boolean }[]>`
    SELECT COALESCE(next.source_primary_id, final.source_primary_id) AS through,
      next.source_primary_id IS NULL AS last
    FROM (SELECT max(source_primary_id) AS source_primary_id FROM ontology_source_rows AS rows
          WHERE ${ofLink} ${lower}) AS final
    LEFT JOIN (SELECT source_primary_id FROM ontology_source_rows AS rows
               WHERE ${ofLink} ${lower}
               ORDER BY source_primary_id OFFSET ${batchRows - 1} LIMIT 1) AS next ON true
  `
  if (!bound?.through) return { counts: {}, cursor: null }

  const [row] = await sql<{ readonly sources: string }[]>`
    WITH deleted AS (
      DELETE FROM ontology_source_rows AS rows USING ontology_source_roots AS roots
      WHERE ${ofLink} ${lower} AND rows.source_primary_id <= ${bound.through}
        AND roots.id = rows.root_id AND roots.project_id = ${projectId}
      RETURNING roots.version_id
    ), counted AS (
      UPDATE ontology_sources AS versions
      SET assertion_count = versions.assertion_count - removed.rows
      FROM (SELECT version_id, count(*) AS rows FROM deleted GROUP BY version_id) AS removed
      WHERE versions.version_id = removed.version_id
    )
    SELECT count(*) AS sources FROM deleted
  `

  const counts = { sources: Number(row?.sources ?? 0) }
  if (bound.last) return { counts, cursor: null }
  return { counts, cursor: { kind: "derived", store: "sourceLinks", after: [bound.through] } }
}

/**
 * Up to `batchRows` source roots of the lane's root-key range in one version, by root key, every
 * version in turn (active, candidates and retired, deletions included), found through
 * `(version_id, root_key)`. Their rows lose the keys from their values and from
 * `absentSourcePropertyIds`, renamed ones under their new id, and the list goes once empty, as a
 * staged row never holds an empty one.
 */
async function applySources(
  sql: SQLClient,
  plan: OntologyMigrationRunPlan,
  lane: OntologyMigrationLane,
  cursor: Extract<OntologyMigrationLaneCursor, { kind: "sources" }>,
  input: ApplyOntologyMigrationBatchInput
): Promise<LaneOutcome> {
  const { projectId, batchRows } = input
  const { objectTypeId } = lane
  const compiled = compileMigrationSteps(migrationRunType(plan, objectTypeId))
  if (compiled.keys.length === 0) return { counts: {}, cursor: null }

  const versionId = cursor.versionId ?? (await nextVersion(sql, projectId, undefined))
  if (versionId === undefined) return { counts: {}, cursor: null }

  const keys = sql`${compiled.keys}::text[]`
  const values = sql`jsonb_set(
    rows.payload, '{properties}',
    ${moved(sql, sql`COALESCE(rows.payload -> 'properties', '{}'::jsonb)`, compiled)}
  )`
  const absent = movedList(
    sql,
    sql`COALESCE(rows.payload -> 'absentSourcePropertyIds', '[]'::jsonb)`,
    compiled
  )
  const through = laneThrough(lane)
  const lower =
    cursor.afterRootKey === undefined
      ? sql`root_key >= ${rootKeyPrefix(objectTypeId)}`
      : sql`root_key > ${cursor.afterRootKey}`
  const upper =
    through === undefined
      ? sql`root_key < ${rootKeyEnd(objectTypeId)}`
      : sql`root_key <= ${through}`

  // The batch's roots are read once; their rows are found through the root index, by id.
  const [row] = await sql<
    { readonly roots: string; readonly last: string | null; readonly sources: string }[]
  >`
    WITH batch AS MATERIALIZED (
      SELECT id, root_key FROM ontology_source_roots
      WHERE version_id = ${versionId}::bigint AND ${lower} AND ${upper}
      ORDER BY root_key
      LIMIT ${batchRows}
    ), changed AS (
      UPDATE ontology_source_rows AS rows
      SET payload = CASE
        WHEN jsonb_array_length(${absent}) = 0 THEN ${values} - 'absentSourcePropertyIds'
        ELSE jsonb_set(${values}, '{absentSourcePropertyIds}', ${absent})
      END
      WHERE rows.root_id = ANY(ARRAY(SELECT id FROM batch))
        AND rows.entity_kind = 'object' AND rows.object_type_id = ${objectTypeId}
        AND (rows.payload -> 'properties' ?| ${keys}
          OR rows.payload -> 'absentSourcePropertyIds' ?| ${keys})
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM batch) AS roots, (SELECT max(root_key) FROM batch) AS last,
      (SELECT count(*) FROM changed) AS sources
  `

  const counts = { sources: Number(row?.sources ?? 0) }
  if (Number(row?.roots ?? 0) === batchRows && row?.last) {
    return { counts, cursor: { kind: "sources", versionId, afterRootKey: row.last } }
  }

  // The next version starts over at the lane's range.
  const next = await nextVersion(sql, projectId, versionId)
  if (next === undefined) return { counts, cursor: null }
  const start = "after" in lane && lane.after !== undefined ? { afterRootKey: lane.after } : {}
  return { counts, cursor: { kind: "sources", versionId: next, ...start } }
}

/** The project's next object source version after `after`, by id. */
async function nextVersion(
  sql: SQLClient,
  projectId: string,
  after: string | undefined
): Promise<string | undefined> {
  const [row] = await sql<{ readonly version_id: string | null }[]>`
    SELECT min(version_id)::text AS version_id FROM ontology_sources
    WHERE project_id = ${projectId} AND projection_kind = 'object'
      ${after === undefined ? sql`` : sql`AND version_id > ${after}::bigint`}
  `
  return row?.version_id ?? undefined
}

async function settle(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly migrations: readonly SettledMigration[]
    readonly settledAt: string
  }
): Promise<void> {
  if (input.migrations.length === 0) return

  await sql`
    INSERT INTO ontology_migrations_settled (project_id, object_type_id, migration_id, settled_at)
    SELECT ${input.projectId}, settled.object_type_id, settled.migration_id, ${input.settledAt}
    FROM unnest(
      ${input.migrations.map((migration) => migration.objectTypeId)}::text[],
      ${input.migrations.map((migration) => migration.migrationId)}::text[]
    ) AS settled (object_type_id, migration_id)
    ON CONFLICT DO NOTHING
  `
}

function runRecord(
  row: PgRunRow,
  laneRecords: readonly OntologyMigrationLaneRecord[]
): OntologyMigrationRunRecord {
  return {
    projectId: row.project_id,
    id: row.id,
    executionId: row.execution_id,
    status: row.status,
    startedAt: toIsoString(row.started_at),
    ...(row.applied_at === null ? {} : { appliedAt: toIsoString(row.applied_at) }),
    plan: row.plan,
    lanes: laneRecords,
  }
}

/**
 * A JSON object with the compiled keys dropped and each renamed value under its new id: only a
 * value the object holds moves, so an absent one doesn't become `null`.
 */
function moved(sql: SQLClient, column: Fragment, compiled: CompiledMigrationSteps): Fragment {
  let expression = sql`(${column} - ${compiled.keys}::text[])`
  for (const { from, to } of compiled.renames) {
    expression = sql`${expression} || CASE WHEN ${column} ? ${from}
      THEN jsonb_build_object(${to}::text, ${column} -> ${from}) ELSE '{}'::jsonb END`
  }
  return expression
}

/** A JSON array of property ids with the compiled keys dropped and renamed ones replaced. */
function movedList(sql: SQLClient, column: Fragment, compiled: CompiledMigrationSteps): Fragment {
  if (compiled.renames.length === 0) return sql`(${column} - ${compiled.keys}::text[])`

  return sql`(
    SELECT COALESCE(jsonb_agg(COALESCE(renamed.to_id, item.id) ORDER BY item.ordinal), '[]'::jsonb)
    FROM jsonb_array_elements_text(${column}) WITH ORDINALITY AS item (id, ordinal)
    LEFT JOIN unnest(
      ${compiled.renames.map((rename) => rename.from)}::text[],
      ${compiled.renames.map((rename) => rename.to)}::text[]
    ) AS renamed (from_id, to_id) ON renamed.from_id = item.id
    WHERE item.id <> ALL(${compiled.removedPropertyIds}::text[])
  )`
}
