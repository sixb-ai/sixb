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
import { objectPartitionName } from "../objects/partitions"
import type { SQL, SQLClient } from "../pg-client"
import { insertPgRuntimeCommit } from "./commits"
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
 * vectors whose source held a key go in one statement; the commit follows only when an object or
 * an edit changed. No touch: `startRun` dropped every plan that would read one.
 */
async function applyObjects(
  sql: SQLClient,
  plan: OntologyMigrationRunPlan,
  lane: OntologyMigrationLane,
  cursor: Extract<OntologyMigrationLaneCursor, { kind: "objects" }>,
  input: ApplyOntologyMigrationBatchInput
): Promise<LaneOutcome> {
  const { projectId } = input
  const type = lane.objectTypeId
  const through = laneThrough(lane)
  const keys = compileMigrationSteps(migrationRunType(plan, type)).removedPropertyIds
  const ofType = sql`project_id = ${projectId} AND object_type_id = ${type}`
  const after =
    cursor.afterPrimaryId === undefined ? sql`` : sql`AND primary_id > ${cursor.afterPrimaryId}`
  const until = (last: string | undefined) =>
    last === undefined ? sql`` : sql`AND primary_id <= ${last}`
  const offset = input.batchRows - 1

  const [bound] = await sql<{ readonly through: string | null }[]>`
    SELECT LEAST(
      (SELECT primary_id FROM objects WHERE ${ofType} ${after} ${until(through)}
       ORDER BY primary_id OFFSET ${offset} LIMIT 1),
      (SELECT primary_id FROM ontology_object_overrides WHERE ${ofType} ${after}
         ${until(through)}
       ORDER BY primary_id OFFSET ${offset} LIMIT 1)
    ) AS through
  `
  const last = bound?.through ?? undefined
  const range = sql`${ofType} ${after} ${until(last ?? through)}`
  const removed = sql`${keys}::text[]`

  const [row] = await sql<
    { readonly objects: string; readonly edits: string; readonly vectors: string }[]
  >`
    WITH objects_changed AS (
      UPDATE objects
      SET properties = properties - ${removed}, version = version + 1,
        last_commit_id = ${input.commit.id}
      WHERE ${range} AND properties ?| ${removed}
      RETURNING primary_id
    ), edits_changed AS (
      UPDATE ontology_object_overrides
      SET value = CASE value ->> 'kind'
          WHEN 'create' THEN jsonb_set(value, '{properties}', (value -> 'properties') - ${removed})
          WHEN 'patch' THEN jsonb_set(
            jsonb_set(value, '{set}', (value -> 'set') - ${removed}),
            '{unset}', (value -> 'unset') - ${removed}
          )
          ELSE value
        END,
        edited_at = edited_at - ${removed},
        last_commit_id = ${input.commit.id}
      WHERE ${range}
        AND (value -> 'properties' ?| ${removed} OR value -> 'set' ?| ${removed}
          OR value -> 'unset' ?| ${removed} OR edited_at ?| ${removed})
      RETURNING primary_id
    ), vectors_dropped AS (
      DELETE FROM object_vectors WHERE ${range} AND source && ${removed}
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM objects_changed) AS objects,
      (SELECT count(*) FROM edits_changed) AS edits,
      (SELECT count(*) FROM vectors_dropped) AS vectors
  `

  const counts = {
    objects: Number(row?.objects ?? 0),
    edits: Number(row?.edits ?? 0),
    vectors: Number(row?.vectors ?? 0),
  }
  if (counts.objects + counts.edits > 0) await insertPgRuntimeCommit(sql, input.commit)

  return { counts, cursor: last === undefined ? null : { kind: "objects", afterPrimaryId: last } }
}

/**
 * Up to `batchRows` unique values (see {@link applyUniqueValues}), then artifact refs in key order
 * after the cursor, of the removed properties.
 */
async function applyDerived(
  sql: SQLClient,
  plan: OntologyMigrationRunPlan,
  objectTypeId: string,
  cursor: Extract<OntologyMigrationLaneCursor, { kind: "derived" }>,
  input: ApplyOntologyMigrationBatchInput
): Promise<LaneOutcome> {
  const { projectId, batchRows } = input
  const keys = compileMigrationSteps(migrationRunType(plan, objectTypeId)).removedPropertyIds
  const ofProperty = sql`
    project_id = ${projectId} AND object_type_id = ${objectTypeId}
    AND property_id = ANY(${keys}::text[])
  `
  const [first, second, third] = cursor.after ?? []

  if (cursor.store === "uniqueValues") {
    const ofType = sql`project_id = ${projectId} AND object_type_id = ${objectTypeId}`
    return applyUniqueValues(sql, ofType, keys, cursor.after, batchRows)
  }

  // Refs are keyed by artifact first: the batch walks the project's refs in key order once.
  const after =
    first === undefined
      ? sql``
      : sql`AND (artifact_id, object_type_id, primary_id, property_id)
          > (${first}, ${objectTypeId}, ${second!}, ${third!})`
  const rows = await sql<
    { readonly artifact_id: string; readonly primary_id: string; readonly property_id: string }[]
  >`
    WITH doomed AS MATERIALIZED (
      SELECT artifact_id, primary_id, property_id FROM object_artifact_refs
      WHERE ${ofProperty} ${after}
      ORDER BY artifact_id, object_type_id, primary_id, property_id
      LIMIT ${batchRows}
    ), dropped AS (
      DELETE FROM object_artifact_refs AS stored USING doomed
      WHERE stored.project_id = ${projectId} AND stored.artifact_id = doomed.artifact_id
        AND stored.object_type_id = ${objectTypeId} AND stored.primary_id = doomed.primary_id
        AND stored.property_id = doomed.property_id
    )
    SELECT artifact_id, primary_id, property_id FROM doomed
    ORDER BY artifact_id, primary_id, property_id
  `
  const counts = { artifactRefs: rows.length }
  const last = rows.at(-1)
  if (rows.length < batchRows || !last) return { counts, cursor: null }

  return {
    counts,
    cursor: {
      kind: "derived",
      store: "artifactRefs",
      after: [last.artifact_id, last.primary_id, last.property_id],
    },
  }
}

/**
 * One batch of the unique values of the removed properties. The first batch picks the walk, which
 * the cursor then carries:
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
  keys: readonly string[],
  cursorAfter: readonly string[] | undefined,
  batchRows: number
): Promise<LaneOutcome> {
  const walk = cursorAfter ?? (await firstUniqueWalk(sql, ofType, keys))
  const step =
    walk[0] === "pages"
      ? await uniqueValuesByPages(sql, ofType, keys, walk, batchRows)
      : await uniqueValuesByProperty(sql, ofType, keys, walk, batchRows)
  if (step.next) {
    return {
      counts: { uniqueValues: step.rows },
      cursor: { kind: "derived", store: "uniqueValues", after: step.next },
    }
  }

  await sql`DELETE FROM object_unique_properties WHERE ${ofType} AND property_id = ANY(${keys}::text[])`
  return {
    counts: { uniqueValues: step.rows },
    cursor: { kind: "derived", store: "artifactRefs" },
  }
}

interface UniqueValuesStep {
  readonly rows: number
  /** The walk's next cursor, or none once every value went. */
  readonly next?: readonly string[]
}

/** `pages` with the table's size, or `values` from the first property; counted only as needed. */
async function firstUniqueWalk(
  sql: SQLClient,
  ofType: Fragment,
  keys: readonly string[]
): Promise<readonly string[]> {
  const [size] = await sql<{ readonly pages: string }[]>`
    SELECT pg_relation_size('object_unique_values') / current_setting('block_size')::int AS pages
  `
  const pages = Number(size?.pages ?? 0)

  const enough = Math.ceil(pages / 4)
  const [held] = await sql<{ readonly values: string }[]>`
    SELECT count(*) AS values FROM (
      SELECT 1 FROM object_unique_values
      WHERE ${ofType} AND property_id = ANY(${keys}::text[])
      LIMIT ${enough}
    ) AS held
  `
  if (Number(held?.values ?? 0) >= enough) return ["pages", "0", String(pages)]
  return ["values", ...[...keys].sort().slice(0, 1)]
}

/** One range of heap pages, `[page, end)` bounding the walk. */
async function uniqueValuesByPages(
  sql: SQLClient,
  ofType: Fragment,
  keys: readonly string[],
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

  const [row] = await sql<{ readonly dropped: string }[]>`
    WITH dropped AS (
      DELETE FROM object_unique_values
      WHERE ctid >= ${`(${page},0)`}::tid AND ctid < ${`(${through},0)`}::tid AND ${ofType}
        AND property_id = ANY(${keys}::text[])
      RETURNING 1
    )
    SELECT count(*) AS dropped FROM dropped
  `
  const rows = Number(row?.dropped ?? 0)
  if (through < end) return { rows, next: ["pages", String(through), String(end)] }
  return { rows, ...(await leftAfterPages(sql, ofType, keys)) }
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
  keys: readonly string[],
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

  const [row] = await sql<{ readonly dropped: string }[]>`
    WITH dropped AS (DELETE FROM object_unique_values WHERE ${range} RETURNING 1)
    SELECT count(*) AS dropped FROM dropped
  `
  const rows = Number(row?.dropped ?? 0)

  if (bound) return { rows, next: ["values", property, bound.value_hash] }
  const properties = [...keys].sort()
  const nextProperty = properties[properties.indexOf(property) + 1]
  return nextProperty === undefined ? { rows } : { rows, next: ["values", nextProperty] }
}

/**
 * Up to `batchRows` source roots of the lane's root-key range in one version, by root key, every
 * version in turn (active, candidates and retired, deletions included), found through
 * `(version_id, root_key)`. Their rows lose the keys from their values and from
 * `absentSourcePropertyIds`, which goes once empty, as a staged row never holds an empty one.
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
  const versionId = cursor.versionId ?? (await nextVersion(sql, projectId, undefined))
  if (versionId === undefined) return { counts: {}, cursor: null }

  const keys = compileMigrationSteps(migrationRunType(plan, objectTypeId)).removedPropertyIds
  const removed = sql`${keys}::text[]`
  const values = sql`jsonb_set(
    rows.payload, '{properties}', COALESCE(rows.payload -> 'properties', '{}'::jsonb) - ${removed}
  )`
  const absent = sql`COALESCE(rows.payload -> 'absentSourcePropertyIds', '[]'::jsonb) - ${removed}`
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
        AND (rows.payload -> 'properties' ?| ${removed}
          OR rows.payload -> 'absentSourcePropertyIds' ?| ${removed})
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
