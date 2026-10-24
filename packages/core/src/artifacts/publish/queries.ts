import { isRuntimeAllowed } from "../../authorization"
import { AuthorizationError } from "../../authorization/errors"
import { readerClearance } from "../../execution/authorized-object-reader"
import type { PropertyClearance } from "../../objects/property-clearance"
import {
  ObjectQueryExecutionError,
  ObjectQueryPlanningError,
  ObjectQueryValidationError,
} from "../../objects/query/errors"
import type { ObjectExpansion, ObjectQuery } from "../../objects/query/ir"
import { normalizeObjectQuery } from "../../objects/query/normalize"
import {
  type ObjectQuerySemanticAdmission,
  validateObjectQueryWithAdmission,
} from "../../objects/query/validate"
import type { OntologyRegistry } from "../../ontology"
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
 * Admits a query as the version's author: it throws what running it as them would throw, and
 * refuses one that would return what they cannot read. A version is refused when its author could
 * not run one of its queries, so a query never reads what whoever wrote it cannot. Each reader
 * still runs it with their own rights.
 */
export type ArtifactQueryChecker = (query: ArtifactQuery) => Promise<void>

/**
 * The checker for the runtime's caller. Running the query once, as cheaply as its kind allows,
 * is the check: validation against the ontology, `can.view` on every type it reads, clearance for
 * every marked property it filters, sorts or facets on, and the caller's share scope all apply
 * there, as they do when it is read.
 *
 * What the rows carry is checked after: a read leaves out a marked property its reader is not
 * cleared for, and the member profiles of a reader who may not view them, so running the query
 * admits one that returns them. A reader's rows reach the page's code, which its author wrote, so
 * the query may return only what the author can read. Facets return counts, never a property.
 */
export function createArtifactQueryChecker(
  runtime: Pick<
    SixbRuntimeContext,
    "objectReader" | "ontology" | "projectId" | "runtimeAuthorization" | "authorization"
  >
): ArtifactQueryChecker {
  return async (query) => {
    if (query.kind === "facets") {
      await runtime.objectReader.facet({ query: query.query, facets: query.facets })
      return
    }

    await runtime.objectReader.exists({ query: query.query })

    const clearance = await readerClearance(runtime.objectReader)
    if (clearance) assertReturnsReadable(query.query, runtime.ontology, clearance)

    // The reader attaches profiles only for an authority that may view the directory.
    if (!isRuntimeAllowed(runtime, { kind: "users.view" })) assertExpandsNoUsers(query.query)
  }
}

/** A query that would return what its author cannot read, at `at` in the query. */
class UnreadableReturnError extends AuthorizationError {
  constructor(
    grantKey: string,
    readonly at: string,
    message: string
  ) {
    super(grantKey, message)
  }
}

/**
 * Refuses a query whose rows would carry a property its author cannot read: one of the result's,
 * those the outermost `project` lists or every one without it, or one of an object an `expand`
 * attaches, which no projection narrows.
 *
 * A `project` counts only under nothing but expansions, sorts and limits. Under a filter, a
 * traversal or a set operand it may not shape the rows, so the query then returns every property.
 */
function assertReturnsReadable(
  query: ObjectQuery,
  ontology: OntologyRegistry,
  clearance: PropertyClearance
): void {
  const { normalized, resultObjectTypeIds, expansions } = returnedShape(query, ontology)
  const project = outermostProject(normalized)

  for (const objectTypeId of resultObjectTypeIds) {
    const propertyIds = project?.properties ?? propertiesOf(ontology, objectTypeId)
    const unreadable = firstUnreadable(clearance, objectTypeId, propertyIds)
    if (!unreadable) continue

    const returns = `returns '${unreadable.propertyId}' on '${objectTypeId}', which you are not cleared to read`
    throw project
      ? new UnreadableReturnError(
          `clearance:marking:${unreadable.marking}`,
          `${project.at}.properties[${unreadable.index}]`,
          `[Sixb] ${returns}: list only the properties you can read.`
        )
      : new UnreadableReturnError(
          `clearance:marking:${unreadable.marking}`,
          "$",
          `[Sixb] ${returns}: add a "project" node that lists only the properties you can read.`
        )
  }

  for (const expansion of expansions) {
    for (const objectTypeId of expansion.objectTypeIds) {
      const unreadable = firstUnreadable(
        clearance,
        objectTypeId,
        propertiesOf(ontology, objectTypeId)
      )
      if (!unreadable) continue

      throw new UnreadableReturnError(
        `clearance:marking:${unreadable.marking}`,
        expansion.at,
        `[Sixb] expands '${expansion.linkId}' to '${objectTypeId}', whose '${unreadable.propertyId}' you are not cleared to read: an expansion returns every property, so leave it out, or read '${objectTypeId}' in a query of its own with a "project" node.`
      )
    }
  }
}

/**
 * Refuses a query that expands member profiles, for an author who may not view them. Only the
 * outermost expand names them, at its rows or under its expansions, once normalized.
 */
function assertExpandsNoUsers(query: ObjectQuery): void {
  const normalized = normalizeObjectQuery(query)
  if (normalized.kind !== "expand") return

  const expanded = firstUserExpansion(normalized.users, normalized.expansions, "$")
  if (!expanded) return

  throw new UnreadableReturnError(
    "view:users",
    expanded.at,
    `[Sixb] returns the member profiles '${expanded.propertyId}' refers to, which you are not allowed to view: leave '${expanded.propertyId}' out of "users".`
  )
}

function firstUserExpansion(
  users: readonly string[] | undefined,
  expansions: readonly ObjectExpansion[],
  at: string
): { readonly propertyId: string; readonly at: string } | undefined {
  const [propertyId] = users ?? []
  if (propertyId !== undefined) return { propertyId, at: `${at}.users[0]` }

  for (const [index, expansion] of expansions.entries()) {
    const path = at === "$" ? `$.expansions[${index}]` : `${at}.expand[${index}]`
    const found = firstUserExpansion(expansion.users, expansion.expand ?? [], path)
    if (found) return found
  }

  return undefined
}

function propertiesOf(ontology: OntologyRegistry, objectTypeId: string): readonly string[] {
  return ontology.resolveObjectType(objectTypeId).properties.map((property) => property.id)
}

function firstUnreadable(
  clearance: PropertyClearance,
  objectTypeId: string,
  propertyIds: readonly string[]
): { readonly propertyId: string; readonly index: number; readonly marking: string } | undefined {
  for (const [index, propertyId] of propertyIds.entries()) {
    const marking = clearance.missingMarking(objectTypeId, propertyId)
    if (marking !== undefined) return { propertyId, index, marking }
  }

  return undefined
}

/**
 * The query as it runs, the object types it returns, and those each expansion attaches, at any
 * depth. Validation resolves an expansion's targets, so a recording admission reads them there:
 * a set operand's expansions are among them too.
 */
function returnedShape(query: ObjectQuery, ontology: OntologyRegistry) {
  const expansions: { readonly at: string; readonly linkId: string; objectTypeIds: string[] }[] = []

  const state = Object.freeze({})
  const recorder: ObjectQuerySemanticAdmission = {
    empty: () => state,
    source: () => ({ state }),
    property: () => undefined,
    edge: (input) => {
      if (input.use === "expand") {
        expansions.push({
          at: input.path,
          linkId: input.linkId,
          objectTypeIds: [...input.result.objectTypeIds],
        })
      }
      return { state }
    },
    set: () => state,
  }

  const validated = validateObjectQueryWithAdmission(query, { ontology }, recorder)
  return {
    normalized: validated.query,
    resultObjectTypeIds: validated.result.objectTypeIds,
    expansions,
  }
}

/** The `project` that shapes the rows, through the nodes that keep them as they are. */
function outermostProject(
  query: ObjectQuery,
  at = "$"
): { readonly properties: readonly string[]; readonly at: string } | undefined {
  switch (query.kind) {
    case "project":
      return query.properties ? { properties: query.properties, at } : undefined
    case "expand":
    case "limit":
    case "sort":
      return outermostProject(query.input, `${at}.input`)
    default:
      return undefined
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

  if (error instanceof UnreadableReturnError) {
    return invalidArtifact(
      `${path}: ${inFile(error.at)}: ${error.message.replace(/^\[Sixb\]\s*/, "")}`
    )
  }

  if (error instanceof ObjectQueryValidationError || error instanceof ObjectQueryPlanningError) {
    const issues = error.issues.map((issue) => `${inFile(issue.path)}: ${issue.message}`)
    return invalidArtifact(`${path}: ${issues.join("; ")}`)
  }

  if (error instanceof AuthorizationError || error instanceof ObjectQueryExecutionError) {
    return invalidArtifact(`${path}: ${error.message.replace(/^\[Sixb\]\s*/, "")}`)
  }

  return error
}
