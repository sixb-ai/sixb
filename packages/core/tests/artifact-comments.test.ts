import { describe, expect, test } from "bun:test"
import type { ArtifactFile } from "../src"
import { SixbHost } from "../src"
import { quoteArtifactComment } from "../src/artifacts"
import { CANVAS_FILE } from "../src/artifacts/canvas"
import { emptyGrantIndex, type GrantIndex } from "../src/authorization/types"
import { bindRequestExecution } from "../src/execution/request"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// Comments on a canvas: Marie owns it, Bob takes part in the conversation that shares it, so he
// may change it, Olivia observes conversations, so she reads it, and Paul reaches none of it.

const projectId = "artifact-comments"

async function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ id: projectId, ontology: [], ...deps })
  const storage = deps.storage
  const as = (id: string, grants: Partial<GrantIndex> = {}) =>
    bindRequestExecution(host, {
      request: new Request("http://localhost/test"),
      authorization: {
        type: "principal",
        credential: { type: "session", id: `session-${id}` },
        context: {
          principal: { type: "user", id },
          sessionId: `session-${id}`,
          groupIds: [],
          roleIds: [],
          grants: { ...emptyGrantIndex(), "run:agent": true, ...grants },
        },
      },
    })
  const marie = as("marie")

  await storage.agents.threads.create({
    projectId,
    id: "thr_marie",
    ownerPrincipal: { type: "user", id: "marie" },
  })
  await storage.agents.threads.addParticipants({
    projectId,
    threadId: "thr_marie",
    principals: [{ type: "user", id: "bob" }],
    addedBy: { type: "user", id: "marie" },
    maxParticipants: 50,
  })

  const put = async (path: string, body: string): Promise<ArtifactFile> => ({
    path,
    file: await deps.blobStorage.put({ body: new TextEncoder().encode(body), fileName: path }),
  })
  const created = await marie.artifacts.create({
    kind: "canvas",
    title: "Flow",
    files: [
      await put(
        CANVAS_FILE,
        JSON.stringify({
          items: [
            {
              id: "welcome",
              type: "board",
              file: "boards/welcome.html",
              x: 0,
              y: 0,
              w: 390,
              h: 844,
            },
          ],
        })
      ),
      await put("boards/welcome.html", "<main><h1>Welcome</h1></main>"),
    ],
  })
  const artifactId = created.artifact.id
  await storage.artifacts?.publish({
    projectId,
    artifactId,
    kind: "canvas",
    version: { ...created.version, origin: { threadId: "thr_marie", runId: "run_marie" } },
  })

  return {
    host,
    artifactId,
    marie,
    bob: as("bob"),
    olivia: as("olivia", { "observe:agentThreads": true }),
    paul: as("paul"),
  }
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error as { code?: string }).code ?? error
  )

describe("comments on an artifact", () => {
  test("are read and added by whoever reads it, a reply about what it replies to", async () => {
    const { artifactId, marie, olivia, paul } = await setup()

    const comment = await olivia.artifacts.addComment(artifactId, {
      body: "  Make this warmer  ",
      anchor: {
        board: "welcome",
        element: "body>main:0>h1:0",
        label: "Welcome\n home",
        point: { x: 0.5, y: 0.1 },
      },
    })
    expect(comment.id).toMatch(/^cmt_[0-9a-z]{10}$/)
    expect(comment).toMatchObject({
      artifactId,
      anchor: {
        board: "welcome",
        element: "body>main:0>h1:0",
        label: "Welcome home",
        point: { x: 0.5, y: 0.1 },
        revision: 2,
      },
      body: "Make this warmer",
      author: { type: "user", id: "olivia" },
    })

    const reply = await marie.artifacts.addComment(artifactId, {
      body: "On it",
      parentId: comment.id,
      anchor: { board: "elsewhere" },
    })
    expect(reply).toMatchObject({ parentId: comment.id, anchor: comment.anchor })
    expect((await marie.artifacts.listComments(artifactId))?.map(({ id }) => id)).toEqual([
      comment.id,
      reply.id,
    ])

    // Someone who cannot read it reads nothing, and adds nothing.
    expect(await paul.artifacts.listComments(artifactId)).toBeNull()
    expect(await refusal(paul.artifacts.addComment(artifactId, { body: "Hi" }))).toBe("not_shared")
  })

  // Guard proof: let `managed` in comments.ts pass whoever reads the artifact; Olivia then
  // resolves Bob's comment.
  test("are resolved and deleted by their author or whoever may change it, nobody else", async () => {
    const { artifactId, bob, marie, olivia } = await setup()
    const bobs = await bob.artifacts.addComment(artifactId, { body: "Tighten the copy" })
    const olivias = await olivia.artifacts.addComment(artifactId, { body: "Nice" })
    await bob.artifacts.addComment(artifactId, { body: "Thanks", parentId: olivias.id })

    expect(await refusal(olivia.artifacts.resolveComment(artifactId, bobs.id))).toBe("not_allowed")
    expect(await refusal(olivia.artifacts.deleteComment(artifactId, bobs.id))).toBe("not_allowed")

    // Bob may change the canvas: he resolves anyone's; Olivia deletes her own, replies and all.
    const resolved = await bob.artifacts.resolveComment(artifactId, olivias.id)
    expect(resolved).toMatchObject({ resolvedBy: { type: "user", id: "bob" } })
    expect(await bob.artifacts.resolveComment(artifactId, olivias.id, false)).not.toHaveProperty(
      "resolvedAt"
    )
    await olivia.artifacts.deleteComment(artifactId, olivias.id)
    await marie.artifacts.deleteComment(artifactId, bobs.id)
    expect(await marie.artifacts.listComments(artifactId)).toEqual([])
    expect(await refusal(marie.artifacts.deleteComment(artifactId, bobs.id))).toBe(
      "comment_not_found"
    )
  })

  test("refuse words or an anchor that will not do", async () => {
    const { artifactId, marie } = await setup()
    const add = (input: Parameters<typeof marie.artifacts.addComment>[1]) =>
      refusal(marie.artifacts.addComment(artifactId, input))

    expect(await add({ body: "   " })).toBe("invalid_comment")
    expect(await add({ body: "x".repeat(4_001) })).toBe("invalid_comment")
    expect(await add({ body: "Hm", anchor: { board: "missing" } })).toBe("invalid_comment")
    expect(await add({ body: "Hm", anchor: { element: "body>main:0" } })).toBe("invalid_comment")
    expect(await add({ body: "Hm", anchor: { board: "welcome", element: "main > h1" } })).toBe(
      "invalid_comment"
    )
    expect(await add({ body: "Hm", anchor: { revision: 3 } })).toBe("invalid_comment")
    expect(
      await add({
        body: "Hm",
        anchor: { board: "welcome", element: `body${">div:0".repeat(200)}` },
      })
    ).toBe("invalid_comment")
    expect(await add({ body: "Hm", anchor: { point: { x: 0.5, y: 0.5 } } })).toBe("invalid_comment")
    expect(await add({ body: "Hm", anchor: { board: "welcome", point: { x: 1.5, y: 0 } } })).toBe(
      "invalid_comment"
    )
    // A number written as text compares as one: it is refused all the same. Guard proof: drop
    // `Number.isFinite` from checkAnchor; the text point is kept.
    const textPoint = { x: "0.5", y: "0.5" } as unknown as { x: number; y: number }
    expect(await add({ body: "Hm", anchor: { board: "welcome", point: textPoint } })).toBe(
      "invalid_comment"
    )
    expect(await add({ body: "Hm", parentId: "cmt_missing" })).toBe("comment_not_found")
  })

  test("are announced to whoever reads the artifact, and nobody else", async () => {
    const { artifactId, marie, olivia, paul } = await setup()
    const comment = await olivia.artifacts.addComment(artifactId, { body: "Hm" })
    await marie.artifacts.resolveComment(artifactId, comment.id)
    await marie.artifacts.deleteComment(artifactId, comment.id)

    const announced = async (sixb: typeof marie) =>
      (await sixb.events.read({ types: ["artifact.commented"] })).map((event) => event.payload)
    expect(await announced(olivia)).toEqual([
      { artifactId, commentId: comment.id, action: "created" },
      { artifactId, commentId: comment.id, action: "resolved" },
      { artifactId, commentId: comment.id, action: "deleted" },
    ])
    expect(await announced(paul)).toEqual([])
  })

  test("are quoted for the Agent with where they are, as its skill reads them", () => {
    const anchor = {
      board: "welcome",
      element: "body>main:0>h1:0",
      label: "Welcome back",
      revision: 12,
    }
    expect(quoteArtifactComment({ anchor, body: "Make the title\nwarmer." })).toBe(
      '[welcome · body>main:0>h1:0 · "Welcome back" · revision 12] Make the title warmer.'
    )
    expect(quoteArtifactComment({ anchor: { board: "welcome", revision: 3 }, body: "Busy" })).toBe(
      "[welcome · revision 3] Busy"
    )
    expect(quoteArtifactComment({ anchor: { revision: 3 }, body: "Good" })).toBe(
      "[revision 3] Good"
    )
    // With its id, for the Agent to resolve it or reply to it, and whose request it is.
    expect(
      quoteArtifactComment({
        id: "cmt_4k2a9c0d1e",
        authorName: "Ava\nMartin",
        anchor,
        body: "Warmer",
      })
    ).toBe(
      '[welcome · body>main:0>h1:0 · "Welcome back" · revision 12 · comment cmt_4k2a9c0d1e · from Ava Martin] Warmer'
    )
    // A shared link's guest says so: nobody vouches for the name they typed.
    expect(
      quoteArtifactComment({ authorName: "Ava Martin", guest: true, anchor, body: "Warmer" })
    ).toBe(
      '[welcome · body>main:0>h1:0 · "Welcome back" · revision 12 · from guest Ava Martin] Warmer'
    )
  })
})
