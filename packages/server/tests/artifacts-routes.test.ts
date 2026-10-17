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

const PROJECT_ID = "artifact-route-tests"

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
  const put = async (path: string, body: string, mediaType: string) => ({
    path,
    file: await blobStorage.put({
      body: new TextEncoder().encode(body),
      fileName: path,
      mediaType,
    }),
  })
  return { app, storage, put }
}

async function seedSession(storage: InMemoryStorage, userId: string) {
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
    headers: { cookie },
    mutationHeaders: {
      cookie: `${cookie}; sixb_csrf_app=csrf_1`,
      "x-sixb-csrf": "csrf_1",
      "content-type": "application/json",
    },
  }
}

function url(path: string): string {
  return `http://localhost${path}`
}

describe("artifact routes", () => {
  test("the owner creates, publishes, reads, and deletes an artifact", async () => {
    const { app, storage, put } = createApp()
    const alice = await seedSession(storage, "alice")
    const markdown = "# Q3 report\n\n## Revenue\n\n![Chart](figures/chart.svg)\n"
    const files = [
      await put("document.md", markdown, "text/markdown"),
      await put("figures/chart.svg", "<svg/>", "image/svg+xml"),
    ]

    const created = await app.fetch(
      new Request(url("/api/artifacts"), {
        method: "POST",
        headers: alice.mutationHeaders,
        body: JSON.stringify({ kind: "document", title: "Q3 report", files }),
      })
    )
    expect(created.status).toBe(201)
    const first = await created.json()
    const id = first.artifact.id as string
    expect(first).toMatchObject({
      artifact: {
        kind: "document",
        title: "Q3 report",
        owner: { type: "user", id: "alice" },
        latestVersion: 1,
      },
      version: {
        version: 1,
        entry: "document.md",
        outline: {
          kind: "document",
          headings: [
            { depth: 1, text: "Q3 report", slug: "q3-report" },
            { depth: 2, text: "Revenue", slug: "revenue" },
          ],
        },
      },
      warnings: [],
    })

    const published = await app.fetch(
      new Request(url(`/api/artifacts/${id}/versions`), {
        method: "POST",
        headers: alice.mutationHeaders,
        body: JSON.stringify({ kind: "document", title: "Q3 report, revised", files }),
      })
    )
    expect(published.status).toBe(201)
    expect((await published.json()).version.version).toBe(2)

    const listed = await (await app.fetch(new Request(url("/api/artifacts"), alice))).json()
    expect(listed).toMatchObject({
      total: 1,
      hasMore: false,
      artifacts: [{ id, latestVersion: 2 }],
    })

    const detail = await (await app.fetch(new Request(url(`/api/artifacts/${id}`), alice))).json()
    expect(detail.artifact.title).toBe("Q3 report, revised")
    expect(detail.versions.map((version: { version: number }) => version.version)).toEqual([2, 1])

    const latest = await app.fetch(new Request(url(`/api/artifacts/${id}/versions/latest`), alice))
    expect((await latest.json()).version).toBe(2)

    const contentUrl = url(`/api/artifacts/${id}/versions/1/content?path=document.md`)
    const content = await app.fetch(new Request(contentUrl, alice))
    expect(content.status).toBe(200)
    expect(await content.text()).toBe(markdown)
    const etag = content.headers.get("etag")
    expect(etag).toBeTruthy()

    const head = await app.fetch(new Request(contentUrl, { ...alice, method: "HEAD" }))
    expect(head.status).toBe(200)
    expect(head.headers.get("etag")).toBe(etag)
    expect(head.headers.get("content-length")).toBe(content.headers.get("content-length"))
    expect(await head.text()).toBe("")

    const notModified = await app.fetch(
      new Request(contentUrl, { headers: { ...alice.headers, "if-none-match": etag ?? "" } })
    )
    expect(notModified.status).toBe(304)

    const range = await app.fetch(
      new Request(contentUrl, { headers: { ...alice.headers, range: "bytes=2-11" } })
    )
    expect(range.status).toBe(206)
    expect(await range.text()).toBe("Q3 report\n")

    const deleted = await app.fetch(
      new Request(url(`/api/artifacts/${id}`), { method: "DELETE", headers: alice.mutationHeaders })
    )
    expect(deleted.status).toBe(200)
    expect((await app.fetch(new Request(url(`/api/artifacts/${id}`), alice))).status).toBe(404)
  })

  test("refuses a version that does not fit its kind, with the validator's reason", async () => {
    const { app, storage, put } = createApp()
    const alice = await seedSession(storage, "alice")
    const post = (path: string, body: unknown) =>
      app.fetch(
        new Request(url(path), {
          method: "POST",
          headers: alice.mutationHeaders,
          body: JSON.stringify(body),
        })
      )

    const missingEntry = await post("/api/artifacts", {
      kind: "document",
      title: "Report",
      files: [await put("report.md", "# Report", "text/markdown")],
    })
    expect(missingEntry.status).toBe(400)
    expect(await missingEntry.json()).toMatchObject({
      code: "invalid_artifact",
      error: expect.stringContaining("document.md"),
    })

    const files = [await put("document.md", "# Report", "text/markdown")]
    const { artifact } = await (
      await post("/api/artifacts", { kind: "document", title: "Report", files })
    ).json()
    const mismatch = await post(`/api/artifacts/${artifact.id}/versions`, {
      kind: "file",
      title: "Report",
      files,
    })
    expect(mismatch.status).toBe(409)
    expect((await mismatch.json()).code).toBe("artifact_kind_mismatch")

    const badReference = await post("/api/artifacts", {
      kind: "file",
      title: "Report",
      files: [{ path: "a.txt", file: { ...files[0]?.file, blobId: "blob_not-a-digest" } }],
    })
    expect(badReference.status).toBe(400)
  })

  test("another user finds nothing, and unknown artifacts, versions, and paths are 404", async () => {
    const { app, storage, put } = createApp()
    const alice = await seedSession(storage, "alice")
    const bob = await seedSession(storage, "bob")
    const files = [await put("document.md", "# Report", "text/markdown")]
    const created = await app.fetch(
      new Request(url("/api/artifacts"), {
        method: "POST",
        headers: alice.mutationHeaders,
        body: JSON.stringify({ kind: "document", title: "Report", files }),
      })
    )
    const { artifact } = await created.json()
    const base = `/api/artifacts/${artifact.id}`

    for (const path of [
      base,
      `${base}/versions/1`,
      `${base}/versions/1/content?path=document.md`,
    ]) {
      expect((await app.fetch(new Request(url(path), bob))).status, path).toBe(404)
    }
    expect((await (await app.fetch(new Request(url("/api/artifacts"), bob))).json()).total).toBe(0)
    const bobPublish = await app.fetch(
      new Request(url(`${base}/versions`), {
        method: "POST",
        headers: bob.mutationHeaders,
        body: JSON.stringify({ kind: "document", title: "Mine", files }),
      })
    )
    expect(bobPublish.status).toBe(404)
    const bobDelete = await app.fetch(
      new Request(url(base), { method: "DELETE", headers: bob.mutationHeaders })
    )
    expect(bobDelete.status).toBe(404)

    for (const path of [
      "/api/artifacts/art_missing",
      `${base}/versions/2`,
      `${base}/versions/1/content?path=figures/missing.svg`,
      `${base}/versions/1/content?path=../document.md`,
    ]) {
      expect((await app.fetch(new Request(url(path), alice))).status, path).toBe(404)
    }
  })
})
