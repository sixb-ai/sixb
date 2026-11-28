import type { Database, SQLQueryBindings } from "bun:sqlite"
import type { CompiledMigrationSteps } from "@sixb/core/internal/storage"
import type {
  ListMigrationValueTargetsInput,
  MigrationHeldUniqueProperty,
  MigrationUniqueCollision,
  OntologyMigrationCounts,
  OntologyMigrationLaneCursor,
  OntologyMigrationValueStorage,
  StagedObjectValues,
} from "@sixb/core/storage"
import type { SqliteRootOperation } from "./shared"

/**
 * What value steps add to a SQLite run: the staging table, the batches that apply it in place
 * and the unique values the derived lane updates from it. `migrations.ts` drives them.
 */

/** The staging of a run's value steps, each call in its own write transaction. */
export class SqliteOntologyMigrationValueStorage implements OntologyMigrationValueStorage {
  constructor(
    private readonly db: Database,
    private readonly runRootOperation: SqliteRootOperation
  ) {}

  async listValueTargets(input: ListMigrationValueTargetsInput) {
    return this.runRootOperation(() => listValueTargets(this.db, input))
  }

  async stageValues(input: Parameters<OntologyMigrationValueStorage["stageValues"]>[0]) {
    await this.runRootOperation(() => stageValues(this.db, input))
  }

  async findUniqueCollisions(
    input: Parameters<OntologyMigrationValueStorage["findUniqueCollisions"]>[0]
  ) {
    return this.runRootOperation(() => findUniqueCollisions(this.db, input))
  }

  async discardStaged(input: { readonly projectId: string; readonly runId: string }) {
    await this.runRootOperation(() => discardStaged(this.db, input))
  }
}

/** Staged rows inserted per statement, as one JSON array. */
const STAGE_CHUNK_ROWS = 1_000

const STAGED = "ontology_migration_staged_values"

/** A batch of a type's objects: `after` excluded, `through` included, either open when absent. */
export interface StagedRange {
  readonly projectId: string
  readonly objectTypeId: string
  readonly after?: string
  readonly through?: string
}

/** The range's staged rows, as `s`. */
function inRange(runId: string, range: StagedRange) {
  return {
    sql: `s.project_id = ? AND s.run_id = ? AND s.object_type_id = ?
      ${range.after === undefined ? "" : "AND s.primary_id > ?"}
      ${range.through === undefined ? "" : "AND s.primary_id <= ?"}`,
    params: [
      range.projectId,
      runId,
      range.objectTypeId,
      ...(range.after === undefined ? [] : [range.after]),
      ...(range.through === undefined ? [] : [range.through]),
    ] as SQLQueryBindings[],
  }
}

function listValueTargets(
  db: Database,
  input: ListMigrationValueTargetsInput
): { readonly primaryIds: readonly string[]; readonly nextPrimaryId?: string } {
  const { projectId, objectTypeId } = input
  const after = input.afterPrimaryId === undefined ? "" : "AND primary_id > ?"
  const afterParams = input.afterPrimaryId === undefined ? [] : [input.afterPrimaryId]

  // Qualified: inside `json_each(...)`, a bare `value` is json_each's own column.
  const holding = input.holding.map(quote).join(", ")
  const holds = ["$.properties", "$.set"].map(
    (path) => `EXISTS (SELECT 1 FROM json_each(ontology_object_overrides.value, '${path}') AS item
      WHERE item.key IN (${holding}))`
  )
  const clears = `EXISTS (SELECT 1 FROM json_each(ontology_object_overrides.value, '$.unset') AS item
    WHERE item.value IN (${input.clearing.map(quote).join(", ")}))`
  const edited = [
    ...(input.creates ? ["json_extract(value, '$.kind') = 'create'"] : []),
    ...(input.holding.length > 0 ? holds : []),
    ...(input.clearing.length > 0 ? [clears] : []),
  ]

  // Each part stops at its own page, so the union never reads past it.
  const parts = [
    `SELECT primary_id FROM ontology_object_overrides
     WHERE project_id = ? AND object_type_id = ? ${after} AND (${edited.join(" OR ") || "false"})`,
    ...(input.everyObject
      ? [`SELECT primary_id FROM objects WHERE project_id = ? AND object_type_id = ? ${after}`]
      : []),
  ].map((part) => `SELECT primary_id FROM (${part} ORDER BY primary_id LIMIT ?)`)
  const params = parts.flatMap(() => [projectId, objectTypeId, ...afterParams, input.limit])
  const rows = db
    .query(`SELECT primary_id FROM (${parts.join(" UNION ")}) ORDER BY primary_id LIMIT ?`)
    .all(...params, input.limit) as { readonly primary_id: string }[]

  const primaryIds = rows.map((row) => row.primary_id)
  return primaryIds.length === input.limit
    ? { primaryIds, nextPrimaryId: primaryIds.at(-1)! }
    : { primaryIds }
}

function stageValues(
  db: Database,
  input: {
    readonly projectId: string
    readonly runId: string
    readonly rows: readonly StagedObjectValues[]
  }
): void {
  const insert = db.query(
    `INSERT INTO ${STAGED} (project_id, run_id, object_type_id, primary_id, edits, edited_at,
       restored, effective, unique_keys, vectors)
     SELECT ?, ?, row.value ->> '$.objectTypeId', row.value ->> '$.primaryId',
       row.value -> '$.edits', row.value -> '$.editedAt', row.value -> '$.restored',
       row.value -> '$.effective', row.value -> '$.unique', row.value -> '$.vectors'
     FROM json_each(?) AS row`
  )

  for (let start = 0; start < input.rows.length; start += STAGE_CHUNK_ROWS) {
    const chunk = input.rows.slice(start, start + STAGE_CHUNK_ROWS)
    insert.run(input.projectId, input.runId, JSON.stringify(chunk))
  }
}

/** Deletes the staging of `runId`, or of every run but it when `others` is set. */
export function discardStaged(
  db: Database,
  input: { readonly projectId: string; readonly runId: string; readonly others?: true }
): void {
  db.query(
    `DELETE FROM ${STAGED} WHERE project_id = ? AND run_id ${input.others ? "<>" : "="} ?`
  ).run(input.projectId, input.runId)
}

function findUniqueCollisions(
  db: Database,
  input: {
    readonly projectId: string
    readonly runId: string
    readonly held: readonly MigrationHeldUniqueProperty[]
    readonly limit: number
  }
): MigrationUniqueCollision[] {
  const staged = `staged AS (
    SELECT s.object_type_id, k.key AS property_id, s.primary_id, k.value ->> '$.to' AS value_key
    FROM ${STAGED} AS s, json_each(s.unique_keys) AS k
    WHERE s.project_id = ? AND s.run_id = ? AND k.value ->> '$.to' IS NOT NULL
  )`
  type Row = Omit<MigrationUniqueCollision, "primaryIds" | "holder"> & {
    readonly ids: string
    readonly holder: string | null
  }

  const twice = db
    .query(
      `WITH ${staged}
       SELECT object_type_id AS objectTypeId, property_id AS propertyId, value_key AS valueKey,
         json_group_array(primary_id) AS ids, NULL AS holder
       FROM (SELECT * FROM staged ORDER BY primary_id)
       GROUP BY object_type_id, property_id, value_key HAVING count(*) > 1
       LIMIT ?`
    )
    .all(input.projectId, input.runId, input.limit) as Row[]

  // A value its holder keeps: the holder isn't staged with a key of that property. Until the
  // run, the values are under the id the objects store them by.
  const kept = db
    .query(
      `WITH ${staged}
       SELECT s.object_type_id AS objectTypeId, s.property_id AS propertyId,
         s.value_key AS valueKey, json_array(s.primary_id) AS ids, held.primary_id AS holder
       FROM staged AS s
       JOIN json_each(?) AS property
         ON property.value ->> '$.objectTypeId' = s.object_type_id
         AND property.value ->> '$.propertyId' = s.property_id
       JOIN object_unique_values AS held ON held.project_id = ?
         AND held.object_type_id = s.object_type_id
         AND held.property_id = property.value ->> '$.storedPropertyId'
         AND held.value_key = s.value_key AND held.primary_id <> s.primary_id
       WHERE NOT EXISTS (
           SELECT 1 FROM ${STAGED} AS releasing, json_each(releasing.unique_keys) AS k
           WHERE releasing.project_id = held.project_id AND releasing.run_id = ?
             AND releasing.object_type_id = held.object_type_id
             AND releasing.primary_id = held.primary_id AND k.key = s.property_id
         )
       ORDER BY s.primary_id
       LIMIT ?`
    )
    .all(
      input.projectId,
      input.runId,
      JSON.stringify(input.held),
      input.projectId,
      input.runId,
      input.limit
    ) as Row[]

  return [...twice, ...kept].slice(0, input.limit).map(({ ids, holder, ...collision }) => ({
    ...collision,
    primaryIds: JSON.parse(ids) as string[],
    ...(holder === null ? {} : { holder }),
  }))
}

/** The batch's last staged primary id, for a type whose steps only stage values. */
export function stagedBound(
  db: Database,
  runId: string,
  range: StagedRange,
  batchRows: number
): string | undefined {
  const staged = inRange(runId, range)
  const row = db
    .query(
      `SELECT primary_id FROM ${STAGED} AS s WHERE ${staged.sql}
       ORDER BY primary_id LIMIT 1 OFFSET ?`
    )
    .get(...staged.params, batchRows - 1) as { readonly primary_id: string } | null
  return row?.primary_id
}

/**
 * The batch's staged values, after its key steps: each edit takes its new values in place, each
 * object its new effective values, at one version more unless the key steps already bumped it in
 * this batch, and each vector whose source changed is queued for indexing.
 */
export function applyStagedObjects(
  db: Database,
  input: {
    readonly runId: string
    readonly compiled: CompiledMigrationSteps
    readonly range: StagedRange
    readonly commitId: string
    readonly committedAt: string
  }
): Partial<OntologyMigrationCounts> {
  const { runId, compiled, commitId } = input
  if (compiled.valuePropertyIds.length === 0) return {}

  const staged = `${STAGED} AS s`
  const { sql: inBatch, params } = inRange(runId, input.range)
  const sameObject = (alias: string) =>
    `${alias}.project_id = s.project_id AND ${alias}.object_type_id = s.object_type_id
     AND ${alias}.primary_id = s.primary_id`

  // Rows the key steps rewrote in this batch already count, and already went one version up.
  const rewritten = (table: string, values: string) =>
    compiled.keys.length === 0
      ? 0
      : (
          db
            .query(
              `SELECT count(*) AS rows FROM ${staged} JOIN ${table} AS o ON ${sameObject("o")}
               WHERE ${inBatch} AND s.${values} <> '{}' AND o.last_commit_id = ?`
            )
            .get(...params, commitId) as { readonly rows: number }
        ).rows

  const editsBefore = rewritten("ontology_object_overrides", "edits")
  const edits = db
    .query(
      `UPDATE ontology_object_overrides AS o
       SET value = CASE json_extract(o.value, '$.kind')
           WHEN 'create' THEN
             json_set(o.value, '$.properties', ${merge("o.value -> '$.properties'", "s.edits")})
           ELSE json_set(
             o.value,
             '$.set', ${merge("o.value -> '$.set'", "s.edits")},
             '$.unset', json((SELECT json_group_array(item.value) FROM json_each(o.value, '$.unset') AS item
               WHERE item.value NOT IN (SELECT restored.value FROM json_each(s.restored) AS restored)))
           )
         END,
         edited_at = ${merge("o.edited_at", "s.edited_at")},
         last_commit_id = ?
       FROM ${staged}
       WHERE ${inBatch} AND s.edits <> '{}' AND ${sameObject("o")}`
    )
    .run(commitId, ...params).changes

  const objectsBefore = rewritten("objects", "effective")
  const objects = db
    .query(
      `UPDATE objects AS o
       SET properties = ${merge("o.properties", "s.effective")},
         version = o.version + (o.last_commit_id IS NOT ?), last_commit_id = ?
       FROM ${staged}
       WHERE ${inBatch} AND s.effective <> '{}' AND ${sameObject("o")}`
    )
    .run(commitId, commitId, ...params).changes

  const vectors = db
    .query(
      `INSERT INTO object_vector_indexing (project_id, id, object_type_id, primary_id, profile,
         request, status, available_at, dispatch_at)
       SELECT s.project_id, vector.value ->> '$.id', s.object_type_id, s.primary_id,
         vector.value ->> '$.profile',
         json_set(vector.value,
           '$.ref', json_object('objectTypeId', s.object_type_id, 'primaryId', s.primary_id),
           '$.sourceCommitId', ?),
         'pending', ?, ?
       FROM ${staged}, json_each(s.vectors) AS vector
       WHERE ${inBatch} AND EXISTS (SELECT 1 FROM objects AS o WHERE ${sameObject("o")})
       ON CONFLICT (project_id, object_type_id, primary_id, profile) DO UPDATE SET
         id = excluded.id, batch_id = NULL, request = excluded.request, status = 'pending',
         available_at = excluded.available_at, dispatch_at = excluded.dispatch_at,
         values_json = NULL, error = NULL`
    )
    .run(commitId, input.committedAt, input.committedAt, ...params).changes

  return { objects: objects - objectsBefore, edits: edits - editsBefore, vectors }
}

/**
 * One batch of the unique values value steps change, for the properties prepared the way the
 * code compares them: every staged object's old key goes first, then each new one is claimed,
 * so two objects may swap values across batches. Each pass walks only the objects that have a key
 * to give up, or to take: a fill's pass of releases is empty. The cursor says which, and where.
 */
export function applyStagedUnique(
  db: Database,
  input: {
    readonly projectId: string
    readonly runId: string
    readonly objectTypeId: string
    readonly compiled: CompiledMigrationSteps
    readonly after: readonly string[] | undefined
    readonly batchRows: number
  }
): { readonly rows: number; readonly cursor: OntologyMigrationLaneCursor } {
  const { projectId, runId, objectTypeId, compiled, batchRows } = input
  const [pass = "release", afterPrimaryId] = input.after ?? []
  const key = pass === "release" ? "from" : "to"

  const batch = db
    .query(
      `SELECT json_group_array(primary_id) AS ids, count(*) AS rows, max(primary_id) AS last
       FROM (
         SELECT primary_id FROM ${STAGED}
         WHERE project_id = ? AND run_id = ? AND object_type_id = ?
           AND EXISTS (SELECT 1 FROM json_each(unique_keys) AS k WHERE k.value ->> '$.${key}' IS NOT NULL)
           ${afterPrimaryId === undefined ? "" : "AND primary_id > ?"}
         ORDER BY primary_id LIMIT ?
       )`
    )
    .get(
      projectId,
      runId,
      objectTypeId,
      ...(afterPrimaryId === undefined ? [] : [afterPrimaryId]),
      batchRows
    ) as { readonly ids: string; readonly rows: number; readonly last: string | null }

  const keys = `SELECT s.project_id, s.object_type_id, k.key AS property_id,
      k.value ->> '$.${key}' AS value_key, s.primary_id
    FROM ${STAGED} AS s, json_each(s.unique_keys) AS k
    WHERE s.project_id = ? AND s.run_id = ? AND s.object_type_id = ?
      AND s.primary_id IN (SELECT value FROM json_each(?))
      AND k.key IN (${compiled.uniqueUpdates.map(quote).join(", ")})
      AND k.value ->> '$.${key}' IS NOT NULL`
  const params = [projectId, runId, objectTypeId, batch.ids]
  const rows =
    pass === "release"
      ? db
          .query(
            `DELETE FROM object_unique_values
             WHERE (project_id, object_type_id, property_id, value_key, primary_id) IN (${keys})`
          )
          .run(...params).changes
      : db
          .query(
            `INSERT INTO object_unique_values (project_id, object_type_id, property_id, value_key,
               primary_id) ${keys}`
          )
          .run(...params).changes

  if (batch.rows === batchRows && batch.last !== null) {
    return { rows, cursor: { kind: "derived", store: "stagedUnique", after: [pass, batch.last] } }
  }
  if (pass === "release") {
    return { rows, cursor: { kind: "derived", store: "stagedUnique", after: ["claim"] } }
  }
  return { rows, cursor: { kind: "derived", store: "artifactRefs" } }
}

/**
 * The JSON object `column` with every key `from` holds set to its value there, in one flat
 * expression whatever their number: `json_patch` would drop the keys set to `null`, and merge
 * an object value into the old one.
 */
function merge(column: string, from: string): string {
  return `(SELECT json_group_object(item.key, CASE WHEN json_type(${from}, item.fullkey) IS NULL
      THEN ${column} -> item.fullkey ELSE ${from} -> item.fullkey END)
    FROM (SELECT key, fullkey FROM json_each(${column})
      UNION SELECT key, fullkey FROM json_each(${from})) AS item)`
}

/** A SQL string literal: property ids are definition data, never input, and few. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
