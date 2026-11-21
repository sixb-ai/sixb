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
import { createSessionCredential } from "@sixb/core/internal/auth"
import type { ArtifactMediaParts } from "@sixb/core/storage"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const PROJECT_ID = "artifact-media-tests"
const url = (path: string) => `http://localhost${path}`

/** The project's sandboxes, which only the render worker opens: asking for media never does. */
const sandboxes: SandboxFactory = {
  supportsRequestCredentials: true,
  create: async () => {
    throw new Error("Must not create a sandbox")
  },
}

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
    sandboxes,
    auth: { id: "test", kind: "dev" as const },
  })
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  const put = (body: string, fileName: string, mediaType: string) =>
    blobStorage.put({ body: new TextEncoder().encode(body), fileName, mediaType })
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
    createdAt: new Date("2026-11-18T10:00:00.000Z"),
    expiresAt: new Date("2099-11-18T10:00:00.000Z"),
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

/** Alice's clip, published as a file artifact, with a proxy and a poster derived of it. */
async function clip() {
  const fixture = createApp()
  const alice = await session(fixture.storage, "alice")
  const original = await fixture.put("the original", "Launch.mov", "video/quicktime")
  const response = await fixture.app.fetch(
    new Request(url("/api/artifacts"), {
      method: "POST",
      headers: alice.mutationHeaders,
      body: JSON.stringify({
        kind: "file",
        title: "Launch",
        files: [{ path: "Launch.mov", file: original }],
      }),
    })
  )
  expect(response.status).toBe(201)
  const { artifact } = (await response.json()) as { readonly artifact: { readonly id: string } }

  const derive = async (parts: Partial<ArtifactMediaParts>) => {
    const pending = { status: "pending" } as const
    await fixture.storage.artifacts?.putMedia({
      projectId: PROJECT_ID,
      digest: original.digest,
      parts: {
        probe: pending,
        proxy: pending,
        poster: pending,
        filmstrip: pending,
        waveform: pending,
        cuts: pending,
        transcript: pending,
        ...parts,
      },
      attempts: 1,
      updatedAt: new Date(),
    })
  }
  const get = (path: string, as = alice, headers: Record<string, string> = {}) =>
    fixture.app.fetch(new Request(url(path), { headers: { ...as.headers, ...headers } }))
  return { ...fixture, alice, artifactId: artifact.id, original, derive, get }
}

describe("what is derived of a media, over the API", () => {
  // Reproduce by dropping the media routes from registerArtifactRoutes: asking is a 404.
  test("answers each part, with the URL of its file once it is ready", async () => {
    const { artifactId, original, put, derive, get } = await clip()
    const media = `/api/artifacts/${artifactId}/versions/latest/media?path=Launch.mov`

    const pending = await get(media)
    expect(pending.status).toBe(200)
    expect(pending.headers.get("cache-control")).toBe("private, no-cache")
    expect(await pending.json()).toMatchObject({
      path: "Launch.mov",
      version: 1,
      parts: { proxy: { status: "pending" }, transcript: { status: "pending" } },
    })

    const poster = await put("a poster", "Launch.poster.jpg", "image/jpeg")
    await derive({
      poster: { status: "ready", file: poster, atMs: 1520 },
      proxy: { status: "failed", reason: "FFmpeg could not make it." },
      cuts: { status: "ready", atMs: [4200] },
      waveform: { status: "unavailable", reason: "No FFmpeg.", lacks: "sandbox_tools" },
    })
    const ready = (await (await get(media)).json()) as {
      readonly parts: Record<string, Record<string, unknown>>
    }
    const v = original.digest.slice(7, 23)
    expect(ready.parts.poster).toEqual({
      status: "ready",
      atMs: 1520,
      url: `/api/artifacts/${artifactId}/versions/1/media/content?path=Launch.mov&part=poster&v=${v}`,
      mediaType: "image/jpeg",
      sizeBytes: 8,
    })
    expect(ready.parts.proxy).toEqual({ status: "failed", reason: "FFmpeg could not make it." })
    expect(ready.parts.cuts).toEqual({ status: "ready", atMs: [4200] })
    // What the project lacks is said, for a client to offer a retry once it has it.
    expect(ready.parts.waveform).toEqual({
      status: "unavailable",
      reason: "No FFmpeg.",
      lacks: "sandbox_tools",
    })
    // No blob of what is derived is named: it is reached through the artifact.
    expect(JSON.stringify(ready)).not.toContain("blobId")
  })

  // Reproduce by leaving `retry` out of the media route's call: the failure is all it answers.
  test("derives again what failed when asked with retry=true", async () => {
    const { artifactId, derive, get } = await clip()
    const failed = { status: "failed", reason: "FFmpeg could not make it." } as const
    await derive({ proxy: failed })
    const media = `/api/artifacts/${artifactId}/versions/1/media?path=Launch.mov`
    const parts = async (path: string) =>
      ((await (await get(path)).json()) as { readonly parts: Record<string, unknown> }).parts

    expect((await parts(media)).proxy).toEqual(failed)
    expect((await parts(`${media}&retry=true`)).proxy).toEqual({ status: "pending" })
    expect((await parts(media)).proxy).toEqual({ status: "pending" })
  })

  test("serves a part's file a byte range at a time, cached for good by its URL", async () => {
    const { artifactId, put, derive, get } = await clip()
    const proxy = await put("0123456789".repeat(10), "Launch.proxy.mp4", "video/mp4")
    await derive({ proxy: { status: "ready", file: proxy } })
    const { parts } = (await (
      await get(`/api/artifacts/${artifactId}/versions/1/media?path=Launch.mov`)
    ).json()) as { readonly parts: { readonly proxy: { readonly url: string } } }

    const piece = await get(parts.proxy.url, undefined, { range: "bytes=10-19" })
    expect(piece.status).toBe(206)
    expect(piece.headers.get("content-type")).toBe("video/mp4")
    expect(piece.headers.get("content-range")).toBe("bytes 10-19/100")
    expect(piece.headers.get("cache-control")).toBe("private, max-age=31536000, immutable")
    expect(await piece.text()).toBe("0123456789")

    // Without the URL's key, the version's file may be replaced at its path.
    const unkeyed = await get(parts.proxy.url.replace(/&v=\w+/, ""))
    expect(unkeyed.headers.get("cache-control")).toBe("private, no-cache")
  })

  test("is 404 media_not_found until a part is derived, and when it will not be", async () => {
    const { artifactId, derive, get } = await clip()
    const content = (part: string) =>
      get(`/api/artifacts/${artifactId}/versions/1/media/content?path=Launch.mov&part=${part}`)

    const pending = await content("poster")
    expect(pending.status).toBe(404)
    expect(pending.headers.get("cache-control")).toBe("no-store")
    expect(await pending.json()).toMatchObject({ code: "media_not_found" })

    await derive({ poster: { status: "unavailable", reason: "It has no picture." } })
    expect((await content("poster")).status).toBe(404)
    // The probe is no file: the route's validation refuses it.
    expect((await content("probe")).status).toBe(422)
  })

  // Reproduce by reading the record before the version in ArtifactsRuntime.media: Bob reads what
  // is derived of Alice's clip, and its poster, by its artifact's id.
  test("is read through the artifact, by whoever reads it", async () => {
    const { artifactId, put, derive, get, storage } = await clip()
    await derive({
      poster: { status: "ready", file: await put("a", "p.jpg", "image/jpeg"), atMs: 0 },
    })
    const bob = await session(storage, "bob")

    const media = await get(`/api/artifacts/${artifactId}/versions/1/media?path=Launch.mov`, bob)
    expect(media.status).toBe(403)
    expect(await media.json()).toMatchObject({ code: "not_shared" })
    const poster = await get(
      `/api/artifacts/${artifactId}/versions/1/media/content?path=Launch.mov&part=poster`,
      bob
    )
    expect(poster.status).toBe(403)

    const notMedia = await get(`/api/artifacts/${artifactId}/versions/1/media?path=nothing.mov`)
    expect(notMedia.status).toBe(400)
    expect(await notMedia.json()).toMatchObject({ code: "invalid_artifact" })
  })
})
