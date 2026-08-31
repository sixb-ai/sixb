import { type AuthorizationContext, assertAuthorized } from "../../authorization"
import type { RuntimeAuthorization } from "../../execution/types"
import type { OntologyRegistry } from "../../ontology"
import type {
  CountObjectsResult,
  ExistsObjectsResult,
  ExpandedLinkValue,
  ExpandedObjectRow,
  FacetObjectsResult,
  ObjectBatchKey,
  ObjectFacetRequest,
  ObjectFacetResult,
  ObjectQueryCapabilities,
  ObjectReadStorage,
  ObjectRow,
  ObjectRowLinks,
  QueryObjectsResult,
} from "../../storage"
import { linkBatchKey, objectBatchKey } from "../../storage"
import {
  ObjectQueryExecutionError,
  ObjectQueryPlanningError,
  ObjectQueryValidationError,
} from "./errors"
import type {
  ObjectExpansion,
  ObjectQuery,
  ObjectQueryPredicate,
  ObjectQueryResultShape,
  ObjectQuerySortField,
} from "./ir"
import { normalizeObjectQuery } from "./normalize"
import { type ObjectQueryPlan, type ObjectQueryPlanningOptions, planObjectQuery } from "./planner"
import { compareQueryScalarValues, queryScalarValuesEqual } from "./scalar-values"
import {
  type ObjectQueryValidationIssue,
  resolveObjectQueryResultShape,
  type ValidatedObjectQuery,
  validateObjectQuery,
} from "./validate"

export interface QueryExecutorOptions
  extends Omit<
    ObjectQueryPlanningOptions,
    | "capabilities"
    | "operation"
    | "hasQueryObjects"
    | "hasCountObjects"
    | "hasExistsObjects"
    | "hasFacetObjects"
  > {
  ontology: OntologyRegistry
  storage: ObjectReadStorage
  maxLimit?: number
  maxPageSize?: number
  maxRefs?: number
  maxFacetLimit?: number
  /**
   * Per-parent cap on how many links a single `expand` hydrates, applied as a
   * top-N trim after `orderBy` (mirrors `maxLimit` for the result set). An
   * expansion's own `limit` narrows this further; the cap is the backstop.
   */
  maxExpansionFanout?: number
  /** When present, every object type the query touches must be viewable. */
  authorization?: AuthorizationContext
  /** Registered execution capability for queries reached through a bound Sixb SDK. */
  runtimeAuthorization?: RuntimeAuthorization
}

export interface ExecuteObjectQueryInput {
  projectId: string
  query: ObjectQuery
  includeTotal?: boolean
}

export interface ExecuteObjectQueryResult extends QueryObjectsResult {
  plan: ObjectQueryPlan
}

export interface ExecuteObjectCountInput {
  projectId: string
  query: ObjectQuery
}

export interface ExecuteObjectCountResult extends CountObjectsResult {
  plan: ObjectQueryPlan
}

export interface ExecuteObjectExistsInput {
  projectId: string
  query: ObjectQuery
}

export interface ExecuteObjectExistsResult extends ExistsObjectsResult {
  plan: ObjectQueryPlan
}

export interface ExecuteObjectFacetsInput {
  projectId: string
  query: ObjectQuery
  facets: readonly ObjectFacetRequest[]
}

export interface ExecuteObjectFacetsResult extends FacetObjectsResult {
  plan: ObjectQueryPlan
}

type FallbackEntry = {
  row: ObjectRow
  order: number
}

type FallbackEvaluation = {
  entries: FallbackEntry[]
  total: number
  hasMore: boolean
  nextPageToken?: string
}

const DEFAULT_MAX_FALLBACK_ROWS = 1_000
const DEFAULT_MAX_FACET_LIMIT = 1_000
const DEFAULT_MAX_EXPANSION_FANOUT = 1_000

// Fallback page tokens are local to the core executor. Provider page tokens are
// opaque and should only be interpreted by the provider that returned them.
const PAGE_TOKEN_PREFIX = "offset:"

export async function executeObjectQuery(
  input: ExecuteObjectQueryInput,
  options: QueryExecutorOptions
): Promise<ExecuteObjectQueryResult> {
  const normalized = normalizeObjectQuery(input.query)
  const validated = validateObjectQuery(normalized, {
    ontology: options.ontology,
    maxLimit: options.maxLimit,
    maxPageSize: options.maxPageSize,
    maxRefs: options.maxRefs,
    normalize: false,
  })
  assertQueryViewable(input.projectId, validated, options)
  const capabilities = options.storage.queryCapabilities()
  const hasQueryObjects = typeof options.storage.queryObjects === "function"
  const hasCountObjects = typeof options.storage.countObjects === "function"
  const hasExistsObjects = typeof options.storage.existsObjects === "function"
  const hasFacetObjects = typeof options.storage.facetObjects === "function"
  const plannedQuery = expandPushdownQuery(
    validated.query,
    options.ontology,
    capabilities,
    {
      hasQueryObjects,
      hasCountObjects,
      hasExistsObjects,
      hasFacetObjects,
      allowFallback: options.allowFallback,
      maxFallbackRows: options.maxFallbackRows,
      requiresExplicitFallbackBound: options.requiresExplicitFallbackBound,
    },
    options.maxExpansionFanout
  )
  const plan = planObjectQuery(plannedQuery, {
    capabilities,
    hasQueryObjects,
    hasCountObjects,
    hasExistsObjects,
    hasFacetObjects,
    allowFallback: options.allowFallback,
    maxFallbackRows: options.maxFallbackRows,
    requiresExplicitFallbackBound: options.requiresExplicitFallbackBound,
  })

  if (plan.mode === "rejected") {
    throw new ObjectQueryPlanningError(plan.issues)
  }

  if (plan.mode === "pushdown") {
    if (!options.storage.queryObjects) {
      throw new ObjectQueryPlanningError(plan.providerIssues)
    }
    const result = await options.storage.queryObjects({
      projectId: input.projectId,
      query: plan.query,
      includeTotal: input.includeTotal,
    })
    return { ...result, plan }
  }

  // The planner admits only the small fallback subset; unsupported cases below
  // remain as defensive guards against future planner drift.
  const fallback = await executeFallbackQuery(input.projectId, validated.query, options, {
    includeTotal: input.includeTotal,
  })
  return { ...fallback, plan }
}

export async function countObjects(
  input: ExecuteObjectCountInput,
  options: QueryExecutorOptions
): Promise<ExecuteObjectCountResult> {
  const normalized = normalizeObjectQuery(input.query)
  const validated = validateObjectQuery(normalized, {
    ontology: options.ontology,
    maxLimit: options.maxLimit,
    maxPageSize: options.maxPageSize,
    maxRefs: options.maxRefs,
    normalize: false,
  })
  assertQueryViewable(input.projectId, validated, options)
  const capabilities = options.storage.queryCapabilities()
  const hasQueryObjects = typeof options.storage.queryObjects === "function"
  const hasCountObjects = typeof options.storage.countObjects === "function"
  const hasExistsObjects = typeof options.storage.existsObjects === "function"
  const hasFacetObjects = typeof options.storage.facetObjects === "function"
  const aggregateQuery = stripOuterRowShape(validated.query)
  const plannedQuery = expandPushdownQuery(aggregateQuery, options.ontology, capabilities, {
    operation: "countObjects",
    hasQueryObjects,
    hasCountObjects,
    hasExistsObjects,
    hasFacetObjects,
    allowFallback: options.allowFallback,
    maxFallbackRows: options.maxFallbackRows,
    requiresExplicitFallbackBound: options.requiresExplicitFallbackBound,
  })
  const plan = planObjectQuery(plannedQuery, {
    capabilities,
    operation: "countObjects",
    hasQueryObjects,
    hasCountObjects,
    hasExistsObjects,
    hasFacetObjects,
    allowFallback: options.allowFallback,
    maxFallbackRows: options.maxFallbackRows,
    requiresExplicitFallbackBound: options.requiresExplicitFallbackBound,
  })

  if (plan.mode === "rejected") {
    throw new ObjectQueryPlanningError(plan.issues)
  }

  if (plan.mode === "pushdown") {
    if (!options.storage.countObjects) {
      throw new ObjectQueryPlanningError(plan.providerIssues)
    }
    const result = await options.storage.countObjects({
      projectId: input.projectId,
      query: plan.query,
    })
    return { ...result, plan }
  }

  const maxRows = options.maxFallbackRows ?? DEFAULT_MAX_FALLBACK_ROWS
  const evaluation = await evaluateFallbackQuery(input.projectId, aggregateQuery, options, maxRows)
  return { count: evaluation.total, plan }
}

export async function existsObjects(
  input: ExecuteObjectExistsInput,
  options: QueryExecutorOptions
): Promise<ExecuteObjectExistsResult> {
  const normalized = normalizeObjectQuery(input.query)
  const validated = validateObjectQuery(normalized, {
    ontology: options.ontology,
    maxLimit: options.maxLimit,
    maxPageSize: options.maxPageSize,
    maxRefs: options.maxRefs,
    normalize: false,
  })
  assertQueryViewable(input.projectId, validated, options)
  const capabilities = options.storage.queryCapabilities()
  const hasQueryObjects = typeof options.storage.queryObjects === "function"
  const hasCountObjects = typeof options.storage.countObjects === "function"
  const hasExistsObjects = typeof options.storage.existsObjects === "function"
  const hasFacetObjects = typeof options.storage.facetObjects === "function"
  const aggregateQuery = stripOuterRowShape(validated.query)
  const plannedQuery = expandPushdownQuery(aggregateQuery, options.ontology, capabilities, {
    operation: "existsObjects",
    hasQueryObjects,
    hasCountObjects,
    hasExistsObjects,
    hasFacetObjects,
    allowFallback: options.allowFallback,
    maxFallbackRows: options.maxFallbackRows,
    requiresExplicitFallbackBound: options.requiresExplicitFallbackBound,
  })
  const plan = planObjectQuery(plannedQuery, {
    capabilities,
    operation: "existsObjects",
    hasQueryObjects,
    hasCountObjects,
    hasExistsObjects,
    hasFacetObjects,
    allowFallback: options.allowFallback,
    maxFallbackRows: options.maxFallbackRows,
    requiresExplicitFallbackBound: options.requiresExplicitFallbackBound,
  })

  if (plan.mode === "rejected") {
    throw new ObjectQueryPlanningError(plan.issues)
  }

  if (plan.mode === "pushdown") {
    if (!options.storage.existsObjects) {
      throw new ObjectQueryPlanningError(plan.providerIssues)
    }
    const result = await options.storage.existsObjects({
      projectId: input.projectId,
      query: plan.query,
    })
    return { ...result, plan }
  }

  const maxRows = options.maxFallbackRows ?? DEFAULT_MAX_FALLBACK_ROWS
  const evaluation = await evaluateFallbackQuery(input.projectId, aggregateQuery, options, maxRows)
  return { exists: evaluation.total > 0, plan }
}

export async function facetObjects(
  input: ExecuteObjectFacetsInput,
  options: QueryExecutorOptions
): Promise<ExecuteObjectFacetsResult> {
  const normalized = normalizeObjectQuery(input.query)
  const validated = validateObjectQuery(normalized, {
    ontology: options.ontology,
    maxLimit: options.maxLimit,
    maxPageSize: options.maxPageSize,
    maxRefs: options.maxRefs,
    normalize: false,
  })
  assertQueryViewable(input.projectId, validated, options)
  const facets = validateFacetRequests(input.facets, validated.result.objectTypeIds, options)
  const aggregateQuery = stripOuterRowShape(validated.query)
  const capabilities = options.storage.queryCapabilities()
  const hasQueryObjects = typeof options.storage.queryObjects === "function"
  const hasCountObjects = typeof options.storage.countObjects === "function"
  const hasExistsObjects = typeof options.storage.existsObjects === "function"
  const hasFacetObjects = typeof options.storage.facetObjects === "function"
  const plannedQuery = expandPushdownQuery(aggregateQuery, options.ontology, capabilities, {
    operation: "facetObjects",
    hasQueryObjects,
    hasCountObjects,
    hasExistsObjects,
    hasFacetObjects,
    allowFallback: options.allowFallback,
    maxFallbackRows: options.maxFallbackRows,
    requiresExplicitFallbackBound: options.requiresExplicitFallbackBound,
  })
  const plan = planObjectQuery(plannedQuery, {
    capabilities,
    operation: "facetObjects",
    hasQueryObjects,
    hasCountObjects,
    hasExistsObjects,
    hasFacetObjects,
    allowFallback: options.allowFallback,
    maxFallbackRows: options.maxFallbackRows,
    requiresExplicitFallbackBound: options.requiresExplicitFallbackBound,
  })

  if (plan.mode === "rejected") {
    throw new ObjectQueryPlanningError(plan.issues)
  }

  if (plan.mode === "pushdown") {
    if (!options.storage.facetObjects) {
      throw new ObjectQueryPlanningError(plan.providerIssues)
    }
    const result = await options.storage.facetObjects({
      projectId: input.projectId,
      query: plan.query,
      facets,
    })
    return { ...result, plan }
  }

  const maxRows = options.maxFallbackRows ?? DEFAULT_MAX_FALLBACK_ROWS
  const evaluation = await evaluateFallbackQuery(input.projectId, aggregateQuery, options, maxRows)
  return {
    facets: buildFacetResults(
      evaluation.entries.map((entry) => entry.row),
      facets
    ),
    plan,
  }
}

// Authorization happens at planning time: a scoped query must hold a view
// grant for every object type it touches, before any storage call runs.
function assertQueryViewable(
  projectId: string,
  validated: ValidatedObjectQuery,
  authorization: Pick<QueryExecutorOptions, "authorization" | "runtimeAuthorization">
): void {
  // The query engine is also a storage-level utility. Authorization is activated by a runtime
  // context; execution SDKs always provide a registered capability, including auth-disabled ones.
  if (!authorization.runtimeAuthorization && !authorization.authorization) return
  assertAuthorized(
    { projectId, ...authorization },
    {
      kind: "object.query",
      touchedObjectTypeIds: validated.touchedObjectTypeIds,
    }
  )
}

interface ExpansionResolutionContext {
  ontology: OntologyRegistry
  maxExpansionFanout: number | undefined
}

function expandPushdownQuery(
  query: ObjectQuery,
  ontology: OntologyRegistry,
  capabilities: ObjectQueryCapabilities,
  planning: Omit<ObjectQueryPlanningOptions, "capabilities">,
  maxExpansionFanout?: number
): ObjectQuery {
  // Resolve each expansion's cardinality and effective per-parent limit from the
  // ontology so a provider can push the graph read down without one. The planner
  // only admits expand pushdown once every expansion carries a cardinality, so a
  // mixed/unresolved expansion (e.g. a polymorphic parent whose branches
  // disagree) cleanly stays on the fallback.
  const ctx: ExpansionResolutionContext = { ontology, maxExpansionFanout }
  const annotated = resolveExpansions(query, ctx)
  const expanded = expandIncludeSubtypes(annotated, ontology)
  if (expanded === annotated) return annotated

  const plan = planObjectQuery(expanded, { ...planning, capabilities, allowFallback: false })
  return plan.mode === "pushdown" ? expanded : annotated
}

// Walk to the (normalized, outermost) expand node and annotate every expansion
// with its resolved cardinality and bounded limit. Output-shaping only — never
// changes which objects match — so it composes with `expandIncludeSubtypes`.
function resolveExpansions(query: ObjectQuery, ctx: ExpansionResolutionContext): ObjectQuery {
  switch (query.kind) {
    case "expand": {
      const parentShape = safeResultShape(query.input, ctx.ontology)
      return {
        ...query,
        input: resolveExpansions(query.input, ctx),
        expansions: query.expansions.map((expansion) =>
          annotateExpansion(expansion, parentShape, ctx)
        ),
      }
    }
    case "start":
    case "refs":
      return query
    case "set":
      return {
        ...query,
        inputs: query.inputs.map((input) => resolveExpansions(input, ctx)),
      }
    case "filter":
    case "text":
    case "vector":
    case "traverse":
    case "sort":
    case "limit":
    case "page":
    case "project":
      return { ...query, input: resolveExpansions(query.input, ctx) }
  }
}

function annotateExpansion(
  expansion: ObjectExpansion,
  parentShape: ObjectQueryResultShape,
  ctx: ExpansionResolutionContext
): ObjectExpansion {
  const cardinality = resolveUniformCardinality(expansion, parentShape, ctx.ontology)
  // Bake the per-parent top-N the provider must apply: the authored limit clamped
  // by the fanout backstop (the fallback computes the same via
  // `effectiveExpansionFanout`). Always defined afterwards, so the compiler need
  // not re-derive the cap.
  const limit = effectiveExpansionFanout(expansion.limit, ctx.maxExpansionFanout)
  const base: ObjectExpansion = cardinality
    ? { ...expansion, cardinality, limit }
    : { ...expansion, limit }

  if (!expansion.expand || expansion.expand.length === 0) return base

  const targetShape = resolveExpansionTargetShape(expansion, parentShape, ctx.ontology)
  return {
    ...base,
    expand: expansion.expand.map((nested) => annotateExpansion(nested, targetShape, ctx)),
  }
}

// The attached value shape is uniform only when every parent type resolves the
// link to the same cardinality. A non-declaring parent type contributes "many"
// (matching the fallback's `link?.cardinality ?? "many"`); incoming is always
// many-to-one. A mixed result returns undefined, keeping the query on fallback.
function resolveUniformCardinality(
  expansion: ObjectExpansion,
  parentShape: ObjectQueryResultShape,
  ontology: OntologyRegistry
): "one" | "many" | undefined {
  if (expansion.direction === "incoming") return "many"
  if (parentShape.objectTypeIds.length === 0) return undefined

  const cardinalities = new Set<"one" | "many">()
  for (const objectTypeId of parentShape.objectTypeIds) {
    const objectType = ontology.getObjectTypeById(objectTypeId)
    const link = objectType?.links.find((candidate) => candidate.id === expansion.linkId)
    cardinalities.add(link?.cardinality ?? "many")
  }
  return cardinalities.size === 1 ? [...cardinalities][0] : undefined
}

// The objects reached by an expansion are exactly the result of the equivalent
// traverse, so reuse the shared shape resolver instead of re-deriving link
// targets. Used to carry the parent context into nested expansions.
function resolveExpansionTargetShape(
  expansion: ObjectExpansion,
  parentShape: ObjectQueryResultShape,
  ontology: OntologyRegistry
): ObjectQueryResultShape {
  if (parentShape.objectTypeIds.length === 0) return { objectTypeIds: [] }

  const input: ObjectQuery =
    parentShape.objectTypeIds.length === 1
      ? { kind: "start", objectTypeId: parentShape.objectTypeIds[0] }
      : {
          kind: "set",
          op: "union",
          inputs: parentShape.objectTypeIds.map((objectTypeId) => ({
            kind: "start",
            objectTypeId,
          })),
        }
  const traverse: ObjectQuery = {
    kind: "traverse",
    input,
    linkId: expansion.linkId,
    direction: expansion.direction,
    ...(expansion.sourceObjectTypeId === undefined
      ? {}
      : { sourceObjectTypeId: expansion.sourceObjectTypeId }),
  }
  return safeResultShape(traverse, ontology)
}

// Cardinality resolution is a pushdown optimization, never a correctness
// requirement: any failure to resolve a shape (the resolver throws on a query it
// considers invalid) must degrade to "unresolved", which the planner reads as
// "keep this on the fallback" rather than surfacing an error.
function safeResultShape(query: ObjectQuery, ontology: OntologyRegistry): ObjectQueryResultShape {
  try {
    return resolveObjectQueryResultShape(query, { ontology })
  } catch {
    return { objectTypeIds: [] }
  }
}

function expandIncludeSubtypes(query: ObjectQuery, ontology: OntologyRegistry): ObjectQuery {
  switch (query.kind) {
    case "start": {
      if (query.includeSubtypes !== true) return query
      const objectTypeIds = [query.objectTypeId, ...ontology.listSubTypes(query.objectTypeId)]
      if (objectTypeIds.length === 1) return { kind: "start", objectTypeId: query.objectTypeId }
      return {
        kind: "set",
        op: "union",
        inputs: objectTypeIds.map((objectTypeId) => ({ kind: "start", objectTypeId })),
      }
    }
    case "refs":
      return query
    case "filter":
    case "text":
    case "vector":
    case "traverse":
    case "sort":
    case "limit":
    case "page":
    case "project":
    case "expand":
      return { ...query, input: expandIncludeSubtypes(query.input, ontology) }
    case "set":
      return {
        ...query,
        inputs: query.inputs.map((input) => expandIncludeSubtypes(input, ontology)),
      }
  }
}

async function executeFallbackQuery(
  projectId: string,
  query: ObjectQuery,
  options: QueryExecutorOptions,
  resultOptions: { includeTotal?: boolean }
): Promise<QueryObjectsResult> {
  const maxRows = options.maxFallbackRows ?? DEFAULT_MAX_FALLBACK_ROWS
  const evaluation = await evaluateFallbackQuery(projectId, query, options, maxRows)
  return {
    objects: evaluation.entries.map((entry) => entry.row),
    hasMore: evaluation.hasMore,
    nextPageToken: evaluation.nextPageToken,
    ...(resultOptions.includeTotal === false ? {} : { total: evaluation.total }),
  }
}

async function evaluateFallbackQuery(
  projectId: string,
  query: ObjectQuery,
  options: QueryExecutorOptions,
  maxRows: number
): Promise<FallbackEvaluation> {
  switch (query.kind) {
    case "start":
      return evaluateFallbackStart(projectId, query, options, maxRows)
    case "refs":
      return evaluateFallbackRefs(projectId, query, options)
    case "filter": {
      const input = await evaluateFallbackQuery(projectId, query.input, options, maxRows)
      return completeFallbackEvaluation(
        input.entries.filter((entry) => matchesPredicate(entry.row, query.predicate))
      )
    }
    case "sort": {
      const input = await evaluateFallbackQuery(projectId, query.input, options, maxRows)
      return {
        ...input,
        entries: sortEntries(input.entries, query.fields),
      }
    }
    case "limit": {
      const input = await evaluateFallbackQuery(projectId, query.input, options, maxRows)
      const limit = Math.max(0, query.limit)
      return {
        entries: input.entries.slice(0, limit),
        total: input.entries.length,
        hasMore: limit < input.entries.length,
      }
    }
    case "page": {
      const input = await evaluateFallbackQuery(projectId, query.input, options, maxRows)
      const offset = decodePageOffset(query.pageToken)
      const pageSize = Math.max(0, query.pageSize)
      const nextOffset = offset + pageSize
      const hasMore = pageSize > 0 && nextOffset < input.entries.length
      return {
        entries: input.entries.slice(offset, nextOffset),
        total: input.entries.length,
        hasMore,
        nextPageToken: hasMore ? encodePageOffset(nextOffset) : undefined,
      }
    }
    case "project": {
      const input = await evaluateFallbackQuery(projectId, query.input, options, maxRows)
      if (!query.properties) return input
      const properties = query.properties
      return {
        ...input,
        entries: input.entries.map((entry) => ({
          ...entry,
          row: projectRow(entry.row, properties),
        })),
      }
    }
    case "expand": {
      // `expand` is output-shaping and normalized to the outermost layer: the
      // input produces the bounded parent set, then we attach hydrated links
      // without changing which objects match.
      const input = await evaluateFallbackQuery(projectId, query.input, options, maxRows)
      const enriched = await hydrateExpansions(
        projectId,
        input.entries.map((entry) => entry.row),
        query.expansions,
        options
      )
      return {
        ...input,
        entries: input.entries.map((entry, index) => ({ ...entry, row: enriched[index] })),
      }
    }
    case "text":
    case "vector":
    case "traverse":
    case "set":
      throw new ObjectQueryExecutionError(
        "fallback_node_not_supported",
        `Fallback execution does not support query node '${query.kind}'`
      )
  }
}

async function evaluateFallbackRefs(
  projectId: string,
  query: Extract<ObjectQuery, { kind: "refs" }>,
  options: QueryExecutorOptions
): Promise<FallbackEvaluation> {
  const rows = await options.storage.getByPrimaryIdBatch({
    projectId,
    items: query.refs,
  })
  return completeFallbackEvaluation(
    query.refs.flatMap((ref, order) => {
      const row = rows.get(objectBatchKey(ref.objectTypeId, ref.primaryId))
      return row ? [{ row, order }] : []
    })
  )
}

/**
 * A candidate neighbour for one parent under a single expansion: the object to
 * hydrate plus the metadata carried on the link edge. For outgoing expansions
 * the neighbour is the link target; for incoming it is the link source.
 */
type ExpansionEdge = {
  neighborTypeId: string
  neighborId: string
  edgeProperties?: Record<string, unknown>
}

// Attach `links` to each parent row by hydrating every expansion over the batch
// storage primitives. Returns fresh rows — stored rows are read by reference, so
// we never mutate them in place.
async function hydrateExpansions(
  projectId: string,
  parents: readonly ObjectRow[],
  expansions: readonly ObjectExpansion[],
  options: QueryExecutorOptions
): Promise<ObjectRow[]> {
  if (expansions.length === 0) {
    return parents.map((parent) => ({ ...parent }))
  }

  const linksByParent: ObjectRowLinks[] = parents.map(() => ({}))
  for (const expansion of expansions) {
    const values = await hydrateExpansion(projectId, parents, expansion, options)
    values.forEach((value, index) => {
      // Keyed by link id, matching the `row.links.<linkId>` authoring surface.
      // Same-id expansions in opposing directions would collide here, but
      // normalization keeps them distinct and that pairing is not yet exposed.
      linksByParent[index][expansion.linkId] = value
    })
  }

  return parents.map((parent, index) => ({ ...parent, links: linksByParent[index] }))
}

// Resolve one expansion for every parent, returning a value aligned to `parents`.
async function hydrateExpansion(
  projectId: string,
  parents: readonly ObjectRow[],
  expansion: ObjectExpansion,
  options: QueryExecutorOptions
): Promise<ExpandedLinkValue[]> {
  const edgesByParent =
    expansion.direction === "incoming"
      ? await collectIncomingEdges(projectId, parents, expansion, options)
      : await collectOutgoingEdges(projectId, parents, expansion, options)

  // Ordering is against target properties, so the target rows must be loaded
  // before the per-parent top-N trim can run.
  const baseTargets = await fetchExpansionTargets(projectId, edgesByParent, options)
  const trimmedByParent = edgesByParent.map((edges) =>
    trimExpansionEdges(edges, expansion, baseTargets, options)
  )

  const enrichedByKey = await enrichExpansionTargets(
    projectId,
    trimmedByParent,
    baseTargets,
    expansion,
    options
  )

  return parents.map((parent, index) => {
    const expanded: ExpandedObjectRow[] = []
    for (const edge of trimmedByParent[index]) {
      const target = enrichedByKey.get(targetKey(edge.neighborTypeId, edge.neighborId))
      // A dangling link (target removed) hydrates to nothing.
      if (!target) continue
      expanded.push(
        edge.edgeProperties && Object.keys(edge.edgeProperties).length > 0
          ? { ...target, linkProperties: edge.edgeProperties }
          : { ...target }
      )
    }
    return toLinkValue(expanded, expansionCardinality(parent, expansion, options))
  })
}

async function collectOutgoingEdges(
  projectId: string,
  parents: readonly ObjectRow[],
  expansion: ObjectExpansion,
  options: QueryExecutorOptions
): Promise<ExpansionEdge[][]> {
  const linksByKey = await options.storage.listLinksBatch({
    projectId,
    items: parents.map((parent) => ({
      objectTypeId: parent.objectTypeId,
      objectId: parent.primaryId,
      linkId: expansion.linkId,
    })),
  })

  return parents.map((parent) => {
    const links = linksByKey.get(
      linkBatchKey(parent.objectTypeId, parent.primaryId, expansion.linkId)
    )
    if (!links) return []
    return links.map((link) => ({
      neighborTypeId: link.targetTypeId,
      neighborId: link.targetId,
      edgeProperties: link.properties,
    }))
  })
}

async function collectIncomingEdges(
  projectId: string,
  parents: readonly ObjectRow[],
  expansion: ObjectExpansion,
  options: QueryExecutorOptions
): Promise<ExpansionEdge[][]> {
  const linksByKey = await options.storage.listLinksBatch({
    projectId,
    direction: "incoming",
    items: parents.map((parent) => ({
      objectTypeId: parent.objectTypeId,
      objectId: parent.primaryId,
      linkId: expansion.linkId,
    })),
  })

  return parents.map((parent) => {
    const links = linksByKey.get(
      linkBatchKey(parent.objectTypeId, parent.primaryId, expansion.linkId)
    )
    if (!links) return []
    // For an incoming expansion the hydrated object is the link's source.
    return links
      .filter(
        (link) =>
          !expansion.sourceObjectTypeId || link.sourceTypeId === expansion.sourceObjectTypeId
      )
      .map((link) => ({
        neighborTypeId: link.sourceTypeId,
        neighborId: link.sourceId,
        edgeProperties: link.properties,
      }))
  })
}

async function fetchExpansionTargets(
  projectId: string,
  edgesByParent: readonly ExpansionEdge[][],
  options: QueryExecutorOptions
): Promise<ReadonlyMap<ObjectBatchKey, ObjectRow>> {
  const seen = new Set<ObjectBatchKey>()
  const items: { objectTypeId: string; primaryId: string }[] = []
  for (const edges of edgesByParent) {
    for (const edge of edges) {
      const key = targetKey(edge.neighborTypeId, edge.neighborId)
      if (seen.has(key)) continue
      seen.add(key)
      items.push({ objectTypeId: edge.neighborTypeId, primaryId: edge.neighborId })
    }
  }
  if (items.length === 0) return new Map()
  return options.storage.getByPrimaryIdBatch({ projectId, items })
}

// Recurse nested expansions over the unique retained targets so each target is
// hydrated once even when shared across parents, then key them for lookup.
async function enrichExpansionTargets(
  projectId: string,
  trimmedByParent: readonly ExpansionEdge[][],
  baseTargets: ReadonlyMap<ObjectBatchKey, ObjectRow>,
  expansion: ObjectExpansion,
  options: QueryExecutorOptions
): Promise<ReadonlyMap<ObjectBatchKey, ObjectRow>> {
  if (!expansion.expand || expansion.expand.length === 0) {
    return baseTargets
  }

  const uniqueTargets: ObjectRow[] = []
  const seen = new Set<string>()
  for (const edges of trimmedByParent) {
    for (const edge of edges) {
      const key = targetKey(edge.neighborTypeId, edge.neighborId)
      if (seen.has(key)) continue
      seen.add(key)
      const base = baseTargets.get(key)
      if (base) uniqueTargets.push(base)
    }
  }

  const enriched = await hydrateExpansions(projectId, uniqueTargets, expansion.expand, options)
  const enrichedByKey = new Map<ObjectBatchKey, ObjectRow>()
  for (const row of enriched) {
    enrichedByKey.set(targetKey(row.objectTypeId, row.primaryId), row)
  }
  return enrichedByKey
}

function trimExpansionEdges(
  edges: readonly ExpansionEdge[],
  expansion: ObjectExpansion,
  baseTargets: ReadonlyMap<ObjectBatchKey, ObjectRow>,
  options: QueryExecutorOptions
): ExpansionEdge[] {
  let ordered = edges
  if (expansion.orderBy && expansion.orderBy.length > 0) {
    const fields = expansion.orderBy
    ordered = [...edges].sort((left, right) =>
      compareExpansionEdges(left, right, fields, baseTargets)
    )
  }

  const limit = effectiveExpansionFanout(expansion.limit, options.maxExpansionFanout)
  return ordered.length > limit ? ordered.slice(0, limit) : [...ordered]
}

function effectiveExpansionFanout(
  limit: number | undefined,
  maxExpansionFanout: number | undefined
): number {
  const cap = maxExpansionFanout !== undefined ? maxExpansionFanout : DEFAULT_MAX_EXPANSION_FANOUT
  return limit !== undefined ? Math.min(limit, cap) : cap
}

function compareExpansionEdges(
  left: ExpansionEdge,
  right: ExpansionEdge,
  fields: readonly ObjectQuerySortField[],
  baseTargets: ReadonlyMap<ObjectBatchKey, ObjectRow>
): number {
  const leftRow = baseTargets.get(targetKey(left.neighborTypeId, left.neighborId))
  const rightRow = baseTargets.get(targetKey(right.neighborTypeId, right.neighborId))
  for (const field of fields) {
    const comparison = compareRowsBySortField(leftRow, rightRow, field)
    if (comparison !== 0) return comparison
  }
  // Identity tiebreak keeps the trim deterministic for equal sort keys.
  return targetKey(left.neighborTypeId, left.neighborId).localeCompare(
    targetKey(right.neighborTypeId, right.neighborId)
  )
}

function compareRowsBySortField(
  left: ObjectRow | undefined,
  right: ObjectRow | undefined,
  field: ObjectQuerySortField
): number {
  if (field.kind === "relevance") return 0

  const leftValue = left?.properties[field.propertyId]
  const rightValue = right?.properties[field.propertyId]
  const leftMissing = leftValue === undefined || leftValue === null
  const rightMissing = rightValue === undefined || rightValue === null
  if (leftMissing && rightMissing) return 0
  if (leftMissing) return 1
  if (rightMissing) return -1

  const comparison = compareQueryScalarValues(leftValue, rightValue, field.scalarKind)
  if (Number.isNaN(comparison)) return 0
  return field.direction === "desc" ? -comparison : comparison
}

// Outgoing cardinality comes from the parent type's link; incoming is inherently
// many-to-one, so an incoming expansion always yields an array.
function expansionCardinality(
  parent: ObjectRow,
  expansion: ObjectExpansion,
  options: QueryExecutorOptions
): "one" | "many" {
  if (expansion.direction === "incoming") return "many"
  const objectType = options.ontology.getObjectTypeById(parent.objectTypeId)
  const link = objectType?.links.find((candidate) => candidate.id === expansion.linkId)
  return link?.cardinality ?? "many"
}

function toLinkValue(
  rows: readonly ExpandedObjectRow[],
  cardinality: "one" | "many"
): ExpandedLinkValue {
  if (cardinality === "one") return rows[0] ?? null
  return rows
}

function targetKey(objectTypeId: string, id: string): ObjectBatchKey {
  return objectBatchKey(objectTypeId, id)
}

async function evaluateFallbackStart(
  projectId: string,
  query: Extract<ObjectQuery, { kind: "start" }>,
  options: QueryExecutorOptions,
  maxRows: number
): Promise<FallbackEvaluation> {
  const objectTypeIds = query.includeSubtypes
    ? [query.objectTypeId, ...options.ontology.listSubTypes(query.objectTypeId)]
    : [query.objectTypeId]

  const result = await options.storage.list({
    projectId,
    objectTypeId: objectTypeIds,
    limit: maxRows + 1,
    orderBy: "primaryId",
    order: "asc",
  })
  // Request one extra row so the executor can prove the source scan stayed
  // within its bound even when the storage backend does not return total counts.
  if (result.objects.length > maxRows || result.hasMore || result.total > maxRows) {
    throw new ObjectQueryExecutionError(
      "fallback_row_limit_exceeded",
      `Fallback start '${query.objectTypeId}' exceeded maxFallbackRows=${maxRows}`,
      "$.start"
    )
  }

  return completeFallbackEvaluation(
    result.objects.map((row, index) => ({
      row,
      order: index,
    }))
  )
}

function completeFallbackEvaluation(entries: FallbackEntry[]): FallbackEvaluation {
  return {
    entries,
    total: entries.length,
    hasMore: false,
  }
}

function matchesPredicate(row: ObjectRow, predicate: ObjectQueryPredicate): boolean {
  switch (predicate.op) {
    case "and":
      return predicate.items.every((item) => matchesPredicate(row, item))
    case "or":
      return predicate.items.some((item) => matchesPredicate(row, item))
    case "not":
      return !matchesPredicate(row, predicate.item)
    case "eq":
      return queryScalarValuesEqual(
        row.properties[predicate.propertyId],
        predicate.value,
        predicate.scalarKind
      )
    case "neq":
      return !queryScalarValuesEqual(
        row.properties[predicate.propertyId],
        predicate.value,
        predicate.scalarKind
      )
    case "lt":
      return (
        compareQueryScalarValues(
          row.properties[predicate.propertyId],
          predicate.value,
          predicate.scalarKind
        ) < 0
      )
    case "lte":
      return (
        compareQueryScalarValues(
          row.properties[predicate.propertyId],
          predicate.value,
          predicate.scalarKind
        ) <= 0
      )
    case "gt":
      return (
        compareQueryScalarValues(
          row.properties[predicate.propertyId],
          predicate.value,
          predicate.scalarKind
        ) > 0
      )
    case "gte":
      return (
        compareQueryScalarValues(
          row.properties[predicate.propertyId],
          predicate.value,
          predicate.scalarKind
        ) >= 0
      )
    case "in":
      return predicate.values.some((value) =>
        queryScalarValuesEqual(row.properties[predicate.propertyId], value, predicate.scalarKind)
      )
    case "exists": {
      const exists =
        Object.hasOwn(row.properties, predicate.propertyId) &&
        row.properties[predicate.propertyId] !== undefined
      return predicate.value ? exists : !exists
    }
    case "contains":
      return containsValue(row.properties[predicate.propertyId], predicate.value)
  }
}

function containsValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.includes(expected)
  }

  if (Array.isArray(actual)) {
    return actual.some((item) => queryScalarValuesEqual(item, expected))
  }

  if (isPlainObject(actual) && typeof expected === "string") {
    return Object.hasOwn(actual, expected)
  }

  return false
}

function sortEntries(
  entries: readonly FallbackEntry[],
  fields: readonly ObjectQuerySortField[]
): FallbackEntry[] {
  return [...entries].sort((left, right) => {
    for (const field of fields) {
      const comparison = compareSortField(left, right, field)
      if (comparison !== 0) return comparison
    }
    // Preserve storage order for true ties, then use identity as a deterministic
    // final fallback so tests and page tokens stay stable.
    return (
      left.order - right.order || rowIdentityKey(left.row).localeCompare(rowIdentityKey(right.row))
    )
  })
}

function compareSortField(
  left: FallbackEntry,
  right: FallbackEntry,
  field: ObjectQuerySortField
): number {
  if (field.kind === "relevance") return 0

  const leftValue = left.row.properties[field.propertyId]
  const rightValue = right.row.properties[field.propertyId]
  const leftMissing = leftValue === undefined || leftValue === null
  const rightMissing = rightValue === undefined || rightValue === null
  if (leftMissing && rightMissing) return 0
  if (leftMissing) return 1
  if (rightMissing) return -1

  const comparison = compareQueryScalarValues(leftValue, rightValue, field.scalarKind)
  if (Number.isNaN(comparison)) return 0
  return field.direction === "desc" ? -comparison : comparison
}

function projectRow(row: ObjectRow, properties: readonly string[]): ObjectRow {
  const projected: Record<string, unknown> = {}
  for (const propertyId of properties) {
    if (Object.hasOwn(row.properties, propertyId)) {
      projected[propertyId] = row.properties[propertyId]
    }
  }
  return { ...row, properties: projected }
}

function stripOuterRowShape(query: ObjectQuery): ObjectQuery {
  switch (query.kind) {
    case "limit":
    case "page":
    case "project":
    case "sort":
    // `expand` is output-shaping: it attaches links but does not change which
    // objects match, so aggregates (count/exists/facets) ignore it.
    case "expand":
      return stripOuterRowShape(query.input)
    default:
      return query
  }
}

function validateFacetRequests(
  facets: readonly ObjectFacetRequest[],
  objectTypeIds: readonly string[],
  options: QueryExecutorOptions
): ObjectFacetRequest[] {
  const issues: ObjectQueryValidationIssue[] = []
  const maxLimit = options.maxFacetLimit ?? DEFAULT_MAX_FACET_LIMIT

  if (facets.length === 0) {
    addFacetIssue(issues, "$.facets", "empty_facets", "At least one facet is required")
  }

  if (!Number.isInteger(maxLimit) || maxLimit <= 0) {
    addFacetIssue(
      issues,
      "$.maxFacetLimit",
      "invalid_facet_bound",
      "maxFacetLimit must be positive"
    )
  }

  const seenPropertyIds = new Set<string>()
  const normalizedFacets: ObjectFacetRequest[] = []

  facets.forEach((facet, index) => {
    const path = `$.facets[${index}]`
    const propertyId = typeof facet.propertyId === "string" ? facet.propertyId.trim() : ""

    if (!propertyId) {
      addFacetIssue(
        issues,
        `${path}.propertyId`,
        "missing_facet_property",
        "Facet propertyId is required"
      )
    } else if (seenPropertyIds.has(propertyId)) {
      addFacetIssue(
        issues,
        `${path}.propertyId`,
        "duplicate_facet",
        `Facet property '${propertyId}' is requested more than once`
      )
    } else {
      seenPropertyIds.add(propertyId)
    }

    if (!Number.isInteger(facet.limit) || facet.limit <= 0) {
      addFacetIssue(
        issues,
        `${path}.limit`,
        "invalid_facet_limit",
        "Facet limit must be a positive integer"
      )
    } else if (facet.limit > maxLimit) {
      addFacetIssue(
        issues,
        `${path}.limit`,
        "facet_limit_too_large",
        `Facet limit must be less than or equal to ${maxLimit}`
      )
    }

    if (!propertyId) return

    for (const objectTypeId of objectTypeIds) {
      const objectType = options.ontology.getObjectTypeById(objectTypeId)
      const property = objectType?.properties.find((candidate) => candidate.id === propertyId)

      if (!objectType || !property) {
        addFacetIssue(
          issues,
          `${path}.propertyId`,
          "unknown_facet_property",
          `Property '${propertyId}' is not defined on '${objectTypeId}'`
        )
        continue
      }

      if (property.query?.searchable !== true || property.query.facet !== true) {
        addFacetIssue(
          issues,
          `${path}.propertyId`,
          "property_not_facetable",
          `Property '${propertyId}' on '${objectTypeId}' must set query.searchable: true and query.facet: true before it can be used as a facet`
        )
      }
    }

    normalizedFacets.push({ propertyId, limit: facet.limit })
  })

  if (issues.length > 0) {
    throw new ObjectQueryValidationError(issues)
  }

  return normalizedFacets
}

function addFacetIssue(
  issues: ObjectQueryValidationIssue[],
  path: string,
  code: string,
  message: string
): void {
  issues.push({ path, code, message })
}

function buildFacetResults(
  rows: readonly ObjectRow[],
  facets: readonly ObjectFacetRequest[]
): ObjectFacetResult[] {
  return facets.map((facet) => ({
    propertyId: facet.propertyId,
    buckets: buildFacetBuckets(rows, facet),
  }))
}

function buildFacetBuckets(
  rows: readonly ObjectRow[],
  facet: ObjectFacetRequest
): ObjectFacetResult["buckets"] {
  const buckets = new Map<string, { value: unknown; count: number }>()

  for (const row of rows) {
    if (!Object.hasOwn(row.properties, facet.propertyId)) continue
    const value = row.properties[facet.propertyId]
    if (value === undefined) continue
    const key = facetValueKey(value)
    const existing = buckets.get(key)
    if (existing) {
      existing.count += 1
    } else {
      buckets.set(key, { value, count: 1 })
    }
  }

  return [...buckets.values()]
    .sort(
      (left, right) =>
        right.count - left.count ||
        facetValueSortKey(left.value).localeCompare(facetValueSortKey(right.value))
    )
    .slice(0, facet.limit)
}

function facetValueKey(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
}

function facetValueSortKey(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
}

function rowIdentityKey(row: ObjectRow): string {
  return objectBatchKey(row.objectTypeId, row.primaryId)
}

function encodePageOffset(offset: number): string {
  return `${PAGE_TOKEN_PREFIX}${offset}`
}

function decodePageOffset(token: string | undefined): number {
  if (!token) return 0
  if (!token.startsWith(PAGE_TOKEN_PREFIX)) {
    throw new ObjectQueryExecutionError(
      "invalid_page_token",
      "Fallback page token must use the offset token format"
    )
  }

  const offset = Number(token.slice(PAGE_TOKEN_PREFIX.length))
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ObjectQueryExecutionError(
      "invalid_page_token",
      "Fallback page token contains an invalid offset"
    )
  }
  return offset
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
