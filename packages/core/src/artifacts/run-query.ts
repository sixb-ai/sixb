import { ObjectQueryPlanningError, ObjectQueryValidationError } from "../objects/query/errors"
import { validateObjectQuery } from "../objects/query/validate"
import type { SixbRuntimeContext } from "../runtime/types"
import type { ObjectRow } from "../storage/objects/types"
import { ArtifactRequestError } from "./errors"
import { ARTIFACT_LIMITS } from "./limits"
import type { ArtifactQuery, ArtifactQueryResult } from "./queries"

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
    const validated = validateObjectQuery(query.query, { ontology: runtime.ontology })
    const shape = {
      resultObjectTypeIds: [...validated.result.objectTypeIds],
      readObjectTypeIds: [...validated.touchedObjectTypeIds],
    }

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
