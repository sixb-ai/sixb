import { createHash } from "node:crypto"
import { isAllowed } from "../../authorization"
import { stableJsonStringify } from "../../json"
import type { LinkDirection, ObjectLinkRow, ObjectRow, ObjectStorage } from "../../storage"
import { ObjectQueryExecutionError } from "./errors"
import { executeObjectQuery, type QueryExecutorOptions } from "./executor"
import type { ObjectQuery } from "./ir"
import { normalizeObjectQuery } from "./normalize"
import { validateObjectQuery } from "./validate"

export interface ObjectQueryLinksExecutorOptions extends QueryExecutorOptions {
  /** Maximum selector rows admitted by the incident-links terminal. */
  maxLinkQueryObjects?: number
  /** Maximum edge page size admitted by the incident-links terminal. */
  maxLinkPageSize?: number
}

export interface ExecuteObjectQueryLinksInput {
  projectId: string
  query: ObjectQuery
  direction?: LinkDirection
  linkId?: string
  includeObjects?: boolean
  pageSize?: number
  pageToken?: string
}

export interface ExecuteObjectQueryLinksResult {
  objects: readonly ObjectRow[]
  links: readonly ObjectLinkRow[]
  hasMore: boolean
  nextPageToken?: string
}

const DEFAULT_MAX_LINK_QUERY_OBJECTS = 1_000
const DEFAULT_MAX_LINK_PAGE_SIZE = 1_000
const DEFAULT_LINK_PAGE_SIZE = 100
const LINK_PAGE_TOKEN_PREFIX = "link:v2:"

/**
 * Select a bounded object set with the query IR, then return physical links
 * incident to that set. This is a separate terminal because edge rows and edge
 * pagination are a different response contract from object-set queries.
 */
export async function executeObjectQueryLinks(
  input: ExecuteObjectQueryLinksInput,
  options: ObjectQueryLinksExecutorOptions
): Promise<ExecuteObjectQueryLinksResult> {
  const maxSelectedObjects = options.maxLinkQueryObjects ?? DEFAULT_MAX_LINK_QUERY_OBJECTS
  const maxPageSize = options.maxLinkPageSize ?? DEFAULT_MAX_LINK_PAGE_SIZE
  assertPositiveInteger(
    maxSelectedObjects,
    "invalid_link_query_object_limit",
    "maxLinkQueryObjects"
  )
  assertPositiveInteger(maxPageSize, "invalid_link_page_size_limit", "maxLinkPageSize")

  const direction = input.direction ?? "both"
  if (direction !== "outgoing" && direction !== "incoming" && direction !== "both") {
    throw new ObjectQueryExecutionError(
      "invalid_link_direction",
      "direction must be 'outgoing', 'incoming', or 'both'",
      "$.direction"
    )
  }
  if (input.linkId !== undefined && input.linkId.length === 0) {
    throw new ObjectQueryExecutionError("invalid_link_id", "linkId must not be empty", "$.linkId")
  }

  const pageSize = input.pageSize ?? DEFAULT_LINK_PAGE_SIZE
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > maxPageSize) {
    throw new ObjectQueryExecutionError(
      "invalid_link_page_size",
      `pageSize must be an integer between 1 and ${maxPageSize}`,
      "$.pageSize"
    )
  }
  // Validate the complete authored query before removing output-only nodes.
  // `project` and `expand` do not change selector membership, but malformed
  // output-shaping instructions should not be silently accepted.
  const validated = validateObjectQuery(normalizeObjectQuery(input.query), {
    ontology: options.ontology,
    maxLimit: options.maxLimit,
    maxPageSize: options.maxPageSize,
    maxRefs: options.maxRefs,
    normalize: false,
  })
  const selectorQuery = stripObjectQueryOutputShape(validated.query)
  const pageScope = linkPageScope(input.projectId, selectorQuery, direction, input.linkId)
  const cursor = decodeLinkPageToken(input.pageToken, pageScope)

  // Probe one extra selector row so an unbounded object query never turns the
  // incident-link batch primitive into an unbounded graph scan.
  const selection = await executeObjectQuery(
    {
      projectId: input.projectId,
      query: {
        kind: "limit",
        limit: maxSelectedObjects + 1,
        input: selectorQuery,
      },
      includeTotal: false,
    },
    {
      ...options,
      maxLimit: Math.max(options.maxLimit ?? 1_000, maxSelectedObjects + 1),
    }
  )
  if (selection.objects.length > maxSelectedObjects) {
    throw new ObjectQueryExecutionError(
      "link_query_object_limit_exceeded",
      `Link query selected more than ${maxSelectedObjects} objects; add a limit or page node`,
      "$.query"
    )
  }

  const selected = selection.objects
  if (selected.length === 0) {
    return { objects: [], links: [], hasMore: false }
  }

  const selectedKeys = new Set(
    selected.map((row) => objectIdentity(row.objectTypeId, row.primaryId))
  )
  const incident = await options.storage.listIncidentLinksBatch({
    projectId: input.projectId,
    items: selected.map((row) => ({ objectTypeId: row.objectTypeId, objectId: row.primaryId })),
  })
  const visibleLinks = incident
    .filter((link) => linkMatchesSelection(link, selectedKeys, direction))
    .filter((link) => input.linkId === undefined || link.linkId === input.linkId)
    .filter(
      (link) =>
        isAllowed(options.authorization, {
          kind: "object.view",
          objectTypeId: link.sourceTypeId,
        }) &&
        isAllowed(options.authorization, {
          kind: "object.view",
          objectTypeId: link.targetTypeId,
        })
    )
    .sort(compareObjectLinks)
    .filter((link) => cursor === undefined || compareObjectLinkToCursor(link, cursor) > 0)

  const hasMore = visibleLinks.length > pageSize
  const links = visibleLinks.slice(0, pageSize)
  const nextPageToken = hasMore
    ? encodeLinkPageToken(linkCursor(links.at(-1)!), pageScope)
    : undefined
  const objects = input.includeObjects
    ? await hydrateLinkQueryObjects(input.projectId, selected, links, options.storage)
    : []

  return { objects, links, hasMore, ...(nextPageToken ? { nextPageToken } : {}) }
}

type ObjectLinkCursor = readonly [string, string, string, string, string]

interface EncodedLinkPageToken {
  version: 2
  scope: string
  cursor: ObjectLinkCursor
}

function assertPositiveInteger(value: number, code: string, field: string): void {
  if (Number.isInteger(value) && value > 0) return
  throw new ObjectQueryExecutionError(code, `${field} must be a positive integer`, `$.${field}`)
}

function stripObjectQueryOutputShape(query: ObjectQuery): ObjectQuery {
  switch (query.kind) {
    case "project":
    case "expand":
      return stripObjectQueryOutputShape(query.input)
    case "start":
    case "refs":
      return query
    case "set":
      return {
        ...query,
        inputs: query.inputs.map(stripObjectQueryOutputShape),
      }
    case "filter":
    case "text":
    case "vector":
    case "traverse":
    case "sort":
    case "limit":
    case "page":
      return { ...query, input: stripObjectQueryOutputShape(query.input) }
  }
}

function linkMatchesSelection(
  link: ObjectLinkRow,
  selectedKeys: ReadonlySet<string>,
  direction: LinkDirection
): boolean {
  const outgoing = selectedKeys.has(objectIdentity(link.sourceTypeId, link.sourceId))
  const incoming = selectedKeys.has(objectIdentity(link.targetTypeId, link.targetId))
  return direction === "outgoing"
    ? outgoing
    : direction === "incoming"
      ? incoming
      : outgoing || incoming
}

function objectIdentity(objectTypeId: string, primaryId: string): string {
  return JSON.stringify([objectTypeId, primaryId])
}

function linkCursor(link: ObjectLinkRow): ObjectLinkCursor {
  return [link.sourceTypeId, link.sourceId, link.linkId, link.targetTypeId, link.targetId]
}

function compareObjectLinks(left: ObjectLinkRow, right: ObjectLinkRow): number {
  return compareLinkCursors(linkCursor(left), linkCursor(right))
}

function compareObjectLinkToCursor(link: ObjectLinkRow, cursor: ObjectLinkCursor): number {
  return compareLinkCursors(linkCursor(link), cursor)
}

function compareLinkCursors(left: ObjectLinkCursor, right: ObjectLinkCursor): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return 0
}

function linkPageScope(
  projectId: string,
  query: ObjectQuery,
  direction: LinkDirection,
  linkId: string | undefined
): string {
  return createHash("sha256")
    .update(
      stableJsonStringify({
        projectId,
        query,
        direction,
        linkId: linkId ?? null,
      })
    )
    .digest("base64url")
}

function encodeLinkPageToken(cursor: ObjectLinkCursor, scope: string): string {
  const payload: EncodedLinkPageToken = { version: 2, scope, cursor }
  return `${LINK_PAGE_TOKEN_PREFIX}${Buffer.from(JSON.stringify(payload)).toString("base64url")}`
}

function decodeLinkPageToken(
  token: string | undefined,
  expectedScope: string
): ObjectLinkCursor | undefined {
  if (token === undefined) return undefined
  try {
    if (!token.startsWith(LINK_PAGE_TOKEN_PREFIX)) throw new Error("invalid prefix")
    const value = JSON.parse(
      Buffer.from(token.slice(LINK_PAGE_TOKEN_PREFIX.length), "base64url").toString("utf8")
    ) as unknown
    if (
      !isPlainObject(value) ||
      value.version !== 2 ||
      typeof value.scope !== "string" ||
      !isObjectLinkCursor(value.cursor)
    ) {
      throw new Error("invalid cursor")
    }
    if (value.scope !== expectedScope) {
      throw new Error("cursor scope mismatch")
    }
    return value.cursor
  } catch {
    throw new ObjectQueryExecutionError(
      "invalid_link_page_token",
      "pageToken is not a valid object-links cursor",
      "$.pageToken"
    )
  }
}

function isObjectLinkCursor(value: unknown): value is ObjectLinkCursor {
  return (
    Array.isArray(value) && value.length === 5 && value.every((part) => typeof part === "string")
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function hydrateLinkQueryObjects(
  projectId: string,
  selected: readonly ObjectRow[],
  links: readonly ObjectLinkRow[],
  storage: ObjectStorage
): Promise<ObjectRow[]> {
  const byIdentity = new Map(
    selected.map((row) => [objectIdentity(row.objectTypeId, row.primaryId), row])
  )
  const orderedIdentities = selected.map((row) => objectIdentity(row.objectTypeId, row.primaryId))
  const seenIdentities = new Set(orderedIdentities)
  const missingRefs: { objectTypeId: string; primaryId: string }[] = []

  for (const link of links) {
    for (const ref of [
      { objectTypeId: link.sourceTypeId, primaryId: link.sourceId },
      { objectTypeId: link.targetTypeId, primaryId: link.targetId },
    ]) {
      const identity = objectIdentity(ref.objectTypeId, ref.primaryId)
      if (seenIdentities.has(identity)) continue
      seenIdentities.add(identity)
      orderedIdentities.push(identity)
      missingRefs.push(ref)
    }
  }

  if (missingRefs.length > 0) {
    const hydrated = await storage.getByPrimaryIdBatch({ projectId, items: missingRefs })
    for (const ref of missingRefs) {
      const row = hydrated.get(`${ref.objectTypeId}:${ref.primaryId}`)
      if (row) byIdentity.set(objectIdentity(ref.objectTypeId, ref.primaryId), row)
    }
  }

  return orderedIdentities.flatMap((identity) => {
    const row = byIdentity.get(identity)
    return row ? [row] : []
  })
}
