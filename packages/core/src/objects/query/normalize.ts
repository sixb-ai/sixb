import type {
  ObjectExpansion,
  ObjectQuery,
  ObjectQueryPredicate,
  ObjectQuerySet,
  ObjectQuerySortField,
} from "./ir"

/**
 * Canonicalizes query trees before validation/planning so providers see a
 * stable shape regardless of how the typed builder assembled the query.
 *
 * `expand` is output-shaping, so it is hoisted to the outermost layer here: two
 * queries that differ only in where `.expand(...)` was chained normalize to the
 * same tree (and therefore the same cache key).
 */
export function normalizeObjectQuery(query: ObjectQuery): ObjectQuery {
  return hoistExpand(normalizeNode(query))
}

function normalizeNode(query: ObjectQuery): ObjectQuery {
  switch (query.kind) {
    case "start":
      return { ...query }
    case "refs":
      return {
        kind: "refs",
        refs: uniqueRefs(query.refs),
      }
    case "filter":
      return normalizeFilter(query.input, query.predicate)
    case "text":
      return {
        ...query,
        input: normalizeObjectQuery(query.input),
        fields: query.fields ? uniqueStrings(query.fields) : undefined,
        fieldsByObjectType: query.fieldsByObjectType
          ? uniqueStringRecord(query.fieldsByObjectType)
          : undefined,
      }
    case "vector":
      return { ...query, input: normalizeObjectQuery(query.input), vector: [...query.vector] }
    case "traverse":
      return { ...query, input: normalizeObjectQuery(query.input) }
    case "set":
      return normalizeSet(query)
    case "sort":
      return normalizeSort(query.input, query.fields)
    case "limit":
      return normalizeLimit(query.input, query.limit)
    case "page":
      return { ...query, input: normalizeObjectQuery(query.input) }
    case "project":
      return {
        ...query,
        input: normalizeObjectQuery(query.input),
        properties: query.properties ? uniqueStrings(query.properties) : undefined,
      }
    case "expand":
      return normalizeExpand(query.input, query.expansions)
  }
}

/**
 * Keeps `expand` at the outermost layer. A single-input wrapper sitting above an
 * `expand` is swapped so the `expand` wraps the (re-normalized) wrapper subtree;
 * re-normalizing collapses any nodes that became adjacent, and a wrapper that
 * lands above another `expand` is merged into one.
 */
function hoistExpand(query: ObjectQuery): ObjectQuery {
  if (
    query.kind === "start" ||
    query.kind === "refs" ||
    query.kind === "set" ||
    query.kind === "expand"
  ) {
    return query
  }
  if (query.input.kind !== "expand") return query

  const inner = query.input
  const rebuilt = normalizeObjectQuery({ ...query, input: inner.input })
  if (rebuilt.kind === "expand") {
    return {
      kind: "expand",
      input: rebuilt.input,
      expansions: normalizeExpansions([...inner.expansions, ...rebuilt.expansions]),
    }
  }
  return { kind: "expand", input: rebuilt, expansions: inner.expansions }
}

function normalizeExpand(input: ObjectQuery, expansions: readonly ObjectExpansion[]): ObjectQuery {
  const normalizedInput = normalizeObjectQuery(input)
  const normalizedExpansions = normalizeExpansions(expansions)

  // A directly-nested expand (`a.expand(X).expand(Y)` builds
  // `expand(expand(start, [X]), [Y])`) collapses into one outermost expand.
  if (normalizedInput.kind === "expand") {
    return {
      kind: "expand",
      input: normalizedInput.input,
      expansions: normalizeExpansions([...normalizedInput.expansions, ...normalizedExpansions]),
    }
  }

  return { kind: "expand", input: normalizedInput, expansions: normalizedExpansions }
}

function normalizeExpansions(expansions: readonly ObjectExpansion[]): ObjectExpansion[] {
  const byKey = new Map<string, ObjectExpansion>()
  for (const expansion of expansions) {
    const normalized = normalizeExpansion(expansion)
    const key = expansionKey(normalized)
    const existing = byKey.get(key)
    byKey.set(key, existing ? mergeExpansion(existing, normalized) : normalized)
  }

  return [...byKey.values()].sort((a, b) => {
    const left = expansionKey(a)
    const right = expansionKey(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

function normalizeExpansion(expansion: ObjectExpansion): ObjectExpansion {
  const nested = expansion.expand ? normalizeExpansions(expansion.expand) : []
  return {
    linkId: expansion.linkId,
    direction: expansion.direction,
    ...(expansion.sourceObjectTypeId !== undefined
      ? { sourceObjectTypeId: expansion.sourceObjectTypeId }
      : {}),
    ...(expansion.limit !== undefined ? { limit: expansion.limit } : {}),
    ...(expansion.orderBy ? { orderBy: expansion.orderBy.map((field) => ({ ...field })) } : {}),
    ...(nested.length > 0 ? { expand: nested } : {}),
  }
}

// Two expansions of the same link in the same direction are one hydration; their
// nested expansions merge so the normalized tree never double-hydrates a link.
function mergeExpansion(a: ObjectExpansion, b: ObjectExpansion): ObjectExpansion {
  const nested = normalizeExpansions([...(a.expand ?? []), ...(b.expand ?? [])])
  const { expand: _existing, ...base } = a
  return nested.length > 0 ? { ...base, expand: nested } : base
}

function expansionKey(expansion: ObjectExpansion): string {
  return `${expansion.direction}\0${expansion.linkId}\0${expansion.sourceObjectTypeId ?? ""}`
}

export function normalizeObjectQueryPredicate(
  predicate: ObjectQueryPredicate
): ObjectQueryPredicate {
  switch (predicate.op) {
    case "and":
    case "or": {
      const items = predicate.items.flatMap((item) => {
        const normalized = normalizeObjectQueryPredicate(item)
        if (normalized.op === predicate.op) return normalized.items
        return [normalized]
      })
      return items.length === 1 ? items[0] : { op: predicate.op, items }
    }
    case "not":
      return { op: "not", item: normalizeObjectQueryPredicate(predicate.item) }
    case "in":
      return { ...predicate, values: [...predicate.values] }
    default:
      return { ...predicate }
  }
}

function normalizeFilter(input: ObjectQuery, predicate: ObjectQueryPredicate): ObjectQuery {
  const normalizedInput = normalizeObjectQuery(input)
  const normalizedPredicate = normalizeObjectQueryPredicate(predicate)

  // Adjacent filters are equivalent to a single conjunction and are easier for
  // capability checks and providers to inspect.
  if (normalizedInput.kind === "filter") {
    return normalizeObjectQuery({
      kind: "filter",
      input: normalizedInput.input,
      predicate: {
        op: "and",
        items: [normalizedInput.predicate, normalizedPredicate],
      },
    })
  }

  return {
    kind: "filter",
    input: normalizedInput,
    predicate: normalizedPredicate,
  }
}

function normalizeSet(query: ObjectQuerySet): ObjectQuery {
  const inputs = query.inputs.flatMap((input) => {
    const normalized = normalizeObjectQuery(input)
    if (normalized.kind === "set" && normalized.op === query.op) return normalized.inputs
    return [normalized]
  })

  return { ...query, inputs }
}

function normalizeSort(input: ObjectQuery, fields: readonly ObjectQuerySortField[]): ObjectQuery {
  const normalizedInput = normalizeObjectQuery(input)
  const normalizedFields = fields.map((field) => ({ ...field }))

  // A later sort fully determines result order, so it replaces an adjacent sort.
  if (normalizedInput.kind === "sort") {
    return {
      kind: "sort",
      input: normalizedInput.input,
      fields: normalizedFields,
    }
  }

  return {
    kind: "sort",
    input: normalizedInput,
    fields: normalizedFields,
  }
}

function normalizeLimit(input: ObjectQuery, limit: number): ObjectQuery {
  const normalizedInput = normalizeObjectQuery(input)

  // Adjacent limits collapse to the stricter bound.
  if (normalizedInput.kind === "limit") {
    return {
      kind: "limit",
      input: normalizedInput.input,
      limit: Math.min(normalizedInput.limit, limit),
    }
  }

  return {
    kind: "limit",
    input: normalizedInput,
    limit,
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function uniqueRefs(
  refs: readonly { objectTypeId: string; primaryId: string }[]
): { objectTypeId: string; primaryId: string }[] {
  const seen = new Set<string>()
  const unique = refs.flatMap((ref) => {
    const key = JSON.stringify([ref.objectTypeId, ref.primaryId])
    if (seen.has(key)) return []
    seen.add(key)
    return [{ ...ref }]
  })

  // `refs` is an object-set source, not a positional batch response. Canonical
  // identity order makes equivalent sets normalize identically and matches the
  // default ordering used by provider query sources.
  return unique.sort(
    (left, right) =>
      compareStrings(left.objectTypeId, right.objectTypeId) ||
      compareStrings(left.primaryId, right.primaryId)
  )
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function uniqueStringRecord(
  record: Readonly<Record<string, readonly string[]>>
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(record).map(([objectTypeId, fields]) => [objectTypeId, uniqueStrings(fields)])
  )
}
