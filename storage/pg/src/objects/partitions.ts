import { createHash } from "node:crypto"
import type { ReservedSQL } from "../pg-client"
import { isLockConflict } from "../storage-errors"
import { runPgTransactionOn } from "../transactions"
import { identifier, literal } from "./sql-text"

// A query reading every partition, and any publication, holds the default partition until it
// commits, which can take minutes. While this waits such queries queue behind it, so it waits a
// moment at a time and steps aside between attempts: about four minutes in all.
const LOCK_TIMEOUT = "1s"
const LOCK_ATTEMPTS = 120
const LOCK_RETRY_MS = 1_000

/** Migration 084 derives the same name in SQL: `'objects_' || left(md5(type), 24)`. */
export function objectPartitionName(objectTypeId: string): string {
  return `objects_${createHash("md5").update(objectTypeId).digest("hex").slice(0, 24)}`
}

/**
 * The object type's partition, created on first use. Reads that name another type never wait. A
 * short lock timeout and retries mean this gives way to long queries and publications instead of
 * queuing other work behind itself, and preparation fails cleanly if they outlast every attempt.
 */
export async function ensureObjectPartition(
  connection: ReservedSQL,
  schema: string,
  objectTypeId: string
): Promise<string> {
  const name = objectPartitionName(objectTypeId)
  const partition = `${identifier(schema)}.${identifier(name)}`
  const [existing] = await connection<{ found: string | null }[]>`
    SELECT to_regclass(${partition})::text AS found`
  if (existing?.found) return name

  for (let attempt = 1; ; attempt++) {
    try {
      await createObjectPartition(connection, schema, partition, objectTypeId)
      return name
    } catch (error) {
      if (!isLockConflict(error)) throw error
      if (attempt === LOCK_ATTEMPTS) {
        throw new Error(
          `[SixbPg] Could not add a partition for object type '${objectTypeId}': other queries held their locks through ${LOCK_ATTEMPTS} attempts. Retry when they finish.`,
          { cause: error }
        )
      }
    }
    await Bun.sleep(LOCK_RETRY_MS)
  }
}

async function createObjectPartition(
  connection: ReservedSQL,
  schema: string,
  partition: string,
  objectTypeId: string
): Promise<void> {
  const parent = `${identifier(schema)}.objects`
  const fallback = `${identifier(schema)}.objects_default`
  const type = literal(objectTypeId)
  const hasRows = async () => {
    const [row] = await connection.unsafe(
      `SELECT 1 FROM ${fallback} WHERE object_type_id = ${type} LIMIT 1`
    )
    return row !== undefined
  }
  const guarded = (run: () => Promise<void>) =>
    runPgTransactionOn(connection, async () => {
      await connection.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
      // Copying rows takes as long as it takes, whatever timeout this role's queries run under.
      await connection.unsafe("SET LOCAL statement_timeout = 0")
      await run()
    })

  let moving = false
  await guarded(async () => {
    moving = await hasRows()
  })

  // Moving rows must drop foreign keys, which takes the parent exclusively, so it asks for that from
  // the start rather than upgrading a lock while queries wait behind it. Otherwise attaching only
  // needs SHARE UPDATE EXCLUSIVE on the parent, so reads and writes of other types carry on.
  await guarded(async () => {
    const references = await referencesToObjects(connection, parent)
    await connection.unsafe(
      `LOCK TABLE ONLY ${parent} IN ${moving ? "ACCESS EXCLUSIVE" : "SHARE UPDATE EXCLUSIVE"} MODE`
    )
    // Before the default partition: a writer on these tables goes on to check objects, so taking
    // them in this order leaves no cycle for it to be killed in.
    for (const { table_name: table } of references) {
      await connection.unsafe(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`)
    }
    await connection.unsafe(`LOCK TABLE ${fallback} IN ACCESS EXCLUSIVE MODE`)

    // A row arrived since the check above, so its type needs the moving path. The next attempt takes it.
    if (!moving && (await hasRows())) {
      throw Object.assign(new Error("[SixbPg] A row arrived while adding its partition."), {
        code: "55P03",
      })
    }

    await connection.unsafe(
      `CREATE TABLE ${partition} (LIKE ${parent} INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS INCLUDING STORAGE)`
    )
    if (moving) await moveRowsFromDefault(connection, parent, fallback, partition, type, references)
    await connection.unsafe(
      `ALTER TABLE ${parent} ATTACH PARTITION ${partition} FOR VALUES IN (${type})`
    )
    if (moving) {
      for (const reference of references) {
        await connection.unsafe(
          `ALTER TABLE ${reference.table_name} ADD CONSTRAINT ${identifier(reference.name)} ${reference.definition}`
        )
      }
    }
  })

  // Not under the locks above: every query on every type is waiting behind them.
  if (moving) await guarded(() => connection.unsafe(`ANALYZE ${partition}`).then(() => undefined))
}

interface ObjectReference {
  readonly table_name: string
  readonly name: string
  readonly definition: string
}

function referencesToObjects(connection: ReservedSQL, parent: string) {
  return connection<ObjectReference[]>`
    SELECT conrelid::regclass::text AS table_name, conname AS name,
      pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE confrelid = ${parent}::regclass AND contype = 'f' AND conparentid = 0`
}

/**
 * Nothing about the rows changes, so foreign keys that reference objects must not see a delete:
 * ON DELETE CASCADE would remove what they protect. The caller adds them back.
 */
async function moveRowsFromDefault(
  connection: ReservedSQL,
  parent: string,
  fallback: string,
  partition: string,
  type: string,
  references: readonly ObjectReference[]
): Promise<void> {
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
    `INSERT INTO ${partition} (${list}) SELECT ${list} FROM ${fallback} WHERE object_type_id = ${type}`
  )
  await connection.unsafe(`DELETE FROM ${fallback} WHERE object_type_id = ${type}`)
}
