import { ObjectQueryValidationError } from "./errors"
import type { ObjectExpansion, ObjectQuery, ObjectQueryPredicate } from "./ir"

const MAX_QUERY_STRUCTURE_NODES = 512
const MAX_QUERY_STRUCTURE_DEPTH = 32
const MAX_QUERY_ARRAY_ENTRIES = 4_096

type WorkItem =
  | {
      readonly kind: "query"
      readonly value: ObjectQuery
      readonly path: string
      readonly depth: number
      readonly exit?: false
    }
  | {
      readonly kind: "predicate"
      readonly value: ObjectQueryPredicate
      readonly path: string
      readonly depth: number
      readonly exit?: false
    }
  | {
      readonly kind: "expansion"
      readonly value: ObjectExpansion
      readonly path: string
      readonly depth: number
      readonly exit?: false
    }
  | { readonly value: object; readonly exit: true }

/**
 * Bound and cycle-check authored query structure before any recursive normalization or validation.
 * Scalar predicate values are data, not query structure, and are intentionally left to schemas.
 */
export function assertObjectQueryComplexity(query: ObjectQuery): void {
  assertStructure([{ kind: "query", value: query, path: "$", depth: 0 }])
}

/** Bound the standalone predicate normalization entrypoint too. */
export function assertObjectQueryPredicateComplexity(predicate: ObjectQueryPredicate): void {
  assertStructure([{ kind: "predicate", value: predicate, path: "$", depth: 0 }])
}

function assertStructure(initial: readonly WorkItem[]): void {
  const stack = [...initial]
  const active = new Set<object>()
  let nodes = 0
  let arrayEntries = 0

  const addEntries = (count: number, path: string): void => {
    arrayEntries += count
    if (arrayEntries > MAX_QUERY_ARRAY_ENTRIES) {
      fail(
        path,
        "query_array_entries_exceeded",
        `Object query exceeds the maximum of ${MAX_QUERY_ARRAY_ENTRIES} array entries`
      )
    }
  }
  const addArray = (value: unknown, path: string): readonly unknown[] => {
    if (!Array.isArray(value)) return []
    addEntries(value.length, path)
    return value
  }

  while (stack.length > 0) {
    const item = stack.pop()
    if (!item) continue
    if (item.exit) {
      active.delete(item.value)
      continue
    }

    if (!isRecord(item.value)) continue
    if (item.depth > MAX_QUERY_STRUCTURE_DEPTH) {
      fail(
        item.path,
        "query_depth_exceeded",
        `Object query exceeds the maximum structural depth of ${MAX_QUERY_STRUCTURE_DEPTH}`
      )
    }
    if (active.has(item.value)) {
      fail(item.path, "cyclic_query", "Object query structure must not contain cycles")
    }

    nodes += 1
    if (nodes > MAX_QUERY_STRUCTURE_NODES) {
      fail(
        item.path,
        "query_nodes_exceeded",
        `Object query exceeds the maximum of ${MAX_QUERY_STRUCTURE_NODES} structural nodes`
      )
    }

    active.add(item.value)
    stack.push({ value: item.value, exit: true })

    if (item.kind === "query") {
      enqueueQuery(item, stack, addArray, addEntries)
    } else if (item.kind === "predicate") {
      enqueuePredicate(item, stack, addArray)
    } else {
      enqueueExpansion(item, stack, addArray)
    }
  }
}

function enqueueQuery(
  item: Extract<WorkItem, { readonly kind: "query" }>,
  stack: WorkItem[],
  addArray: (value: unknown, path: string) => readonly unknown[],
  addEntries: (count: number, path: string) => void
): void {
  const query = item.value
  switch (query.kind) {
    case "start":
      return
    case "refs":
      addArray(query.refs, `${item.path}.refs`)
      return
    case "filter":
      stack.push({
        kind: "predicate",
        value: query.predicate,
        path: `${item.path}.predicate`,
        depth: item.depth + 1,
      })
      pushInput(query.input, item, stack)
      return
    case "text":
      addArray(query.fields, `${item.path}.fields`)
      if (isRecord(query.fieldsByObjectType)) {
        for (const objectTypeId in query.fieldsByObjectType) {
          if (!Object.hasOwn(query.fieldsByObjectType, objectTypeId)) continue
          addEntries(1, `${item.path}.fieldsByObjectType`)
          const fields = query.fieldsByObjectType[objectTypeId]
          addArray(fields, `${item.path}.fieldsByObjectType.${objectTypeId}`)
        }
      }
      pushInput(query.input, item, stack)
      return
    case "vector":
      addArray(query.vector, `${item.path}.vector`)
      pushInput(query.input, item, stack)
      return
    case "traverse":
    case "limit":
    case "page":
      pushInput(query.input, item, stack)
      return
    case "sort":
      addArray(query.fields, `${item.path}.fields`)
      pushInput(query.input, item, stack)
      return
    case "project":
      addArray(query.properties, `${item.path}.properties`)
      pushInput(query.input, item, stack)
      return
    case "set": {
      const inputs = addArray(query.inputs, `${item.path}.inputs`)
      pushChildren("query", inputs, `${item.path}.inputs`, item.depth, stack)
      return
    }
    case "expand": {
      const expansions = addArray(query.expansions, `${item.path}.expansions`)
      pushChildren("expansion", expansions, `${item.path}.expansions`, item.depth, stack)
      pushInput(query.input, item, stack)
      return
    }
  }
}

function enqueuePredicate(
  item: Extract<WorkItem, { readonly kind: "predicate" }>,
  stack: WorkItem[],
  addArray: (value: unknown, path: string) => readonly unknown[]
): void {
  const predicate = item.value
  switch (predicate.op) {
    case "and":
    case "or": {
      const items = addArray(predicate.items, `${item.path}.items`)
      pushChildren("predicate", items, `${item.path}.items`, item.depth, stack)
      return
    }
    case "not":
      stack.push({
        kind: "predicate",
        value: predicate.item,
        path: `${item.path}.item`,
        depth: item.depth + 1,
      })
      return
    case "in":
      addArray(predicate.values, `${item.path}.values`)
      return
    default:
      return
  }
}

function enqueueExpansion(
  item: Extract<WorkItem, { readonly kind: "expansion" }>,
  stack: WorkItem[],
  addArray: (value: unknown, path: string) => readonly unknown[]
): void {
  addArray(item.value.orderBy, `${item.path}.orderBy`)
  const nested = addArray(item.value.expand, `${item.path}.expand`)
  pushChildren("expansion", nested, `${item.path}.expand`, item.depth, stack)
}

function pushInput(
  input: ObjectQuery,
  parent: Extract<WorkItem, { readonly kind: "query" }>,
  stack: WorkItem[]
): void {
  stack.push({
    kind: "query",
    value: input,
    path: `${parent.path}.input`,
    depth: parent.depth + 1,
  })
}

function pushChildren(
  kind: "query" | "predicate" | "expansion",
  values: readonly unknown[],
  path: string,
  parentDepth: number,
  stack: WorkItem[]
): void {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    stack.push({
      kind,
      value: values[index],
      path: `${path}[${index}]`,
      depth: parentDepth + 1,
    } as WorkItem)
  }
}

function fail(path: string, code: string, message: string): never {
  throw new ObjectQueryValidationError([{ path, code, message }])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
