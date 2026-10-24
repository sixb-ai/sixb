import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { BlobStorageError } from "@sixb/core/blob-storage/server"
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
  return { app, storage, blobStorage, put }
}

function artifactStorage(storage: InMemoryStorage) {
  if (!storage.artifacts) throw new Error("Expected artifact storage.")
  return storage.artifacts
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

type Fixture = ReturnType<typeof createApp>
type Session = Awaited<ReturnType<typeof session>>

async function publish(
  { app }: Fixture,
  as: Session,
  kind: string,
  files: Awaited<ReturnType<Fixture["put"]>>[]
) {
  const response = await app.fetch(
    new Request(url("/api/artifacts"), {
      method: "POST",
      headers: as.mutationHeaders,
      body: JSON.stringify({ kind, title: "Untitled", files }),
    })
  )
  expect(response.status).toBe(201)
  return await response.json()
}

async function mint({ app }: Fixture, as: Session, artifactId: string) {
  return app.fetch(
    new Request(url(`/api/artifacts/${artifactId}/versions/1/frame`), {
      method: "POST",
      headers: as.mutationHeaders,
    })
  )
}

async function remove({ app }: Fixture, as: Session, artifactId: string) {
  const response = await app.fetch(
    new Request(url(`/api/artifacts/${artifactId}`), {
      method: "DELETE",
      headers: as.mutationHeaders,
    })
  )
  expect(response.status).toBe(200)
}

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
  const published = await publish(fixture, alice, "slides", files)
  const minted = await mint(fixture, alice, published.artifact.id)
  expect(minted.status).toBe(200)
  const frame = (await minted.json()) as { path: string; expiresAt: string }
  return { ...fixture, alice, published, frame }
}

/** The headers every frame response carries, whatever it answers. */
function expectFrameHeaders(response: Response, label: string) {
  expect(response.headers.get("content-security-policy"), label).toContain("sandbox allow-scripts")
  expect(response.headers.get("access-control-allow-origin"), label).toBe("*")
  expect(response.headers.get("referrer-policy"), label).toBe("no-referrer")
}

describe("a deck's frame", () => {
  test("serves the entry with the kit and the runtime first in its head, once", async () => {
    const { app, frame } = await deck()
    expect(frame.path).toMatch(/^\/api\/artifact-frames\/[A-Za-z0-9_-]{43}\/$/)
    const response = await app.fetch(new Request(url(`${frame.path}index.html`)))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
    const html = await response.text()
    expect(html).toContain(
      '<head><link rel="stylesheet" href="__sixb/deck.css"><script src="__sixb/runtime.js" data-sixb-layout="deck"></script><title>'
    )
    expect(html.match(/__sixb\/runtime\.js/g)).toHaveLength(1)

    const runtime = await app.fetch(new Request(url(`${frame.path}__sixb/runtime.js`)))
    expect(runtime.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect(await runtime.text()).toContain("sixb-frame/1")
    const kit = await app.fetch(new Request(url(`${frame.path}__sixb/deck.css`)))
    expect(await kit.text()).toContain("@layer sixb-kit")
  })

  test("serves a page's entry in the page layout, with the page's kit, and its data beside it", async () => {
    // Reproduce by giving a page the deck's layout in frames/entries.ts: its entry asks for the
    // deck's kit and its runtime lays it out as slides.
    const fixture = createApp()
    const alice = await session(fixture.storage, "alice")
    const page = await publish(fixture, alice, "page", [
      await fixture.put(
        "index.html",
        "<!doctype html><html><head><title>Planner</title></head><body><main></main></body></html>",
        "text/html"
      ),
      await fixture.put("data/units.json", '[{"unit":"V-12"}]', "application/json"),
    ])
    const minted = await mint(fixture, alice, page.artifact.id)
    expect(minted.status).toBe(200)
    const { path } = (await minted.json()) as { path: string }
    const html = await (await fixture.app.fetch(new Request(url(`${path}index.html`)))).text()
    expect(html).toContain(
      '<head><link rel="stylesheet" href="__sixb/page.css"><script src="__sixb/runtime.js" data-sixb-layout="page"></script><title>'
    )
    const kit = await fixture.app.fetch(new Request(url(`${path}__sixb/page.css`)))
    expect(await kit.text()).toContain(".card {")
    const data = await fixture.app.fetch(new Request(url(`${path}data/units.json`)))
    expect(await data.json()).toEqual([{ unit: "V-12" }])
  })

  test("serves each of a canvas's boards as a page under one link, and its shared files as they are", async () => {
    // Reproduce by listing only a version's entry in frames/entries.ts: a canvas's entry is its
    // canvas.json, so its boards are served without the kit and the runtime.
    const fixture = createApp()
    const alice = await session(fixture.storage, "alice")
    const board = (id: string, x: number) => ({
      id,
      type: "board",
      file: `boards/${id}.html`,
      x,
      y: 0,
      w: 390,
      h: 844,
    })
    const canvas = await publish(fixture, alice, "canvas", [
      await fixture.put(
        "canvas.json",
        JSON.stringify({ items: [board("welcome", 0), board("region", 550)] }),
        "application/json"
      ),
      await fixture.put(
        "boards/welcome.html",
        "<html><head></head><body>Welcome</body></html>",
        "text/html"
      ),
      await fixture.put(
        "boards/region.html",
        "<html><head></head><body>Region</body></html>",
        "text/html"
      ),
      await fixture.put("boards/shared.css", "body { margin: 0 }", "text/css"),
    ])
    const minted = await mint(fixture, alice, canvas.artifact.id)
    expect(minted.status).toBe(200)
    const { path } = (await minted.json()) as { path: string }
    for (const id of ["welcome", "region"]) {
      const html = await (
        await fixture.app.fetch(new Request(url(`${path}boards/${id}.html`)))
      ).text()
      expect(html).toContain(
        '<head><link rel="stylesheet" href="../__sixb/page.css"><script src="../__sixb/runtime.js" data-sixb-layout="page"></script></head>'
      )
    }
    // A board in a folder finds the kit at the frame's root, where it is served. Reproduce by
    // injecting __sixb/ relative to the board: the browser asks for boards/__sixb/page.css.
    const kit = await fixture.app.fetch(new Request(url(`${path}__sixb/page.css`)))
    expect(kit.status).toBe(200)
    const css = await fixture.app.fetch(new Request(url(`${path}boards/shared.css`)))
    expect(await css.text()).toBe("body { margin: 0 }")
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
      // Its page reads rows as the reader, and opens no window to take them elsewhere: the app
      // opens its web links. Reproduce by putting `allow-popups` back in the frame's policy.
      expect(policy).toContain("sandbox allow-scripts allow-modals")
      expect(policy).not.toContain("allow-popups")
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
    const fixture = await deck()
    const { app, storage, alice, published, frame } = fixture
    const bob = await session(storage, "bob")
    expect((await mint(fixture, bob, published.artifact.id)).status).toBe(403)

    const artifacts = artifactStorage(storage)
    const version = await artifacts.getVersion({
      projectId: PROJECT_ID,
      artifactId: published.artifact.id,
      version: 1,
    })
    if (!version) throw new Error("Expected the deck's version.")
    const expired = await createArtifactFrame({
      projectId: PROJECT_ID,
      storage: artifacts,
      version,
      now: new Date(Date.now() - 2 * 60 * 60 * 1000),
    })
    expect((await app.fetch(new Request(url(`${expired.path}index.html`)))).status).toBe(404)
    expect((await app.fetch(new Request(url(`${frame.path}index.html`), alice))).status).toBe(200)
    expect(
      (await app.fetch(new Request(url(`/api/artifact-frames/${"x".repeat(43)}/index.html`))))
        .status
    ).toBe(404)
  })

  test("stops serving once its deck is deleted", async () => {
    // Two guards hold this: deleting an artifact deletes its frame grants, and resolveArtifactFrame
    // answers null for a deleted version. Reproduce by dropping both (InMemoryArtifactStorage's
    // delete keeping the grants): the route then fails on the missing version, a 500.
    const fixture = await deck()
    await remove(fixture, fixture.alice, fixture.published.artifact.id)
    for (const path of ["index.html", "deck.css", "__sixb/deck.css"]) {
      const response = await fixture.app.fetch(new Request(url(`${fixture.frame.path}${path}`)))
      expect(response.status, path).toBe(404)
      expectFrameHeaders(response, path)
    }
  })

  test("takes requests from the frame's opaque origin, and no other route does", async () => {
    // Reproduce by letting isAllowedApiBrowserOrigin throw on `null` again: the CORS plugin then
    // answers what a deck loads in CORS mode with the error, under none of the frame's headers.
    // Dropping the frame prefix from rejectDisallowedBrowserOrigin refuses it with a 403.
    const { app, frame } = await deck()
    const fromFrame = await app.fetch(
      new Request(url(`${frame.path}deck.css`), { headers: { origin: "null" } })
    )
    expect(fromFrame.status).toBe(200)
    expectFrameHeaders(fromFrame, "deck.css")
    expect(fromFrame.headers.get("content-type")).toBe("text/css")
    expect(await fromFrame.text()).toBe(".slide { color: red }")
    const elsewhere = await app.fetch(
      new Request(url("/api/artifacts"), { headers: { origin: "null" } })
    )
    expect(elsewhere.status).toBe(403)
  })

  test("takes only reads from the frame's opaque origin", async () => {
    // Reproduce by dropping the method check from rejectDisallowedBrowserOrigin: these reach the
    // router, and a preflight is answered for a route that takes no writes.
    const { app, frame } = await deck()
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await app.fetch(
        new Request(url(`${frame.path}deck.css`), { method, headers: { origin: "null" } })
      )
      expect(response.status, method).toBe(403)
    }
  })

  test("opens only in a frame, never as a page of its own", async () => {
    // Reproduce by dropping the sec-fetch-dest check from the frame route: the deck opens as a page
    // on the API's origin, where its sandbox still lets it show dialogs.
    const { app, frame } = await deck()
    const page = await app.fetch(
      new Request(url(`${frame.path}index.html`), { headers: { "sec-fetch-dest": "document" } })
    )
    expect(page.status).toBe(404)
    expectFrameHeaders(page, "document")
    const framed = await app.fetch(
      new Request(url(`${frame.path}index.html`), { headers: { "sec-fetch-dest": "iframe" } })
    )
    expect(framed.status).toBe(200)
  })

  test("serves a file's heads, ranges, and revalidations under the frame's headers", async () => {
    // Reproduce by returning the file response as createFileContentResponse builds it (each of
    // these then carries the file routes' policy, not the frame's), or by not handing it the
    // request (the range is answered in full).
    const { app, frame } = await deck()
    const css = url(`${frame.path}deck.css`)
    const etag = (await app.fetch(new Request(css))).headers.get("etag") ?? ""
    const answers = {
      head: await app.fetch(new Request(css, { method: "HEAD" })),
      range: await app.fetch(new Request(css, { headers: { range: "bytes=0-5" } })),
      unsatisfiable: await app.fetch(new Request(css, { headers: { range: "bytes=999-" } })),
      unchanged: await app.fetch(new Request(css, { headers: { "if-none-match": etag } })),
      entry: await app.fetch(new Request(url(`${frame.path}index.html`), { method: "HEAD" })),
    }
    expect(answers.head.status).toBe(200)
    expect(await answers.head.text()).toBe("")
    expect(answers.range.status).toBe(206)
    expect(await answers.range.text()).toBe(".slide")
    expect(answers.unsatisfiable.status).toBe(416)
    expect(answers.unchanged.status).toBe(304)
    expect(answers.entry.status).toBe(200)
    expect(answers.entry.headers.get("content-type")).toBe("text/html; charset=utf-8")
    for (const [label, response] of Object.entries(answers)) {
      expectFrameHeaders(response, label)
      if (label !== "unsatisfiable") {
        expect(response.headers.get("cache-control"), label).toBe("private, no-cache")
      }
    }
  })

  test("answers 404, not an error, once a file's blob is gone", async () => {
    // Reproduce by opening the entry with blobStorage.open() in the frame route again: the missing
    // blob throws, and the deck's page fails with a 500.
    const { app, blobStorage, published, frame } = await deck()
    const gone = new Set<string>(
      published.version.files.map((file: { file: { blobId: string } }) => file.file.blobId)
    )
    const { open, stat } = blobStorage
    blobStorage.stat = async (blobId) => (gone.has(blobId) ? null : stat.call(blobStorage, blobId))
    blobStorage.open = async (blobId) => {
      if (gone.has(blobId)) throw new BlobStorageError(`[BlobStorage] Unknown blob '${blobId}'`)
      return open.call(blobStorage, blobId)
    }
    for (const path of ["index.html", "deck.css"]) {
      const response = await app.fetch(new Request(url(`${frame.path}${path}`)))
      expect(response.status, path).toBe(404)
      expectFrameHeaders(response, path)
    }
  })
})

describe("a frame for anything but a deck", () => {
  test("is refused when asked for, and served by no link", async () => {
    // Reproduce by dropping the kind check from createArtifactFrame (the mint answers 200 and the
    // call resolves) or from resolveArtifactFrame (the link serves document.md as a page, kit and
    // all).
    const fixture = createApp()
    const alice = await session(fixture.storage, "alice")
    const notes = await publish(fixture, alice, "document", [
      await fixture.put("document.md", "# Notes\n\nNothing to present.\n", "text/markdown"),
    ])
    const minted = await mint(fixture, alice, notes.artifact.id)
    expect(minted.status).toBe(409)
    expect(await minted.json()).toEqual({
      error: `[Sixb] '${notes.artifact.id}' is a document, which does not open in a frame. Read its files instead.`,
      code: "artifact_kind_mismatch",
    })

    const artifacts = artifactStorage(fixture.storage)
    const version = await artifacts.getVersion({
      projectId: PROJECT_ID,
      artifactId: notes.artifact.id,
      version: 1,
    })
    if (!version) throw new Error("Expected the document's version.")
    await expect(
      createArtifactFrame({ projectId: PROJECT_ID, storage: artifacts, version })
    ).rejects.toMatchObject({ code: "artifact_kind_mismatch" })

    // A link for it all the same, such as one stored before only decks had frames, serves nothing.
    const token = "a".repeat(43)
    await artifacts.createFrameGrant({
      projectId: PROJECT_ID,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      artifactId: notes.artifact.id,
      version: 1,
      targets: [],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    const served = await fixture.app.fetch(
      new Request(url(`/api/artifact-frames/${token}/document.md`))
    )
    expect(served.status).toBe(404)
  })
})

describe("a deck's images from other artifacts", () => {
  const SVG = "<svg xmlns='http://www.w3.org/2000/svg'/>"

  /** Publishes a deck that shows `markup` on its one slide. */
  async function deckShowing(fixture: Fixture, as: Session, markup: string) {
    const deck = await publish(fixture, as, "slides", [
      await fixture.put("index.html", `<section class="slide">${markup}</section>`, "text/html"),
    ])
    const minted = await mint(fixture, as, deck.artifact.id)
    expect(minted.status).toBe(200)
    return ((await minted.json()) as { path: string }).path
  }

  test("are served under its frame, those it shows and no others, while its reader may read them", async () => {
    // Reproduce by matching a lent file on its artifact and version alone in the frame route: the
    // lender's other files are served too.
    const fixture = createApp()
    const { app, put } = fixture
    const alice = await session(fixture.storage, "alice")
    const figures = (
      await publish(fixture, alice, "slides", [
        await put("index.html", '<section class="slide"><h1>Figures</h1></section>', "text/html"),
        await put("img/flow.svg", SVG, "image/svg+xml"),
        await put("img/other.svg", SVG, "image/svg+xml"),
      ])
    ).artifact.id
    const appendix = (
      await publish(fixture, alice, "slides", [
        await put("index.html", '<section class="slide"><h1>Appendix</h1></section>', "text/html"),
        await put("img/map.svg", SVG, "image/svg+xml"),
      ])
    ).artifact.id
    const deck = await publish(fixture, alice, "slides", [
      await put(
        "index.html",
        `<section class="slide"><img src="artifact:${figures}/img/flow.svg" alt=""><img src="artifact:${appendix}/img/map.svg" alt=""></section>`,
        "text/html"
      ),
    ])
    // The appendix is gone by the time the deck is opened: its reader can no longer see the map.
    await remove(fixture, alice, appendix)
    const frame = (await (await mint(fixture, alice, deck.artifact.id)).json()) as { path: string }

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

  test("stop being served once the artifact lending them is deleted", async () => {
    // Reproduce by dropping the missing-lender check from the frame route: the route fails on the
    // deleted version instead of answering 404.
    const fixture = createApp()
    const alice = await session(fixture.storage, "alice")
    const figures = await publish(fixture, alice, "file", [
      await fixture.put("flow.svg", SVG, "image/svg+xml"),
    ])
    const frame = await deckShowing(
      fixture,
      alice,
      `<img src="artifact:${figures.artifact.id}/flow.svg" alt="">`
    )
    const lent = url(`${frame}__sixb/ref/${figures.artifact.id}@1/flow.svg`)
    expect((await fixture.app.fetch(new Request(lent))).status).toBe(200)

    await remove(fixture, alice, figures.artifact.id)
    const response = await fixture.app.fetch(new Request(lent))
    expect(response.status).toBe(404)
    expectFrameHeaders(response, "lent")
  })

  test("are found by the address the browser reads, entities decoded", async () => {
    // Reproduce by matching the src attribute as written in rewriteFrameReferences: `&amp;` is not
    // the `&` publishing recorded, and the image is drawn unavailable.
    const fixture = createApp()
    const alice = await session(fixture.storage, "alice")
    const figures = await publish(fixture, alice, "file", [
      await fixture.put("q3&q4.svg", SVG, "image/svg+xml"),
    ])
    const id = figures.artifact.id
    const frame = await deckShowing(
      fixture,
      alice,
      `<img src="artifact:${id}/q3&amp;q4.svg" alt="">`
    )

    const html = await (await fixture.app.fetch(new Request(url(`${frame}index.html`)))).text()
    expect(html).toContain(`<img src="__sixb/ref/${id}@1/q3%26q4.svg" alt="" data-sixb-ref="">`)
    const shown = await fixture.app.fetch(
      new Request(url(`${frame}__sixb/ref/${id}@1/q3%26q4.svg`))
    )
    expect(shown.status).toBe(200)
  })
})

describe("injecting the kit and the runtime", () => {
  const tag = '<link rel="stylesheet" href="__sixb/deck.css">'

  test("goes in the head, else the html element, else after the doctype", () => {
    expect(injectFrameAssets("<html><head><meta charset=utf-8></head></html>", "deck")).toStartWith(
      `<html><head>${tag}`
    )
    expect(injectFrameAssets('<html lang="en"><body></body></html>', "deck")).toStartWith(
      `<html lang="en">${tag}`
    )
    expect(
      injectFrameAssets("<!DOCTYPE html>\n<section class=slide></section>", "deck")
    ).toStartWith(`<!DOCTYPE html>${tag}`)
  })

  test("finds the head and the html element as elements, not as text in a comment or a script", () => {
    // Reproduce by choosing the element with a regular expression over the text again: it finds
    // the comment's <head> and the string's <html>, the rewriter finds neither element, and the
    // deck gets no kit and no runtime.
    for (const [html, start] of [
      ['<!-- uses <head> later --><section class="slide"></section>', tag],
      [
        '<!doctype html><script>"<html lang=en>"</script><section class="slide"></section>',
        `<!doctype html>${tag}`,
      ],
    ] as const) {
      const injected = injectFrameAssets(html, "deck")
      expect(injected, html).toStartWith(start)
      expect(injected.match(/__sixb\/runtime\.js/g), html).toHaveLength(1)
    }
  })
})
