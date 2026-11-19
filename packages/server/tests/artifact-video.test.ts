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
import {
  type VideoMediaFile,
  videoExportPlan,
  videoStillKey,
} from "@sixb/core/internal/artifacts/publish"
import { createSessionCredential } from "@sixb/core/internal/auth"
import type { ArtifactVersionRecord } from "@sixb/core/storage"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const PROJECT_ID = "artifact-video-tests"
const url = (path: string) => `http://localhost${path}`

/** The project's sandboxes, which only the render worker opens: asking for an MP4 never does. */
const sandboxes: SandboxFactory = {
  supportsRequestCredentials: true,
  create: async () => {
    throw new Error("Must not create a sandbox")
  },
}

function createApp(options: { readonly sandboxes?: boolean } = {}) {
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
    ...(options.sandboxes === false ? {} : { sandboxes }),
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
  return { app, storage, blobStorage, put }
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

const scene = (id: string) =>
  `<template><div data-composition-id="${id}" data-width="1280" data-height="720"><h1>${id}</h1></div></template>`
const host = (id: string, start: string) =>
  `<div data-composition-id="${id}" data-composition-src="scenes/${id}.html" data-start="${start}" data-duration="2"></div>`

/** Alice's launch film, two scenes, as she publishes it. */
async function launch(fixture: ReturnType<typeof createApp>) {
  const alice = await session(fixture.storage, "alice")
  const files = [
    await fixture.put(
      "index.html",
      `<html><body><div data-composition-id="main" data-width="1280" data-height="720">${host("intro", "0")}${host("outro", "intro")}</div></body></html>`,
      "text/html"
    ),
    await fixture.put("scenes/intro.html", scene("intro"), "text/html"),
    await fixture.put("scenes/outro.html", scene("outro"), "text/html"),
  ]
  const response = await fixture.app.fetch(
    new Request(url("/api/artifacts"), {
      method: "POST",
      headers: alice.mutationHeaders,
      body: JSON.stringify({ kind: "video", title: "Launch", files }),
    })
  )
  expect(response.status).toBe(201)
  const published = (await response.json()) as {
    readonly artifact: { readonly id: string }
    readonly version: { readonly exportable?: boolean }
  }
  const version = (await fixture.storage.artifacts?.getVersion({
    projectId: PROJECT_ID,
    artifactId: published.artifact.id,
    version: 1,
  })) as ArtifactVersionRecord
  return { alice, artifactId: published.artifact.id, published, version }
}

const planOf = (version: ArtifactVersionRecord, media: readonly VideoMediaFile[] = []) => {
  if (version.outline.kind !== "video") throw new Error("Expected a video.")
  return videoExportPlan({
    outline: version.outline,
    files: version.files,
    references: version.references,
    media,
  })
}

describe("a video's MP4 over the API", () => {
  // Reproduce by dropping the `video` routes from registerArtifactRoutes: asking for it is a 404.
  test("is asked for, said to be rendering, then downloaded once rendered", async () => {
    const fixture = createApp()
    const { alice, artifactId, published, version } = await launch(fixture)
    expect(published.version.exportable).toBe(true)
    const path = `/api/artifacts/${artifactId}/versions/1/video`

    const ask = async () => {
      const response = await fixture.app.fetch(
        new Request(url(path), { method: "POST", headers: alice.mutationHeaders })
      )
      expect(response.status).toBe(200)
      return response.json()
    }
    expect(await ask()).toEqual({
      status: "rendering",
      progress: { ready: 0, total: 3, assembling: false },
    })

    const get = () => fixture.app.fetch(new Request(url(path), { headers: alice.headers }))
    const missing = await get()
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: "video_not_found" })

    const mp4 = await fixture.put("Launch.mp4", "the mp4", "video/mp4")
    const plan = planOf(version)
    await fixture.storage.artifacts?.putVideoRender({
      projectId: PROJECT_ID,
      key: plan.key,
      file: mp4.file,
      createdAt: new Date(),
    })
    expect(await ask()).toEqual({ status: "ready", durationMs: 4000, sizeBytes: 7 })

    const downloaded = await get()
    expect(downloaded.status).toBe(200)
    expect(downloaded.headers.get("content-type")).toBe("video/mp4")
    expect(downloaded.headers.get("content-disposition")).toContain("attachment")
    expect(await downloaded.text()).toBe("the mp4")

    // A player seeks by range.
    const range = await fixture.app.fetch(
      new Request(url(path), { headers: { ...alice.headers, range: "bytes=4-6" } })
    )
    expect(range.status).toBe(206)
    expect(await range.text()).toBe("mp4")
  })

  test("says why it could not render until asked to retry, and is refused where nothing renders", async () => {
    const fixture = createApp()
    const { alice, artifactId, version } = await launch(fixture)
    const [intro] = planOf(version).segments
    await fixture.storage.artifacts?.putVideoRender({
      projectId: PROJECT_ID,
      key: intro?.key ?? "",
      failure: "Scene 'intro' could not be rendered. Try again in a moment.",
      createdAt: new Date(),
    })
    const ask = (query = "") =>
      fixture.app.fetch(
        new Request(url(`/api/artifacts/${artifactId}/versions/latest/video${query}`), {
          method: "POST",
          headers: alice.mutationHeaders,
        })
      )
    expect(await (await ask()).json()).toEqual({
      status: "failed",
      reason: "Scene 'intro' could not be rendered. Try again in a moment.",
    })
    expect(await (await ask("?retry=true")).json()).toMatchObject({ status: "rendering" })

    const bare = createApp({ sandboxes: false })
    const film = await launch(bare)
    expect(film.published.version.exportable).toBeUndefined()
    const refused = await bare.app.fetch(
      new Request(url(`/api/artifacts/${film.artifactId}/versions/1/video`), {
        method: "POST",
        headers: film.alice.mutationHeaders,
      })
    )
    expect(refused.status).toBe(501)
    expect(await refused.json()).toMatchObject({ code: "video_unavailable" })
  })

  test("serves each scene's still once snapshotted, to whoever reads the video", async () => {
    const fixture = createApp()
    const { alice, artifactId, version } = await launch(fixture)
    const still = (who: { readonly headers: Record<string, string> }, id = "outro") =>
      fixture.app.fetch(
        new Request(url(`/api/artifacts/${artifactId}/versions/1/scenes/${id}/still`), {
          headers: who.headers,
        })
      )

    const missing = await still(alice)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: "still_not_found" })

    if (version.outline.kind !== "video") throw new Error("Expected a video.")
    const outro = version.outline.scenes[1]
    if (!outro) throw new Error("Expected the outro.")
    const jpeg = await fixture.put("outro.jpg", "jpeg", "image/jpeg")
    await fixture.storage.artifacts?.putVideoRender({
      projectId: PROJECT_ID,
      key: videoStillKey(outro),
      file: jpeg.file,
      createdAt: new Date(),
    })
    const served = await still(alice)
    expect(served.status).toBe(200)
    expect(served.headers.get("content-type")).toBe("image/jpeg")
    expect(await served.text()).toBe("jpeg")
    expect((await still(alice, "nowhere")).status).toBe(404)

    // Bob, who reads nothing of Alice's, is refused.
    const bob = await session(fixture.storage, "bob")
    expect((await still(bob)).status).toBe(403)
  })
})
