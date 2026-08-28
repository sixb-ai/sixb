import type { ApiClient } from "./api-client"
import { CliError, EXIT_API } from "./output"
import { CLI_LIMITS } from "./policies"

interface ObjectRef {
  readonly objectTypeId: string
  readonly primaryId: string
}

interface LocatedRef extends ObjectRef {
  readonly distance: number
}

interface MaterializedObject extends ObjectRef {
  readonly createdAt?: unknown
  readonly updatedAt?: unknown
  readonly [key: string]: unknown
}

interface PhysicalLink {
  readonly sourceTypeId: string
  readonly sourceId: string
  readonly linkId: string
  readonly targetTypeId: string
  readonly targetId: string
  readonly properties?: unknown
}

interface LinksResponse {
  readonly objects: MaterializedObject[]
  readonly links: Array<{
    readonly source: ObjectRef
    readonly linkId: string
    readonly target: ObjectRef
    readonly properties?: unknown
  }>
  readonly hasMore: boolean
  readonly nextPageToken?: string
}

interface InspectGraphOptions {
  readonly depth: number
  readonly maxObjects: number
  readonly maxLinks: number
  readonly full: boolean
}

export async function inspectGraph(
  api: ApiClient,
  objectTypeId: string,
  primaryId: string,
  options: InspectGraphOptions
): Promise<unknown> {
  if (options.depth === 0) return inspectRoot(api, objectTypeId, primaryId, options)

  let refs: LocatedRef[] = [{ objectTypeId, primaryId, distance: 0 }]
  let frontier = refs
  const objects = new Map<string, MaterializedObject>()
  const links = new Map<string, PhysicalLink>()
  let objectsTruncated = false
  let linksTruncated = false
  let pagesTruncated = false
  let pagesRead = 0
  let linksExamined = 0

  for (let level = 0; level < options.depth && frontier.length > 0; level += 1) {
    const levelObjects = new Map<string, MaterializedObject>()
    const levelLinks = new Map<string, PhysicalLink>()
    const seenPageTokens = new Set<string>()
    let pageToken: string | undefined
    let continuePaging = true

    while (continuePaging) {
      const remainingLinks = options.maxLinks - linksExamined
      if (remainingLinks <= 0) {
        linksTruncated = true
        break
      }
      if (pagesRead >= CLI_LIMITS.inspect.maximumPages) {
        pagesTruncated = true
        break
      }
      const response = asLinksResponse(
        await api.post("/api/objects/query/links", {
          query: {
            kind: "refs",
            refs: frontier.map(({ objectTypeId: type, primaryId: id }) => ({
              objectTypeId: type,
              primaryId: id,
            })),
          },
          direction: "both",
          includeObjects: true,
          pageSize: Math.min(CLI_LIMITS.linkPage.default, remainingLinks),
          ...(pageToken ? { pageToken } : {}),
        })
      )
      pagesRead += 1
      const pageLinks = response.links.slice(0, remainingLinks)
      linksExamined += pageLinks.length
      linksTruncated ||= response.links.length > pageLinks.length
      const relevantObjects = new Set(frontier.map(refKey))
      for (const link of pageLinks) {
        relevantObjects.add(refKey(link.source))
        relevantObjects.add(refKey(link.target))
      }
      for (const object of response.objects) {
        if (relevantObjects.has(refKey(object))) levelObjects.set(refKey(object), object)
      }
      for (const link of pageLinks) {
        const physical = {
          sourceTypeId: link.source.objectTypeId,
          sourceId: link.source.primaryId,
          linkId: link.linkId,
          targetTypeId: link.target.objectTypeId,
          targetId: link.target.primaryId,
          ...(Object.hasOwn(link, "properties") ? { properties: link.properties } : {}),
        }
        levelLinks.set(linkKey(physical), physical)
      }
      if (!response.hasMore) {
        continuePaging = false
        continue
      }
      if (linksExamined >= options.maxLinks) {
        linksTruncated = true
        break
      }
      if (pagesRead >= CLI_LIMITS.inspect.maximumPages) {
        pagesTruncated = true
        break
      }
      if (!response.nextPageToken) {
        invalidApiResponse("The object-links API reported another page without a nextPageToken.")
      }
      if (seenPageTokens.has(response.nextPageToken)) {
        invalidApiResponse(
          "The object-links API repeated a nextPageToken while inspecting the graph."
        )
      }
      seenPageTokens.add(response.nextPageToken)
      pageToken = response.nextPageToken
    }

    for (const [key, object] of levelObjects) objects.set(key, object)
    for (const [key, link] of levelLinks) links.set(key, link)

    const frontierKeys = new Set(frontier.map(refKey))
    const candidates: LocatedRef[] = []
    for (const link of levelLinks.values()) {
      const source = { objectTypeId: link.sourceTypeId, primaryId: link.sourceId }
      const target = { objectTypeId: link.targetTypeId, primaryId: link.targetId }
      if (frontierKeys.has(refKey(source))) candidates.push({ ...target, distance: level + 1 })
      else if (frontierKeys.has(refKey(target))) candidates.push({ ...source, distance: level + 1 })
    }

    const seen = new Set(refs.map(refKey))
    const all = dedupeRefs([...refs, ...candidates])
    objectsTruncated ||= all.length > options.maxObjects
    refs = all.slice(0, options.maxObjects)
    frontier = linksTruncated || pagesTruncated ? [] : refs.filter((ref) => !seen.has(refKey(ref)))
  }

  const kept = new Set(refs.map(refKey))
  const filteredLinks = [...links.values()]
    .filter(
      (link) =>
        kept.has(refKey({ objectTypeId: link.sourceTypeId, primaryId: link.sourceId })) &&
        kept.has(refKey({ objectTypeId: link.targetTypeId, primaryId: link.targetId }))
    )
    .sort(compareLinks)
    .map((link) =>
      link.properties == null
        ? {
            sourceTypeId: link.sourceTypeId,
            sourceId: link.sourceId,
            linkId: link.linkId,
            targetTypeId: link.targetTypeId,
            targetId: link.targetId,
          }
        : link
    )

  const root = objects.get(refKey({ objectTypeId, primaryId }))
  if (!root) objectNotFound(objectTypeId, primaryId)
  const relatedObjects = refs
    .filter((ref) => ref.distance > 0)
    .flatMap((ref) => {
      const object = objects.get(refKey(ref))
      return object ? [{ ...object, distance: ref.distance }] : []
    })

  const objectTypes = options.full
    ? await Promise.all(
        [...new Set(refs.map((ref) => ref.objectTypeId))]
          .sort((left, right) => left.localeCompare(right))
          .map((typeId) => api.get(`/api/object-types/${encodeURIComponent(typeId)}`))
      )
    : undefined

  return {
    object: options.full ? root : compactObject(root),
    relatedObjects: options.full ? relatedObjects : relatedObjects.map(compactObject),
    links: filteredLinks,
    graph: {
      depth: options.depth,
      maxObjects: options.maxObjects,
      maxLinks: options.maxLinks,
      maxPages: CLI_LIMITS.inspect.maximumPages,
      objectCount: 1 + relatedObjects.length,
      linkCount: filteredLinks.length,
      pagesRead,
      linksExamined,
      truncated: objectsTruncated || linksTruncated || pagesTruncated,
      truncation: {
        objects: objectsTruncated,
        links: linksTruncated,
        pages: pagesTruncated,
      },
    },
    ...(objectTypes ? { objectTypes } : {}),
  }
}

async function inspectRoot(
  api: ApiClient,
  objectTypeId: string,
  primaryId: string,
  options: InspectGraphOptions
): Promise<unknown> {
  const response = await api.post("/api/objects/query", {
    query: { kind: "refs", refs: [{ objectTypeId, primaryId }] },
    includeTotal: false,
  })
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    invalidApiResponse("The object query API returned an invalid response.")
  }
  const rows = (response as Record<string, unknown>).objects
  if (!Array.isArray(rows)) invalidApiResponse("The object query API returned an invalid response.")
  const root = rows.find(
    (value): value is MaterializedObject =>
      isMaterializedObject(value) &&
      value.objectTypeId === objectTypeId &&
      value.primaryId === primaryId
  )
  if (!root) objectNotFound(objectTypeId, primaryId)
  const objectTypes = options.full
    ? [await api.get(`/api/object-types/${encodeURIComponent(objectTypeId)}`)]
    : undefined
  return {
    object: options.full ? root : compactObject(root),
    relatedObjects: [],
    links: [],
    graph: {
      depth: 0,
      maxObjects: options.maxObjects,
      maxLinks: options.maxLinks,
      maxPages: CLI_LIMITS.inspect.maximumPages,
      objectCount: 1,
      linkCount: 0,
      pagesRead: 0,
      linksExamined: 0,
      truncated: false,
      truncation: { objects: false, links: false, pages: false },
    },
    ...(objectTypes ? { objectTypes } : {}),
  }
}

function asLinksResponse(value: unknown): LinksResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidLinksResponse()
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.objects) || !Array.isArray(record.links)) invalidLinksResponse()
  if (typeof record.hasMore !== "boolean") invalidLinksResponse()
  if (record.nextPageToken !== undefined && typeof record.nextPageToken !== "string") {
    invalidLinksResponse()
  }
  if (!record.objects.every(isMaterializedObject) || !record.links.every(isPhysicalLinkResponse)) {
    invalidLinksResponse()
  }
  return record as unknown as LinksResponse
}

function invalidLinksResponse(): never {
  invalidApiResponse("The object-links API returned an invalid response.")
}

function invalidApiResponse(message: string): never {
  throw new CliError({ code: "invalid_api_response", message }, EXIT_API)
}

function objectNotFound(objectTypeId: string, primaryId: string): never {
  throw new CliError(
    { code: "not_found", message: `Object '${objectTypeId}/${primaryId}' was not found.` },
    EXIT_API
  )
}

function isMaterializedObject(value: unknown): value is MaterializedObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.objectTypeId === "string" && typeof record.primaryId === "string"
}

function isPhysicalLinkResponse(value: unknown): value is LinksResponse["links"][number] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.linkId === "string" && isObjectRef(record.source) && isObjectRef(record.target)
  )
}

function isObjectRef(value: unknown): value is ObjectRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.objectTypeId === "string" && typeof record.primaryId === "string"
}

function compactObject<T extends MaterializedObject>(
  object: T
): Omit<T, "createdAt" | "updatedAt"> {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...compact } = object
  return compact
}

function dedupeRefs(values: LocatedRef[]): LocatedRef[] {
  const unique = new Map<string, LocatedRef>()
  for (const value of values) {
    const key = refKey(value)
    const current = unique.get(key)
    if (!current || value.distance < current.distance) unique.set(key, value)
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.distance - right.distance ||
      left.objectTypeId.localeCompare(right.objectTypeId) ||
      left.primaryId.localeCompare(right.primaryId)
  )
}

function refKey(ref: ObjectRef): string {
  return JSON.stringify([ref.objectTypeId, ref.primaryId])
}

function linkKey(link: PhysicalLink): string {
  return JSON.stringify([
    link.sourceTypeId,
    link.sourceId,
    link.linkId,
    link.targetTypeId,
    link.targetId,
  ])
}

function compareLinks(left: PhysicalLink, right: PhysicalLink): number {
  return linkKey(left).localeCompare(linkKey(right))
}
