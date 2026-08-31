import { ObjectQueryValidationError } from "./errors"
import type { ObjectQuery, ObjectQueryPredicate } from "./ir"

/** Shared admission bounds for authored and transport object-query trees. */
export const OBJECT_QUERY_STRUCTURE_LIMITS = Object.freeze({
  maxNodes: 512,
  maxDepth: 32,
  maxArrayEntries: 4_096,
  maxJsonValueDepth: 64,
  /** Cumulative children across every JSON container in predicate values. */
  maxJsonValueEntries: 4_096,
})

export interface ObjectQueryStructureIssue {
  readonly path: string
  readonly code: string
  readonly message: string
}

export type ObjectQueryStructureRoot = "query" | "predicate"

interface StructureNodeWorkItem {
  readonly kind: "query" | "predicate" | "expansion"
  readonly value: unknown
  readonly path: string
  readonly depth: number
}

type StructureWorkItem = StructureNodeWorkItem | { readonly kind: "exit"; readonly value: object }

interface ScanState {
  arrayEntries: number
  jsonValueEntries: number
  issue: ObjectQueryStructureIssue | null
}

/**
 * Inspect an unknown query-shaped value without recursive calls.
 *
 * This is deliberately structural only: malformed nodes are left to the schema and Core remains
 * the semantic authority. The same walker can therefore protect both authored queries and the
 * transport parser that runs before recursive Zod schemas.
 */
export function findObjectQueryStructureIssue(
  value: unknown,
  root: ObjectQueryStructureRoot = "query"
): ObjectQueryStructureIssue | null {
  const stack: StructureWorkItem[] = [{ kind: root, value, path: "$", depth: 0 }]
  const active = new Set<object>()
  const state: ScanState = { arrayEntries: 0, jsonValueEntries: 0, issue: null }
  let nodes = 0

  while (stack.length > 0) {
    const item = stack.pop()
    if (!item) continue
    if (item.kind === "exit") {
      active.delete(item.value)
      continue
    }
    if (!isRecord(item.value)) continue

    if (item.depth > OBJECT_QUERY_STRUCTURE_LIMITS.maxDepth) {
      return issue(
        item.path,
        "query_depth_exceeded",
        `Object query exceeds the maximum structural depth of ${OBJECT_QUERY_STRUCTURE_LIMITS.maxDepth}`
      )
    }
    if (active.has(item.value)) {
      return issue(item.path, "cyclic_query", "Object query structure must not contain cycles")
    }

    nodes += 1
    if (nodes > OBJECT_QUERY_STRUCTURE_LIMITS.maxNodes) {
      return issue(
        item.path,
        "query_nodes_exceeded",
        `Object query exceeds the maximum of ${OBJECT_QUERY_STRUCTURE_LIMITS.maxNodes} structural nodes`
      )
    }

    active.add(item.value)
    stack.push({ kind: "exit", value: item.value })

    if (item.kind === "query") enqueueQuery(item, stack, state)
    else if (item.kind === "predicate") enqueuePredicate(item, stack, state)
    else enqueueExpansion(item, stack, state)
    if (state.issue) return state.issue
  }

  return null
}

/** Bound and cycle-check an authored query before recursive normalization or validation. */
export function assertObjectQueryComplexity(query: ObjectQuery): void {
  assertStructure(query, "query")
}

/** Bound the standalone predicate normalization entrypoint too. */
export function assertObjectQueryPredicateComplexity(predicate: ObjectQueryPredicate): void {
  assertStructure(predicate, "predicate")
}

function assertStructure(value: unknown, root: ObjectQueryStructureRoot): void {
  const found = findObjectQueryStructureIssue(value, root)
  if (found) throw new ObjectQueryValidationError([found])
}

function enqueueQuery(
  item: StructureNodeWorkItem,
  stack: StructureWorkItem[],
  state: ScanState
): void {
  const query = item.value as Record<string, unknown>
  switch (query.kind) {
    case "refs":
      readArray(query.refs, `${item.path}.refs`, state)
      return
    case "filter":
      stack.push({
        kind: "predicate",
        value: query.predicate,
        path: `${item.path}.predicate`,
        depth: item.depth + 1,
      })
      pushQueryInput(query.input, item, stack)
      return
    case "text": {
      readArray(query.fields, `${item.path}.fields`, state)
      if (state.issue) return
      if (isRecord(query.fieldsByObjectType)) {
        for (const objectTypeId in query.fieldsByObjectType) {
          if (!Object.hasOwn(query.fieldsByObjectType, objectTypeId)) continue
          addArrayEntries(1, `${item.path}.fieldsByObjectType`, state)
          if (state.issue) return
          const fields = query.fieldsByObjectType[objectTypeId]
          readArray(fields, `${item.path}.fieldsByObjectType.${objectTypeId}`, state)
          if (state.issue) return
        }
      }
      pushQueryInput(query.input, item, stack)
      return
    }
    case "vector":
      readArray(query.vector, `${item.path}.vector`, state)
      if (state.issue) return
      pushQueryInput(query.input, item, stack)
      return
    case "traverse":
    case "limit":
    case "page":
      pushQueryInput(query.input, item, stack)
      return
    case "sort":
      readArray(query.fields, `${item.path}.fields`, state)
      if (state.issue) return
      pushQueryInput(query.input, item, stack)
      return
    case "project":
      readArray(query.properties, `${item.path}.properties`, state)
      if (state.issue) return
      pushQueryInput(query.input, item, stack)
      return
    case "set":
      pushArrayChildren("query", query.inputs, `${item.path}.inputs`, item.depth, stack, state)
      return
    case "expand":
      pushArrayChildren(
        "expansion",
        query.expansions,
        `${item.path}.expansions`,
        item.depth,
        stack,
        state
      )
      if (state.issue) return
      pushQueryInput(query.input, item, stack)
      return
    default:
      return
  }
}

function enqueuePredicate(
  item: StructureNodeWorkItem,
  stack: StructureWorkItem[],
  state: ScanState
): void {
  const predicate = item.value as Record<string, unknown>
  // Predicate validation is a Zod union rather than a discriminated union. Inspect every field
  // that any branch may recurse into even when `op` itself is malformed, otherwise the schema
  // could still reach an attacker-controlled recursive child before reporting the bad literal.
  pushArrayChildren("predicate", predicate.items, `${item.path}.items`, item.depth, stack, state)
  if (state.issue) return
  if (Object.hasOwn(predicate, "item")) {
    stack.push({
      kind: "predicate",
      value: predicate.item,
      path: `${item.path}.item`,
      depth: item.depth + 1,
    })
  }

  const values = readArray(predicate.values, `${item.path}.values`, state)
  if (state.issue) return
  for (const [index, value] of values.entries()) {
    state.issue = findJsonValueIssue(value, `${item.path}.values[${index}]`, state)
    if (state.issue) return
  }
  if (Object.hasOwn(predicate, "value")) {
    state.issue = findJsonValueIssue(predicate.value, `${item.path}.value`, state)
  }
}

function enqueueExpansion(
  item: StructureNodeWorkItem,
  stack: StructureWorkItem[],
  state: ScanState
): void {
  const expansion = item.value as Record<string, unknown>
  readArray(expansion.orderBy, `${item.path}.orderBy`, state)
  if (state.issue) return
  pushArrayChildren("expansion", expansion.expand, `${item.path}.expand`, item.depth, stack, state)
}

function pushQueryInput(
  input: unknown,
  parent: StructureNodeWorkItem,
  stack: StructureWorkItem[]
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
  stack: StructureWorkItem[]
): void {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    stack.push({ kind, value: values[index], path: `${path}[${index}]`, depth: parentDepth + 1 })
  }
}

function pushArrayChildren(
  kind: "query" | "predicate" | "expansion",
  value: unknown,
  path: string,
  parentDepth: number,
  stack: StructureWorkItem[],
  state: ScanState
): void {
  const values = readArray(value, path, state)
  if (state.issue) return
  pushChildren(kind, values, path, parentDepth, stack)
}

function readArray(value: unknown, path: string, state: ScanState): readonly unknown[] {
  if (!Array.isArray(value)) return []
  addArrayEntries(value.length, path, state)
  return value
}

function addArrayEntries(count: number, path: string, state: ScanState): void {
  state.arrayEntries += count
  if (state.arrayEntries > OBJECT_QUERY_STRUCTURE_LIMITS.maxArrayEntries) {
    state.issue = issue(
      path,
      "query_array_entries_exceeded",
      `Object query exceeds the maximum of ${OBJECT_QUERY_STRUCTURE_LIMITS.maxArrayEntries} array entries`
    )
  }
}

function findJsonValueIssue(
  value: unknown,
  path: string,
  state: ScanState
): ObjectQueryStructureIssue | null {
  type JsonWorkItem =
    | {
        readonly kind: "value"
        readonly value: unknown
        readonly path: string
        readonly depth: number
      }
    | { readonly kind: "exit"; readonly value: object }

  const stack: JsonWorkItem[] = [{ kind: "value", value, path, depth: 0 }]
  const active = new Set<object>()
  while (stack.length > 0) {
    const item = stack.pop()
    if (!item) continue
    if (item.kind === "exit") {
      active.delete(item.value)
      continue
    }
    if (typeof item.value !== "object" || item.value === null) continue
    if (item.depth > OBJECT_QUERY_STRUCTURE_LIMITS.maxJsonValueDepth) {
      return issue(
        item.path,
        "query_json_value_depth_exceeded",
        `Object query JSON values exceed the maximum depth of ${OBJECT_QUERY_STRUCTURE_LIMITS.maxJsonValueDepth}`
      )
    }
    if (active.has(item.value)) {
      return issue(
        item.path,
        "cyclic_query_value",
        "Object query JSON values must not contain cycles"
      )
    }

    if (Array.isArray(item.value)) {
      if (
        state.jsonValueEntries + item.value.length >
        OBJECT_QUERY_STRUCTURE_LIMITS.maxJsonValueEntries
      ) {
        return jsonValueEntriesIssue(item.path)
      }
      state.jsonValueEntries += item.value.length
      active.add(item.value)
      stack.push({ kind: "exit", value: item.value })
      for (let index = item.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          kind: "value",
          value: item.value[index],
          path: `${item.path}[${index}]`,
          depth: item.depth + 1,
        })
      }
    } else {
      const objectValue = item.value as Record<string, unknown>
      let width = 0
      for (const key in objectValue) {
        if (!Object.hasOwn(objectValue, key)) continue
        width += 1
        if (state.jsonValueEntries + width > OBJECT_QUERY_STRUCTURE_LIMITS.maxJsonValueEntries) {
          return jsonValueEntriesIssue(item.path)
        }
      }
      state.jsonValueEntries += width
      active.add(item.value)
      stack.push({ kind: "exit", value: item.value })

      // Allocate keys only after proving the container is within the fixed bound. In particular,
      // an object that exceeds the remaining cumulative budget never reads its values or allocates
      // an entries array proportional to attacker-controlled input.
      const keys = Object.keys(objectValue)
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]!
        stack.push({
          kind: "value",
          value: objectValue[key],
          path: `${item.path}.${key}`,
          depth: item.depth + 1,
        })
      }
    }
  }
  return null
}

function jsonValueEntriesIssue(path: string): ObjectQueryStructureIssue {
  return issue(
    path,
    "query_json_value_entries_exceeded",
    `Object query JSON values exceed the maximum total of ${OBJECT_QUERY_STRUCTURE_LIMITS.maxJsonValueEntries} entries`
  )
}

function issue(path: string, code: string, message: string): ObjectQueryStructureIssue {
  return { path, code, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
