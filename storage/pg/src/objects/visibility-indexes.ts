import { createHash } from "node:crypto"
import type { ObjectQueryPreparationPlan, ObjectVisibilityKeys } from "@sixb/core/storage"
import type { ReservedSQL } from "../pg-client"
import { runPgTransactionOn } from "../transactions"
import { objectPartitionName } from "./partitions"
import { identifier, literal } from "./sql-text"
import { compilePgVisibilityKeys } from "./visibility"

interface VisibilityIndex {
  readonly objectTypeId: string
  readonly partition: string
  readonly expression: string
  readonly name: string
  readonly statistics: string
}

/** What an index comment records, so a later preparation finds the indexes it no longer needs. */
interface VisibilityIndexComment {
  readonly kind: "visibility"
  readonly projectId: string
  readonly statistics: string
}

/**
 * Index the keys of every view condition, so a member's read finds the rows it sees instead of
 * checking each one.
 *
 * One GIN index per condition and type, partial on the project and built concurrently, with
 * statistics on its expression so the planner knows how many rows a reader's keys show. A read
 * repeats the indexed expression, so it is served by an index only once it exists, and is right
 * either way. Indexes no condition of the project needs any more are dropped. Runs under the
 * preparation lock, on the connection that holds it.
 */
export async function preparePgVisibilityIndexes(
  connection: ReservedSQL,
  schema: string,
  plan: ObjectQueryPreparationPlan
): Promise<{ readonly names: readonly string[]; readonly warnings: readonly string[] }> {
  // Prepared without the view conditions: keep the indexes a preparation that had them built.
  if (plan.objectTypes.every((type) => type.visibility === undefined)) {
    return { names: [], warnings: [] }
  }

  const warnings: string[] = []
  const built: VisibilityIndex[] = []
  for (const index of visibilityIndexes(plan)) {
    const warning = await createVisibilityIndex(connection, schema, plan.projectId, index)
    if (warning) warnings.push(warning)
    else built.push(index)
  }

  await ensureVisibilityStatistics(connection, schema, built)
  await dropUnusedVisibilityIndexes(connection, schema, plan.projectId, built)

  return { names: built.map((index) => index.name), warnings }
}

function visibilityIndexes(plan: ObjectQueryPreparationPlan): VisibilityIndex[] {
  return plan.objectTypes.flatMap((type) => {
    const partition = objectPartitionName(type.objectTypeId)

    return (type.visibility ?? []).map((keys) => {
      const expression = compilePgVisibilityKeys(keys)
      const statistics = visibilityStatisticsName(type.objectTypeId, keys)
      const name = `sixb_visibility_${digest(`${partition}:${plan.projectId}:${expression}`, 32)}`
      return { objectTypeId: type.objectTypeId, partition, expression, name, statistics }
    })
  })
}

/**
 * The statistics on a condition's keys. Statistics cannot be partial, so projects sharing a schema
 * share those of one expression.
 */
export function visibilityStatisticsName(objectTypeId: string, keys: ObjectVisibilityKeys): string {
  const expression = compilePgVisibilityKeys(keys)
  return `sixb_visibility_stats_${digest(`${objectPartitionName(objectTypeId)}:${expression}`, 24)}`
}

/** Build one index; a condition PostgreSQL cannot index keeps its reads right, and is reported. */
async function createVisibilityIndex(
  connection: ReservedSQL,
  schema: string,
  projectId: string,
  index: VisibilityIndex
): Promise<string | undefined> {
  const table = `${identifier(schema)}.${identifier(index.partition)}`

  try {
    await connection.unsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${identifier(index.name)} ON ${table} USING gin ((${index.expression})) WHERE project_id = ${literal(projectId)}`
    )
  } catch (error) {
    // An expression with a function that is not IMMUTABLE fails before anything is built.
    if ((error as { code?: unknown }).code !== FUNCTION_NOT_IMMUTABLE) throw error
    return conditionNotIndexed(index.objectTypeId, error)
  }

  const [built] = await connection<{ valid: boolean }[]>`
    SELECT i.indisvalid AS valid FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relname = ${index.name}`
  if (!built?.valid) {
    throw new Error(
      `[SixbPg] Visibility index ${schema}.${index.name} is invalid after an interrupted build. Drop that index concurrently and prepare again.`
    )
  }

  const comment: VisibilityIndexComment = {
    kind: "visibility",
    projectId,
    statistics: index.statistics,
  }
  await connection.unsafe(
    `COMMENT ON INDEX ${identifier(schema)}.${identifier(index.name)} IS ${literal(JSON.stringify(comment))}`
  )
  return undefined
}

const FUNCTION_NOT_IMMUTABLE = "42P17"

/** One transaction per type, so its queries plan with the old statistics until the new exist. */
async function ensureVisibilityStatistics(
  connection: ReservedSQL,
  schema: string,
  indexes: readonly VisibilityIndex[]
): Promise<void> {
  const partitions = new Map<string, VisibilityIndex[]>()
  for (const index of indexes) {
    partitions.set(index.partition, [...(partitions.get(index.partition) ?? []), index])
  }

  for (const [partition, partitionIndexes] of partitions) {
    const table = `${identifier(schema)}.${identifier(partition)}`

    await runPgTransactionOn(connection, async () => {
      let created = false
      for (const index of partitionIndexes) {
        const [existing] = await connection`
          SELECT 1 FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid = s.stxnamespace
          WHERE n.nspname = ${schema} AND s.stxname = ${index.statistics}`
        if (existing) continue

        await connection.unsafe(
          `CREATE STATISTICS ${identifier(schema)}.${identifier(index.statistics)} ON (${index.expression}) FROM ${table}`
        )
        created = true
      }
      if (created) await connection.unsafe(`ANALYZE ${table}`)
    })
  }
}

/**
 * Drop this project's visibility indexes that no current condition needs: writes would keep
 * maintaining them. Statistics go with the last index of any project that uses them.
 */
async function dropUnusedVisibilityIndexes(
  connection: ReservedSQL,
  schema: string,
  projectId: string,
  current: readonly VisibilityIndex[]
): Promise<void> {
  const currentNames = new Set(current.map((index) => index.name))
  const existing = await readVisibilityIndexes(connection, schema)

  const unused = existing.filter(
    (index) => index.comment.projectId === projectId && !currentNames.has(index.name)
  )
  for (const index of unused) {
    await connection.unsafe(
      `DROP INDEX CONCURRENTLY IF EXISTS ${identifier(schema)}.${identifier(index.name)}`
    )
  }

  const kept = existing.filter((index) => !unused.includes(index))
  for (const statistics of new Set(unused.map((index) => index.comment.statistics))) {
    if (kept.some((index) => index.comment.statistics === statistics)) continue
    await connection.unsafe(
      `DROP STATISTICS IF EXISTS ${identifier(schema)}.${identifier(statistics)}`
    )
  }
}

async function readVisibilityIndexes(connection: ReservedSQL, schema: string) {
  const rows = await connection<{ name: string; definition: string }[]>`
    SELECT c.relname AS name, d.description AS definition
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_description d
      ON d.objoid = c.oid AND d.classoid = 'pg_class'::regclass AND d.objsubid = 0
    WHERE n.nspname = ${schema} AND c.relname LIKE 'sixb_visibility_%'`

  return rows.flatMap((row) => {
    const comment = parseComment(row.definition)
    return comment ? [{ name: row.name, comment }] : []
  })
}

function parseComment(definition: string): VisibilityIndexComment | undefined {
  try {
    const comment = JSON.parse(definition) as Partial<VisibilityIndexComment> | null
    return comment?.kind === "visibility" &&
      typeof comment.projectId === "string" &&
      typeof comment.statistics === "string"
      ? (comment as VisibilityIndexComment)
      : undefined
  } catch {
    return undefined
  }
}

function conditionNotIndexed(objectTypeId: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error)
  return `${objectTypeId}: a view condition cannot be indexed (${reason}); members read the type by checking each object.`
}

function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length)
}
