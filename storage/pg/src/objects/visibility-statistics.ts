import type { ObjectReadCondition } from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"
import { MAX_KEYED_ID_LENGTH, pgVisibilityReaderKeys } from "./visibility"
import { visibilityStatisticsName } from "./visibility-indexes"

// How long a read of the statistics serves queries before they are read again.
const VISIBILITY_STATISTICS_TTL_MS = 60_000

/**
 * The keys the statistics of each view condition list as most common, read at most once a minute.
 *
 * ANALYZE lists every key above a small share of the rows. PostgreSQL estimates one it does not
 * list at about half a percent of them, whatever its real share: a reader who sees nothing looks
 * like one who sees thousands of objects.
 */
export class PgVisibilityStatisticsCatalog {
  #read:
    | {
        readonly at: number
        readonly keys: Promise<ReadonlyMap<string, ReadonlySet<string>>>
      }
    | undefined

  /** Read through the caller's client, so a transaction never waits for a second connection. */
  commonKeys(sql: SQLClient): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    const now = Date.now()
    if (this.#read && now - this.#read.at < VISIBILITY_STATISTICS_TTL_MS) return this.#read.keys

    const read = { at: now, keys: readCommonKeys(sql) }
    this.#read = read
    // A failed read is not kept: the next query reads again.
    read.keys.catch(() => {
      if (this.#read === read) this.#read = undefined
    })
    return read.keys
  }
}

async function readCommonKeys(sql: SQLClient): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const rows = await sql<{ name: string; keys: string[] | null }[]>`
    SELECT statistics_name AS name, most_common_elems::text::text[] AS keys
    FROM pg_stats_ext_exprs
    WHERE schemaname = current_schema() AND statistics_name LIKE 'sixb\\_visibility\\_stats\\_%'`

  return new Map(rows.map((row) => [row.name, new Set(row.keys ?? [])]))
}

/**
 * Whether a reader sees so few objects of a type that its ordered pages read the objects it sees
 * first, then sort them.
 *
 * Walking a sort index stops at a page's last object, so it is the right plan for a reader who sees
 * many. For one who sees few, it checks nearly every object, and PostgreSQL cannot tell them apart
 * when the statistics list none of the reader's keys. Such a reader sees few objects: those its
 * keys meet are under the share ANALYZE lists. Without statistics, or with a remainder read object
 * by object, the reader's share is unknown and PostgreSQL chooses.
 */
export async function readsFewObjects(
  sql: SQLClient,
  catalog: PgVisibilityStatisticsCatalog,
  condition: ObjectReadCondition
): Promise<boolean> {
  const visibility = condition.visibility
  if (!visibility || visibility.remainder) return false
  if ((visibility.user?.id.length ?? 0) > MAX_KEYED_ID_LENGTH) return false

  const common = await catalog.commonKeys(sql)
  const readerKeys = pgVisibilityReaderKeys(visibility.user)

  for (const keys of visibility.keys) {
    const listed = common.get(visibilityStatisticsName(condition.objectTypeId, keys))
    if (!listed || readerKeys.some((key) => listed.has(key))) return false
  }
  return true
}
