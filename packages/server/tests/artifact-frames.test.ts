import { describe, expect, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createArtifactFrame, injectFrameAssets } from "@sixb/core/internal/artifacts/frames"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const PROJECT_ID = "artifact-frame-tests"
const DECK = `<!doctype html>
<html lang="en">
<head><title>Q3 review</title><link rel="stylesheet" href="deck.css"></head>
<body>
<section class="slide title"><h1>Q3 review</h1></section>
<section class="slide"><h2>Revenue grew 18%</h2><img src="img/chart.svg" alt=""></section>
</body>
</html>`

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
    headers: { cookie },
    mutationHeaders: {
      cookie: `${cookie}; sixb_csrf_app=csrf_1`,
      "x-sixb-csrf": "csrf_1",
      "content-type": "application/json",
    },
  }
}

const url = (path: string) => `http://localhost${path}`

/** A published deck, and a frame for its first version opened by its owner. */
async function deck() {
  const fixture = createApp()
  const alice = await session(fixture.storage, "alice")
  const files = [
    await fixture.put("index.html", DECK, "text/html"),
    await fixture.put("deck.css", ".slide { color: red }", "text/css"),
    await fixture.put(
      "img/chart.svg",
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
      "image/svg+xml"
    ),
  ]
  const created = await fixture.app.fetch(
    new Request(url("/api/artifacts"), {
      method: "POST",
      headers: alice.mutationHeaders,
      body: JSON.stringify({ kind: "slides", title: "Q3 review", files }),
    })
  )
  expect(created.status).toBe(201)
  const published = await created.json()
  const minted = await fixture.app.fetch(
    new Request(url(`/api/artifacts/${published.artifact.id}/versions/1/frame`), {
      method: "POST",
      headers: alice.mutationHeaders,
    })
  )
  expect(minted.status).toBe(200)
  const frame = (await minted.json()) as { path: string; expiresAt: string }
  return { ...fixture, alice, published, frame }
}

describe("a deck's frame", () => {
  test("publishes as slides, outlined by each slide's first heading", async () => {
    const { published } = await deck()
    expect(published.version).toMatchObject({
      entry: "index.html",
      outline: { kind: "slides", slides: [{ title: "Q3 review" }, { title: "Revenue grew 18%" }] },
    })
  })

  test("serves the entry with the kit and the runtime first in its head, once", async () => {
    const { app, frame } = await deck()
    expect(frame.path).toMatch(/^\/api\/artifact-frames\/[A-Za-z0-9_-]{43}\/$/)
    const response = await app.fetch(new Request(url(`${frame.path}index.html`)))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
    const html = await response.text()
    expect(html).toContain(
      '<head><link rel="stylesheet" href="__sixb/kit.css"><script src="__sixb/runtime.js"></script><title>'
    )
    expect(html.match(/__sixb\/runtime\.js/g)).toHaveLength(1)

    const runtime = await app.fetch(new Request(url(`${frame.path}__sixb/runtime.js`)))
    expect(runtime.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect(await runtime.text()).toContain("sixb-frame/1")
    const kit = await app.fetch(new Request(url(`${frame.path}__sixb/kit.css`)))
    expect(await kit.text()).toContain("@layer sixb-kit")
  })

  test("serves the version's files, and nothing else, under its policy", async () => {
    const { app, frame } = await deck()
    const base = `http://api.localhost${frame.path}`
    for (const [path, status] of [
      ["deck.css", 200],
      ["img/chart.svg", 200],
      ["missing.css", 404],
      // `..` never gets here: URLs normalize it, `%2E%2E` included, out of the token's path.
      ["img/missing.svg", 404],
    ] as const) {
      const response = await app.fetch(new Request(url(`${frame.path}${path}`)))
      expect(response.status).toBe(status)
      // Every response carries the policy, 404s included.
      const policy = response.headers.get("content-security-policy") ?? ""
      expect(policy).toContain("sandbox allow-scripts")
      expect(policy).not.toContain("allow-same-origin")
      expect(policy).toContain(`script-src ${base} 'unsafe-inline'`)
      expect(policy).toContain("frame-ancestors 'self' http://app.localhost")
      expect(response.headers.get("access-control-allow-origin")).toBe("*")
    }
    const css = await app.fetch(new Request(url(`${frame.path}deck.css`)))
    expect(css.headers.get("content-disposition")).toBe("inline")
    expect(await css.text()).toBe(".slide { color: red }")
  })

  test("is opened only by who may read the deck, and stops at its expiry", async () => {
    const { app, storage, alice, published, frame } = await deck()
    const bob = await session(storage, "bob")
    const denied = await app.fetch(
      new Request(url(`/api/artifacts/${published.artifact.id}/versions/1/frame`), {
        method: "POST",
        headers: bob.mutationHeaders,
      })
    )
    expect(denied.status).toBe(404)

    const artifacts = storage.artifacts
    if (!artifacts) throw new Error("Expected artifact storage.")
    const expired = await createArtifactFrame({
      projectId: PROJECT_ID,
      storage: artifacts,
      artifactId: published.artifact.id,
      version: 1,
      now: new Date(Date.now() - 2 * 60 * 60 * 1000),
    })
    expect((await app.fetch(new Request(url(`${expired.path}index.html`)))).status).toBe(404)
    expect((await app.fetch(new Request(url(`${frame.path}index.html`), alice))).status).toBe(200)
    expect(
      (await app.fetch(new Request(url(`/api/artifact-frames/${"x".repeat(43)}/index.html`))))
        .status
    ).toBe(404)
  })

  test("takes requests from the frame's opaque origin, and no other route does", async () => {
    // Reproduce by dropping the frame prefix from rejectDisallowedBrowserOrigin: a deck's module
    // scripts and fonts, which arrive with `Origin: null`, are refused.
    const { app, frame } = await deck()
    const fromFrame = await app.fetch(
      new Request(url(`${frame.path}deck.css`), { headers: { origin: "null" } })
    )
    expect(fromFrame.status).toBe(200)
    const elsewhere = await app.fetch(
      new Request(url("/api/artifacts"), { headers: { origin: "null" } })
    )
    expect(elsewhere.status).toBe(403)
  })
})

describe("a deck's images from other artifacts", () => {
  test("are served under its frame, those it shows and no others, while its reader may read them", async () => {
    // Reproduce by matching a lent file on its artifact and version alone in the frame route: the
    // lender's other files are served too.
    const { app, put, storage } = createApp()
    const alice = await session(storage, "alice")
    const publish = async (files: Awaited<ReturnType<typeof put>>[]) => {
      const response = await app.fetch(
        new Request(url("/api/artifacts"), {
          method: "POST",
          headers: alice.mutationHeaders,
          body: JSON.stringify({ kind: "slides", title: "Deck", files }),
        })
      )
      expect(response.status).toBe(201)
      return (await response.json()).artifact.id as string
    }
    const figures = await publish([
      await put("index.html", '<section class="slide"><h1>Figures</h1></section>', "text/html"),
      await put("img/flow.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml"),
      await put("img/other.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml"),
    ])
    const appendix = await publish([
      await put("index.html", '<section class="slide"><h1>Appendix</h1></section>', "text/html"),
      await put("img/map.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml"),
    ])
    const deck = await publish([
      await put(
        "index.html",
        `<section class="slide"><img src="artifact:${figures}/img/flow.svg" alt=""><img src="artifact:${appendix}/img/map.svg" alt=""></section>`,
        "text/html"
      ),
    ])
    // The appendix is gone by the time the deck is opened: its reader can no longer see the map.
    await app.fetch(
      new Request(url(`/api/artifacts/${appendix}`), {
        method: "DELETE",
        headers: alice.mutationHeaders,
      })
    )
    const minted = await app.fetch(
      new Request(url(`/api/artifacts/${deck}/versions/1/frame`), {
        method: "POST",
        headers: alice.mutationHeaders,
      })
    )
    const frame = (await minted.json()) as { path: string }

    const html = await (await app.fetch(new Request(url(`${frame.path}index.html`)))).text()
    expect(html).toContain(
      `<img src="__sixb/ref/${figures}@1/img/flow.svg" alt="" data-sixb-ref="">`
    )
    expect(html).toContain('<img alt="" data-sixb-ref="unavailable">')

    const shown = await app.fetch(
      new Request(url(`${frame.path}__sixb/ref/${figures}@1/img/flow.svg`))
    )
    expect(shown.status).toBe(200)
    expect(shown.headers.get("content-security-policy")).toContain("sandbox allow-scripts")
    // The same artifact's other files, and its entry, are not the deck's to show.
    for (const path of [
      `${figures}@1/img/other.svg`,
      `${figures}@1/index.html`,
      `${appendix}@1/img/map.svg`,
    ]) {
      expect((await app.fetch(new Request(url(`${frame.path}__sixb/ref/${path}`)))).status).toBe(
        404
      )
    }
  })
})

describe("injecting the kit and the runtime", () => {
  test("goes in the head, else the html element, else after the doctype", async () => {
    const tag = '<link rel="stylesheet" href="__sixb/kit.css">'
    expect(await injectFrameAssets("<html><head><meta charset=utf-8></head></html>")).toStartWith(
      `<html><head>${tag}`
    )
    expect(await injectFrameAssets('<html lang="en"><body></body></html>')).toStartWith(
      `<html lang="en">${tag}`
    )
    expect(await injectFrameAssets("<!DOCTYPE html>\n<section class=slide></section>")).toStartWith(
      `<!DOCTYPE html>${tag}`
    )
  })
})
