import { getAuthorizedOntologyView } from "../execution/authorized-object-reader"
import type { AuthorizedOntologyView } from "../objects/authorized-ontology-view"
import { ObjectQueryPlanningError, ObjectQueryValidationError } from "../objects/query/errors"
import type { ObjectExpansion } from "../objects/query/ir"
import { type ValidatedObjectQuery, validateObjectQuery } from "../objects/query/validate"
import type { Schema, ValueType } from "../ontology/types"
import type { SixbRuntimeContext } from "../runtime/types"
import type { ObjectRow } from "../storage/objects/types"
import { ArtifactRequestError } from "./errors"
import { ARTIFACT_LIMITS } from "./limits"
import type {
  ArtifactQuery,
  ArtifactQueryProperty,
  ArtifactQueryResult,
  ArtifactQuerySchema,
  ArtifactQueryShape,
} from "./queries"

/** Rows read per call to the reader, so a large result never comes back in one response. */
const PAGE_SIZE = 1_000

/**
 * Runs one of a version's queries as the runtime's caller, through their object reader: what they
 * cannot view refuses the query, and what they are not cleared for is left out of each row.
 *
 * The query was valid when it was published, but the ontology may have changed since: a query
 * that no longer validates, or no longer plans, is `query_invalid`. Rows are read a page at a
 * time, up to `ARTIFACT_LIMITS.maxQueryRows`, within any `limit` the query declares.
 */
export async function runArtifactQuery(
  runtime: Pick<SixbRuntimeContext, "ontology" | "objectReader">,
  name: string,
  query: ArtifactQuery
): Promise<ArtifactQueryResult> {
  try {
    const shape = describeArtifactQuery(runtime, query)

    if (query.kind === "facets") {
      const { total, facets } = await runtime.objectReader.facet({
        query: query.query,
        facets: query.facets,
      })
      return { kind: "facets", total, facets, ...shape }
    }

    return { kind: "objects", ...(await readRows(runtime, query.query)), ...shape }
  } catch (error) {
    throw queryInvalid(name, error)
  }
}

/**
 * What a query returns and reads, and what its rows hold as the runtime's caller may view them. It
 * throws what validating the query throws.
 */
export function describeArtifactQuery(
  runtime: Pick<SixbRuntimeContext, "ontology" | "objectReader">,
  query: ArtifactQuery
): ArtifactQueryShape {
  const validated = validateObjectQuery(query.query, { ontology: runtime.ontology })

  return {
    resultObjectTypeIds: [...validated.result.objectTypeIds],
    readObjectTypeIds: [...validated.touchedObjectTypeIds],
    schema: artifactQuerySchema(getAuthorizedOntologyView(runtime.objectReader), validated),
  }
}

/**
 * The properties of the types a validated query returns, and of those each link it expands on its
 * rows reaches, read from `view`: a reader is never told of a property their view leaves out. A
 * type the view leaves out adds none. Only the outermost expansions are read, where normalization
 * puts every expansion of the rows; one nested in another is not.
 */
export function artifactQuerySchema(
  view: AuthorizedOntologyView,
  validated: ValidatedObjectQuery
): ArtifactQuerySchema {
  const valueTypes = view.getValueTypesById()
  const results = validated.result.objectTypeIds
  const root = validated.query

  const links: Record<string, { properties: Record<string, ArtifactQueryProperty> }> = {}
  for (const expansion of root.kind === "expand" ? root.expansions : []) {
    links[expansion.linkId] = {
      properties: propertiesOf(view, expansionTargets(view, results, expansion), valueTypes),
    }
  }

  return { properties: propertiesOf(view, results, valueTypes), links }
}

function propertiesOf(
  view: AuthorizedOntologyView,
  objectTypeIds: readonly string[],
  valueTypes: ReadonlyMap<string, ValueType>
): Record<string, ArtifactQueryProperty> {
  const properties: Record<string, ArtifactQueryProperty> = {}

  for (const objectTypeId of objectTypeIds) {
    for (const property of view.getObjectTypeById(objectTypeId)?.properties ?? []) {
      properties[property.id] ??= queryProperty(property.schema, valueTypes)
    }
  }

  return properties
}

/** What an expansion reaches from the rows, as the validator resolves it, within the view. */
function expansionTargets(
  view: AuthorizedOntologyView,
  results: readonly string[],
  expansion: ObjectExpansion
): string[] {
  const targets = new Set<string>()

  if (expansion.direction === "outgoing") {
    for (const objectTypeId of results) {
      const link = view
        .getObjectTypeById(objectTypeId)
        ?.links.find((candidate) => candidate.id === expansion.linkId)
      if (!link || link.targetObjectTypeId === "*") continue

      for (const target of [link.targetObjectTypeId].flat()) targets.add(target)
    }
    return [...targets]
  }

  const sources =
    expansion.sourceObjectTypeId === undefined
      ? view.listObjectTypes()
      : [view.getObjectTypeById(expansion.sourceObjectTypeId)].filter((type) => type !== null)

  for (const source of sources) {
    const link = source.links.find((candidate) => candidate.id === expansion.linkId)
    if (!link) continue

    const reaches =
      link.targetObjectTypeId === "*" ||
      results.some((result) => view.isValidLinkTarget(link.targetObjectTypeId, result))
    if (reaches) targets.add(source.id)
  }
  return [...targets]
}

/** A property's schema as a value of a row holds it: a value type's resolved to its own. */
function queryProperty(
  schema: Schema,
  valueTypes: ReadonlyMap<string, ValueType>,
  depth = 0
): ArtifactQueryProperty {
  if (typeof schema === "string") return { type: schema }

  switch (schema.type) {
    case "valueTypeRef": {
      const named = valueTypes.get(schema.valueTypeId)?.schema ?? schema._resolved
      // A value type naming itself, through others or not, holds what nothing else says.
      return named && depth < 8 ? queryProperty(named, valueTypes, depth + 1) : { type: "object" }
    }
    case "enum":
      return { type: "enum", valueType: schema.valueType }
    default:
      return { type: schema.type }
  }
}

async function readRows(
  runtime: Pick<SixbRuntimeContext, "objectReader">,
  query: ArtifactQuery["query"]
): Promise<{ objects: ObjectRow[]; total: number; truncated: boolean }> {
  const objects: ObjectRow[] = []
  let total = 0
  let pageToken: string | undefined

  for (;;) {
    // The last page asks only for what fits under the cap, and says whether more remain.
    const pageSize = Math.min(PAGE_SIZE, ARTIFACT_LIMITS.maxQueryRows - objects.length)
    const first = pageToken === undefined

    const page = await runtime.objectReader.executeQuery({
      query: { kind: "page", input: query, pageSize, ...(pageToken ? { pageToken } : {}) },
      ...(first ? { includeTotal: true } : {}),
    })

    if (first) total = page.total ?? page.objects.length
    objects.push(...page.objects)

    if (!page.hasMore || page.nextPageToken === undefined) {
      return { objects, total, truncated: false }
    }
    if (objects.length >= ARTIFACT_LIMITS.maxQueryRows) {
      return { objects, total, truncated: true }
    }

    pageToken = page.nextPageToken
  }
}

/** A query the ontology no longer admits, in the words validation gives; anything else as is. */
function queryInvalid(name: string, error: unknown): unknown {
  if (!(error instanceof ObjectQueryValidationError || error instanceof ObjectQueryPlanningError)) {
    return error
  }

  const issues = error.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")
  const problem =
    error instanceof ObjectQueryValidationError
      ? "no longer matches the ontology"
      : "can no longer run"

  return new ArtifactRequestError("query_invalid", `[Sixb] Query '${name}' ${problem}: ${issues}`)
}
