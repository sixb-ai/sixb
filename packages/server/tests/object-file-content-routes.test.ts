import { describe, expect, test } from "bun:test"
import {
  type AuthSessionAudience,
  can,
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
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
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
  const sixb = new SixbHost<readonly OntologySource[]>({
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

async function seedSession(
  storage: InMemoryStorage,
  groupIds: readonly string[],
  audience: AuthSessionAudience = "atlas"
) {
  const credential = createSessionCredential(`ses_file_viewer_${audience}`)
  await storage.auth.users.create({
    id: `usr_file_viewer_${audience}`,
    projectId: "test-project",
    email: `${audience}@example.com`,
  })
  for (const groupId of groupIds) {
    await storage.auth.groupMemberships.upsert({
      projectId: "test-project",
      userId: `usr_file_viewer_${audience}`,
      groupId,
      source: "manual",
    })
  }
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: "test-project",
    userId: `usr_file_viewer_${audience}`,
    strategyId: "test",
    audience,
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-06-30T12:00:00.000Z"),
    expiresAt: new Date("2099-06-30T12:00:00.000Z"),
  })

  return { cookie: `sixb_session${audience === "app" ? "_app" : ""}=${credential.cookieValue}` }
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
  // Regression for #606: remove resolveFileNavigationAudience from browser-origin.ts;
  // the app-only GET/HEAD requests below must fail with 401 instead of streaming bytes.
  test("selects only the requested session for file navigation without Origin", async () => {
    const { app, storage } = await createObjectFileApi({ auth: true })
    const appSession = await seedSession(storage, ["document-viewers"], "app")
    const atlasSession = await seedSession(storage, [], "atlas")
    const path = "/api/objects/document/doc-1/files/content?path=/properties/pdf"
    for (const method of ["GET", "HEAD"]) {
      for (const disposition of ["inline", "attachment"]) {
        for (const cookie of [appSession.cookie, `${appSession.cookie}; ${atlasSession.cookie}`]) {
          const response = await app.fetch(
            contentRequest(`${path}&audience=app&disposition=${disposition}`, {
              method,
              headers: { cookie, range: "bytes=0-3" },
            })
          )
          expect(response.status).toBe(206)
          expect(response.headers.get("content-range")).toBe("bytes 0-3/9")
          expect(response.headers.get("content-disposition")).toContain(disposition)
          expect(await response.text()).toBe(method === "HEAD" ? "" : "%PDF")
        }
        for (const cookie of ["", atlasSession.cookie]) {
          const response = await app.fetch(
            contentRequest(`${path}&audience=app&disposition=${disposition}`, {
              method,
              headers: { cookie },
            })
          )
          expect(response.status).toBe(401)
        }
      }
    }
    expect((await app.fetch(contentRequest(path, { headers: appSession }))).status).toBe(401)
    expect(
      (
        await app.fetch(
          contentRequest(`${path}&audience=atlas`, {
            headers: appSession,
          })
        )
      ).status
    ).toBe(401)
    // Both-session browsers must use the selected identity's grants, with no fallback.
    expect(
      (
        await app.fetch(
          contentRequest(`${path}&audience=atlas`, {
            headers: { cookie: `${appSession.cookie}; ${atlasSession.cookie}` },
          })
        )
      ).status
    ).toBe(404)
    for (const target of [
      "/api/objects/invoice/inv-1/files/content?path=/properties/pdf",
      "/api/objects/document/doc-1/files/content?path=/properties/missing",
    ]) {
      expect(
        (
          await app.fetch(
            contentRequest(`${target}&audience=app`, {
              headers: { ...appSession, "if-none-match": "*" },
            })
          )
        ).status
      ).toBe(404)
    }
  })

  test("keeps Origin authoritative and rejects malformed file audiences", async () => {
    const { app, storage } = await createObjectFileApi({ auth: true })
    const session = await seedSession(storage, ["document-viewers"], "app")
    const path = "/api/objects/document/doc-1/files/content?path=/properties/pdf"
    for (const suffix of ["&audience=app", ""]) {
      expect(
        (
          await app.fetch(
            contentRequest(`${path}${suffix}`, {
              headers: { ...session, origin: "http://app.localhost" },
            })
          )
        ).status
      ).toBe(200)
    }
    for (const origin of [
      "http://atlas.localhost",
      "http://api.localhost",
      "https://evil.test",
      "null",
    ]) {
      expect(
        (
          await app.fetch(
            contentRequest(`${path}&audience=app`, {
              headers: { ...session, origin },
            })
          )
        ).status
      ).toBe(403)
    }
    for (const query of ["audience=", "audience=unknown", "audience=app&audience=atlas"]) {
      expect([403, 422]).toContain(
        (
          await app.fetch(
            contentRequest(`${path}&${query}`, {
              headers: session,
            })
          )
        ).status
      )
    }
    // A file selector cannot change authentication for unrelated API reads.
    expect(
      (
        await app.fetch(
          contentRequest("/api/objects/document/doc-1?audience=app", {
            headers: session,
          })
        )
      ).status
    ).toBe(401)
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

  test("checks visibility and existence before conditional responses", async () => {
    const { app, storage } = await createObjectFileApi({ auth: true })
    const viewer = await seedSession(storage, ["document-viewers"])
    for (const path of [
      "/api/objects/invoice/inv-1/files/content?path=/properties/pdf",
      "/api/objects/document/missing/files/content?path=/properties/pdf",
      "/api/objects/document/doc-1/files/content?path=/properties/missing",
    ]) {
      const response = await app.fetch(
        contentRequest(path, { headers: { ...viewer, "if-none-match": "*" } })
      )
      expect(response.status).toBe(404)
    }
  })

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

    const explicitAtlas = await app.fetch(
      contentRequest(
        "/api/objects/document/doc-1/files/content?path=/properties/pdf&audience=atlas",
        {
          headers: viewer,
        }
      )
    )
    expect(explicitAtlas.status).toBe(200)
    expect(await explicitAtlas.text()).toBe("%PDF test")

    const forbidden = await app.fetch(
      contentRequest("/api/objects/invoice/inv-1/files/content?path=/properties/pdf", {
        headers: viewer,
      })
    )
    expect(forbidden.status).toBe(404)
    expect(await forbidden.json()).toEqual({ error: "File not found" })
  })
})
