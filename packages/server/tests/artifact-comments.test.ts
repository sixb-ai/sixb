import { describe, expect, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const PROJECT_ID = "artifact-comment-routes"
const url = (path: string) => `http://localhost${path}`

function createApp() {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const host = new SixbHost({
    id: PROJECT_ID,
    ontology: [],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage,
    queues: new InMemoryQueues(),
    auth: { id: "test", kind: "dev" as const },
  })
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  const put = async (path: string, body: string) => ({
    path,
    file: await blobStorage.put({ body: new TextEncoder().encode(body), fileName: path }),
  })
  return { app, storage, put }
}

async function session(storage: InMemoryStorage, userId: string) {
  const credential = createSessionCredential(`ses_${userId}`)
  await storage.auth.users.create({
    id: userId,
    projectId: PROJECT_ID,
    email: `${userId}@acme.com`,
  })
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: PROJECT_ID,
    userId,
    strategyId: "test",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-10-17T10:00:00.000Z"),
    expiresAt: new Date("2099-10-17T10:00:00.000Z"),
  })
  const cookie = `sixb_session_app=${credential.cookieValue}`
  return {
    cookie,
    mutation: {
      cookie: `${cookie}; sixb_csrf_app=csrf_1`,
      "x-sixb-csrf": "csrf_1",
      "content-type": "application/json",
    },
  }
}

describe("an artifact's comments over HTTP", () => {
  test("are added, replied to, listed, resolved and deleted by the artifact's owner", async () => {
    const { app, storage, put } = createApp()
    const alice = await session(storage, "alice")
    const created = await app.fetch(
      new Request(url("/api/artifacts"), {
        method: "POST",
        headers: alice.mutation,
        body: JSON.stringify({
          kind: "canvas",
          title: "Flow",
          files: [
            await put(
              "canvas.json",
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
        }),
      })
    )
    expect(created.status).toBe(201)
    const { artifact } = (await created.json()) as { artifact: { id: string } }
    const base = `/api/artifacts/${artifact.id}/comments`
    const send = (path: string, method: string, body?: unknown) =>
      app.fetch(
        new Request(url(path), {
          method,
          headers: method === "GET" ? { cookie: alice.cookie } : alice.mutation,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      )

    const added = await send(base, "POST", {
      body: "Warmer, please",
      anchor: { board: "welcome", element: "body>main:0>h1:0", label: "Welcome" },
    })
    expect(added.status).toBe(201)
    const comment = (await added.json()) as { id: string; anchor: unknown }
    expect(comment).toMatchObject({
      artifactId: artifact.id,
      anchor: { board: "welcome", element: "body>main:0>h1:0", label: "Welcome", revision: 1 },
      body: "Warmer, please",
      author: { type: "user", id: "alice" },
    })
    const replied = await send(base, "POST", { body: "Done", parentId: comment.id })
    expect(await replied.json()).toMatchObject({ parentId: comment.id, anchor: comment.anchor })

    const listed = (await (await send(base, "GET")).json()) as { comments: { body: string }[] }
    expect(listed.comments.map(({ body }) => body)).toEqual(["Warmer, please", "Done"])

    const resolved = await send(`${base}/${comment.id}/resolve`, "POST", {})
    expect(await resolved.json()).toMatchObject({
      resolvedAt: expect.any(String),
      resolvedBy: { type: "user", id: "alice" },
    })
    const reopened = await send(`${base}/${comment.id}/resolve`, "POST", { resolved: false })
    expect(await reopened.json()).not.toHaveProperty("resolvedAt")

    expect(await (await send(`${base}/${comment.id}`, "DELETE")).json()).toEqual({ deleted: true })
    const gone = await send(`${base}/${comment.id}`, "DELETE")
    expect(gone.status).toBe(404)
    expect(await gone.json()).toMatchObject({ code: "comment_not_found" })
    expect(((await (await send(base, "GET")).json()) as { comments: [] }).comments).toEqual([])

    const invalid = await send(base, "POST", { body: "Hm", anchor: { board: "nowhere" } })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: "invalid_comment" })

    // Someone it is not shared with reads none.
    const bob = await session(storage, "bob")
    const refused = await app.fetch(new Request(url(base), { headers: { cookie: bob.cookie } }))
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: "not_shared" })
  })
})
