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
import type { ArtifactVersionRecord } from "@sixb/core/storage"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const PROJECT_ID = "artifact-board-preview-tests"
const url = (path: string) => `http://localhost${path}`

/** The project's sandboxes, which only the agent worker opens: serving previews never does. */
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
  const put = async (path: string, body: string, mediaType = "text/html") => ({
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

/** Alice's canvas of two boards, pinned to dark mode when `dark`, with Welcome pictured. */
async function canvas(options: { readonly dark?: boolean } = {}) {
  const fixture = createApp()
  const { app, storage, put } = fixture
  const alice = await session(storage, "alice")
  const bob = await session(storage, "bob")

  const files = [
    await put(
      "canvas.json",
      JSON.stringify({
        items: ["welcome", "region"].map((id, index) => ({
          id,
          type: "board",
          file: `${id}.html`,
          x: index * 480,
          y: 0,
          w: 390,
          h: 844,
        })),
      }),
      "application/json"
    ),
    await put("welcome.html", "<main><h1>Welcome</h1></main>"),
    await put("region.html", "<main><h1>Regions</h1></main>"),
    ...(options.dark ? [await put("theme.json", '{"mode":"dark"}', "application/json")] : []),
  ]
  const response = await app.fetch(
    new Request(url("/api/artifacts"), {
      method: "POST",
      headers: alice.mutationHeaders,
      body: JSON.stringify({ kind: "canvas", title: "Onboarding", files }),
    })
  )
  expect(response.status).toBe(201)
  const published = (await response.json()) as {
    readonly artifact: { readonly id: string }
    readonly version: { readonly boardPreviews?: Record<string, string> }
  }
  const artifactId = published.artifact.id

  // The worker pictured Welcome in each mode the canvas is seen in, at both sizes.
  const version = (await storage.artifacts.getVersion({
    projectId: PROJECT_ID,
    artifactId,
    version: 1,
  })) as ArtifactVersionRecord
  const outline = version.outline
  if (outline.kind !== "canvas") throw new Error("Expected a canvas.")
  const welcome = outline.items.find((item) => item.id === "welcome")
  const renderKey = welcome?.type === "board" ? welcome.renderKey : undefined
  if (!renderKey) throw new Error("Expected Welcome's render key.")
  await storage.artifacts.putBoardPreviews({
    projectId: PROJECT_ID,
    previews: (
      await Promise.all(
        (outline.themes ?? []).map(async (theme) => [
          {
            renderKey,
            theme,
            size: "full" as const,
            file: (await put(`welcome.${theme}.png`, `welcome ${theme}`, "image/png")).file,
            createdAt: new Date(),
          },
          {
            renderKey,
            theme,
            size: "small" as const,
            file: (await put(`welcome.${theme}.webp`, `small ${theme}`, "image/webp")).file,
            createdAt: new Date(),
          },
        ])
      )
    ).flat(),
  })

  const preview = (
    as: { readonly headers: Record<string, string> },
    path: string,
    headers: Record<string, string> = {}
  ) =>
    app.fetch(
      new Request(url(`/api/artifacts/${artifactId}/versions/${path}`), {
        headers: { ...as.headers, ...headers },
      })
    )
  return { ...fixture, alice, bob, artifactId, preview, published, renderKey }
}

describe("a canvas board's preview", () => {
  // Guard proof: cache any numbered version's preview for good in the route; version 1's is then
  // kept while it is open, and a write to it shows its reader a stale picture.
  test("is served to a reader of its version, cached for good once the version is created", async () => {
    const { storage, alice, artifactId, preview } = await canvas()

    // While the version is open, each write may change what the board shows.
    const open = await preview(alice, "1/boards/welcome/preview?theme=light")
    expect(open.headers.get("cache-control")).toBe("private, no-cache")

    await storage.artifacts.freeze({
      projectId: PROJECT_ID,
      artifactId,
      frozenAt: new Date(),
      frozenBy: { type: "user", id: "alice" },
    })
    const light = await preview(alice, "1/boards/welcome/preview?theme=light")
    expect(light.status).toBe(200)
    expect(light.headers.get("content-type")).toBe("image/png")
    expect(light.headers.get("cache-control")).toBe("private, max-age=31536000, immutable")
    expect(await light.text()).toBe("welcome light")

    const dark = await preview(alice, "1/boards/welcome/preview?theme=dark")
    expect(await dark.text()).toBe("welcome dark")

    // The latest version moves with each write: it is checked each time.
    const latest = await preview(alice, "latest/boards/welcome/preview")
    expect(latest.headers.get("cache-control")).toBe("private, no-cache")

    const etag = light.headers.get("etag") ?? ""
    const again = await preview(alice, "1/boards/welcome/preview?theme=light", {
      "if-none-match": etag,
    })
    expect(again.status).toBe(304)
  })

  test("is a small WebP when asked for one, and a full PNG otherwise", async () => {
    // Reproduce by serving the full picture whatever the size: a canvas of a hundred boards
    // decodes every one at its own size on a phone.
    const { alice, preview } = await canvas()

    const small = await preview(alice, "1/boards/welcome/preview?theme=light&size=small")
    expect(small.status).toBe(200)
    expect(small.headers.get("content-type")).toBe("image/webp")
    expect(await small.text()).toBe("small light")

    const full = await preview(alice, "1/boards/welcome/preview?theme=light&size=full")
    expect(full.headers.get("content-type")).toBe("image/png")
    expect(await full.text()).toBe("welcome light")

    // The API refuses a size it does not keep, as it refuses any query outside its schema.
    expect((await preview(alice, "1/boards/welcome/preview?size=huge")).status).toBe(422)
  })

  test("is a revision's: kept for good at it, not found once the version moved past it", async () => {
    // A viewer names the revision it shows, so a picture of an open version is never kept past a
    // write. Reproduce by ignoring revision: the old revision's picture is served, and kept.
    const { alice, preview } = await canvas()

    const at = await preview(alice, "1/boards/welcome/preview?theme=light&revision=1")
    expect(at.status).toBe(200)
    expect(at.headers.get("cache-control")).toBe("private, max-age=31536000, immutable")

    const moved = await preview(alice, "1/boards/welcome/preview?theme=light&revision=2")
    expect(moved.status).toBe(404)
    expect(moved.headers.get("cache-control")).toBe("no-store")
    expect(await moved.json()).toMatchObject({ code: "preview_not_found" })
  })

  test("is the board's, by its render key: the same while the canvas changes around it", async () => {
    // A canvas edited live is written every few seconds: a picture asked for by revision would be
    // fetched again each time. Reproduce by ignoring key in the route: the address of Welcome's
    // old picture serves its new one, which a browser then keeps for good under it.
    const { app, put, storage, alice, artifactId, preview, renderKey } = await canvas()
    const write = async (welcome: string, regionX: number) => {
      const files = [
        await put(
          "canvas.json",
          JSON.stringify({
            items: [
              { id: "welcome", type: "board", file: "welcome.html", x: 0, y: 0, w: 390, h: 844 },
              {
                id: "region",
                type: "board",
                file: "region.html",
                x: regionX,
                y: 0,
                w: 390,
                h: 844,
              },
            ],
          }),
          "application/json"
        ),
        await put("welcome.html", welcome),
        await put("region.html", "<main><h1>Regions</h1></main>"),
      ]
      const response = await app.fetch(
        new Request(url(`/api/artifacts/${artifactId}/content`), {
          method: "PUT",
          headers: alice.mutationHeaders,
          body: JSON.stringify({ kind: "canvas", title: "Onboarding", files }),
        })
      )
      expect(response.status).toBe(200)
    }
    const byKey = `1/boards/welcome/preview?theme=light&key=${encodeURIComponent(renderKey)}`

    // Another board moves: Welcome's picture stays, kept for good; the revision's does not.
    await write("<main><h1>Welcome</h1></main>", 960)
    const kept = await preview(alice, byKey)
    expect(kept.status).toBe(200)
    expect(kept.headers.get("cache-control")).toBe("private, max-age=31536000, immutable")
    expect(await kept.text()).toBe("welcome light")
    expect((await preview(alice, "1/boards/welcome/preview?theme=light&revision=1")).status).toBe(
      404
    )

    // Welcome itself changes, and is pictured again: the address of its old picture serves
    // nothing, so what a browser kept for it for good is never the new one.
    await write("<main><h1>Welcome aboard</h1></main>", 960)
    const version = (await storage.artifacts.getVersion({
      projectId: PROJECT_ID,
      artifactId,
      version: 1,
    })) as ArtifactVersionRecord
    const outline = version.outline
    const welcome = outline.kind === "canvas" ? outline.items[0] : undefined
    const next = welcome?.type === "board" ? welcome.renderKey : undefined
    if (!next || next === renderKey) throw new Error("Expected Welcome's new render key.")
    await storage.artifacts.putBoardPreviews({
      projectId: PROJECT_ID,
      previews: [
        {
          renderKey: next,
          theme: "light",
          size: "full",
          file: (await put("welcome.new.png", "welcome aboard", "image/png")).file,
          createdAt: new Date(),
        },
      ],
    })
    const changed = await preview(alice, byKey)
    expect(changed.status).toBe(404)
    expect(await changed.json()).toMatchObject({ code: "preview_not_found" })
    const current = await preview(
      alice,
      `1/boards/welcome/preview?theme=light&key=${encodeURIComponent(next)}`
    )
    expect(await current.text()).toBe("welcome aboard")
  })

  test("is the mode the canvas pins, whatever the reader's", async () => {
    const { alice, preview } = await canvas({ dark: true })

    const response = await preview(alice, "1/boards/welcome/preview?theme=light")
    expect(await response.text()).toBe("welcome dark")
  })

  test("is refused to whoever cannot read the version", async () => {
    // Reproduce by reading the storage without reading the version as the caller: Bob, who no
    // conversation shares it with, gets Alice's picture.
    const { bob, preview } = await canvas()

    const response = await preview(bob, "1/boards/welcome/preview?theme=light")
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: "not_shared" })
  })

  test("is not found until it is rendered, and nothing keeps that answer", async () => {
    const { alice, preview } = await canvas()

    const pending = await preview(alice, "1/boards/region/preview?theme=light")
    expect(pending.status).toBe(404)
    expect(pending.headers.get("cache-control")).toBe("no-store")
    expect(await pending.json()).toMatchObject({ code: "preview_not_found" })

    expect((await preview(alice, "1/boards/pricing/preview")).status).toBe(404)
  })

  test("is pending in the publish's answer too, which a viewer seeds itself from", async () => {
    // Reproduce by answering a publish with the bare version: the app, seeded from it after a
    // save, never asks which pictures are ready and draws every board's outline.
    const { published } = await canvas()

    expect(published.version.boardPreviews).toEqual({ welcome: "pending", region: "pending" })
  })

  test("is ready or pending in the version, as the viewer reads it", async () => {
    const { alice, preview } = await canvas()

    const response = await preview(alice, "1")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      outline: { themes: ["light", "dark"] },
      boardPreviews: { welcome: "ready", region: "pending" },
    })
  })
})
