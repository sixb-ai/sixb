import type { ObjectQuery, ObjectQueryPredicate, ObjectQuerySet, ObjectQuerySortField } from "./ir"

/**
 * Canonicalizes query trees before validation/planning so providers see a
 * stable shape regardless of how the typed builder assembled the query.
 */
export function normalizeObjectQuery(query: ObjectQuery): ObjectQuery {
  switch (query.kind) {
    case "start":
      return { ...query }
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
  }
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

function uniqueStringRecord(
  record: Readonly<Record<string, readonly string[]>>
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(record).map(([objectTypeId, fields]) => [objectTypeId, uniqueStrings(fields)])
  )
}
