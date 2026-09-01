import type {
  ObjectRef,
  ObjectType,
  OntologyRegistry,
  Property,
  Schema,
  ValueType,
} from "../../ontology"
import { normalizeDecimalValue } from "../../ontology"
import { formatUnknownObjectTypeMessage } from "../../ontology/errors"
import { validatePropertyValue, validateSchemaValue } from "../../ontology/validation"
import { assertObjectQueryComplexity } from "./complexity"
import { ObjectQueryValidationError } from "./errors"
import type {
  ObjectExpansion,
  ObjectQuery,
  ObjectQueryDirection,
  ObjectQueryPredicate,
  ObjectQueryResultShape,
  ObjectQuerySetOperation,
  ObjectQuerySortField,
  QueryScalarKind,
} from "./ir"
import { normalizeObjectQuery } from "./normalize"

export interface ObjectQueryValidationIssue {
  path: string
  code: string
  message: string
}

export interface ValidatedObjectQuery {
  query: ObjectQuery
  result: ObjectQueryResultShape
  /** Every object type the query touches, including intermediate traversal types. */
  touchedObjectTypeIds: readonly string[]
}

export interface ObjectQueryValidationOptions {
  ontology: OntologyRegistry
  maxLimit?: number
  maxPageSize?: number
  maxRefs?: number
  normalize?: boolean
}

/** Opaque semantic state carried by the canonical query validator for an internal admission. */
export type ObjectQueryAdmissionState = object

export type ObjectQueryPropertyUse =
  | "filter"
  | "text"
  | "vector"
  | "sort"
  | "project"
  | "expand.orderBy"
  | "facet"

export type ObjectQueryEdgeUse = "traverse" | "expand" | "queryLinks"

export interface ObjectQueryAdmissionTransition {
  readonly state: ObjectQueryAdmissionState
  /** Recorded during the walk and raised only after ordinary validation succeeds. */
  readonly denial?: Error
}

/**
 * Internal semantic admission reducer driven by the canonical query validator.
 *
 * It deliberately has no AST visitor: validation owns recursion through query nodes, predicates,
 * and expansions, while an admission only reduces the semantic sources, properties, edges, and
 * set operations it observes.
 */
export interface ObjectQuerySemanticAdmission {
  empty(): ObjectQueryAdmissionState
  source(input: {
    readonly kind: "start" | "refs"
    readonly result: ObjectQueryResultShape
    readonly objectTypeId?: string
    readonly refs?: readonly ObjectRef[]
    readonly path: string
  }): ObjectQueryAdmissionTransition
  property(input: {
    readonly state: ObjectQueryAdmissionState
    readonly propertyId: string
    readonly objectTypeId?: string
    readonly use: ObjectQueryPropertyUse
    readonly path: string
  }): Error | undefined
  edge(input: {
    readonly state: ObjectQueryAdmissionState
    /** Ontology-resolved shape after following this edge. */
    readonly result: ObjectQueryResultShape
    readonly linkId: string
    readonly direction: ObjectQueryDirection
    readonly sourceObjectTypeId?: string
    readonly use: ObjectQueryEdgeUse
    readonly path: string
  }): ObjectQueryAdmissionTransition
  set(input: {
    readonly op: ObjectQuerySetOperation
    readonly states: readonly ObjectQueryAdmissionState[]
    readonly path: string
  }): ObjectQueryAdmissionState
}

export interface AdmittedObjectQuery extends ValidatedObjectQuery {
  /** Root provenance for terminal-specific checks such as facets and physical link queries. */
  admissionState: ObjectQueryAdmissionState
}

type QueryValidationContext = Required<
  Pick<ObjectQueryValidationOptions, "maxLimit" | "maxPageSize" | "maxRefs">
> & {
  ontology: OntologyRegistry
  valueTypesById: ReadonlyMap<string, ValueType>
  issues: ObjectQueryValidationIssue[]
  touchedObjectTypeIds: Set<string>
  admission: ObjectQuerySemanticAdmission
  admissionDenials: Error[]
}

interface QueryNodeValidation {
  result: ObjectQueryResultShape
  query: ObjectQuery
}

interface QueryValidationResult extends QueryNodeValidation {
  admissionState: ObjectQueryAdmissionState
}

interface TextFieldResolution {
  fieldsByObjectType?: Record<string, string[]>
}

const DEFAULT_MAX_LIMIT = 1_000
const DEFAULT_MAX_PAGE_SIZE = 1_000
const DEFAULT_MAX_REFS = 1_000

const NOOP_ADMISSION_STATE = Object.freeze({})
const NOOP_QUERY_ADMISSION: ObjectQuerySemanticAdmission = Object.freeze({
  empty: () => NOOP_ADMISSION_STATE,
  source: () => ({ state: NOOP_ADMISSION_STATE }),
  property: () => undefined,
  edge: (input: Parameters<ObjectQuerySemanticAdmission["edge"]>[0]) => ({
    state: input.state,
  }),
  set: (input: Parameters<ObjectQuerySemanticAdmission["set"]>[0]) =>
    input.states[0] ?? NOOP_ADMISSION_STATE,
})

export function validateObjectQuery(
  query: ObjectQuery,
  options: ObjectQueryValidationOptions
): ValidatedObjectQuery {
  const admitted = validateObjectQueryWithAdmission(query, options, NOOP_QUERY_ADMISSION)
  return {
    query: admitted.query,
    result: admitted.result,
    touchedObjectTypeIds: admitted.touchedObjectTypeIds,
  }
}

/**
 * Validate and semantically admit one query in the same canonical walk.
 *
 * This is an internal direct-file API. It is intentionally absent from public query barrels.
 */
export function validateObjectQueryWithAdmission(
  query: ObjectQuery,
  options: ObjectQueryValidationOptions,
  admission: ObjectQuerySemanticAdmission
): AdmittedObjectQuery {
  if (options.normalize === false) assertObjectQueryComplexity(query)
  const normalized = options.normalize === false ? query : normalizeObjectQuery(query)
  const ctx = createValidationContext(options, admission)
  const validation = validateQueryNode(normalized, "$", ctx)

  if (ctx.issues.length > 0) {
    throw new ObjectQueryValidationError(ctx.issues)
  }
  const denial = ctx.admissionDenials[0]
  if (denial) throw denial

  return {
    query: validation.query,
    result: validation.result,
    touchedObjectTypeIds: [...ctx.touchedObjectTypeIds],
    admissionState: validation.admissionState,
  }
}

export function collectObjectQueryValidationIssues(
  query: ObjectQuery,
  options: ObjectQueryValidationOptions
): readonly ObjectQueryValidationIssue[] {
  let normalized: ObjectQuery
  try {
    if (options.normalize === false) assertObjectQueryComplexity(query)
    normalized = options.normalize === false ? query : normalizeObjectQuery(query)
  } catch (error) {
    if (error instanceof ObjectQueryValidationError) return error.issues
    throw error
  }
  const ctx = createValidationContext(options, NOOP_QUERY_ADMISSION)
  validateQueryNode(normalized, "$", ctx)
  return ctx.issues
}

export function resolveObjectQueryResultShape(
  query: ObjectQuery,
  options: ObjectQueryValidationOptions
): ObjectQueryResultShape {
  return validateObjectQuery(query, options).result
}

function createValidationContext(
  options: ObjectQueryValidationOptions,
  admission: ObjectQuerySemanticAdmission
): QueryValidationContext {
  return {
    ontology: options.ontology,
    valueTypesById: options.ontology.getValueTypesById(),
    maxLimit: options.maxLimit ?? DEFAULT_MAX_LIMIT,
    maxPageSize: options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE,
    maxRefs: options.maxRefs ?? DEFAULT_MAX_REFS,
    issues: [],
    touchedObjectTypeIds: new Set<string>(),
    admission,
    admissionDenials: [],
  }
}

function validateQueryNode(
  query: ObjectQuery,
  path: string,
  ctx: QueryValidationContext
): QueryValidationResult {
  const validation = dispatchQueryNode(query, path, ctx)

  // Record every intermediate result shape so callers can authorize all
  // object types a query touches, not just the types it returns.
  for (const objectTypeId of validation.result.objectTypeIds) {
    ctx.touchedObjectTypeIds.add(objectTypeId)
  }

  return validation
}

function dispatchQueryNode(
  query: ObjectQuery,
  path: string,
  ctx: QueryValidationContext
): QueryValidationResult {
  switch (query.kind) {
    case "start": {
      const validation = validateStart(query.objectTypeId, query.includeSubtypes, path, ctx)
      return {
        ...validation,
        admissionState: admitTransition(
          ctx,
          ctx.admission.source({
            kind: "start",
            result: validation.result,
            objectTypeId: query.objectTypeId,
            path,
          })
        ),
      }
    }
    case "refs": {
      const validation = validateRefs(query.refs, path, ctx)
      return {
        ...validation,
        admissionState: admitTransition(
          ctx,
          ctx.admission.source({
            kind: "refs",
            result: validation.result,
            refs: validation.query.kind === "refs" ? validation.query.refs : query.refs,
            path,
          })
        ),
      }
    }
    case "filter": {
      const input = validateQueryNode(query.input, `${path}.input`, ctx)
      const predicate = validatePredicate(
        query.predicate,
        input.result,
        input.admissionState,
        `${path}.predicate`,
        ctx
      )
      return {
        result: input.result,
        query: { ...query, input: input.query, predicate },
        admissionState: input.admissionState,
      }
    }
    case "text": {
      const input = validateQueryNode(query.input, `${path}.input`, ctx)
      const textFields = validateTextQuery(
        query.query,
        query.fields,
        input.result,
        input.admissionState,
        path,
        ctx
      )
      return {
        result: input.result,
        query: {
          ...query,
          input: input.query,
          fields: query.fields,
          fieldsByObjectType: query.fields ? undefined : textFields.fieldsByObjectType,
        },
        admissionState: input.admissionState,
      }
    }
    case "vector": {
      const input = validateQueryNode(query.input, `${path}.input`, ctx)
      validateVectorQuery(
        query.vector,
        query.propertyId,
        query.k,
        input.result,
        input.admissionState,
        path,
        ctx
      )
      return {
        result: input.result,
        query: { ...query, input: input.query },
        admissionState: input.admissionState,
      }
    }
    case "traverse": {
      const input = validateQueryNode(query.input, `${path}.input`, ctx)
      const result = validateTraverse(
        query.linkId,
        query.direction,
        query.sourceObjectTypeId,
        input.result,
        path,
        ctx
      )
      return {
        result,
        query: { ...query, input: input.query },
        admissionState: admitTransition(
          ctx,
          ctx.admission.edge({
            state: input.admissionState,
            result,
            linkId: query.linkId,
            direction: query.direction,
            sourceObjectTypeId: query.sourceObjectTypeId,
            use: "traverse",
            path,
          })
        ),
      }
    }
    case "set":
      return validateSet(query.inputs, query.op, path, ctx)
    case "sort": {
      const input = validateQueryNode(query.input, `${path}.input`, ctx)
      const fields = validateSortFields(
        query.fields,
        input.result,
        input.admissionState,
        "sort",
        path,
        ctx
      )
      return {
        result: input.result,
        query: { ...query, input: input.query, fields },
        admissionState: input.admissionState,
      }
    }
    case "limit": {
      const input = validateQueryNode(query.input, `${path}.input`, ctx)
      validateLimit(query.limit, path, ctx)
      return {
        result: input.result,
        query: { ...query, input: input.query },
        admissionState: input.admissionState,
      }
    }
    case "page": {
      const input = validateQueryNode(query.input, `${path}.input`, ctx)
      validatePage(query.pageSize, query.pageToken, path, ctx)
      return {
        result: input.result,
        query: { ...query, input: input.query },
        admissionState: input.admissionState,
      }
    }
    case "project": {
      const input = validateQueryNode(query.input, `${path}.input`, ctx)
      validateProjection(query.properties, input.result, input.admissionState, path, ctx)
      return {
        result: input.result,
        query: { ...query, input: input.query },
        admissionState: input.admissionState,
      }
    }
    case "expand": {
      const input = validateQueryNode(query.input, `${path}.input`, ctx)
      // expand is output-shaping: it attaches links without changing the matched
      // set, so the result type is the input's result type.
      const expansions = validateExpansions(
        query.expansions,
        input.result,
        input.admissionState,
        `${path}.expansions`,
        ctx
      )
      return {
        result: input.result,
        query: { ...query, input: input.query, expansions },
        admissionState: input.admissionState,
      }
    }
  }
}

function validateRefs(
  refs: readonly ObjectRef[],
  path: string,
  ctx: QueryValidationContext
): QueryNodeValidation {
  if (refs.length === 0) {
    addIssue(ctx, `${path}.refs`, "empty_refs", "refs must include at least one object reference")
  }
  if (refs.length > ctx.maxRefs) {
    addIssue(
      ctx,
      `${path}.refs`,
      "too_many_refs",
      `refs must include at most ${ctx.maxRefs} object references`
    )
  }

  const objectTypeIds = new Set<string>()
  refs.forEach((ref, index) => {
    const refPath = `${path}.refs[${index}]`
    if (!ref.objectTypeId) {
      addIssue(ctx, `${refPath}.objectTypeId`, "missing_object_type", "objectTypeId is required")
    } else if (!ctx.ontology.getObjectTypeById(ref.objectTypeId)) {
      addIssue(
        ctx,
        `${refPath}.objectTypeId`,
        "unknown_object_type",
        formatUnknownObjectTypeMessage(ref.objectTypeId)
      )
    } else {
      objectTypeIds.add(ref.objectTypeId)
    }

    if (!ref.primaryId) {
      addIssue(ctx, `${refPath}.primaryId`, "missing_primary_id", "primaryId is required")
    }
  })

  return {
    result: { objectTypeIds: [...objectTypeIds] },
    query: { kind: "refs", refs: refs.map((ref) => ({ ...ref })) },
  }
}

function validateStart(
  objectTypeId: string,
  includeSubtypes: boolean | undefined,
  path: string,
  ctx: QueryValidationContext
): QueryNodeValidation {
  if (!objectTypeId) {
    addIssue(ctx, path, "missing_object_type", "start.objectTypeId is required")
    return { result: { objectTypeIds: [] }, query: { kind: "start", objectTypeId } }
  }

  if (!ctx.ontology.getObjectTypeById(objectTypeId)) {
    addIssue(ctx, path, "unknown_object_type", formatUnknownObjectTypeMessage(objectTypeId))
    return { result: { objectTypeIds: [] }, query: { kind: "start", objectTypeId } }
  }

  const objectTypeIds = includeSubtypes
    ? uniqueStrings([objectTypeId, ...ctx.ontology.listSubTypes(objectTypeId)])
    : [objectTypeId]

  return { result: { objectTypeIds }, query: { kind: "start", objectTypeId, includeSubtypes } }
}

function validatePredicate(
  predicate: ObjectQueryPredicate,
  shape: ObjectQueryResultShape,
  admissionState: ObjectQueryAdmissionState,
  path: string,
  ctx: QueryValidationContext
): ObjectQueryPredicate {
  switch (predicate.op) {
    case "and":
    case "or":
      if (predicate.items.length === 0) {
        addIssue(
          ctx,
          path,
          "empty_predicate_group",
          `Predicate '${predicate.op}' must not be empty`
        )
      }
      return {
        ...predicate,
        items: predicate.items.map((item, index) =>
          validatePredicate(item, shape, admissionState, `${path}.items[${index}]`, ctx)
        ),
      }
    case "not":
      return {
        ...predicate,
        item: validatePredicate(predicate.item, shape, admissionState, `${path}.item`, ctx),
      }
    case "eq":
    case "neq":
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const { scalarKind: _authoredScalarKind, ...authoredPredicate } = predicate
      const scalarKind = resolveAndValidatePredicateProperty(
        predicate.propertyId,
        predicate.op,
        shape,
        path,
        ctx
      )
      validatePredicateValue(predicate.propertyId, predicate.value, shape, path, ctx)
      admitProperty(ctx, {
        state: admissionState,
        propertyId: predicate.propertyId,
        use: "filter",
        path,
      })
      return {
        ...authoredPredicate,
        value: normalizeObjectQueryValue(predicate.value, scalarKind),
        ...(scalarKind ? { scalarKind } : {}),
      }
    }
    case "in": {
      const { scalarKind: _authoredScalarKind, ...authoredPredicate } = predicate
      const scalarKind = resolveAndValidatePredicateProperty(
        predicate.propertyId,
        predicate.op,
        shape,
        path,
        ctx
      )
      if (predicate.values.length === 0) {
        addIssue(ctx, path, "empty_in_values", "Predicate 'in' must include at least one value")
      }
      predicate.values.forEach((value, index) => {
        validatePredicateValue(predicate.propertyId, value, shape, `${path}.values[${index}]`, ctx)
      })
      admitProperty(ctx, {
        state: admissionState,
        propertyId: predicate.propertyId,
        use: "filter",
        path,
      })
      return {
        ...authoredPredicate,
        values: predicate.values.map((value) => normalizeObjectQueryValue(value, scalarKind)),
        ...(scalarKind ? { scalarKind } : {}),
      }
    }
    case "exists":
      resolveAndValidatePredicateProperty(predicate.propertyId, predicate.op, shape, path, ctx)
      admitProperty(ctx, {
        state: admissionState,
        propertyId: predicate.propertyId,
        use: "filter",
        path,
      })
      if (typeof predicate.value !== "boolean") {
        addIssue(ctx, path, "invalid_exists_value", "Predicate 'exists' value must be boolean")
      }
      return predicate
    case "contains":
      resolveAndValidatePredicateProperty(predicate.propertyId, predicate.op, shape, path, ctx)
      validateContainsValue(predicate.propertyId, predicate.value, shape, path, ctx)
      admitProperty(ctx, {
        state: admissionState,
        propertyId: predicate.propertyId,
        use: "filter",
        path,
      })
      return predicate
  }
}

function resolveAndValidatePredicateProperty(
  propertyId: string,
  op: ObjectQueryPredicate["op"],
  shape: ObjectQueryResultShape,
  path: string,
  ctx: QueryValidationContext
): QueryScalarKind | undefined {
  const properties = getPropertiesForResult(propertyId, shape, path, ctx)
  if (properties.length === 0) return undefined
  const schemas: Schema[] = []

  for (const { objectType, property } of properties) {
    const schema = resolveSchemaForProperty(property, objectType.id, ctx, path)
    if (schema) schemas.push(schema)

    if (isPrimaryExactPredicate(property, op)) {
      continue
    }

    if (property.query?.searchable !== true || property.query.filterable !== true) {
      addIssue(
        ctx,
        path,
        "property_not_filterable",
        `Property '${propertyId}' on '${objectType.id}' must set query.searchable: true and query.filterable: true before it can be used in predicates`
      )
      continue
    }

    if (!schema) continue

    if ((op === "lt" || op === "lte" || op === "gt" || op === "gte") && !isSortableSchema(schema)) {
      addIssue(
        ctx,
        path,
        "operator_not_supported_for_schema",
        `Predicate '${op}' cannot be used with property '${propertyId}' on '${objectType.id}' because its schema is not orderable`
      )
    }

    if ((op === "eq" || op === "neq" || op === "in" || op === "exists") && !isExactSchema(schema)) {
      addIssue(
        ctx,
        path,
        "operator_not_supported_for_schema",
        `Predicate '${op}' cannot be used with property '${propertyId}' on '${objectType.id}' because its schema cannot be exact-matched`
      )
    }

    if (op === "contains" && !isContainsSchema(schema)) {
      addIssue(
        ctx,
        path,
        "operator_not_supported_for_schema",
        `Predicate 'contains' cannot be used with property '${propertyId}' on '${objectType.id}' because its schema is not string, array, or map`
      )
    }
  }

  if (op === "exists" || op === "contains") return undefined
  return resolveCommonQueryScalarKind(schemas, propertyId, path, ctx)
}

function normalizeObjectQueryValue(value: unknown, scalarKind: QueryScalarKind | undefined) {
  if (scalarKind !== "decimal" || typeof value !== "string") return value
  try {
    return normalizeDecimalValue(value)
  } catch {
    return value
  }
}

function resolveCommonQueryScalarKind(
  schemas: readonly Schema[],
  propertyId: string,
  path: string,
  ctx: QueryValidationContext
): QueryScalarKind | undefined {
  const scalarKinds = schemas.map(queryScalarKindForSchema)
  if (scalarKinds.length === 0 || scalarKinds.some((kind) => kind === undefined)) {
    return undefined
  }

  const resolvedKinds = new Set(scalarKinds)
  if (resolvedKinds.size === 1) return scalarKinds[0]

  addIssue(
    ctx,
    path,
    "incompatible_property_scalar_kinds",
    `Property '${propertyId}' resolves to incompatible scalar schemas: ${[...resolvedKinds].join(
      ", "
    )}`
  )
  return undefined
}

function queryScalarKindForSchema(schema: Schema): QueryScalarKind | undefined {
  if (typeof schema === "string") return schema === "fileRef" ? undefined : schema
  if (schema.type === "enum") return schema.valueType === "integer" ? "integer" : "string"
  return undefined
}

function validatePredicateValue(
  propertyId: string,
  value: unknown,
  shape: ObjectQueryResultShape,
  path: string,
  ctx: QueryValidationContext
): void {
  for (const { objectType, property } of getPropertiesForResult(propertyId, shape, path, ctx, {
    reportMissing: false,
  })) {
    try {
      validatePropertyValue(property, value, `${objectType.id}.${property.id}`, ctx.valueTypesById)
    } catch (error) {
      addIssue(
        ctx,
        path,
        "invalid_predicate_value",
        error instanceof Error
          ? error.message
          : `Invalid value for property '${property.id}' on '${objectType.id}'`
      )
    }
  }
}

function validateContainsValue(
  propertyId: string,
  value: unknown,
  shape: ObjectQueryResultShape,
  path: string,
  ctx: QueryValidationContext
): void {
  for (const { objectType, property } of getPropertiesForResult(propertyId, shape, path, ctx, {
    reportMissing: false,
  })) {
    const schema = resolveSchemaForProperty(property, objectType.id, ctx, path)
    if (!schema) continue

    if (typeof schema === "string") {
      if (schema === "string" || schema === "uuid") {
        if (typeof value !== "string") {
          addIssue(
            ctx,
            path,
            "invalid_contains_value",
            `Predicate 'contains' value for '${objectType.id}.${property.id}' must be a string`
          )
        }
      }
      continue
    }

    if (schema.type === "array") {
      try {
        validateSchemaValue(
          schema.items,
          value,
          `${objectType.id}.${property.id}[]`,
          ctx.valueTypesById
        )
      } catch (error) {
        addIssue(
          ctx,
          path,
          "invalid_contains_value",
          error instanceof Error
            ? error.message
            : `Invalid contains value for '${objectType.id}.${property.id}'`
        )
      }
      continue
    }

    if (schema.type === "map" && typeof value !== "string") {
      addIssue(
        ctx,
        path,
        "invalid_contains_value",
        `Predicate 'contains' value for '${objectType.id}.${property.id}' must be a map key string`
      )
    }
  }
}

function validateTextQuery(
  query: string,
  fields: readonly string[] | undefined,
  shape: ObjectQueryResultShape,
  admissionState: ObjectQueryAdmissionState,
  path: string,
  ctx: QueryValidationContext
): TextFieldResolution {
  if (query.trim().length === 0) {
    addIssue(ctx, path, "empty_text_query", "Text query must not be empty")
  }

  const fieldsByObjectType: Record<string, string[]> | undefined = fields ? undefined : {}

  for (const objectType of getObjectTypesForResult(shape, ctx)) {
    const fieldIds = fields ?? objectType.search?.defaultText
    if (!fieldIds || fieldIds.length === 0) {
      addIssue(
        ctx,
        path,
        "missing_text_fields",
        `Object type '${objectType.id}' must define search.defaultText or the text query must specify fields`
      )
      continue
    }

    if (fieldsByObjectType) fieldsByObjectType[objectType.id] = uniqueStrings(fieldIds)

    for (const fieldId of fieldIds) {
      admitProperty(ctx, {
        state: admissionState,
        propertyId: fieldId,
        objectTypeId: objectType.id,
        use: "text",
        path: `${path}.fields`,
      })
      const property = getProperty(objectType, fieldId)
      if (!property) {
        addIssue(
          ctx,
          path,
          "unknown_text_field",
          `Text query references unknown property '${fieldId}' on '${objectType.id}'`
        )
        continue
      }

      assertStaticSearchProperty(objectType.id, property, "text query", path, ctx)
      assertQueryFlag(objectType.id, property, "text", "text query", path, ctx)
      const schema = resolveSchemaForProperty(property, objectType.id, ctx, path)
      if (schema && !isTextSchema(schema)) {
        addIssue(
          ctx,
          path,
          "text_field_not_string_like",
          `Text query field '${fieldId}' on '${objectType.id}' must be string-like`
        )
      }
    }
  }

  return fieldsByObjectType ? { fieldsByObjectType } : {}
}

function validateVectorQuery(
  vector: readonly number[],
  propertyId: string,
  k: number,
  shape: ObjectQueryResultShape,
  admissionState: ObjectQueryAdmissionState,
  path: string,
  ctx: QueryValidationContext
): void {
  if (!Number.isInteger(k) || k <= 0) {
    addIssue(ctx, path, "invalid_vector_k", "Vector query k must be a positive integer")
  }

  if (vector.length === 0) {
    addIssue(ctx, path, "empty_vector", "Vector query vector must not be empty")
  }

  if (vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    addIssue(ctx, path, "invalid_vector_value", "Vector query vector values must be finite numbers")
  }

  for (const objectType of getObjectTypesForResult(shape, ctx)) {
    admitProperty(ctx, {
      state: admissionState,
      propertyId,
      objectTypeId: objectType.id,
      use: "vector",
      path,
    })
    const property = getProperty(objectType, propertyId)
    if (!property) {
      addIssue(
        ctx,
        path,
        "unknown_vector_property",
        `Vector query references unknown property '${propertyId}' on '${objectType.id}'`
      )
      continue
    }

    assertStaticSearchProperty(objectType.id, property, "vector query", path, ctx)
    assertQueryFlag(objectType.id, property, "vector", "vector query", path, ctx)

    if (objectType.search?.vector?.property !== propertyId) {
      addIssue(
        ctx,
        path,
        "vector_profile_missing",
        `Object type '${objectType.id}' must declare search.vector.property '${propertyId}' before vector search can use it`
      )
    }

    const schema = resolveSchemaForProperty(property, objectType.id, ctx, path)
    if (schema && !isVectorSchema(schema, ctx)) {
      addIssue(
        ctx,
        path,
        "vector_property_not_numeric_array",
        `Vector query property '${propertyId}' on '${objectType.id}' must be a numeric array`
      )
    }
  }
}

function validateTraverse(
  linkId: string,
  direction: "outgoing" | "incoming",
  sourceObjectTypeId: string | undefined,
  shape: ObjectQueryResultShape,
  path: string,
  ctx: QueryValidationContext
): ObjectQueryResultShape {
  if (!linkId) {
    addIssue(ctx, path, "missing_link_id", "traverse.linkId is required")
    return { objectTypeIds: [] }
  }

  if (direction === "outgoing") {
    if (sourceObjectTypeId !== undefined) {
      addIssue(
        ctx,
        path,
        "traverse_source_not_applicable",
        "traverse.sourceObjectTypeId only applies to incoming traversal"
      )
    }
    return validateOutgoingTraverse(linkId, shape, path, ctx)
  }

  return validateIncomingTraverse(linkId, sourceObjectTypeId, shape, path, ctx)
}

function validateOutgoingTraverse(
  linkId: string,
  shape: ObjectQueryResultShape,
  path: string,
  ctx: QueryValidationContext
): ObjectQueryResultShape {
  const targetTypeIds: string[] = []

  for (const objectType of getObjectTypesForResult(shape, ctx)) {
    const link = objectType.links.find((candidate) => candidate.id === linkId)
    if (!link) {
      addIssue(
        ctx,
        path,
        "unknown_link",
        `Outgoing traversal references unknown link '${linkId}' on '${objectType.id}'`
      )
      continue
    }

    if (link.targetObjectTypeId === "*") {
      addIssue(
        ctx,
        path,
        "wildcard_traverse_target",
        `Outgoing traversal over wildcard link '${objectType.id}.${linkId}' cannot infer a target object type`
      )
      continue
    }

    const declaredTargets = Array.isArray(link.targetObjectTypeId)
      ? link.targetObjectTypeId
      : [link.targetObjectTypeId]

    for (const targetId of declaredTargets) {
      if (!ctx.ontology.getObjectTypeById(targetId)) {
        addIssue(
          ctx,
          path,
          "unknown_link_target",
          `Outgoing traversal over '${objectType.id}.${linkId}' targets unknown object type '${targetId}'`
        )
      } else {
        targetTypeIds.push(targetId)
      }
    }
  }

  return { objectTypeIds: uniqueStrings(targetTypeIds) }
}

function validateIncomingTraverse(
  linkId: string,
  sourceObjectTypeId: string | undefined,
  shape: ObjectQueryResultShape,
  path: string,
  ctx: QueryValidationContext
): ObjectQueryResultShape {
  let candidateTypes = ctx.ontology.listObjectTypes()
  if (sourceObjectTypeId !== undefined) {
    const sourceType = ctx.ontology.getObjectTypeById(sourceObjectTypeId)
    if (!sourceType) {
      addIssue(
        ctx,
        path,
        "unknown_traverse_source",
        `Incoming traversal references unknown source object type '${sourceObjectTypeId}'`
      )
      return { objectTypeIds: [] }
    }
    candidateTypes = [sourceType]
  }

  const sourceTypeIds: string[] = []

  for (const sourceType of candidateTypes) {
    const link = sourceType.links.find((candidate) => candidate.id === linkId)
    if (!link) continue

    if (link.targetObjectTypeId === "*") {
      sourceTypeIds.push(sourceType.id)
      continue
    }

    const matches = shape.objectTypeIds.some((targetTypeId) =>
      ctx.ontology.isValidLinkTarget(link.targetObjectTypeId, targetTypeId)
    )
    if (matches) sourceTypeIds.push(sourceType.id)
  }

  if (sourceTypeIds.length === 0) {
    addIssue(
      ctx,
      path,
      "incoming_link_not_found",
      `Incoming traversal found no source object types with link '${linkId}' targeting ${shape.objectTypeIds.join(
        " | "
      )}`
    )
  }

  return { objectTypeIds: uniqueStrings(sourceTypeIds) }
}

function validateExpansions(
  expansions: readonly ObjectExpansion[],
  shape: ObjectQueryResultShape,
  admissionState: ObjectQueryAdmissionState,
  path: string,
  ctx: QueryValidationContext
): ObjectExpansion[] {
  return expansions.map((expansion, index) =>
    validateExpansion(expansion, shape, admissionState, `${path}[${index}]`, ctx)
  )
}

function validateExpansion(
  expansion: ObjectExpansion,
  shape: ObjectQueryResultShape,
  admissionState: ObjectQueryAdmissionState,
  path: string,
  ctx: QueryValidationContext
): ObjectExpansion {
  if (!expansion.linkId) {
    addIssue(ctx, path, "missing_expand_link", "expand.linkId is required")
    return expansion
  }

  const targetShape =
    expansion.direction === "incoming"
      ? resolveIncomingExpansionTargets(
          expansion.linkId,
          expansion.sourceObjectTypeId,
          shape,
          path,
          ctx
        )
      : resolveOutgoingExpansionTargets(
          expansion.linkId,
          expansion.sourceObjectTypeId,
          shape,
          path,
          ctx
        )
  const targetAdmissionState = admitTransition(
    ctx,
    ctx.admission.edge({
      state: admissionState,
      result: targetShape,
      linkId: expansion.linkId,
      direction: expansion.direction,
      sourceObjectTypeId: expansion.sourceObjectTypeId,
      use: "expand",
      path,
    })
  )

  // Expansion targets are touched types: the principal must be able to `view`
  // every type a query hydrates, exactly like `start`/`traverse`. `dispatch`'s
  // automatic fold only covers result types, and expansion targets are not in
  // the result — so add them here (recursively, via the nested call below).
  for (const targetTypeId of targetShape.objectTypeIds) {
    ctx.touchedObjectTypeIds.add(targetTypeId)
  }

  validateExpansionLimit(expansion.limit, path, ctx)
  const orderBy = expansion.orderBy
    ? validateSortFields(
        expansion.orderBy,
        targetShape,
        targetAdmissionState,
        "expand.orderBy",
        `${path}.orderBy`,
        ctx
      )
    : undefined
  const expand = expansion.expand
    ? validateExpansions(expansion.expand, targetShape, targetAdmissionState, `${path}.expand`, ctx)
    : undefined

  return { ...expansion, orderBy, expand }
}

function resolveOutgoingExpansionTargets(
  linkId: string,
  sourceObjectTypeId: string | undefined,
  shape: ObjectQueryResultShape,
  path: string,
  ctx: QueryValidationContext
): ObjectQueryResultShape {
  if (sourceObjectTypeId !== undefined) {
    addIssue(
      ctx,
      path,
      "expand_source_not_applicable",
      "expand.sourceObjectTypeId only applies to incoming expansion"
    )
  }

  const targetTypeIds: string[] = []
  let foundOnAnyType = false

  for (const objectType of getObjectTypesForResult(shape, ctx)) {
    const link = objectType.links.find((candidate) => candidate.id === linkId)
    if (!link) continue
    foundOnAnyType = true

    if (link.targetObjectTypeId === "*") {
      addIssue(
        ctx,
        path,
        "wildcard_expand_target",
        `Expansion over wildcard link '${objectType.id}.${linkId}' cannot infer a target object type`
      )
      continue
    }

    const declaredTargets = Array.isArray(link.targetObjectTypeId)
      ? link.targetObjectTypeId
      : [link.targetObjectTypeId]

    for (const targetId of declaredTargets) {
      if (!ctx.ontology.getObjectTypeById(targetId)) {
        addIssue(
          ctx,
          path,
          "unknown_expand_target",
          `Expansion over '${objectType.id}.${linkId}' targets unknown object type '${targetId}'`
        )
      } else {
        targetTypeIds.push(targetId)
      }
    }
  }

  // A link absent from every result type is the "abandoned by a later traverse"
  // case: expands hoist above traverse, so an expand on a type the traverse
  // replaced cannot resolve its link on the final result type.
  if (!foundOnAnyType) {
    addIssue(
      ctx,
      path,
      "unknown_expand_link",
      `Expansion references link '${linkId}' not present on result type ${shape.objectTypeIds.join(
        " | "
      )} (an expand abandoned by a later traverse?)`
    )
  }

  return { objectTypeIds: uniqueStrings(targetTypeIds) }
}

function resolveIncomingExpansionTargets(
  linkId: string,
  sourceObjectTypeId: string | undefined,
  shape: ObjectQueryResultShape,
  path: string,
  ctx: QueryValidationContext
): ObjectQueryResultShape {
  let candidateTypes = ctx.ontology.listObjectTypes()
  if (sourceObjectTypeId !== undefined) {
    const sourceType = ctx.ontology.getObjectTypeById(sourceObjectTypeId)
    if (!sourceType) {
      addIssue(
        ctx,
        path,
        "unknown_expand_source",
        `Incoming expansion references unknown source object type '${sourceObjectTypeId}'`
      )
      return { objectTypeIds: [] }
    }
    candidateTypes = [sourceType]
  }

  const sourceTypeIds: string[] = []

  for (const sourceType of candidateTypes) {
    const link = sourceType.links.find((candidate) => candidate.id === linkId)
    if (!link) continue

    if (link.targetObjectTypeId === "*") {
      sourceTypeIds.push(sourceType.id)
      continue
    }

    const matches = shape.objectTypeIds.some((targetTypeId) =>
      ctx.ontology.isValidLinkTarget(link.targetObjectTypeId, targetTypeId)
    )
    if (matches) sourceTypeIds.push(sourceType.id)
  }

  if (sourceTypeIds.length === 0) {
    addIssue(
      ctx,
      path,
      "incoming_expand_link_not_found",
      `Incoming expansion found no source object types with link '${linkId}' targeting ${shape.objectTypeIds.join(
        " | "
      )}`
    )
  }

  return { objectTypeIds: uniqueStrings(sourceTypeIds) }
}

function validateExpansionLimit(
  limit: number | undefined,
  path: string,
  ctx: QueryValidationContext
): void {
  if (limit === undefined) return
  if (!Number.isInteger(limit) || limit < 0) {
    addIssue(
      ctx,
      `${path}.limit`,
      "invalid_expand_limit",
      "expand.limit must be a non-negative integer"
    )
  }
}

function validateSet(
  inputs: readonly ObjectQuery[],
  op: "union" | "intersect" | "subtract",
  path: string,
  ctx: QueryValidationContext
): QueryValidationResult {
  if (inputs.length === 0) {
    addIssue(ctx, path, "empty_set", `Set operation '${op}' must include at least one input`)
    return {
      result: { objectTypeIds: [] },
      query: { kind: "set", op, inputs },
      admissionState: ctx.admission.empty(),
    }
  }

  const results = inputs.map((input, index) =>
    validateQueryNode(input, `${path}.inputs[${index}]`, ctx)
  )
  const first = results[0]?.result ?? { objectTypeIds: [] }
  const expected = keyForTypeIds(first.objectTypeIds)

  results.forEach((result, index) => {
    if (keyForTypeIds(result.result.objectTypeIds) !== expected) {
      addIssue(
        ctx,
        `${path}.inputs[${index}]`,
        "incompatible_set_input",
        `Set operation '${op}' inputs must produce the same object type set`
      )
    }
  })

  return {
    result: first,
    query: { kind: "set", op, inputs: results.map((result) => result.query) },
    admissionState: ctx.admission.set({
      op,
      states: results.map((result) => result.admissionState),
      path,
    }),
  }
}

function validateSortFields(
  fields: readonly ObjectQuerySortField[],
  shape: ObjectQueryResultShape,
  admissionState: ObjectQueryAdmissionState,
  use: Extract<ObjectQueryPropertyUse, "sort" | "expand.orderBy">,
  path: string,
  ctx: QueryValidationContext
): ObjectQuerySortField[] {
  if (fields.length === 0) {
    addIssue(ctx, path, "empty_sort", "Sort must include at least one field")
    return []
  }

  const seen = new Set<string>()
  return fields.map((field, index) => {
    if (field.direction && field.direction !== "asc" && field.direction !== "desc") {
      addIssue(
        ctx,
        `${path}.fields[${index}]`,
        "invalid_sort_direction",
        "Sort direction must be asc or desc"
      )
    }

    const key = field.kind === "property" ? `property:${field.propertyId}` : "relevance"
    if (seen.has(key)) {
      addIssue(
        ctx,
        `${path}.fields[${index}]`,
        "duplicate_sort_field",
        `Duplicate sort field '${key}'`
      )
    }
    seen.add(key)

    if (field.kind === "relevance") return field

    admitProperty(ctx, {
      state: admissionState,
      propertyId: field.propertyId,
      use,
      path: `${path}.fields[${index}]`,
    })

    const { scalarKind: _authoredScalarKind, ...authoredField } = field

    const schemas: Schema[] = []

    for (const { objectType, property } of getPropertiesForResult(
      field.propertyId,
      shape,
      `${path}.fields[${index}]`,
      ctx
    )) {
      if (property.query?.searchable !== true || property.query.sortable !== true) {
        addIssue(
          ctx,
          `${path}.fields[${index}]`,
          "property_not_sortable",
          `Property '${property.id}' on '${objectType.id}' must set query.searchable: true and query.sortable: true before it can be sorted`
        )
        continue
      }

      const schema = resolveSchemaForProperty(
        property,
        objectType.id,
        ctx,
        `${path}.fields[${index}]`
      )
      if (schema) schemas.push(schema)
      if (schema && !isSortableSchema(schema)) {
        addIssue(
          ctx,
          `${path}.fields[${index}]`,
          "sort_field_not_orderable",
          `Sort field '${property.id}' on '${objectType.id}' is not orderable`
        )
      }
    }

    const scalarKind = resolveCommonQueryScalarKind(
      schemas,
      field.propertyId,
      `${path}.fields[${index}]`,
      ctx
    )
    return { ...authoredField, ...(scalarKind ? { scalarKind } : {}) }
  })
}

function validateLimit(limit: number, path: string, ctx: QueryValidationContext): void {
  if (!Number.isInteger(limit) || limit < 0) {
    addIssue(ctx, path, "invalid_limit", "limit must be a non-negative integer")
  } else if (limit > ctx.maxLimit) {
    addIssue(ctx, path, "limit_too_large", `limit must be <= ${ctx.maxLimit}`)
  }
}

function validatePage(
  pageSize: number,
  pageToken: string | undefined,
  path: string,
  ctx: QueryValidationContext
): void {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    addIssue(ctx, path, "invalid_page_size", "pageSize must be a positive integer")
  } else if (pageSize > ctx.maxPageSize) {
    addIssue(ctx, path, "page_size_too_large", `pageSize must be <= ${ctx.maxPageSize}`)
  }

  if (pageToken !== undefined && pageToken.length === 0) {
    addIssue(ctx, path, "empty_page_token", "pageToken must not be empty when provided")
  }
}

function validateProjection(
  properties: readonly string[] | undefined,
  shape: ObjectQueryResultShape,
  admissionState: ObjectQueryAdmissionState,
  path: string,
  ctx: QueryValidationContext
): void {
  if (!properties) return
  if (properties.length === 0) {
    addIssue(ctx, path, "empty_projection", "project.properties must not be empty when provided")
  }

  const seen = new Set<string>()
  properties.forEach((propertyId, index) => {
    admitProperty(ctx, {
      state: admissionState,
      propertyId,
      use: "project",
      path: `${path}.properties[${index}]`,
    })
    if (seen.has(propertyId)) {
      addIssue(
        ctx,
        `${path}.properties[${index}]`,
        "duplicate_projection_property",
        `Duplicate projected property '${propertyId}'`
      )
    }
    seen.add(propertyId)
    getPropertiesForResult(propertyId, shape, `${path}.properties[${index}]`, ctx)
  })
}

function getObjectTypesForResult(
  shape: ObjectQueryResultShape,
  ctx: QueryValidationContext
): ObjectType[] {
  const objectTypes: ObjectType[] = []
  for (const objectTypeId of shape.objectTypeIds) {
    const objectType = ctx.ontology.getObjectTypeById(objectTypeId)
    if (objectType) objectTypes.push(objectType)
  }
  return objectTypes
}

function getPropertiesForResult(
  propertyId: string,
  shape: ObjectQueryResultShape,
  path: string,
  ctx: QueryValidationContext,
  options: { reportMissing?: boolean } = {}
): { objectType: ObjectType; property: Property }[] {
  const results: { objectType: ObjectType; property: Property }[] = []

  for (const objectType of getObjectTypesForResult(shape, ctx)) {
    const property = getProperty(objectType, propertyId)
    if (!property) {
      if (options.reportMissing === false) {
        continue
      }
      addIssue(
        ctx,
        path,
        "unknown_property",
        `Property '${propertyId}' does not exist on object type '${objectType.id}'`
      )
      continue
    }
    results.push({ objectType, property })
  }

  return results
}

function getProperty(objectType: ObjectType, propertyId: string): Property | undefined {
  return objectType.properties.find((property) => property.id === propertyId)
}

function assertStaticSearchProperty(
  objectTypeId: string,
  property: Property,
  context: string,
  path: string,
  ctx: QueryValidationContext
): void {
  if (property.mode === "telemetry") {
    addIssue(
      ctx,
      path,
      "telemetry_search_property",
      `${context} references telemetry property '${property.id}' on '${objectTypeId}'. Search can only reference static properties because telemetry latest values are not object-query indexed.`
    )
  }
}

function assertQueryFlag(
  objectTypeId: string,
  property: Property,
  flag: "text" | "vector",
  context: string,
  path: string,
  ctx: QueryValidationContext
): void {
  if (property.query?.searchable === true && property.query[flag] === true) return
  addIssue(
    ctx,
    path,
    "query_field_not_enabled",
    `${context} field '${property.id}' on '${objectTypeId}' must set query.searchable: true and query.${flag}: true`
  )
}

function resolveSchemaForProperty(
  property: Property,
  objectTypeId: string,
  ctx: QueryValidationContext,
  path: string
): Schema | null {
  try {
    return resolveSchema(property.schema, ctx.valueTypesById)
  } catch (error) {
    addIssue(
      ctx,
      path,
      "unresolved_property_schema",
      error instanceof Error
        ? error.message
        : `Could not resolve schema for '${objectTypeId}.${property.id}'`
    )
    return null
  }
}

function resolveSchema(
  schema: Schema,
  valueTypesById: ReadonlyMap<string, ValueType>,
  seenValueTypeIds = new Set<string>()
): Schema {
  if (typeof schema === "string") return schema
  if (schema.type !== "valueTypeRef") return schema
  if (seenValueTypeIds.has(schema.valueTypeId)) {
    throw new Error(`Circular valueTypeRef '${schema.valueTypeId}'`)
  }

  const resolved = schema._resolved ?? valueTypesById.get(schema.valueTypeId)?.schema
  if (!resolved) {
    throw new Error(`Unknown valueTypeRef '${schema.valueTypeId}'`)
  }

  seenValueTypeIds.add(schema.valueTypeId)
  return resolveSchema(resolved, valueTypesById, seenValueTypeIds)
}

function isPrimaryExactPredicate(property: Property, op: ObjectQueryPredicate["op"]): boolean {
  return property.primary === true && (op === "eq" || op === "in")
}

function isTextSchema(schema: Schema): boolean {
  if (schema === "string") return true
  return typeof schema !== "string" && schema.type === "enum" && schema.valueType === "string"
}

function isExactSchema(schema: Schema): boolean {
  if (typeof schema === "string") return schema !== "fileRef"
  return schema.type === "enum"
}

function isSortableSchema(schema: Schema): boolean {
  if (typeof schema === "string") {
    return (
      schema === "string" ||
      schema === "uuid" ||
      schema === "integer" ||
      schema === "double" ||
      schema === "decimal" ||
      schema === "date" ||
      schema === "timestamp"
    )
  }
  return schema.type === "enum"
}

function isContainsSchema(schema: Schema): boolean {
  return (
    schema === "string" ||
    schema === "uuid" ||
    (typeof schema !== "string" && (schema.type === "array" || schema.type === "map"))
  )
}

function isVectorSchema(schema: Schema, ctx: QueryValidationContext): boolean {
  if (typeof schema === "string") return false
  if (schema.type !== "array") return false
  const itemSchema = resolveSchema(schema.items, ctx.valueTypesById)
  return itemSchema === "integer" || itemSchema === "double" || itemSchema === "decimal"
}

function keyForTypeIds(typeIds: readonly string[]): string {
  return uniqueStrings(typeIds).sort().join("\0")
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function admitTransition(
  ctx: QueryValidationContext,
  transition: ObjectQueryAdmissionTransition
): ObjectQueryAdmissionState {
  if (transition.denial) recordAdmissionDenial(ctx, transition.denial)
  return transition.state
}

function admitProperty(
  ctx: QueryValidationContext,
  input: Parameters<ObjectQuerySemanticAdmission["property"]>[0]
): void {
  const denial = ctx.admission.property(input)
  if (denial) recordAdmissionDenial(ctx, denial)
}

function recordAdmissionDenial(ctx: QueryValidationContext, denial: Error): void {
  // Only the first deterministic denial is observable. Keep walking so ordinary validation keeps
  // priority, but do not retain attacker-controlled messages for every rejected field or edge.
  if (ctx.admissionDenials.length === 0) ctx.admissionDenials.push(denial)
}

function addIssue(ctx: QueryValidationContext, path: string, code: string, message: string): void {
  ctx.issues.push({ path, code, message })
}
