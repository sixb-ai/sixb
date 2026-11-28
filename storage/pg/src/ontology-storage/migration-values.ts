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
import { copyIn, copyText } from "../copy"
import type { SQL, SQLClient } from "../pg-client"
import type { PgRootOperation } from "./shared"

/**
 * What value steps add to a PostgreSQL run: the staging table, loaded with `COPY`, the batches
 * that apply it in place, set-based, and the unique values the derived lane updates from it.
 * `migrations.ts` drives them.
 */

type Fragment = ReturnType<SQL["unsafe"]>

/** The staging of a run's value steps, each call a transaction of its own or the caller's. */
export class PgOntologyMigrationValueStorage implements OntologyMigrationValueStorage {
  constructor(private readonly runRootOperation: PgRootOperation) {}

  async listValueTargets(input: ListMigrationValueTargetsInput) {
    return this.runRootOperation((sql) => listValueTargets(sql, input))
  }

  async stageValues(input: Parameters<OntologyMigrationValueStorage["stageValues"]>[0]) {
    await this.runRootOperation((sql) => stageValues(sql, input))
  }

  async findUniqueCollisions(
    input: Parameters<OntologyMigrationValueStorage["findUniqueCollisions"]>[0]
  ) {
    return this.runRootOperation((sql) => findUniqueCollisions(sql, input))
  }

  async discardStaged(input: { readonly projectId: string; readonly runId: string }) {
    await this.runRootOperation((sql) => discardStaged(sql, input))
  }
}

const STAGED_COLUMNS =
  "ontology_migration_staged_values (project_id, run_id, object_type_id, primary_id, edits, " +
  "edited_at, restored, effective, unique_keys, vectors)"

async function listValueTargets(
  sql: SQLClient,
  input: ListMigrationValueTargetsInput
): Promise<{ readonly primaryIds: readonly string[]; readonly nextPrimaryId?: string }> {
  const { projectId, objectTypeId, limit } = input
  const after =
    input.afterPrimaryId === undefined ? sql`` : sql`AND primary_id > ${input.afterPrimaryId}`
  const keys = sql`${input.holding}::text[]`

  const edits = sql`
    SELECT primary_id FROM ontology_object_overrides
    WHERE project_id = ${projectId} AND object_type_id = ${objectTypeId} ${after}
      AND (${input.creates ? sql`value ->> 'kind' = 'create'` : sql`false`}
        OR value -> 'properties' ?| ${keys} OR value -> 'set' ?| ${keys}
        OR value -> 'unset' ?| ${input.clearing}::text[])
    ORDER BY primary_id LIMIT ${limit}
  `
  const objects = sql`
    SELECT primary_id FROM objects
    WHERE project_id = ${projectId} AND object_type_id = ${objectTypeId} ${after}
    ORDER BY primary_id LIMIT ${limit}
  `
  const rows = await sql<{ readonly primary_id: string }[]>`
    SELECT primary_id FROM (
      (${edits}) ${input.everyObject ? sql`UNION (${objects})` : sql``}
    ) AS targets
    ORDER BY primary_id LIMIT ${limit}
  `

  const primaryIds = rows.map((row) => row.primary_id)
  return primaryIds.length === limit
    ? { primaryIds, nextPrimaryId: primaryIds.at(-1)! }
    : { primaryIds }
}

/** The rows, in one `COPY`: the fastest load PostgreSQL has. */
async function stageValues(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly runId: string
    readonly rows: readonly StagedObjectValues[]
  }
): Promise<void> {
  if (input.rows.length === 0) return

  let text = ""
  for (const row of input.rows) {
    const columns = [
      input.projectId,
      input.runId,
      row.objectTypeId,
      row.primaryId,
      JSON.stringify(row.edits),
      JSON.stringify(row.editedAt),
      JSON.stringify(row.restored),
      JSON.stringify(row.effective),
      JSON.stringify(row.unique),
      JSON.stringify(row.vectors),
    ]
    text += `${columns.map(copyText).join("\t")}\n`
  }

  await copyIn(sql, `COPY ${STAGED_COLUMNS} FROM STDIN`, [text])
}

/** Deletes the staging of `runId`, or of every run but it when `others` is set. */
export async function discardStaged(
  sql: SQLClient,
  input: { readonly projectId: string; readonly runId: string; readonly others?: true }
): Promise<void> {
  await sql`
    DELETE FROM ontology_migration_staged_values
    WHERE project_id = ${input.projectId}
      AND ${input.others ? sql`run_id <> ${input.runId}` : sql`run_id = ${input.runId}`}
  `
}

async function findUniqueCollisions(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly runId: string
    readonly held: readonly MigrationHeldUniqueProperty[]
    readonly limit: number
  }
): Promise<MigrationUniqueCollision[]> {
  const { projectId, runId, limit } = input
  const staged = sql`
    SELECT staged.object_type_id, keys.key AS property_id, staged.primary_id,
      keys.value ->> 'to' AS value_key
    FROM ontology_migration_staged_values AS staged
    CROSS JOIN LATERAL jsonb_each(staged.unique_keys) AS keys
    WHERE staged.project_id = ${projectId} AND staged.run_id = ${runId}
      AND keys.value ->> 'to' IS NOT NULL
  `
  type Row = {
    readonly object_type_id: string
    readonly property_id: string
    readonly value_key: string
    readonly primary_ids: string[]
    readonly holder: string | null
  }

  const twice = await sql<Row[]>`
    WITH staged AS MATERIALIZED (${staged})
    SELECT object_type_id, property_id, value_key,
      array_agg(primary_id ORDER BY primary_id) AS primary_ids, NULL AS holder
    FROM staged
    GROUP BY object_type_id, property_id, value_key HAVING count(*) > 1
    ORDER BY min(primary_id)
    LIMIT ${limit}
  `

  // A value its holder keeps: the holder isn't staged with a key of that property.
  const kept =
    input.held.length === 0
      ? []
      : await sql<Row[]>`
          WITH staged AS MATERIALIZED (
            SELECT staged.*, held.stored_property_id FROM (${staged}) AS staged
            JOIN unnest(
              ${input.held.map((property) => property.objectTypeId)}::text[],
              ${input.held.map((property) => property.propertyId)}::text[],
              ${input.held.map((property) => property.storedPropertyId)}::text[]
            ) AS held (object_type_id, property_id, stored_property_id)
              ON held.object_type_id = staged.object_type_id
              AND held.property_id = staged.property_id
          )
          SELECT staged.object_type_id, staged.property_id, staged.value_key,
            ARRAY[staged.primary_id] AS primary_ids, stored.primary_id AS holder
          FROM staged
          -- Until the run, the values are under the id the objects store them by. A lateral
          -- lookup by the whole primary key keeps the planner on the index.
          CROSS JOIN LATERAL (
            SELECT stored.primary_id FROM object_unique_values AS stored
            WHERE stored.project_id = ${projectId} AND stored.object_type_id = staged.object_type_id
              AND stored.property_id = staged.stored_property_id
              AND stored.value_hash = sha256(convert_to(staged.value_key, 'UTF8'))
              AND stored.value_key = staged.value_key
            LIMIT 1
          ) AS stored
          WHERE stored.primary_id <> staged.primary_id AND NOT EXISTS (
            SELECT 1 FROM ontology_migration_staged_values AS releasing
            WHERE releasing.project_id = ${projectId} AND releasing.run_id = ${runId}
              AND releasing.object_type_id = staged.object_type_id
              AND releasing.primary_id = stored.primary_id
              AND releasing.unique_keys ? staged.property_id
          )
          ORDER BY staged.primary_id
          LIMIT ${limit}
        `

  return [...twice, ...kept].slice(0, limit).map((row) => ({
    objectTypeId: row.object_type_id,
    propertyId: row.property_id,
    valueKey: row.value_key,
    primaryIds: row.primary_ids,
    ...(row.holder === null ? {} : { holder: row.holder }),
  }))
}

/** The batch's last staged primary id, for a type whose steps only stage values. */
export async function stagedBound(
  sql: SQLClient,
  input: { readonly projectId: string; readonly runId: string; readonly objectTypeId: string },
  range: Fragment,
  batchRows: number
): Promise<string | undefined> {
  const [row] = await sql<{ readonly primary_id: string }[]>`
    SELECT primary_id FROM ontology_migration_staged_values
    WHERE project_id = ${input.projectId} AND run_id = ${input.runId}
      AND object_type_id = ${input.objectTypeId} ${range}
    ORDER BY primary_id OFFSET ${batchRows - 1} LIMIT 1
  `
  return row?.primary_id
}

/**
 * The batch's staged values, after its key steps, in one statement: each edit takes its new
 * values in place, each object its new effective values, at one version more unless the key steps
 * already bumped it in this batch, and each vector whose source changed is queued for indexing.
 */
export async function applyStagedObjects(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly runId: string
    readonly objectTypeId: string
    readonly compiled: CompiledMigrationSteps
    /** The batch's primary-id range, on `primary_id`. */
    readonly range: Fragment
    readonly commitId: string
    readonly committedAt: string
  }
): Promise<Partial<OntologyMigrationCounts>> {
  const { projectId, runId, objectTypeId, compiled, commitId } = input
  if (compiled.valuePropertyIds.length === 0) return {}

  const ofObject = (alias: string) => sql`
    ${sql(alias)}.project_id = ${projectId} AND ${sql(alias)}.object_type_id = ${objectTypeId}
    AND ${sql(alias)}.primary_id = batch.primary_id
  `
  // Rows the key steps rewrote in this batch: they count, and went one version up, already.
  const rewritten = (table: string, values: string) =>
    compiled.keys.length === 0
      ? sql`SELECT 0 AS count`
      : sql`
          SELECT count(*) AS count FROM batch JOIN ${sql(table)} AS o ON ${ofObject("o")}
          WHERE batch.${sql(values)} <> '{}'::jsonb AND o.last_commit_id = ${commitId}
        `

  const [row] = await sql<
    {
      readonly edits: string
      readonly edits_rewritten: string
      readonly objects: string
      readonly objects_rewritten: string
      readonly vectors: string
    }[]
  >`
    WITH batch AS MATERIALIZED (
      SELECT primary_id, edits, edited_at, restored, effective, vectors
      FROM ontology_migration_staged_values
      WHERE project_id = ${projectId} AND run_id = ${runId} AND object_type_id = ${objectTypeId}
        ${input.range}
    ), edits_rewritten AS (${rewritten("ontology_object_overrides", "edits")}
    ), objects_rewritten AS (${rewritten("objects", "effective")}
    ), edits_changed AS (
      UPDATE ontology_object_overrides AS o
      SET value = CASE o.value ->> 'kind'
          WHEN 'create' THEN jsonb_set(o.value, '{properties}', (o.value -> 'properties') || batch.edits)
          ELSE jsonb_set(
            jsonb_set(o.value, '{set}', (o.value -> 'set') || batch.edits),
            '{unset}', (o.value -> 'unset') - ARRAY(SELECT jsonb_array_elements_text(batch.restored))
          )
        END,
        edited_at = o.edited_at || batch.edited_at,
        last_commit_id = ${commitId}
      FROM batch
      WHERE ${ofObject("o")} AND batch.edits <> '{}'::jsonb
      RETURNING 1
    ), objects_changed AS (
      UPDATE objects AS o
      SET properties = o.properties || batch.effective,
        version = o.version + CASE WHEN o.last_commit_id = ${commitId} THEN 0 ELSE 1 END,
        last_commit_id = ${commitId}
      FROM batch
      WHERE ${ofObject("o")} AND batch.effective <> '{}'::jsonb
      RETURNING 1
    ), vectors_queued AS (
      INSERT INTO object_vector_indexing (project_id, id, object_type_id, primary_id, profile,
        request, status, available_at, dispatch_at)
      SELECT ${projectId}, vector ->> 'id', ${objectTypeId}, batch.primary_id, vector ->> 'profile',
        vector || jsonb_build_object(
          'ref', jsonb_build_object('objectTypeId', ${objectTypeId}::text, 'primaryId', batch.primary_id),
          'sourceCommitId', ${commitId}::text
        ),
        'pending', ${input.committedAt}::timestamptz, ${input.committedAt}::timestamptz
      FROM batch CROSS JOIN LATERAL jsonb_array_elements(batch.vectors) AS vector
      WHERE EXISTS (SELECT 1 FROM objects AS o WHERE ${ofObject("o")})
      ON CONFLICT (project_id, object_type_id, primary_id, profile) DO UPDATE SET
        id = EXCLUDED.id, batch_id = NULL, request = EXCLUDED.request, status = 'pending',
        available_at = EXCLUDED.available_at, dispatch_at = EXCLUDED.dispatch_at,
        values_json = NULL, error = NULL
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM edits_changed) AS edits,
      (SELECT count FROM edits_rewritten) AS edits_rewritten,
      (SELECT count(*) FROM objects_changed) AS objects,
      (SELECT count FROM objects_rewritten) AS objects_rewritten,
      (SELECT count(*) FROM vectors_queued) AS vectors
  `

  return {
    edits: Number(row?.edits ?? 0) - Number(row?.edits_rewritten ?? 0),
    objects: Number(row?.objects ?? 0) - Number(row?.objects_rewritten ?? 0),
    vectors: Number(row?.vectors ?? 0),
  }
}

/**
 * One batch of the unique values value steps change, for the properties prepared the way the
 * code compares them: every staged object's old key goes first, then each new one is claimed,
 * so two objects may swap values across batches. Each pass walks only the objects that have a key
 * to give up, or to take: a fill's pass of releases is empty. The cursor says which, and where.
 */
export async function applyStagedUnique(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly runId: string
    readonly objectTypeId: string
    readonly compiled: CompiledMigrationSteps
    readonly after: readonly string[] | undefined
    readonly batchRows: number
  }
): Promise<{ readonly rows: number; readonly cursor: OntologyMigrationLaneCursor }> {
  const { projectId, runId, objectTypeId, compiled, batchRows } = input
  const [pass = "release", afterPrimaryId] = input.after ?? []
  const key = pass === "release" ? "from" : "to"

  const keys = sql`
    SELECT batch.primary_id, keys.key AS property_id, keys.value ->> ${key} AS value_key
    FROM batch CROSS JOIN LATERAL jsonb_each(batch.unique_keys) AS keys
    WHERE keys.key = ANY(${compiled.uniqueUpdates}::text[]) AND keys.value ->> ${key} IS NOT NULL
  `
  const written =
    pass === "release"
      ? sql`
          DELETE FROM object_unique_values AS stored USING keys
          WHERE stored.project_id = ${projectId} AND stored.object_type_id = ${objectTypeId}
            AND stored.property_id = keys.property_id
            AND stored.value_hash = sha256(convert_to(keys.value_key, 'UTF8'))
            AND stored.primary_id = keys.primary_id
          RETURNING 1
        `
      : sql`
          INSERT INTO object_unique_values (project_id, object_type_id, property_id, value_hash,
            value_key, primary_id)
          SELECT ${projectId}, ${objectTypeId}, property_id,
            sha256(convert_to(value_key, 'UTF8')), value_key, primary_id
          FROM keys
          RETURNING 1
        `

  const [row] = await sql<
    { readonly rows: string; readonly last: string | null; readonly written: string }[]
  >`
    WITH batch AS MATERIALIZED (
      SELECT primary_id, unique_keys FROM ontology_migration_staged_values
      WHERE project_id = ${projectId} AND run_id = ${runId} AND object_type_id = ${objectTypeId}
        AND jsonb_path_exists(unique_keys, ${`$.* ? (@.${key} != null)`}::jsonpath)
        ${afterPrimaryId === undefined ? sql`` : sql`AND primary_id > ${afterPrimaryId}`}
      ORDER BY primary_id LIMIT ${batchRows}
    ), keys AS (${keys}), written AS (${written})
    SELECT (SELECT count(*) FROM batch) AS rows, (SELECT max(primary_id) FROM batch) AS last,
      (SELECT count(*) FROM written) AS written
  `

  const rows = Number(row?.written ?? 0)
  if (Number(row?.rows ?? 0) === batchRows && row?.last) {
    return { rows, cursor: { kind: "derived", store: "stagedUnique", after: [pass, row.last] } }
  }
  if (pass === "release") {
    return { rows, cursor: { kind: "derived", store: "stagedUnique", after: ["claim"] } }
  }
  return { rows, cursor: { kind: "derived", store: "artifactRefs" } }
}
