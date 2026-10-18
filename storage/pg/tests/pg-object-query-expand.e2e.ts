import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { defineObjectType, link, OntologyRegistry, prop } from "@sixb/core"
import { executeObjectQuery } from "@sixb/core/internal/query"
import type { ExpandedObjectRow } from "@sixb/core/storage"
import { createMaterializerTestFixture } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage, disposeTestStorage } from "./helpers"

// Self-contained ontology exercising the runtime shapes the in-memory contract
// can't: a "one" link, a "many" link, a nested "one" hop, link properties, and a
// stable link metadata. All assertions hold for both pushdown (here, against Postgres)
// and the bounded fallback the cross-provider contract covers separately.
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
    link("tags", Tag, {
      cardinality: "many",
      properties: [prop("weight", "integer")],
    }),
  ],
})

const ontology = new OntologyRegistry({ sources: [Tag, Author, Post] })
const projectId = "expand-e2e"

let storage: PostgresStorage
beforeAll(async () => {
  const created = await createTestStorage()
  storage = created.storage
  const fixture = createMaterializerTestFixture({ projectId, ontology, storage })
  await fixture.seed({
    objects: [
      {
        ref: { objectTypeId: Tag.id, primaryId: "tag-a" },
        properties: { id: "tag-a", label: "Apple" },
      },
      {
        ref: { objectTypeId: Tag.id, primaryId: "tag-b" },
        properties: { id: "tag-b", label: "Banana" },
      },
      {
        ref: { objectTypeId: Tag.id, primaryId: "tag-c" },
        properties: { id: "tag-c", label: "Cherry" },
      },
      {
        ref: { objectTypeId: Author.id, primaryId: "author-1" },
        properties: { id: "author-1", name: "Alice" },
      },
      {
        ref: { objectTypeId: Author.id, primaryId: "author-2" },
        properties: { id: "author-2", name: "Bob" },
      },
      {
        ref: { objectTypeId: Post.id, primaryId: "post-1" },
        properties: { id: "post-1", title: "First" },
      },
    ],
    links: [
      {
        ref: {
          source: { objectTypeId: Post.id, primaryId: "post-1" },
          linkId: "author",
          target: { objectTypeId: Author.id, primaryId: "author-1" },
        },
      },
      {
        ref: {
          source: { objectTypeId: Author.id, primaryId: "author-1" },
          linkId: "favoriteTag",
          target: { objectTypeId: Tag.id, primaryId: "tag-b" },
        },
      },
      {
        ref: {
          source: { objectTypeId: Author.id, primaryId: "author-1" },
          linkId: "manager",
          target: { objectTypeId: Author.id, primaryId: "author-2" },
        },
      },
      {
        ref: {
          source: { objectTypeId: Author.id, primaryId: "author-2" },
          linkId: "favoriteTag",
          target: { objectTypeId: Tag.id, primaryId: "tag-c" },
        },
      },
      {
        ref: {
          source: { objectTypeId: Post.id, primaryId: "post-1" },
          linkId: "tags",
          target: { objectTypeId: Tag.id, primaryId: "tag-a" },
        },
        properties: { weight: 10 },
      },
      {
        ref: {
          source: { objectTypeId: Post.id, primaryId: "post-1" },
          linkId: "tags",
          target: { objectTypeId: Tag.id, primaryId: "tag-b" },
        },
      },
      {
        ref: {
          source: { objectTypeId: Post.id, primaryId: "post-1" },
          linkId: "tags",
          target: { objectTypeId: Tag.id, primaryId: "tag-c" },
        },
      },
    ],
  })
})

afterAll(async () => {
  await disposeTestStorage(storage)
})

describe("PgObjectStorage expand pushdown", () => {
  test("hydrates one and many links in-database, with link properties", async () => {
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
      { ontology, storage: storage.objects }
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

    // "many" → an array, carrying link properties only where the link has them.
    const tags = post.links?.tags as ExpandedObjectRow[]
    expect(tags.map((tag) => tag.primaryId).sort()).toEqual(["tag-a", "tag-b", "tag-c"])
    expect(tags.find((tag) => tag.primaryId === "tag-a")?.linkProperties).toEqual({ weight: 10 })
    expect(tags.find((tag) => tag.primaryId === "tag-b")?.linkProperties).toBeUndefined()
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
      { ontology, storage: storage.objects }
    )

    expect(result.plan.mode).toBe("pushdown")
    const tags = postRow(result, "post-1").links?.tags as ExpandedObjectRow[]
    // Apple, Banana, Cherry → top-2 ascending, in order.
    expect(tags.map((tag) => tag.primaryId)).toEqual(["tag-a", "tag-b"])
  })

  test("hydrates nested expansions correlated on each parent neighbour", async () => {
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
                { linkId: "favoriteTag", direction: "outgoing" },
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
      { ontology, storage: storage.objects }
    )

    expect(result.plan.mode).toBe("pushdown")
    // post-1 → author-1 (favoriteTag tag-b) → manager author-2 → favoriteTag tag-c: each hop
    // correlates on its own parent, so the two favoriteTag expansions differ.
    const author = postRow(result, "post-1").links?.author as ExpandedObjectRow
    const authorFavorite = author.links?.favoriteTag as ExpandedObjectRow
    expect(authorFavorite.primaryId).toBe("tag-b")
    expect(authorFavorite.properties.label).toBe("Banana")
    const manager = author.links?.manager as ExpandedObjectRow
    expect(manager.primaryId).toBe("author-2")
    const favorite = manager.links?.favoriteTag as ExpandedObjectRow
    expect(favorite.primaryId).toBe("tag-c")
    expect(favorite.properties.label).toBe("Cherry")
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
