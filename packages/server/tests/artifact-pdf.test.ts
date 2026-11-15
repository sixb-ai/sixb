import { describe, expect, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type SandboxFactory,
  SixbHost,
} from "@sixb/core"
import { documentPdfKey } from "@sixb/core/internal/artifacts/publish"
import { createSessionCredential } from "@sixb/core/internal/auth"
import type { ArtifactVersionRecord } from "@sixb/core/storage"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const PROJECT_ID = "artifact-pdf-tests"
const url = (path: string) => `http://localhost${path}`

/** The project's sandboxes, which only the agent worker opens: asking for a PDF never does. */
const sandboxes: SandboxFactory = {
  supportsRequestCredentials: true,
  create: async () => {
    throw new Error("Must not create a sandbox")
  },
}

function createApp(options: { readonly sandboxes?: boolean } = {}) {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const queues = new InMemoryQueues()
  const host = new SixbHost({
    id: PROJECT_ID,
    ontology: [],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage,
    queues,
    ...(options.sandboxes === false ? {} : { sandboxes }),
    auth: { id: "test", kind: "dev" as const },
  })
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  const put = async (path: string, body: string, mediaType = "text/html") => ({
    path,
    file: await blobStorage.put({
      body: new TextEncoder().encode(body),
      fileName: path,
      mediaType,
    }),
  })
  return { app, storage, blobStorage, queues, put }
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
    createdAt: new Date("2026-11-08T10:00:00.000Z"),
    expiresAt: new Date("2099-11-08T10:00:00.000Z"),
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

/** Alice's designed proposal, as she publishes it. */
async function proposal(fixture: ReturnType<typeof createApp>) {
  const alice = await session(fixture.storage, "alice")
  const files = [
    await fixture.put(
      "document.html",
      '<!doctype html><html><head><link rel="stylesheet" href="design.css"></head><body><h1>Proposal</h1></body></html>'
    ),
    await fixture.put("design.css", "@page { size: letter; margin: 0.75in }", "text/css"),
  ]
  const response = await fixture.app.fetch(
    new Request(url("/api/artifacts"), {
      method: "POST",
      headers: alice.mutationHeaders,
      body: JSON.stringify({ kind: "document", title: "Harbor proposal", files }),
    })
  )
  expect(response.status).toBe(201)
  const published = (await response.json()) as {
    readonly artifact: { readonly id: string }
    readonly version: { readonly pdf?: string }
  }
  return { alice, artifactId: published.artifact.id, published }
}

describe("a designed document's PDF over the API", () => {
  // Reproduce by dropping the `pdf` routes from registerArtifactRoutes: asking for it is a 404.
  test("is asked for, said to be printing, then downloaded once printed", async () => {
    const fixture = createApp()
    const { alice, artifactId, published } = await proposal(fixture)
    expect(published.version.pdf).toBe("printable")
    const pdfPath = `/api/artifacts/${artifactId}/versions/1/pdf`

    const ask = () =>
      fixture.app.fetch(
        new Request(url(pdfPath), { method: "POST", headers: alice.mutationHeaders })
      )
    const asked = await ask()
    expect(asked.status).toBe(200)
    expect(await asked.json()).toEqual({ status: "printing" })
    const early = await fixture.app.fetch(new Request(url(pdfPath), { headers: alice.headers }))
    expect(early.status).toBe(404)
    expect(await early.json()).toMatchObject({ code: "pdf_not_found" })

    // The worker printed it.
    const version = (await fixture.storage.artifacts.getVersion({
      projectId: PROJECT_ID,
      artifactId,
      version: 1,
    })) as ArtifactVersionRecord
    await fixture.storage.artifacts.putPdf({
      projectId: PROJECT_ID,
      renderKey: documentPdfKey(version) ?? "",
      file: await fixture.blobStorage.put({
        body: new TextEncoder().encode("%PDF-1.7 proposal"),
        fileName: "Harbor proposal.pdf",
        mediaType: "application/pdf",
      }),
      pages: 2,
      createdAt: new Date("2026-11-11T10:00:00.000Z"),
    })

    expect(await (await ask()).json()).toEqual({ status: "ready", pages: 2 })
    const downloaded = await fixture.app.fetch(
      new Request(url(pdfPath), { headers: alice.headers })
    )
    expect(downloaded.status).toBe(200)
    expect(downloaded.headers.get("content-type")).toBe("application/pdf")
    expect(downloaded.headers.get("content-disposition")).toContain("attachment")
    expect(downloaded.headers.get("content-disposition")).toContain("Harbor proposal.pdf")
    expect(await downloaded.text()).toBe("%PDF-1.7 proposal")

    const read = await fixture.app.fetch(
      new Request(url(`/api/artifacts/${artifactId}/versions/1`), { headers: alice.headers })
    )
    expect(await read.json()).toMatchObject({ pdf: "ready" })
  })

  // Reproduce by dropping `retry` from the POST route: asking again hears the failure, and prints
  // nothing.
  test("says it could not be printed, and prints again when asked to retry", async () => {
    const fixture = createApp()
    const { alice, artifactId } = await proposal(fixture)
    const version = (await fixture.storage.artifacts.getVersion({
      projectId: PROJECT_ID,
      artifactId,
      version: 1,
    })) as ArtifactVersionRecord
    await fixture.storage.artifacts.putPdf({
      projectId: PROJECT_ID,
      renderKey: documentPdfKey(version) ?? "",
      failure: "It could not be printed.",
      createdAt: new Date("2026-11-11T10:00:00.000Z"),
    })
    const pdfPath = `/api/artifacts/${artifactId}/versions/1/pdf`
    const read = async () =>
      (await (
        await fixture.app.fetch(
          new Request(url(`/api/artifacts/${artifactId}/versions/1`), { headers: alice.headers })
        )
      ).json()) as { readonly pdf?: string }
    const ask = async (query = "") =>
      (
        await fixture.app.fetch(
          new Request(url(`${pdfPath}${query}`), { method: "POST", headers: alice.mutationHeaders })
        )
      ).json()

    expect((await read()).pdf).toBe("failed")
    expect(await ask()).toEqual({ status: "failed", reason: "It could not be printed." })
    expect(await ask("?retry=true")).toEqual({ status: "printing" })
    expect((await read()).pdf).toBe("printable")
  })

  test("is unavailable without sandboxes, and refused for someone who cannot read it", async () => {
    const fixture = createApp({ sandboxes: false })
    const { alice, artifactId, published } = await proposal(fixture)
    expect(published.version).not.toHaveProperty("pdf")
    const pdfPath = `/api/artifacts/${artifactId}/versions/1/pdf`

    const asked = await fixture.app.fetch(
      new Request(url(pdfPath), { method: "POST", headers: alice.mutationHeaders })
    )
    expect(asked.status).toBe(501)
    expect(await asked.json()).toMatchObject({ code: "pdf_unavailable" })

    const bob = await session(fixture.storage, "bob")
    const refused = await fixture.app.fetch(
      new Request(url(pdfPath), { method: "POST", headers: bob.mutationHeaders })
    )
    expect(refused.status).toBe(403)
  })
})
