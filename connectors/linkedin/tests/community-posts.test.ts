import { afterEach, describe, expect, test } from "bun:test"
import { organizationUrn, shareUrn, ugcPostUrn } from "../src"
import { collect, createTestClient, empty, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("linkedin community posts and engagement", () => {
  test("follows Posts next links even when LinkedIn returns a short page", async () => {
    const author = organizationUrn(123)
    const first = shareUrn(1)
    const second = ugcPostUrn(2)
    const calls = recorder([
      json({
        elements: [{ id: first, author, visibility: "PUBLIC", lifecycleState: "PUBLISHED" }],
        paging: {
          start: 0,
          count: 100,
          links: [{ rel: "next", href: "/rest/posts?q=author&start=100&count=100" }],
        },
      }),
      json({
        elements: [{ id: second, author, visibility: "PUBLIC", lifecycleState: "PUBLISHED" }],
        paging: { start: 100, count: 100, links: [] },
      }),
    ])
    const client = await createTestClient()

    const posts = await collect(client.posts.listAllByAuthor(author))

    expect(posts.map((post) => post.id)).toEqual([first, second])
    expect(new URL(calls[0]?.url ?? "").searchParams.get("count")).toBe("100")
    expect(new URL(calls[1]?.url ?? "").searchParams.get("start")).toBe("100")
    expect(calls[0]?.headers.get("x-restli-method")).toBe("FINDER")
  })

  test("gets, creates, updates, and deletes Posts using encoded URN paths", async () => {
    const author = organizationUrn(123)
    const post = shareUrn(456)
    const calls = recorder([
      json({ id: post, author, visibility: "PUBLIC", lifecycleState: "PUBLISHED" }),
      empty(201, { "x-restli-id": post }),
      empty(),
      empty(),
    ])
    const client = await createTestClient()

    await client.posts.get(post, "AUTHOR")
    const created = await client.posts.create({
      author,
      commentary: "Hello",
      distribution: { feedDistribution: "MAIN_FEED" },
      visibility: "PUBLIC",
      lifecycleState: "PUBLISHED",
    })
    await client.posts.update(post, { commentary: "Updated" })
    await client.posts.delete(post)

    expect(created.id).toBe(post)
    expect(new URL(calls[0]?.url ?? "").searchParams.get("viewContext")).toBe("AUTHOR")
    expect(JSON.parse(calls[1]?.body ?? "{}").commentary).toBe("Hello")
    expect(calls[2]?.headers.get("x-restli-method")).toBe("PARTIAL_UPDATE")
    expect(JSON.parse(calls[2]?.body ?? "{}")).toEqual({
      patch: { $set: { commentary: "Updated" } },
    })
    expect(calls[3]?.method).toBe("DELETE")
    expect(decodeURIComponent(new URL(calls[3]?.url ?? "").pathname)).toContain(post)
  })

  test("reads social metadata and manages comments", async () => {
    const organization = organizationUrn(123)
    const post = shareUrn(456)
    const calls = recorder([
      json({
        entity: post,
        commentSummary: { count: 1, topLevelCount: 1 },
        reactionSummaries: { LIKE: { count: 2 } },
      }),
      json({
        elements: [{ id: "10", actor: organization, message: { text: "Nice" } }],
        paging: { start: 0, count: 10, total: 1, links: [] },
      }),
      json(
        { id: "11", actor: organization, object: post, message: { text: "Thanks" } },
        { status: 201, headers: { "x-restli-id": "11" } }
      ),
      json({ id: "11", actor: organization, object: post, message: { text: "Thank you" } }),
      empty(),
      empty(202),
    ])
    const client = await createTestClient()

    const metadata = await client.socialMetadata.get(post)
    const comments = await client.comments.list(post, { count: 10 })
    const created = await client.comments.create(post, {
      actor: organization,
      message: { text: "Thanks" },
    })
    await client.comments.update(post, 11, {
      actor: organization,
      message: { text: "Thank you" },
    })
    await client.comments.delete(post, 11, organization)
    await client.socialMetadata.setCommentsState(post, organization, "OPEN")

    expect(metadata.commentSummary?.count).toBe(1)
    expect(comments.items[0]?.message.text).toBe("Nice")
    expect(created.id).toBe("11")
    expect(created.data.message.text).toBe("Thanks")
    expect(JSON.parse(calls[2]?.body ?? "{}")).toEqual({
      actor: organization,
      message: { text: "Thanks" },
      object: post,
    })
    expect(JSON.parse(calls[3]?.body ?? "{}")).toEqual({
      patch: { message: { $set: { text: "Thank you" } } },
    })
    expect(new URL(calls[4]?.url ?? "").searchParams.get("actor")).toBe(organization)
    expect(JSON.parse(calls[5]?.body ?? "{}")).toEqual({
      patch: { $set: { commentsState: "OPEN" } },
    })
  })

  test("reads, creates, and deletes reactions with Rest.li compound keys", async () => {
    const organization = organizationUrn(123)
    const post = shareUrn(456)
    const calls = recorder([
      json({ reactionType: "LIKE", root: post }),
      json({
        elements: [{ reactionType: "LIKE", root: post }],
        paging: { start: 0, count: 10, total: 1, links: [] },
      }),
      json({ reactionType: "PRAISE", root: post }, { status: 201 }),
      empty(),
    ])
    const client = await createTestClient()

    await client.reactions.get(organization, post)
    const reactions = await client.reactions.listByEntity(post, { count: 10 })
    const created = await client.reactions.create({
      actor: organization,
      entity: post,
      reactionType: "PRAISE",
    })
    await client.reactions.delete(organization, post)

    expect(decodeURIComponent(new URL(calls[0]?.url ?? "").pathname)).toContain(
      `(actor:${organization},entity:${post})`
    )
    expect(reactions.items[0]?.reactionType).toBe("LIKE")
    expect(new URL(calls[1]?.url ?? "").searchParams.get("sort")).toBe(
      "(value:REVERSE_CHRONOLOGICAL)"
    )
    expect(new URL(calls[2]?.url ?? "").searchParams.get("actor")).toBe(organization)
    expect(JSON.parse(calls[2]?.body ?? "{}")).toEqual({
      root: post,
      reactionType: "PRAISE",
    })
    expect(created.reactionType).toBe("PRAISE")
    expect(calls[3]?.method).toBe("DELETE")
  })

  test("rejects incomplete nested comments and the deprecated MAYBE reaction", async () => {
    const client = await createTestClient()
    const parent = "urn:li:comment:(urn:li:activity:123,456)" as const
    const actor = organizationUrn(123)

    await expect(
      client.comments.create(parent, { actor, message: { text: "Nested" } })
    ).rejects.toThrow("nested comments require both object and parentComment")
    await expect(
      client.reactions.create({ actor, entity: shareUrn(456), reactionType: "MAYBE" })
    ).rejects.toThrow("MAYBE is deprecated")
  })

  test("validates documented poll constraints before sending the post", async () => {
    const client = await createTestClient()
    const author = organizationUrn(123)

    await expect(
      client.posts.create({
        author,
        commentary: "Choose",
        content: {
          poll: {
            question: "Which option?",
            options: [{ text: "Only one" }],
            settings: { duration: "ONE_DAY" },
          },
        },
        distribution: { feedDistribution: "MAIN_FEED" },
        visibility: "PUBLIC",
        lifecycleState: "PUBLISHED",
      })
    ).rejects.toThrow("between 2 and 4 options")

    await expect(
      client.posts.create({
        author,
        commentary: "Choose",
        content: {
          poll: {
            question: "Which option?",
            options: [{ text: "One" }, { text: "Two" }],
            settings: { duration: "ONE_DAY", isVoterVisibleToAuthor: false },
          },
        },
        distribution: { feedDistribution: "MAIN_FEED" },
        visibility: "PUBLIC",
        lifecycleState: "PUBLISHED",
      })
    ).rejects.toThrow("requires isVoterVisibleToAuthor to be true")
  })
})
