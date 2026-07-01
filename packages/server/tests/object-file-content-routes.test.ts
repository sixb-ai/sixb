import { describe, expect, test } from "bun:test"
import {
  can,
  createSessionCredential,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  prop,
  Sixb,
} from "@sixb/core"
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
  const sixb = new Sixb<readonly OntologySource[]>({
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

  await sixb.upsertObject("document", {
    id: "doc-1",
    title: "Q3 Report",
    pdf: pdfRef,
    html: htmlRef,
  })
  await sixb.upsertObject("invoice", {
    id: "inv-1",
    pdf: invoiceRef,
  })

  return {
    app: createSixbApi(new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })),
    storage,
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
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-06-30T12:00:00.000Z"),
    expiresAt: new Date("2099-06-30T12:00:00.000Z"),
  })

  return { cookie: `sixb_session=${credential.cookieValue}` }
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
  test("streams object-bound FileRef content with browser viewer headers", async () => {
    const { app } = await createObjectFileApi()

    const response = await app.fetch(
      contentRequest("/api/objects/document/doc-1/files/content?path=/properties/pdf")
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect(response.headers.get("content-length")).toBe("9")
    expect(response.headers.get("content-disposition")).toContain('inline; filename="report.pdf"')
    expect(response.headers.get("etag")).toMatch(/^"sha256:[a-f0-9]{64}"$/)
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(await response.text()).toBe("%PDF test")
  })

  test("returns headers without a body for HEAD requests", async () => {
    const { app } = await createObjectFileApi()

    const response = await app.fetch(
      contentRequest("/api/objects/document/doc-1/files/content?path=/properties/pdf", {
        method: "HEAD",
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect(response.headers.get("content-length")).toBe("9")
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(await response.text()).toBe("")
  })

  test("streams byte ranges for object-bound FileRef content", async () => {
    const { app } = await createObjectFileApi()

    const response = await app.fetch(
      contentRequest("/api/objects/document/doc-1/files/content?path=/properties/pdf", {
        headers: { range: "bytes=0-3" },
      })
    )

    expect(response.status).toBe(206)
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect(response.headers.get("content-length")).toBe("4")
    expect(response.headers.get("content-range")).toBe("bytes 0-3/9")
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(await response.text()).toBe("%PDF")
  })

  test("returns partial headers without a body for HEAD range requests", async () => {
    const { app } = await createObjectFileApi()

    const response = await app.fetch(
      contentRequest("/api/objects/document/doc-1/files/content?path=/properties/pdf", {
        method: "HEAD",
        headers: { range: "bytes=5-" },
      })
    )

    expect(response.status).toBe(206)
    expect(response.headers.get("content-length")).toBe("4")
    expect(response.headers.get("content-range")).toBe("bytes 5-8/9")
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(await response.text()).toBe("")
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

  test("forces unsafe inline media types to attachment", async () => {
    const { app } = await createObjectFileApi()

    const response = await app.fetch(
      contentRequest(
        "/api/objects/document/doc-1/files/content?path=/properties/html&disposition=inline"
      )
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/html")
    expect(response.headers.get("content-disposition")).toContain(
      'attachment; filename="preview.html"'
    )
    expect(await response.text()).toBe("<h1>unsafe</h1>")
  })

  test("returns attachment when requested for otherwise inline-safe content", async () => {
    const { app } = await createObjectFileApi()

    const response = await app.fetch(
      contentRequest(
        "/api/objects/document/doc-1/files/content?path=/properties/pdf&disposition=attachment"
      )
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-disposition")).toContain(
      'attachment; filename="report.pdf"'
    )
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

  test("uses object view authorization for file content", async () => {
    const { app, storage } = await createObjectFileApi({ auth: true })
    const viewer = await seedSession(storage, ["document-viewers"])

    const allowed = await app.fetch(
      contentRequest("/api/objects/document/doc-1/files/content?path=/properties/pdf", {
        headers: viewer,
      })
    )
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toBe("%PDF test")

    const forbidden = await app.fetch(
      contentRequest("/api/objects/invoice/inv-1/files/content?path=/properties/pdf", {
        headers: viewer,
      })
    )
    expect(forbidden.status).toBe(404)
    expect(await forbidden.json()).toEqual({ error: "File not found" })
  })
})
