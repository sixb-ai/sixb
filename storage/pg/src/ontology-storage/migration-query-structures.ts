import { compileMigrationSteps, migrationRunType } from "@sixb/core/internal/storage"
import type { OntologyMigrationRunPlan } from "@sixb/core/storage"
import { objectPartitionName } from "../objects/partitions"
import { identifier } from "../objects/sql-text"
import type { SQLClient } from "../pg-client"

/**
 * Drops, in the run's first transaction, every query structure built on a key the run removes or
 * renames: indexes and extended statistics on the type's partition, and the text and filter
 * columns `objects` stores for it. Writes would otherwise keep maintaining them through every
 * batch, for keys the code no longer declares. Query preparation builds what the code needs once
 * the run is applied, so its record of the last preparation goes too.
 *
 * Only sort and text count indexes say what they were built for, so a structure is found by what
 * PostgreSQL prints of its expressions: `properties -> 'gate'::text` or `->>`. A text column is
 * found by the definition its count index carries, since a filter on the key changes its name only.
 */
export async function dropMigratedQueryStructures(
  sql: SQLClient,
  plan: OntologyMigrationRunPlan
): Promise<void> {
  let dropped = false

  for (const { objectTypeId } of plan.types) {
    const keys = compileMigrationSteps(migrationRunType(plan, objectTypeId)).keys
    if (keys.length === 0) continue

    const partition = objectPartitionName(objectTypeId)
    const reads = (definition: string) =>
      keys.some((key) => {
        const quoted = `'${key.replace(/'/g, "''")}'::text`
        return definition.includes(`-> ${quoted}`) || definition.includes(`->> ${quoted}`)
      })

    const indexes = await sql<
      { readonly name: string; readonly definition: string; readonly comment: string | null }[]
    >`
      SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS definition,
        obj_description(i.indexrelid, 'pg_class') AS comment
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = to_regclass(${partition})
    `
    const statistics = await sql<{ readonly name: string; readonly definition: string }[]>`
      SELECT stxname AS name, pg_get_statisticsobjdef(oid) AS definition
      FROM pg_statistic_ext WHERE stxrelid = to_regclass(${partition})
    `
    const columns = await sql<{ readonly name: string; readonly definition: string }[]>`
      SELECT a.attname AS name, pg_get_expr(d.adbin, d.adrelid) AS definition
      FROM pg_attribute a
      JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = to_regclass('objects') AND a.attgenerated = 's' AND NOT a.attisdropped
        AND a.attname LIKE 'sixb_q%'
    `

    // A text count's columns: its text column by name, whatever its filters read.
    const textColumns = indexes.flatMap((index) => {
      if (!index.name.startsWith("sixb_text_count_") || !index.comment) return []
      const counted = JSON.parse(index.comment) as {
        readonly objectTypeId: string
        readonly propertyId: string
        readonly filters: readonly string[]
      }
      const onKey = [counted.propertyId, ...counted.filters].some((id) => keys.includes(id))
      if (counted.objectTypeId !== objectTypeId || !onKey) return []
      return [`sixb_qtext_${index.name.slice("sixb_text_count_".length)}`]
    })
    const typeScope = `object_type_id = '${objectTypeId.replace(/'/g, "''")}'::text`
    const droppedColumns = new Set([
      ...textColumns,
      ...columns
        .filter((column) => column.definition.includes(typeScope) && reads(column.definition))
        .map((column) => column.name),
    ])

    // Columns first: the indexes built on them go with them.
    for (const column of droppedColumns) {
      await sql.unsafe(`ALTER TABLE objects DROP COLUMN IF EXISTS ${identifier(column)}`)
    }
    for (const index of indexes.filter((candidate) => reads(candidate.definition))) {
      await sql.unsafe(`DROP INDEX IF EXISTS ${identifier(index.name)}`)
    }
    for (const statistic of statistics.filter((candidate) => reads(candidate.definition))) {
      await sql.unsafe(`DROP STATISTICS IF EXISTS ${identifier(statistic.name)}`)
    }

    dropped ||= droppedColumns.size > 0 || indexes.some((index) => reads(index.definition))
  }

  if (dropped) await sql`DELETE FROM object_query_preparation`
}
