import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  defineObjectType,
  type ExpandedObjectRow,
  executeObjectQuery,
  link,
  OntologyRegistry,
  prop,
  type StoredLinkUpsertedEvent,
  type StoredObjectUpsertedEvent,
} from "@sixb/core"
import { SqliteObjectStorage } from "../src/object-storage"

// Self-contained ontology exercising the runtime shapes the in-memory contract
// can't: a "one" link, a "many" link, a nested "one" hop, link properties, and a
// dangling edge. All assertions hold for both pushdown (here, against SQLite) and
// the bounded fallback the cross-provider contract covers separately.
const Tag = defineObjectType({
  id: "ExpandTag",
  name: "Expand Tag",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("label", "string", {
      query: { searchable: true, filterable: true, sortable: true, exact: true },
    }),
  ],
})

const Author = defineObjectType({
  id: "ExpandAuthor",
  name: "Expand Author",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
  links: [
    link("favoriteTag", Tag, { cardinality: "one" }),
    link.self("manager", { cardinality: "one" }),
  ],
})

const Post = defineObjectType({
  id: "ExpandPost",
  name: "Expand Post",
  properties: [prop("id", "string", { required: true, primary: true }), prop("title", "string")],
  links: [
    link("author", Author, { cardinality: "one" }),
    link("tags", Tag, { cardinality: "many" }),
  ],
})

const ontology = new OntologyRegistry({ sources: [Tag, Author, Post] })
const projectId = "expand-e2e"

let storage: SqliteObjectStorage
let cursor = 0

beforeAll(async () => {
  storage = new SqliteObjectStorage()

  await storage.applyObjectUpserted(objectEvent(Tag.id, "tag-a", { id: "tag-a", label: "Apple" }))
  await storage.applyObjectUpserted(objectEvent(Tag.id, "tag-b", { id: "tag-b", label: "Banana" }))
  await storage.applyObjectUpserted(objectEvent(Tag.id, "tag-c", { id: "tag-c", label: "Cherry" }))
  await storage.applyObjectUpserted(
    objectEvent(Author.id, "author-1", { id: "author-1", name: "Alice" })
  )
  await storage.applyObjectUpserted(
    objectEvent(Author.id, "author-2", { id: "author-2", name: "Bob" })
  )
  await storage.applyObjectUpserted(
    objectEvent(Post.id, "post-1", { id: "post-1", title: "First" })
  )

  await storage.applyLinkUpserted(linkEvent(Post.id, "post-1", "author", Author.id, "author-1"))
  await storage.applyLinkUpserted(linkEvent(Author.id, "author-1", "favoriteTag", Tag.id, "tag-b"))
  // author-1 → manager author-2 → favoriteTag tag-c: the third hop for deep expansion.
  await storage.applyLinkUpserted(
    linkEvent(Author.id, "author-1", "manager", Author.id, "author-2")
  )
  await storage.applyLinkUpserted(linkEvent(Author.id, "author-2", "favoriteTag", Tag.id, "tag-c"))
  // post-1 → three real tags plus one dangling edge; tag-a carries link properties.
  await storage.applyLinkUpserted(
    linkEvent(Post.id, "post-1", "tags", Tag.id, "tag-a", { weight: 10 })
  )
  await storage.applyLinkUpserted(linkEvent(Post.id, "post-1", "tags", Tag.id, "tag-b"))
  await storage.applyLinkUpserted(linkEvent(Post.id, "post-1", "tags", Tag.id, "tag-c"))
  await storage.applyLinkUpserted(linkEvent(Post.id, "post-1", "tags", Tag.id, "tag-missing"))
})

afterAll(() => {
  storage.close()
})

describe("SqliteObjectStorage expand pushdown", () => {
  test("declares expand pushdown support", () => {
    expect(storage.queryCapabilities().nodes?.expand).toBe(true)
  })

  test("hydrates one and many links in-database, dropping a dangling edge", async () => {
    const result = await executeObjectQuery(
      {
        projectId,
        query: {
          kind: "expand",
          expansions: [
            { linkId: "author", direction: "outgoing" },
            { linkId: "tags", direction: "outgoing" },
          ],
          input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: Post.id } },
        },
      },
      { ontology, storage }
    )

    expect(result.plan.mode).toBe("pushdown")
    const post = postRow(result, "post-1")

    // "one" → a single object (not an array), with timestamps revived to Date.
    const author = post.links?.author as ExpandedObjectRow
    expect(Array.isArray(author)).toBe(false)
    expect(author.primaryId).toBe("author-1")
    expect(author.properties.name).toBe("Alice")
    expect(author.createdAt).toBeInstanceOf(Date)
    expect(author.updatedAt).toBeInstanceOf(Date)

    // "many" → an array; the dangling tag-missing edge hydrates to nothing.
    const tags = post.links?.tags as ExpandedObjectRow[]
    expect(tags.map((tag) => tag.primaryId).sort()).toEqual(["tag-a", "tag-b", "tag-c"])
  })

  test("orders and bounds a many expansion to the top-N by target property", async () => {
    const result = await executeObjectQuery(
      {
        projectId,
        query: {
          kind: "expand",
          expansions: [
            {
              linkId: "tags",
              direction: "outgoing",
              limit: 2,
              orderBy: [{ kind: "property", propertyId: "label", direction: "asc" }],
            },
          ],
          input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: Post.id } },
        },
      },
      { ontology, storage }
    )

    expect(result.plan.mode).toBe("pushdown")
    const tags = postRow(result, "post-1").links?.tags as ExpandedObjectRow[]
    // Apple, Banana, Cherry → top-2 ascending, in order.
    expect(tags.map((tag) => tag.primaryId)).toEqual(["tag-a", "tag-b"])
  })

  test("attaches link properties only when present", async () => {
    const result = await executeObjectQuery(
      {
        projectId,
        query: {
          kind: "expand",
          expansions: [{ linkId: "tags", direction: "outgoing" }],
          input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: Post.id } },
        },
      },
      { ontology, storage }
    )

    const tags = postRow(result, "post-1").links?.tags as ExpandedObjectRow[]
    const tagA = tags.find((tag) => tag.primaryId === "tag-a")
    const tagB = tags.find((tag) => tag.primaryId === "tag-b")
    expect(tagA?.linkProperties).toEqual({ weight: 10 })
    expect(tagB?.linkProperties).toBeUndefined()
  })

  test("hydrates a nested expansion correlated on the parent neighbour", async () => {
    const result = await executeObjectQuery(
      {
        projectId,
        query: {
          kind: "expand",
          expansions: [
            {
              linkId: "author",
              direction: "outgoing",
              expand: [{ linkId: "favoriteTag", direction: "outgoing" }],
            },
          ],
          input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: Post.id } },
        },
      },
      { ontology, storage }
    )

    expect(result.plan.mode).toBe("pushdown")
    const author = postRow(result, "post-1").links?.author as ExpandedObjectRow
    const favorite = author.links?.favoriteTag as ExpandedObjectRow
    expect(favorite.primaryId).toBe("tag-b")
    expect(favorite.properties.label).toBe("Banana")
  })

  test("hydrates a three-hop expansion end to end", async () => {
    const result = await executeObjectQuery(
      {
        projectId,
        query: {
          kind: "expand",
          expansions: [
            {
              linkId: "author",
              direction: "outgoing",
              expand: [
                {
                  linkId: "manager",
                  direction: "outgoing",
                  expand: [{ linkId: "favoriteTag", direction: "outgoing" }],
                },
              ],
            },
          ],
          input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: Post.id } },
        },
      },
      { ontology, storage }
    )

    expect(result.plan.mode).toBe("pushdown")
    // post-1 → author-1 → manager author-2 → favoriteTag tag-c, verified at each hop.
    const author = postRow(result, "post-1").links?.author as ExpandedObjectRow
    const manager = author.links?.manager as ExpandedObjectRow
    expect(manager.primaryId).toBe("author-2")
    const favorite = manager.links?.favoriteTag as ExpandedObjectRow
    expect(favorite.primaryId).toBe("tag-c")
    expect(favorite.properties.label).toBe("Cherry")
  })

  test("hydrates an incoming expansion back to its sources", async () => {
    const result = await executeObjectQuery(
      {
        projectId,
        query: {
          kind: "expand",
          expansions: [{ linkId: "tags", direction: "incoming", sourceObjectTypeId: Post.id }],
          input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: Tag.id } },
        },
      },
      { ontology, storage }
    )

    expect(result.plan.mode).toBe("pushdown")
    const tagA = result.objects.find((row) => row.primaryId === "tag-a")
    const sources = tagA?.links?.tags as ExpandedObjectRow[]
    expect(sources.map((source) => source.primaryId)).toEqual(["post-1"])
  })
})

function postRow(
  result: Awaited<ReturnType<typeof executeObjectQuery>>,
  primaryId: string
): { links?: Record<string, unknown> } & { primaryId: string } {
  const row = result.objects.find((candidate) => candidate.primaryId === primaryId)
  if (!row) throw new Error(`row '${primaryId}' not found`)
  return row
}

function objectEvent(
  objectTypeId: string,
  primaryId: string,
  properties: Record<string, unknown>
): StoredObjectUpsertedEvent {
  cursor += 1
  const tag = String(cursor).padStart(3, "0")
  return {
    id: `expand-e2e-object-${tag}`,
    cursor: tag,
    schemaVersion: 1,
    projectId,
    type: "object.upserted",
    topic: "objects",
    partitionKey: `${objectTypeId}:${primaryId}`,
    payload: { objectTypeId, primaryId, properties },
    occurredAt: `2026-01-01T00:00:${tag.slice(-2)}.000Z`,
  }
}

function linkEvent(
  sourceTypeId: string,
  sourceId: string,
  linkId: string,
  targetTypeId: string,
  targetId: string,
  properties?: Record<string, unknown>
): StoredLinkUpsertedEvent {
  cursor += 1
  const tag = String(cursor).padStart(3, "0")
  return {
    id: `expand-e2e-link-${tag}`,
    cursor: tag,
    schemaVersion: 1,
    projectId,
    type: "link.upserted",
    topic: "links",
    partitionKey: `${sourceTypeId}:${sourceId}:${linkId}`,
    payload: {
      sourceTypeId,
      sourceId,
      linkId,
      targetTypeId,
      targetId,
      ...(properties === undefined ? {} : { properties }),
    },
    occurredAt: `2026-01-01T00:00:${tag.slice(-2)}.000Z`,
  }
}
