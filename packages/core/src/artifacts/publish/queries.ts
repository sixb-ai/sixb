import { AuthorizationError } from "../../authorization/errors"
import {
  ObjectQueryExecutionError,
  ObjectQueryPlanningError,
  ObjectQueryValidationError,
} from "../../objects/query/errors"
import type { SixbRuntimeContext } from "../../runtime/types"
import type { ArtifactFile } from "../../storage/artifacts/types"
import type { ArtifactKind } from "../kinds"
import { ARTIFACT_LIMITS } from "../limits"
import {
  ARTIFACT_QUERIES_DIRECTORY,
  ARTIFACT_QUERY_KINDS,
  type ArtifactQuery,
  artifactQueryName,
  parseArtifactQuery,
} from "../queries"
import { type ArtifactBlobStorage, invalidArtifact, readArtifactText } from "./files"

/**
 * Admits a query as the version's author: it throws what running it as them would throw. A
 * version is refused when its author could not run one of its queries, so a query never reads
 * what whoever wrote it cannot. Each reader still runs it with their own rights.
 */
export type ArtifactQueryChecker = (query: ArtifactQuery) => Promise<void>

/**
 * The checker for the runtime's caller. Running the query once, as cheaply as its kind allows,
 * is the check: validation against the ontology, `can.view` on every type it reads, clearance for
 * every marked property it filters, sorts or facets on, and the caller's share scope all apply
 * there, as they do when it is read.
 */
export function createArtifactQueryChecker(
  runtime: Pick<SixbRuntimeContext, "objectReader">
): ArtifactQueryChecker {
  return async (query) => {
    if (query.kind === "facets") {
      await runtime.objectReader.facet({ query: query.query, facets: query.facets })
      return
    }

    await runtime.objectReader.exists({ query: query.query })
  }
}

/**
 * Checks the `queries/` files of a version: their names and number, their shape, then each one as
 * its author through `checker`. Fails closed: a version that holds a query is refused without one.
 * A file artifact is delivered as it is, so its one file is never read as a query.
 */
export async function checkArtifactQueries(
  blobStorage: ArtifactBlobStorage,
  kind: ArtifactKind,
  files: readonly ArtifactFile[],
  checker: ArtifactQueryChecker | undefined
): Promise<void> {
  if (kind === "file") return

  const queries = files.filter((file) => file.path.startsWith(ARTIFACT_QUERIES_DIRECTORY))
  const [first] = queries
  if (!first) return

  if (!ARTIFACT_QUERY_KINDS.includes(kind)) {
    throw invalidArtifact(
      `'${first.path}': a ${kind} runs no query. A document shows a live sheet instead.`
    )
  }

  if (queries.length > ARTIFACT_LIMITS.maxQueries) {
    throw invalidArtifact(
      `A version holds at most ${ARTIFACT_LIMITS.maxQueries} queries; this one has ${queries.length}.`
    )
  }

  if (!checker) {
    throw invalidArtifact(
      `'${first.path}' is a query, and this publish has no way to check it as its author.`
    )
  }

  // One at a time, so the same version is always refused for the same query.
  for (const file of queries) {
    if (!artifactQueryName(file.path)) {
      throw invalidArtifact(
        `'${file.path}' is not a query: name it queries/<name>.json, with lowercase letters, digits and hyphens, at most 64 characters.`
      )
    }

    const text = await readArtifactText(blobStorage, file, ARTIFACT_LIMITS.maxQueryBytes)
    const parsed = parseArtifactQuery(file.path, text)
    if ("error" in parsed) throw invalidArtifact(parsed.error)

    try {
      await checker(parsed.query)
    } catch (error) {
      throw refusal(file.path, parsed, error)
    }
  }
}

/**
 * Why the author cannot run the query, naming the file and, for a problem in the query, where it
 * is in the file. A query's own paths start at the query, which a request holds under `query`;
 * a facet's paths are the file's already.
 */
function refusal(
  path: string,
  parsed: { readonly query: ArtifactQuery; readonly at: "$" | "$.query" },
  error: unknown
): unknown {
  const inFile = (issuePath: string) =>
    parsed.query.kind === "facets" && issuePath.startsWith("$.facets")
      ? issuePath
      : `${parsed.at}${issuePath.slice(1)}`

  if (error instanceof ObjectQueryValidationError || error instanceof ObjectQueryPlanningError) {
    const issues = error.issues.map((issue) => `${inFile(issue.path)}: ${issue.message}`)
    return invalidArtifact(`${path}: ${issues.join("; ")}`)
  }

  if (error instanceof AuthorizationError || error instanceof ObjectQueryExecutionError) {
    return invalidArtifact(`${path}: ${error.message.replace(/^\[Sixb\]\s*/, "")}`)
  }

  return error
}
