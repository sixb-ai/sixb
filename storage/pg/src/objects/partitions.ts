import { createHash } from "node:crypto"
import type { ReservedSQL } from "../pg-client"
import { runPgTransactionOn } from "../transactions"

/** Migration 084 derives the same name in SQL: `'objects_' || left(md5(type), 24)`. */
export function objectPartitionName(objectTypeId: string): string {
  return `objects_${createHash("md5").update(objectTypeId).digest("hex").slice(0, 24)}`
}

/**
 * The object type's partition, created on first use. Rows written before it existed sit in the
 * default partition and move across, without firing the cascades of the foreign keys that
 * reference objects: nothing about those rows changes.
 */
export async function ensureObjectPartition(
  connection: ReservedSQL,
  schema: string,
  objectTypeId: string
): Promise<string> {
  const name = objectPartitionName(objectTypeId)
  const parent = `${identifier(schema)}.objects`
  const partition = `${identifier(schema)}.${identifier(name)}`
  const fallback = `${identifier(schema)}.objects_default`
  const type = literal(objectTypeId)

  const [existing] = await connection<{ found: string | null }[]>`
    SELECT to_regclass(${partition})::text AS found`
  if (existing?.found) return name

  await runPgTransactionOn(connection, async () => {
    await connection.unsafe(`LOCK TABLE ${fallback} IN ACCESS EXCLUSIVE MODE`)
    const [waiting] = await connection.unsafe(
      `SELECT 1 FROM ${fallback} WHERE object_type_id = ${type} LIMIT 1`
    )
    if (!waiting) {
      await connection.unsafe(
        `CREATE TABLE ${partition} PARTITION OF ${parent} FOR VALUES IN (${type})`
      )
      return
    }

    const references = await connection<{ table_name: string; name: string; definition: string }[]>`
      SELECT conrelid::regclass::text AS table_name, conname AS name,
        pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE confrelid = ${parent}::regclass AND contype = 'f' AND conparentid = 0`
    for (const reference of references) {
      await connection.unsafe(
        `ALTER TABLE ${reference.table_name} DROP CONSTRAINT ${identifier(reference.name)}`
      )
    }

    const columns = await connection<{ name: string }[]>`
      SELECT attname AS name FROM pg_attribute
      WHERE attrelid = ${parent}::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''
      ORDER BY attnum`
    const list = columns.map((column) => identifier(column.name)).join(", ")
    await connection.unsafe(
      `CREATE TABLE ${partition} (LIKE ${parent} INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS INCLUDING STORAGE)`
    )
    await connection.unsafe(
      `INSERT INTO ${partition} (${list}) SELECT ${list} FROM ${fallback} WHERE object_type_id = ${type}`
    )
    await connection.unsafe(`DELETE FROM ${fallback} WHERE object_type_id = ${type}`)
    await connection.unsafe(
      `ALTER TABLE ${parent} ATTACH PARTITION ${partition} FOR VALUES IN (${type})`
    )

    for (const reference of references) {
      await connection.unsafe(
        `ALTER TABLE ${reference.table_name} ADD CONSTRAINT ${identifier(reference.name)} ${reference.definition}`
      )
    }
  })
  return name
}

function identifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
