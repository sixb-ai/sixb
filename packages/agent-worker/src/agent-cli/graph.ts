import type { ApiClient } from "./api-client"
import { fail } from "./output"

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

export async function inspectGraph(
  api: ApiClient,
  objectTypeId: string,
  primaryId: string,
  options: { readonly depth: number; readonly maxObjects: number; readonly full: boolean }
): Promise<unknown> {
  let refs: LocatedRef[] = [{ objectTypeId, primaryId, distance: 0 }]
  let frontier = refs
  const objects = new Map<string, MaterializedObject>()
  const links = new Map<string, PhysicalLink>()
  let truncated = false
  const iterations = Math.max(options.depth, 1)

  for (let level = 0; level < iterations && frontier.length > 0; level += 1) {
    const levelObjects = new Map<string, MaterializedObject>()
    const levelLinks = new Map<string, PhysicalLink>()
    let pageToken: string | undefined
    let continuePaging = true

    while (continuePaging) {
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
          pageSize: 1_000,
          ...(pageToken ? { pageToken } : {}),
        })
      )
      for (const object of response.objects) levelObjects.set(refKey(object), object)
      for (const link of response.links) {
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
      if (!response.hasMore || level >= options.depth) {
        continuePaging = false
        continue
      }
      if (!response.nextPageToken) {
        fail("The object-links API reported another page without a nextPageToken.")
      }
      pageToken = response.nextPageToken
    }

    for (const [key, object] of levelObjects) objects.set(key, object)
    if (level >= options.depth) continue
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
    truncated ||= all.length > options.maxObjects
    refs = all.slice(0, options.maxObjects)
    frontier = refs.filter((ref) => !seen.has(refKey(ref)))
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
  if (!root) fail(`Object '${objectTypeId}/${primaryId}' was not found.`)
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
      objectCount: 1 + relatedObjects.length,
      linkCount: filteredLinks.length,
      truncated,
    },
    ...(objectTypes ? { objectTypes } : {}),
  }
}

function asLinksResponse(value: unknown): LinksResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidLinksResponse()
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.objects) || !Array.isArray(record.links)) invalidLinksResponse()
  if (typeof record.hasMore !== "boolean") invalidLinksResponse()
  return record as unknown as LinksResponse
}

function invalidLinksResponse(): never {
  fail("The object-links API returned an invalid response.")
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
