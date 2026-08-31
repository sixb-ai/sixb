import { createHash } from "node:crypto"
import { isAllowed } from "../../authorization"
import { stableJsonStringify } from "../../json"
import {
  type LinkDirection,
  type ObjectBatchKey,
  type ObjectLinkCursor,
  type ObjectLinkRow,
  type ObjectRow,
  type ObjectStorage,
  objectBatchKey,
  objectLinkCursor,
} from "../../storage"
import { ObjectQueryExecutionError } from "./errors"
import { executeObjectQuery, type QueryExecutorOptions } from "./executor"
import type { ObjectQuery } from "./ir"
import { normalizeObjectQuery } from "./normalize"
import { validateObjectQuery } from "./validate"

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

const MAX_LINK_QUERY_OBJECTS = 1_000
const MAX_LINK_PAGE_SIZE = 1_000
const DEFAULT_LINK_PAGE_SIZE = 100
const LINK_PAGE_TOKEN_PREFIX = "link:v1:"

/**
 * Select a bounded object set with the query IR, then return physical links
 * incident to that set. This is a separate terminal because edge rows and edge
 * pagination are a different response contract from object-set queries.
 */
export async function executeObjectQueryLinks(
  input: ExecuteObjectQueryLinksInput,
  options: QueryExecutorOptions
): Promise<ExecuteObjectQueryLinksResult> {
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
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > MAX_LINK_PAGE_SIZE) {
    throw new ObjectQueryExecutionError(
      "invalid_link_page_size",
      `pageSize must be an integer between 1 and ${MAX_LINK_PAGE_SIZE}`,
      "$.pageSize"
    )
  }
  const validated = validateObjectQuery(normalizeObjectQuery(input.query), {
    ontology: options.ontology,
    maxLimit: options.maxLimit,
    maxPageSize: options.maxPageSize,
    maxRefs: options.maxRefs,
    normalize: false,
  })
  assertLinkSelectorShape(validated.query)
  const selectorQuery = validated.query
  const pageScope = linkPageScope(input.projectId, selectorQuery, direction, input.linkId)
  const cursor = decodeLinkPageToken(input.pageToken, pageScope)

  // A root page already has an explicit result bound and must execute directly: nesting it under a
  // probe limit would expose the provider's internal pageSize+1 row. All other selector shapes are
  // capped here before the provider receives the selected identities.
  const boundedSelector =
    selectorQuery.kind === "page"
      ? selectorQuery
      : { kind: "limit" as const, limit: MAX_LINK_QUERY_OBJECTS + 1, input: selectorQuery }
  const selection = await executeObjectQuery(
    {
      projectId: input.projectId,
      query: boundedSelector,
      includeTotal: false,
    },
    {
      ...options,
      maxLimit: Math.max(options.maxLimit ?? 1_000, MAX_LINK_QUERY_OBJECTS + 1),
    }
  )
  if (selection.objects.length > MAX_LINK_QUERY_OBJECTS) {
    throw new ObjectQueryExecutionError(
      "link_query_object_limit_exceeded",
      `Link query selected more than ${MAX_LINK_QUERY_OBJECTS} objects; add a limit or page node`,
      "$.query"
    )
  }

  const selected = selection.objects
  if (selected.length === 0) {
    return { objects: [], links: [], hasMore: false }
  }

  const endpointObjectTypeIds = visibleEndpointTypeIds(options)
  const page = await options.storage.queryLinks({
    projectId: input.projectId,
    objectRefs: selected.map((row) => ({
      objectTypeId: row.objectTypeId,
      primaryId: row.primaryId,
    })),
    direction,
    ...(input.linkId === undefined ? {} : { linkId: input.linkId }),
    ...(endpointObjectTypeIds === undefined ? {} : { endpointObjectTypeIds }),
    ...(cursor === undefined ? {} : { after: cursor }),
    limit: pageSize,
  })
  const lastLink = page.links.at(-1)
  let nextPageToken: string | undefined
  if (page.hasMore) {
    if (!lastLink) {
      throw new Error("[Sixb] Object storage returned hasMore for an empty link page.")
    }
    nextPageToken = encodeLinkPageToken(objectLinkCursor(lastLink), pageScope)
  }
  const objects = input.includeObjects
    ? await hydrateLinkQueryObjects(input.projectId, selected, page.links, options.storage)
    : []

  return {
    objects,
    links: page.links,
    hasMore: page.hasMore,
    ...(nextPageToken ? { nextPageToken } : {}),
  }
}

interface EncodedLinkPageToken {
  version: 1
  scope: string
  cursor: ObjectLinkCursor
}

function assertLinkSelectorShape(query: ObjectQuery, path = "$.query", root = true): void {
  switch (query.kind) {
    case "project":
    case "expand":
      throw new ObjectQueryExecutionError(
        "link_selector_output_shape_not_supported",
        `Link selectors do not support '${query.kind}' nodes; remove output shaping from the selector`,
        path
      )
    case "page":
      if (!root) {
        throw new ObjectQueryExecutionError(
          "link_selector_page_must_be_root",
          "A page node in a link selector must be the outermost node",
          path
        )
      }
      assertLinkSelectorShape(query.input, `${path}.input`, false)
      return
    case "start":
    case "refs":
      return
    case "set": {
      for (const [index, input] of query.inputs.entries()) {
        assertLinkSelectorShape(input, `${path}.inputs[${index}]`, false)
      }
      return
    }
    case "filter":
    case "text":
    case "vector":
    case "traverse":
    case "sort":
    case "limit":
      assertLinkSelectorShape(query.input, `${path}.input`, false)
      return
  }
}

function visibleEndpointTypeIds(options: QueryExecutorOptions): readonly string[] | undefined {
  if (!options.authorization) return undefined
  return options.ontology
    .listObjectTypes()
    .filter((objectType) =>
      isAllowed(options.authorization, { kind: "object.view", objectTypeId: objectType.id })
    )
    .map((objectType) => objectType.id)
}

function objectIdentity(objectTypeId: string, primaryId: string): ObjectBatchKey {
  return objectBatchKey(objectTypeId, primaryId)
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
  const payload: EncodedLinkPageToken = { version: 1, scope, cursor }
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
      value.version !== 1 ||
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
      const row = hydrated.get(objectBatchKey(ref.objectTypeId, ref.primaryId))
      if (row) byIdentity.set(objectIdentity(ref.objectTypeId, ref.primaryId), row)
    }
  }

  return orderedIdentities.flatMap((identity) => {
    const row = byIdentity.get(identity)
    return row ? [row] : []
  })
}
