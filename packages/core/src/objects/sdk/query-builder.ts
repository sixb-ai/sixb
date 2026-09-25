/**
 * Fluent ObjectSet query builder.
 *
 * This is the TypeScript authoring layer for object queries. It builds the
 * provider-neutral object query IR and delegates execution to an
 * `ObjectQueryExecutor` — the server runtime executor or the HTTP client
 * executor — so the same builder serves both sides.
 */
import { OntologyValidationError } from "../../ontology/errors"
import type { LinkToken, ObjectTypeWithPropertyTokens, PropertyToken } from "../../ontology/tokens"
import type {
  ListResult,
  ListResultWithoutTotal,
  ObjectExpandBuilder,
  ObjectExpandOptions,
  ObjectQueryBuilder,
  ObjectQueryFacetInput,
  ObjectQueryFacetResult,
  ObjectQueryListOptions,
  ObjectWhereBuilder,
  ObjectWhereClause,
  TwinObject,
} from "../../runtime/types"
import { formatObjectQueryExplanation } from "../query/explain-format"
import type {
  ObjectExpansion,
  ObjectQuery,
  ObjectQueryDirection,
  ObjectQuerySortDirection,
  ObjectQuerySortField,
} from "../query/ir"
import { normalizeObjectQuery } from "../query/normalize"
import type { ObjectQueryExecutor } from "./query-executor"
import { resolveWhere } from "./where"

type QueryBuilderParams = {
  query: ObjectQuery
  executor: ObjectQueryExecutor
}

export function createObjectQueryBuilder<TObjectType extends ObjectTypeWithPropertyTokens>(
  params: QueryBuilderParams
): ObjectQueryBuilder<TObjectType> {
  return new ObjectQueryBuilderImpl<TObjectType>(
    params
  ) as unknown as ObjectQueryBuilder<TObjectType>
}

class ObjectQueryBuilderImpl<TObjectType extends ObjectTypeWithPropertyTokens> {
  constructor(private readonly params: QueryBuilderParams) {}

  get ir(): ObjectQuery {
    return normalizeObjectQuery(this.params.query)
  }

  where(
    whereFn: (
      builder: ObjectWhereBuilder<TObjectType>
    ) => ObjectWhereClause<TObjectType> | readonly ObjectWhereClause<TObjectType>[]
  ): ObjectQueryBuilder<TObjectType> {
    const predicate = resolveWhere<TObjectType>(whereFn)
    if (!predicate) return this as unknown as ObjectQueryBuilder<TObjectType>

    return this.withQuery({
      kind: "filter",
      input: this.ir,
      predicate,
    })
  }

  search(
    query: string,
    options?: { fields?: readonly PropertyToken<TObjectType["id"], string>[] }
  ): ObjectQueryBuilder<TObjectType> {
    return this.withQuery({
      kind: "text",
      input: this.ir,
      query,
      fields: options?.fields?.map(propertyTokenToId),
    })
  }

  vector(profile: string, vector: string, options: { k: number }): ObjectQueryBuilder<TObjectType> {
    if (typeof profile !== "string" || typeof vector !== "string") {
      throw new Error("[Sixb] Vector search requires a named profile and search text")
    }
    return this.withQuery({
      kind: "vector",
      input: this.ir,
      profile,
      vector,
      k: options.k,
    })
  }

  traverse(
    link: LinkToken<TObjectType["id"], string, string>,
    options?: { direction?: "outgoing" }
  ): ObjectQueryBuilder<ObjectTypeWithPropertyTokens>
  traverse(
    link: LinkToken<string, string, TObjectType["id"] | readonly TObjectType["id"][]>,
    options: { direction: "incoming" }
  ): ObjectQueryBuilder<ObjectTypeWithPropertyTokens>
  traverse(
    link: LinkToken,
    options: { direction?: ObjectQueryDirection } = {}
  ): ObjectQueryBuilder<ObjectTypeWithPropertyTokens> {
    const direction = options.direction ?? "outgoing"
    if (direction === "outgoing") {
      requireSingleTargetObjectTypeId(link)
    }

    return new ObjectQueryBuilderImpl<ObjectTypeWithPropertyTokens>({
      ...this.params,
      query: {
        kind: "traverse",
        input: this.ir,
        linkId: link.id,
        direction,
        // Several object types can declare a link with the same id. The token
        // names exactly one source type, so incoming traversal pins it —
        // matching the result type the fluent API advertises.
        ...(direction === "incoming" ? { sourceObjectTypeId: link.objectTypeId } : {}),
      },
    }) as unknown as ObjectQueryBuilder<ObjectTypeWithPropertyTokens>
  }

  expand(
    link: LinkToken<string, string, string | readonly string[]>,
    optionsOrBuild?: ObjectExpandOptions<ObjectTypeWithPropertyTokens> | NestedExpandBuild,
    build?: NestedExpandBuild
  ): ObjectQueryBuilder<TObjectType> {
    return this.withQuery({
      kind: "expand",
      input: this.ir,
      expansions: [buildExpansion(link, optionsOrBuild, build)],
    })
  }

  orderBy(
    property: PropertyToken<TObjectType["id"], string>,
    direction?: ObjectQuerySortDirection
  ): ObjectQueryBuilder<TObjectType> {
    return this.withQuery(
      appendSortField(this.ir, {
        kind: "property",
        propertyId: property.id,
        direction,
      })
    )
  }

  orderByRelevance(direction?: ObjectQuerySortDirection): ObjectQueryBuilder<TObjectType> {
    return this.withQuery(
      appendSortField(this.ir, {
        kind: "relevance",
        direction,
      })
    )
  }

  limit(limit: number): ObjectQueryBuilder<TObjectType> {
    return this.withQuery({
      kind: "limit",
      input: this.ir,
      limit,
    })
  }

  page(input: { pageSize: number; pageToken?: string }): ObjectQueryBuilder<TObjectType> {
    return this.withQuery({
      kind: "page",
      input: this.ir,
      pageSize: input.pageSize,
      pageToken: input.pageToken,
    })
  }

  validate() {
    if (!this.params.executor.validate) {
      throw new OntologyValidationError(
        "[Sixb] validate() requires ontology access and is not supported by this query executor. Execute the query to get server-side validation."
      )
    }
    return this.params.executor.validate(this.ir)
  }

  explain() {
    if (!this.params.executor.explain) {
      throw new OntologyValidationError(
        "[Sixb] explain() requires ontology access and is not supported by this query executor."
      )
    }
    return this.params.executor.explain(this.ir)
  }

  formatExplanation(): string {
    return formatObjectQueryExplanation(this.explain())
  }

  async list(): Promise<ListResult<TwinObject<TObjectType>>>
  async list(options: {
    includeTotal: false
    signal?: AbortSignal
  }): Promise<ListResultWithoutTotal<TwinObject<TObjectType>>>
  async list(options: {
    includeTotal?: true
    signal?: AbortSignal
  }): Promise<ListResult<TwinObject<TObjectType>>>
  async list(
    options?: ObjectQueryListOptions
  ): Promise<
    ListResult<TwinObject<TObjectType>> | ListResultWithoutTotal<TwinObject<TObjectType>>
  > {
    const result = await this.params.executor.list(this.ir, {
      includeTotal: options?.includeTotal,
      signal: options?.signal,
    })
    const objects = result.objects.map((row) => row as unknown as TwinObject<TObjectType>)

    if (options?.includeTotal === false) {
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

  async count(): Promise<number> {
    return this.params.executor.count(this.ir)
  }

  async exists(): Promise<boolean> {
    return this.params.executor.exists(this.ir)
  }

  async facets(
    input: readonly ObjectQueryFacetInput<TObjectType>[]
  ): Promise<ObjectQueryFacetResult[]> {
    return this.params.executor.facets(
      this.ir,
      input.map((facet) => ({
        propertyId: facet.property.id,
        limit: facet.limit,
      }))
    )
  }

  async first(): Promise<TwinObject<TObjectType> | null> {
    const result = await this.params.executor.list({ kind: "limit", input: this.ir, limit: 1 })
    const row = result.objects[0]
    return row ? (row as unknown as TwinObject<TObjectType>) : null
  }

  private withQuery(query: ObjectQuery): ObjectQueryBuilder<TObjectType> {
    return new ObjectQueryBuilderImpl<TObjectType>({
      ...this.params,
      query,
    }) as unknown as ObjectQueryBuilder<TObjectType>
  }
}

type AnyExpandBuilder = ObjectExpandBuilder<ObjectTypeWithPropertyTokens>
type NestedExpandBuild = (nested: AnyExpandBuilder) => AnyExpandBuilder

/**
 * Runtime backing for the nested `.expand(..., (e) => …)` callback. Immutable,
 * mirroring the query builder: each `expand` returns a new instance so the
 * accumulated expansions are never shared between branches.
 */
class ObjectExpandBuilderImpl {
  constructor(readonly expansions: readonly ObjectExpansion[] = []) {}

  expand(
    link: LinkToken<string, string, string | readonly string[]>,
    optionsOrBuild?: ObjectExpandOptions<ObjectTypeWithPropertyTokens> | NestedExpandBuild,
    build?: NestedExpandBuild
  ): ObjectExpandBuilderImpl {
    return new ObjectExpandBuilderImpl([
      ...this.expansions,
      buildExpansion(link, optionsOrBuild, build),
    ])
  }
}

function buildExpansion(
  link: LinkToken<string, string, string | readonly string[]>,
  optionsOrBuild: ObjectExpandOptions<ObjectTypeWithPropertyTokens> | NestedExpandBuild | undefined,
  build: NestedExpandBuild | undefined
): ObjectExpansion {
  // `.expand(link, build)` and `.expand(link, options, build)` are both valid:
  // a function in the second slot is the nested builder, otherwise it is options.
  const options = typeof optionsOrBuild === "function" ? undefined : optionsOrBuild
  const nestedBuild = typeof optionsOrBuild === "function" ? optionsOrBuild : build

  let nested: readonly ObjectExpansion[] = []
  if (nestedBuild) {
    const result = nestedBuild(new ObjectExpandBuilderImpl() as unknown as AnyExpandBuilder)
    nested = (result as unknown as ObjectExpandBuilderImpl).expansions
  }

  return {
    linkId: link.id,
    direction: "outgoing",
    ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    ...(options?.orderBy ? { orderBy: options.orderBy.map(expansionSortToField) } : {}),
    ...(nested.length > 0 ? { expand: nested } : {}),
  }
}

function expansionSortToField(sort: {
  property: PropertyToken
  direction?: ObjectQuerySortDirection
}): ObjectQuerySortField {
  return { kind: "property", propertyId: sort.property.id, direction: sort.direction }
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

function requireSingleTargetObjectTypeId(link: LinkToken): void {
  const target = link.targetObjectTypeId
  if (target === "*" || typeof target !== "string") {
    throw new OntologyValidationError(
      "[Sixb] Object query traverse requires a single concrete outgoing target type"
    )
  }
}
