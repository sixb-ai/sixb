import { describe, expect, test } from "bun:test"
import {
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import { FRAME_PROTOCOL, parseFrameCall } from "@sixb/core/artifacts"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createTestSixb } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const PROJECT_ID = "artifact-route-tests"

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("status", "string", { query: { searchable: true, filterable: true } }),
  ],
})
const readers = defineGroup("invoice-readers")
const invoiceReader = defineRole("invoice-reader", {
  grantedTo: [readers],
  grants: [can.view(Invoice)],
})

function createApp() {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const host = new SixbHost({
    id: PROJECT_ID,
    ontology: [Invoice],
    groups: [readers],
    roles: [invoiceReader],
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
  return { app, host, storage, put }
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
    const ofKind = async (kind: string) =>
      app.fetch(new Request(url(`/api/artifacts?kind=${kind}`), alice))
    expect((await (await ofKind("document")).json()).total).toBe(1)
    expect((await (await ofKind("slides")).json()).total).toBe(0)
    expect((await ofKind("spreadsheet")).status).toBe(422)

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

    // A save from version 1 after version 2 was published is refused, naming version 2.
    const edited = await post(`/api/artifacts/${artifact.id}/versions`, {
      kind: "document",
      title: "Report",
      files,
      baseVersion: 1,
    })
    expect(edited.status).toBe(201)
    const moved = await post(`/api/artifacts/${artifact.id}/versions`, {
      kind: "document",
      title: "Report",
      files,
      baseVersion: 1,
    })
    expect(moved.status).toBe(409)
    expect(await moved.json()).toMatchObject({
      code: "artifact_moved",
      latest: { version: 2, author: { type: "user" } },
    })

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
      // It exists but is not shared with Bob: refused, not hidden, so a page can say why.
      const refused = await app.fetch(new Request(url(path), bob))
      expect(refused.status, path).toBe(403)
      expect(await refused.json()).toMatchObject({ code: "not_shared" })
    }
    expect((await (await app.fetch(new Request(url("/api/artifacts"), bob))).json()).total).toBe(0)
    const bobPublish = await app.fetch(
      new Request(url(`${base}/versions`), {
        method: "POST",
        headers: bob.mutationHeaders,
        body: JSON.stringify({ kind: "document", title: "Mine", files }),
      })
    )
    expect(bobPublish.status).toBe(403)
    const bobDelete = await app.fetch(
      new Request(url(base), { method: "DELETE", headers: bob.mutationHeaders })
    )
    expect(bobDelete.status).toBe(403)

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

describe("what a page keeps", () => {
  async function page() {
    const { app, storage, put } = createApp()
    const alice = await seedSession(storage, "alice")
    const created = await app.fetch(
      new Request(url("/api/artifacts"), {
        method: "POST",
        headers: alice.mutationHeaders,
        body: JSON.stringify({
          kind: "page",
          title: "Rate what-if",
          files: [await put("index.html", "<main><h1>Rate what-if</h1></main>", "text/html")],
        }),
      })
    )
    const id = (await created.json()).artifact.id as string
    const call = (path: string, init: { method?: string; body?: unknown } = {}, as = alice) =>
      app.fetch(
        new Request(url(`/api/artifacts/${id}/state${path}`), {
          method: init.method ?? "GET",
          headers: init.method ? as.mutationHeaders : as.headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        })
      )
    return { storage, call }
  }

  test("keeps the reader's values by key, across requests, until they reset them", async () => {
    const { call } = await page()
    const kept = await call("/inputs", {
      method: "PUT",
      body: { value: { rate: 450, occupancy: 84 } },
    })
    expect(kept.status).toBe(200)
    expect(await kept.json()).toMatchObject({ key: "inputs", value: { rate: 450, occupancy: 84 } })
    // A key may hold any character a page names it with.
    expect(
      (
        await call(`/${encodeURIComponent("view/Lisboa 2")}`, {
          method: "PUT",
          body: { value: "chart" },
        })
      ).status
    ).toBe(200)

    const read = await (await call("")).json()
    expect(
      read.entries.map((entry: { key: string; value: unknown }) => [entry.key, entry.value])
    ).toEqual([
      ["inputs", { rate: 450, occupancy: 84 }],
      ["view/Lisboa 2", "chart"],
    ])

    expect(await (await call("/inputs", { method: "DELETE" })).json()).toEqual({ deleted: true })
    expect(await (await call("", { method: "DELETE" })).json()).toEqual({ cleared: 1 })
    expect((await (await call("")).json()).entries).toEqual([])
  })

  test("keeps each reader's own, and keeps nothing for one who can't open the page", async () => {
    // Reproduce by dropping the visibility check from `state` in createArtifactsRuntime: Bob
    // writes into Alice's page.
    const { storage, call } = await page()
    const bob = await seedSession(storage, "bob")
    expect((await call("/inputs", { method: "PUT", body: { value: 1 } }, bob)).status).toBe(403)
    expect((await call("", {}, bob)).status).toBe(403)
  })

  test("refuses a value past the limits, and a key or a value that is not one", async () => {
    const { call } = await page()
    const big = await call("/big", { method: "PUT", body: { value: "x".repeat(70 * 1024) } })
    expect(big.status).toBe(413)
    expect(await big.json()).toMatchObject({ code: "state_full" })
    const control = await call(`/${encodeURIComponent("a\nb")}`, {
      method: "PUT",
      body: { value: 1 },
    })
    expect(control.status).toBe(400)
    expect(await control.json()).toMatchObject({ code: "invalid_state" })
    // The body is checked before the route runs, as every body is.
    expect((await call("/empty", { method: "PUT", body: {} })).status).toBe(422)
  })

  test("never sends a key that names another route", async () => {
    // The client puts the key in the path with encodeURIComponent, which keeps dots, and the URL
    // parser resolves them: `/state/..` is the artifact itself, `/state/.` every value the reader
    // keeps. Reproduce by accepting "." and ".." in isStateKey (protocol.ts): the page's delete
    // reaches the server, and the artifact is gone.
    const { call } = await page()
    await call("/inputs", { method: "PUT", body: { value: 1 } })

    for (const key of ["..", "."]) {
      const sent = parseFrameCall({
        protocol: FRAME_PROTOCOL,
        call: 1,
        method: "state.delete",
        params: { key },
      })
      expect(sent, key).toBeNull()

      // What the app would send for it, as the generated client writes the path.
      if (sent?.method === "state.delete") {
        await call(`/${encodeURIComponent(sent.params.key)}`, { method: "DELETE" })
      }
    }

    const kept = await call("")
    expect(kept.status).toBe(200)
    expect((await kept.json()).entries).toMatchObject([{ key: "inputs", value: 1 }])
  })
})

describe("an artifact's queries", () => {
  // Guard proof: drop `case "query_not_found"` from handleArtifactRouteError; the query the
  // version does not hold then answers 422, not 404.
  test("run as the caller, by name, at a version", async () => {
    const { app, host, storage, put } = createApp()
    const alice = await seedSession(storage, "alice")
    const bob = await seedSession(storage, "bob")
    for (const userId of ["alice", "bob"]) {
      await storage.auth.groupMemberships.upsert({
        projectId: PROJECT_ID,
        userId,
        groupId: readers.id,
        source: "manual",
      })
    }
    await createTestSixb(host).objects.upsert("Invoice", { id: "inv_1", status: "open" })

    const open = {
      kind: "filter",
      input: { kind: "start", objectTypeId: "Invoice" },
      predicate: { op: "eq", propertyId: "status", value: "open" },
    }
    const files = [
      await put("index.html", "<!doctype html><title>Open</title><p>Open</p>", "text/html"),
      await put("queries/open.json", JSON.stringify(open), "application/json"),
    ]
    const created = await app.fetch(
      new Request(url("/api/artifacts"), {
        method: "POST",
        headers: alice.mutationHeaders,
        body: JSON.stringify({ kind: "page", title: "Open", files }),
      })
    )
    const body = await created.json()
    expect(created.status).toBe(201)
    const base = `/api/artifacts/${body.artifact.id}/versions`

    const read = await app.fetch(new Request(url(`${base}/latest/queries/open`), alice))
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({
      kind: "objects",
      objects: [
        {
          primaryId: "inv_1",
          objectTypeId: "Invoice",
          properties: { id: "inv_1", status: "open" },
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      ],
      total: 1,
      truncated: false,
      resultObjectTypeIds: ["Invoice"],
      readObjectTypeIds: ["Invoice"],
      schema: { properties: { id: { type: "string" }, status: { type: "string" } }, links: {} },
    })

    const missing = await app.fetch(new Request(url(`${base}/1/queries/closed`), alice))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: "query_not_found" })
    expect((await app.fetch(new Request(url(`${base}/2/queries/open`), alice))).status).toBe(404)

    // It exists but is not shared with Bob: refused, as every read of it is.
    const refused = await app.fetch(new Request(url(`${base}/1/queries/open`), bob))
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: "not_shared" })
  })
})
