import { describe, expect, test } from "bun:test"
import {
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  type FileRef,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import type { ObjectRow } from "@sixb/core/storage"
import { createTestSixb } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const Document = defineObjectType({
  id: "document",
  name: "Document",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("pdf", "fileRef"),
    prop("html", "fileRef"),
    prop("title", "string"),
  ],
})

const Invoice = defineObjectType({
  id: "invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true }), prop("pdf", "fileRef")],
})

const documentViewers = defineGroup("document-viewers")
const documentViewerRole = defineRole("document.viewer", {
  grantedTo: [documentViewers],
  grants: [can.view(Document)],
})

async function createObjectFileApi(options: { readonly auth?: boolean } = {}) {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const sixb = new SixbHost({
    id: "test-project",
    ontology: [Document, Invoice],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage,
    queues: new InMemoryQueues(),
    groups: [documentViewers],
    roles: [documentViewerRole],
    auth: options.auth ? { id: "test", kind: "dev" } : undefined,
  })

  const pdfRef = await blobStorage.put({
    body: new Blob(["%PDF test"], { type: "application/pdf" }),
    fileName: "report.pdf",
    mediaType: "application/pdf",
    logicalPath: "reports/report.pdf",
  })
  const htmlRef = await blobStorage.put({
    body: new TextEncoder().encode("<h1>unsafe</h1>"),
    fileName: "preview.html",
    mediaType: "text/html",
  })
  const invoiceRef = await blobStorage.put({
    body: new TextEncoder().encode("invoice pdf"),
    fileName: "invoice.pdf",
    mediaType: "application/pdf",
  })

  const setup = createTestSixb(sixb)
  await setup.objects.upsert("document", {
    id: "doc-1",
    title: "Q3 Report",
    pdf: pdfRef,
    html: htmlRef,
  })
  await setup.objects.upsert("invoice", {
    id: "inv-1",
    pdf: invoiceRef,
  })

  return {
    app: createSixbApi(
      new SixbServer({ host: sixb, quiet: true, browser: createTestBrowserPolicy() })
    ),
    storage,
    blobStorage,
    setup,
  }
}

async function seedSession(storage: InMemoryStorage, groupIds: readonly string[]) {
  const credential = createSessionCredential("ses_file_viewer")
  await storage.auth.users.create({
    id: "usr_file_viewer",
    projectId: "test-project",
    email: "viewer@example.com",
  })
  for (const groupId of groupIds) {
    await storage.auth.groupMemberships.upsert({
      projectId: "test-project",
      userId: "usr_file_viewer",
      groupId,
      source: "manual",
    })
  }
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: "test-project",
    userId: "usr_file_viewer",
    strategyId: "test",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-06-30T12:00:00.000Z"),
    expiresAt: new Date("2099-06-30T12:00:00.000Z"),
  })

  return { cookie: `sixb_session_app=${credential.cookieValue}` }
}

interface InMemoryObjectRows {
  snapshot(): { rows: Map<string, Map<string, Pick<ObjectRow, "objectTypeId" | "properties">>> }
  restore(snapshot: ReturnType<InMemoryObjectRows["snapshot"]>): void
}

function contentRequest(
  path: string,
  options: { readonly method?: string; readonly headers?: HeadersInit } = {}
) {
  return new Request(`http://localhost${path}`, {
    method: options.method ?? "GET",
    headers: options.headers,
  })
}

describe("object file content routes", () => {
  // A link opened in a new tab or an <img> sends no Origin; the session cookie alone opens it.
  test("serves file navigations without Origin to viewers of the object only", async () => {
    const { app, storage } = await createObjectFileApi({ auth: true })
    const session = await seedSession(storage, ["document-viewers"])
    const path = "/api/objects/document/doc-1/files/content?path=/properties/pdf"
    for (const method of ["GET", "HEAD"]) {
      for (const disposition of ["inline", "attachment"]) {
        const response = await app.fetch(
          contentRequest(`${path}&disposition=${disposition}`, {
            method,
            headers: { ...session, range: "bytes=0-3" },
          })
        )
        expect(response.status).toBe(206)
        expect(response.headers.get("content-range")).toBe("bytes 0-3/9")
        expect(response.headers.get("content-disposition")).toContain(disposition)
        expect(await response.text()).toBe(method === "HEAD" ? "" : "%PDF")
      }
      const signedOut = await app.fetch(contentRequest(path, { method }))
      expect(signedOut.status).toBe(401)
    }
    // Visibility and existence are checked before conditional responses, and an object the
    // viewer cannot see answers exactly like a missing one.
    for (const target of [
      "/api/objects/invoice/inv-1/files/content?path=/properties/pdf",
      "/api/objects/document/missing/files/content?path=/properties/pdf",
      "/api/objects/document/doc-1/files/content?path=/properties/missing",
    ]) {
      const response = await app.fetch(
        contentRequest(target, { headers: { ...session, "if-none-match": "*" } })
      )
      expect(response.status, target).toBe(404)
      expect(await response.json()).toEqual({ error: "File not found" })
    }
  })

  test("serves the app's origin and refuses any other", async () => {
    const { app, storage } = await createObjectFileApi({ auth: true })
    const session = await seedSession(storage, ["document-viewers"])
    const path = "/api/objects/document/doc-1/files/content?path=/properties/pdf"
    expect(
      (
        await app.fetch(
          contentRequest(path, { headers: { ...session, origin: "http://app.localhost" } })
        )
      ).status
    ).toBe(200)
    for (const origin of ["https://evil.test", "null"]) {
      expect(
        (await app.fetch(contentRequest(path, { headers: { ...session, origin } }))).status
      ).toBe(403)
    }
  })

  // Regression for #527: restoring the immutable cache policy or removing conditional
  // handling in src/files/content.ts must make these cache tests fail.
  test("revalidates cached content against the current property", async () => {
    const { app, setup, blobStorage } = await createObjectFileApi()
    const path = "/api/objects/document/doc-1/files/content?path=/properties/pdf"
    const initial = await app.fetch(contentRequest(path))
    expect(initial.headers.get("cache-control")).toBe("private, no-cache")
    const etag = initial.headers.get("etag")!
    await initial.text()

    for (const method of ["GET", "HEAD"]) {
      for (const validator of [etag, `"other", W/${etag}`, "*"]) {
        const response = await app.fetch(
          contentRequest(path, {
            method,
            headers: { "if-none-match": validator, range: "bytes=0-3" },
          })
        )
        expect(response.status).toBe(304)
        expect(response.headers.get("etag")).toBe(etag)
        expect(response.headers.get("cache-control")).toBe("private, no-cache")
        expect(response.headers.get("content-range")).toBeNull()
        expect(await response.text()).toBe("")
      }
    }

    const replacement = await blobStorage.put({
      body: new TextEncoder().encode("replacement pdf"),
      mediaType: "application/pdf",
    })
    await setup.objects.upsert("document", { id: "doc-1", pdf: replacement })
    const updated = await app.fetch(contentRequest(path, { headers: { "if-none-match": etag } }))
    expect(updated.status).toBe(200)
    expect(updated.headers.get("etag")).not.toBe(etag)
    expect(await updated.text()).toBe("replacement pdf")

    await setup.objects.upsert("document", {
      id: "doc-1",
      pdf: { ...replacement, fileName: "renamed.txt", mediaType: "text/plain" },
    })
    const renamed = await app.fetch(
      contentRequest(path, { headers: { "if-none-match": updated.headers.get("etag")! } })
    )
    expect(renamed.status).toBe(200)
    expect(renamed.headers.get("content-type")).toBe("text/plain")
    expect(renamed.headers.get("content-disposition")).toContain("renamed.txt")
    expect(await renamed.text()).toBe("replacement pdf")
  })

  test("honors ranges only when If-Range strongly matches the current representation", async () => {
    const { app } = await createObjectFileApi()
    const path = "/api/objects/document/doc-1/files/content?path=/properties/pdf"
    const initial = await app.fetch(contentRequest(path))
    const etag = initial.headers.get("etag")!
    await initial.text()

    for (const validator of [etag, `W/${etag}`, '"old-file"', "Wed, 01 Jul 2026 00:00:00 GMT"]) {
      const response = await app.fetch(
        contentRequest(path, { headers: { range: "bytes=0-3", "if-range": validator } })
      )
      expect(response.status).toBe(validator === etag ? 206 : 200)
      expect(response.headers.get("cache-control")).toBe("private, no-cache")
      expect(await response.text()).toBe(validator === etag ? "%PDF" : "%PDF test")
    }
  })

  test("treats version queries as cache keys, not historical file selectors", async () => {
    const { app } = await createObjectFileApi()
    const query = new URLSearchParams({
      path: "/properties/pdf",
      v: `sha256%3A${"0".repeat(64)}:old%2Cname.pdf:application%2Fpdf:`,
    })
    const response = await app.fetch(
      contentRequest(`/api/objects/document/doc-1/files/content?${query}`)
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-cache")
    expect(await response.text()).toBe("%PDF test")
  })

  test("streams object-bound FileRef content with browser viewer headers, and HEAD without a body", async () => {
    const { app } = await createObjectFileApi()
    const path = "/api/objects/document/doc-1/files/content?path=/properties/pdf"

    for (const method of ["GET", "HEAD"]) {
      const response = await app.fetch(contentRequest(path, { method }))

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("application/pdf")
      expect(response.headers.get("content-length")).toBe("9")
      expect(response.headers.get("content-disposition")).toContain('inline; filename="report.pdf"')
      expect(response.headers.get("etag")).toMatch(/^"sha256:[a-f0-9]{64}"$/)
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; object-src 'self'"
      )
      expect(response.headers.get("accept-ranges")).toBe("bytes")
      expect(await response.text()).toBe(method === "HEAD" ? "" : "%PDF test")
    }
  })

  test.each([
    ["GET", "bytes=0-3", "bytes 0-3/9", "%PDF"],
    ["HEAD", "bytes=5-", "bytes 5-8/9", ""],
  ])("streams a %s byte range %s of object-bound FileRef content", async (method, range, contentRange, body) => {
    const { app } = await createObjectFileApi()

    const response = await app.fetch(
      contentRequest("/api/objects/document/doc-1/files/content?path=/properties/pdf", {
        method,
        headers: { range },
      })
    )

    expect(response.status).toBe(206)
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect(response.headers.get("content-length")).toBe("4")
    expect(response.headers.get("content-range")).toBe(contentRange)
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(await response.text()).toBe(body)
  })

  test("rejects invalid object file content ranges", async () => {
    const { app } = await createObjectFileApi()

    const response = await app.fetch(
      contentRequest("/api/objects/document/doc-1/files/content?path=/properties/pdf", {
        headers: { range: "bytes=99-100" },
      })
    )

    expect(response.status).toBe(416)
    expect(response.headers.get("content-range")).toBe("bytes */9")
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(await response.text()).toBe("")
  })

  // Stored references keep working whatever type they were written with; serving falls back to a
  // download. Regression proof: require a valid media type in isFileRef; this answers 404.
  test("serves a stored reference with an invalid media type as a download", async () => {
    const { app, storage } = await createObjectFileApi()
    // Writes now reject this type, so rewrite the stored row as one written before they did,
    // through the in-memory provider's snapshot and restore.
    const objects = storage.objects as unknown as InMemoryObjectRows
    const snapshot = objects.snapshot()
    for (const rows of snapshot.rows.values()) {
      const row = rows.get("doc-1")
      if (row?.objectTypeId !== "document") continue
      row.properties.pdf = { ...(row.properties.pdf as FileRef), mediaType: "image/png,text/html" }
    }
    objects.restore(snapshot)

    const response = await app.fetch(
      contentRequest("/api/objects/document/doc-1/files/content?path=/properties/pdf")
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/octet-stream")
    expect(response.headers.get("content-disposition")).toStartWith("attachment;")
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    )
    expect(await response.text()).toBe("%PDF test")
  })

  test("hides missing objects, invalid paths, and non-file values as 404", async () => {
    const { app } = await createObjectFileApi()

    for (const path of [
      "/api/objects/document/missing/files/content?path=/properties/pdf",
      "/api/objects/document/doc-1/files/content?path=/properties/missing",
      "/api/objects/document/doc-1/files/content?path=/properties/title",
    ]) {
      const response = await app.fetch(contentRequest(path))
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: "File not found" })
    }
  })

  test("rejects object file content paths outside object properties", async () => {
    const { app } = await createObjectFileApi()

    const getResponse = await app.fetch(
      contentRequest("/api/objects/document/doc-1/files/content?path=/pdf")
    )
    expect(getResponse.status).toBe(400)
    expect(await getResponse.json()).toEqual({ error: "Invalid file content query" })

    const headResponse = await app.fetch(
      contentRequest("/api/objects/document/doc-1/files/content?path=/pdf", {
        method: "HEAD",
      })
    )
    expect(headResponse.status).toBe(400)
    expect(await headResponse.text()).toBe("")
  })
})
