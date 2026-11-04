import type { ObjectQuery } from "@sixb/core"

const MAX_REMEMBERED_QUERIES = 1_000

/** Reads are per API client: the same query can read different types in another project. */
const readsByClient = new WeakMap<object, Map<string, readonly string[]>>()
const DEFAULT_CLIENT = {}

/** Two queries that differ only in property order share one cache entry, and so one key here. */
const keys = new WeakMap<object, string>()

function queryKey(query: object): string {
  let key = keys.get(query)
  if (key === undefined) {
    key = JSON.stringify(query, (_name, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
        : value
    )
    keys.set(query, key)
  }
  return key
}

/** Any page of a query reads the same types as the query it pages through. */
function withoutPage<TQuery extends object>(query: TQuery): object {
  return (query as { kind?: unknown }).kind === "page"
    ? (query as unknown as { input: object }).input
    : query
}

function readsOf(client: object | undefined): Map<string, readonly string[]> {
  const owner = client ?? DEFAULT_CLIENT
  let reads = readsByClient.get(owner)
  if (!reads) {
    reads = new Map()
    readsByClient.set(owner, reads)
  }
  return reads
}

export function rememberObjectQueryReads(
  client: object | undefined,
  query: ObjectQuery,
  objectTypeIds: readonly string[] | undefined
): void {
  const reads = readsOf(client)
  const key = queryKey(withoutPage(query))

  // Oldest first, so the most recently answered queries are the ones kept.
  reads.delete(key)
  if (objectTypeIds) reads.set(key, objectTypeIds)
  if (reads.size > MAX_REMEMBERED_QUERIES) {
    const oldest = reads.keys().next().value
    if (oldest !== undefined) reads.delete(oldest)
  }
}

/**
 * Whether a change to these object types can change this cached query's result. A query not known
 * here has not answered yet, or has been forgotten, so it counts as reading everything.
 */
export function objectQueryReadsAny(
  client: object | undefined,
  query: unknown,
  changed: ReadonlySet<string>
): boolean {
  if (!query || typeof query !== "object") return true

  const reads = readsOf(client).get(queryKey(withoutPage(query)))
  return reads === undefined || reads.some((objectTypeId) => changed.has(objectTypeId))
}
