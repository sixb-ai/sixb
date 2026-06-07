/**
 * Fluent ObjectSet query builder.
 *
 * This is the TypeScript authoring layer for object queries. It builds the
 * provider-neutral object query IR and leaves validation, planning, fallback,
 * and execution to the shared query executor.
 */
import type { OntologyRegistry, ValueType } from "../../ontology"
import { OntologyValidationError } from "../../ontology/errors"
import type { LinkToken, ObjectTypeWithPropertyTokens, PropertyToken } from "../../ontology/tokens"
import type {
  ListResult,
  ListResultWithoutTotal,
  ObjectQueryBuilder,
  ObjectQueryFacetInput,
  ObjectQueryFacetResult,
  ObjectQueryListOptions,
  ObjectWhereBuilder,
  ObjectWhereClause,
  TwinObject,
} from "../../runtime/types"
import type { Storage } from "../../storage"
import {
  countObjects,
  executeObjectQuery,
  existsObjects,
  explainObjectQuery,
  facetObjects,
  formatObjectQueryExplanation,
  normalizeObjectQuery,
  type ObjectQuery,
  type ObjectQueryDirection,
  ObjectQueryPlanningError,
  type ObjectQuerySortDirection,
  validateObjectQuery,
} from "../query"
import { resolveWhere } from "./where"

type QueryBuilderParams<TObjectType extends ObjectTypeWithPropertyTokens> = {
  objectType: TObjectType
  projectId: string
  ontology: OntologyRegistry
  storage: Storage
  query: ObjectQuery
}

export function createObjectQueryBuilder<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TRegisteredObjectTypes extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
>(
  params: QueryBuilderParams<TObjectType>
): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes> {
  return new ObjectQueryBuilderImpl<TObjectType, TRegisteredObjectTypes, TValueTypes>(
    params
  ) as unknown as ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes>
}

class ObjectQueryBuilderImpl<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TRegisteredObjectTypes extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
> {
  constructor(private readonly params: QueryBuilderParams<TObjectType>) {}

  get ir(): ObjectQuery {
    return normalizeObjectQuery(this.params.query)
  }

  where(
    whereFn: (
      builder: ObjectWhereBuilder<TObjectType, TValueTypes>
    ) =>
      | ObjectWhereClause<TObjectType, TValueTypes>
      | readonly ObjectWhereClause<TObjectType, TValueTypes>[]
  ): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes> {
    const predicate = resolveWhere<TObjectType, TValueTypes>(this.params.objectType, whereFn)
    if (!predicate)
      return this as unknown as ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes>

    return this.withQuery({
      kind: "filter",
      input: this.ir,
      predicate,
    })
  }

  search(
    query: string,
    options?: { fields?: readonly PropertyToken<TObjectType["id"], string>[] }
  ): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes> {
    return this.withQuery({
      kind: "text",
      input: this.ir,
      query,
      fields: options?.fields?.map(propertyTokenToId),
    })
  }

  vector(
    property: PropertyToken<TObjectType["id"], string>,
    vector: readonly number[],
    options: { k: number }
  ): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes> {
    return this.withQuery({
      kind: "vector",
      input: this.ir,
      propertyId: property.id,
      vector,
      k: options.k,
    })
  }

  traverse(
    link: LinkToken<TObjectType["id"], string, string>,
    options?: { direction?: "outgoing" }
  ): ObjectQueryBuilder<ObjectTypeWithPropertyTokens, TRegisteredObjectTypes, TValueTypes>
  traverse(
    link: LinkToken<string, string, TObjectType["id"] | readonly TObjectType["id"][]>,
    options: { direction: "incoming" }
  ): ObjectQueryBuilder<ObjectTypeWithPropertyTokens, TRegisteredObjectTypes, TValueTypes>
  traverse(
    link: LinkToken,
    options: { direction?: ObjectQueryDirection } = {}
  ): ObjectQueryBuilder<ObjectTypeWithPropertyTokens, TRegisteredObjectTypes, TValueTypes> {
    const direction = options.direction ?? "outgoing"
    const nextObjectType = this.resolveTraverseObjectType(link, direction)

    return new ObjectQueryBuilderImpl<
      ObjectTypeWithPropertyTokens,
      TRegisteredObjectTypes,
      TValueTypes
    >({
      ...this.params,
      objectType: nextObjectType,
      query: {
        kind: "traverse",
        input: this.ir,
        linkId: link.id,
        direction,
      },
    }) as unknown as ObjectQueryBuilder<
      ObjectTypeWithPropertyTokens,
      TRegisteredObjectTypes,
      TValueTypes
    >
  }

  orderBy(
    property: PropertyToken<TObjectType["id"], string>,
    direction?: ObjectQuerySortDirection
  ): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes> {
    return this.withQuery(
      appendSortField(this.ir, {
        kind: "property",
        propertyId: property.id,
        direction,
      })
    )
  }

  orderByRelevance(
    direction?: ObjectQuerySortDirection
  ): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes> {
    return this.withQuery(
      appendSortField(this.ir, {
        kind: "relevance",
        direction,
      })
    )
  }

  limit(limit: number): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes> {
    return this.withQuery({
      kind: "limit",
      input: this.ir,
      limit,
    })
  }

  page(input: {
    pageSize: number
    pageToken?: string
  }): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes> {
    return this.withQuery({
      kind: "page",
      input: this.ir,
      pageSize: input.pageSize,
      pageToken: input.pageToken,
    })
  }

  validate() {
    return validateObjectQuery(this.ir, {
      ontology: this.params.ontology,
      normalize: false,
    })
  }

  explain() {
    return explainObjectQuery(this.ir, {
      ontology: this.params.ontology,
      normalize: false,
    })
  }

  formatExplanation(): string {
    return formatObjectQueryExplanation(this.explain())
  }

  async list(): Promise<ListResult<TwinObject<TObjectType, TValueTypes>>>
  async list(options: {
    includeTotal: false
  }): Promise<ListResultWithoutTotal<TwinObject<TObjectType, TValueTypes>>>
  async list(options: {
    includeTotal?: true
  }): Promise<ListResult<TwinObject<TObjectType, TValueTypes>>>
  async list(
    options?: ObjectQueryListOptions
  ): Promise<
    | ListResult<TwinObject<TObjectType, TValueTypes>>
    | ListResultWithoutTotal<TwinObject<TObjectType, TValueTypes>>
  > {
    return executeTypedObjectQuery<TObjectType, TValueTypes>({
      projectId: this.params.projectId,
      query: this.ir,
      storage: this.params.storage,
      ontology: this.params.ontology,
      sdkHints: true,
      includeTotal: options?.includeTotal,
    })
  }

  async count(): Promise<number> {
    const result = await countObjects(
      {
        projectId: this.params.projectId,
        query: this.ir,
      },
      { ontology: this.params.ontology, storage: this.params.storage.objects }
    )
    return result.count
  }

  async exists(): Promise<boolean> {
    const result = await existsObjects(
      {
        projectId: this.params.projectId,
        query: this.ir,
      },
      { ontology: this.params.ontology, storage: this.params.storage.objects }
    )
    return result.exists
  }

  async facets(
    input: readonly ObjectQueryFacetInput<TObjectType>[]
  ): Promise<ObjectQueryFacetResult[]> {
    const result = await facetObjects(
      {
        projectId: this.params.projectId,
        query: this.ir,
        facets: input.map((facet) => ({
          propertyId: facet.property.id,
          limit: facet.limit,
        })),
      },
      { ontology: this.params.ontology, storage: this.params.storage.objects }
    )
    return result.facets.map((facet) => ({
      propertyId: facet.propertyId,
      buckets: [...facet.buckets],
    }))
  }

  async first(): Promise<TwinObject<TObjectType, TValueTypes> | null> {
    const result = await executeTypedObjectQuery<TObjectType, TValueTypes>({
      projectId: this.params.projectId,
      query: { kind: "limit", input: this.ir, limit: 1 },
      storage: this.params.storage,
      ontology: this.params.ontology,
    })
    return result.objects[0] ?? null
  }

  private withQuery(
    query: ObjectQuery
  ): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes> {
    return new ObjectQueryBuilderImpl<TObjectType, TRegisteredObjectTypes, TValueTypes>({
      ...this.params,
      query,
    }) as unknown as ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes>
  }

  private resolveTraverseObjectType(link: LinkToken, direction: ObjectQueryDirection) {
    const objectTypeId =
      direction === "incoming" ? link.objectTypeId : resolveSingleTargetObjectTypeId(link)
    return this.params.ontology.resolveObjectType(objectTypeId)
  }
}

function appendSortField(
  query: ObjectQuery,
  field: Extract<ObjectQuery, { kind: "sort" }>["fields"][number]
): ObjectQuery {
  if (query.kind === "sort") {
    return {
      ...query,
      fields: [...query.fields, field],
    }
  }

  return {
    kind: "sort",
    input: query,
    fields: [field],
  }
}

function propertyTokenToId(token: PropertyToken): string {
  return token.id
}

function resolveSingleTargetObjectTypeId(link: LinkToken): string {
  const target = link.targetObjectTypeId
  if (target === "*" || typeof target !== "string") {
    throw new OntologyValidationError(
      "[Sixb] Object query traverse requires a single concrete outgoing target type"
    )
  }
  return target
}

async function executeTypedObjectQuery<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
>(params: {
  query: ObjectQuery
  ontology: OntologyRegistry
  projectId: string
  storage: Storage
  sdkHints?: boolean
  includeTotal?: boolean
}) {
  const result = await executeObjectQueryWithSdkHints(params)

  const objects = result.objects.map(
    (row) => row as unknown as TwinObject<TObjectType, TValueTypes>
  )

  if (params.includeTotal === false) {
    return {
      objects,
      hasMore: result.hasMore,
      nextPageToken: result.nextPageToken,
    }
  }

  return {
    objects,
    hasMore: result.hasMore,
    nextPageToken: result.nextPageToken,
    total: result.total ?? result.objects.length,
  }
}

async function executeObjectQueryWithSdkHints(params: {
  query: ObjectQuery
  ontology: OntologyRegistry
  projectId: string
  storage: Storage
  sdkHints?: boolean
  includeTotal?: boolean
}) {
  try {
    return await executeObjectQuery(
      {
        projectId: params.projectId,
        query: params.query,
        includeTotal: params.includeTotal,
      },
      { ontology: params.ontology, storage: params.storage.objects }
    )
  } catch (error) {
    if (params.sdkHints && error instanceof ObjectQueryPlanningError) {
      throw addSdkPlanningHints(error)
    }
    throw error
  }
}

function addSdkPlanningHints(error: ObjectQueryPlanningError): ObjectQueryPlanningError {
  if (!error.issues.some((issue) => issue.code === "fallback_requires_bound")) return error

  return new ObjectQueryPlanningError(
    error.issues.map((issue) =>
      issue.code === "fallback_requires_bound"
        ? {
            ...issue,
            message:
              "Object query fallback requires an explicit result bound. Add .limit(n) or .page({ pageSize: n }) before .list().",
          }
        : issue
    )
  )
}
