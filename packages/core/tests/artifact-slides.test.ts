import { describe, expect, test } from "bun:test"
import type { ArtifactFile } from "../src"
import { ArtifactRequestError, SixbHost } from "../src"
import { injectFrameAssets } from "../src/artifacts/frames/assets"
import { frameEntries, frameLayout } from "../src/artifacts/frames/entries"
import {
  DECK_KEYS,
  FRAME_PROTOCOL,
  frameStartHash,
  parseFrameCall,
  parseFrameEvent,
} from "../src/artifacts/frames/protocol"
import { frameRuntime } from "../src/artifacts/frames/runtime"
import { ARTIFACT_STATE_LIMITS } from "../src/artifacts/limits"
import { isArtifactQueryName } from "../src/artifacts/queries"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ id: "slides", ontology: [], ...deps })
  const sixb = createTestSixb(host, {
    authorization: {
      principal: { type: "user", id: "alice" },
      groupIds: [],
      roleIds: [],
      grants: emptyGrantIndex(),
    },
  })
  const publish = async (contents: Record<string, string>) => {
    const files: ArtifactFile[] = []
    for (const [path, body] of Object.entries(contents)) {
      files.push({
        path,
        file: await deps.blobStorage.put({
          body: new TextEncoder().encode(body),
          fileName: path.split("/").at(-1) ?? path,
        }),
      })
    }
    return sixb.artifacts.create({ kind: "slides", title: "Q3 review", files })
  }
  return { publish }
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(ArtifactRequestError)
  return (error as Error).message
}

describe("publishing a deck", () => {
  test("outlines each slide by its first heading, and records the artifacts it links to and shows", async () => {
    const { publish } = setup()
    const target = await publish({
      "index.html": '<section class="slide"><h1>Appendix</h1></section>',
      "img/flow.svg": "<svg/>",
    })
    const published = await publish({
      "index.html": [
        '<section class="slide title"><p class="eyebrow">Q3</p><h1>Q3 review &amp; outlook</h1></section>',
        '<section class="slide stat"><h2>Revenue grew <strong>18%</strong></h2><h3>Not the title</h3></section>',
        `<section class="slide"><p>No heading, but <a href="artifact:${target.artifact.id}">a link</a>.</p></section>`,
        '<section class="notes">Not a slide</section>',
        `<section class="slide"><img src="artifact:${target.artifact.id}/img/flow.svg" alt=""><sixb-embed src="artifact:${target.artifact.id}#1"></sixb-embed></section>`,
      ].join("\n"),
      "img/chart.svg": "<svg/>",
    })
    expect(published.version.entry).toBe("index.html")
    expect(published.version.outline).toEqual({
      kind: "slides",
      slides: [{ title: "Q3 review & outlook" }, { title: "Revenue grew 18%" }, {}, {}],
    })
    expect(published.version.references).toEqual([
      { address: `artifact:${target.artifact.id}`, as: "link", at: "3", resolvedVersion: 1 },
      {
        address: `artifact:${target.artifact.id}/img/flow.svg`,
        as: "embed",
        at: "4",
        resolvedVersion: 1,
      },
      { address: `artifact:${target.artifact.id}#1`, as: "embed", at: "4", resolvedVersion: 1 },
    ])
    // What a deck shows must exist, as a document's embeds must.
    expect(
      await refusal(
        publish({
          "index.html": `<section class="slide"><sixb-embed src="artifact:${target.artifact.id}#9"></sixb-embed></section>`,
        })
      )
    ).toContain("#9")
  })

  test("refuses what would not render, saying what to fix", async () => {
    const { publish } = setup()
    expect(await refusal(publish({ "slides.html": "<section class=slide></section>" }))).toContain(
      "A deck needs 'index.html'"
    )
    expect(await refusal(publish({ "index.html": "<h1>One page</h1>" }))).toContain(
      'put each slide in a <section class="slide">'
    )
    expect(
      await refusal(
        publish({ "index.html": "<section class=slide></section>", "__sixb/kit.css": "" })
      )
    ).toContain("'__sixb/kit.css' is under __sixb/")
    expect(
      await refusal(
        publish({
          "index.html":
            '<section class="slide"><img src="artifact:art_0000000000#chart=x"></section>',
        })
      )
    ).toContain('with <sixb-embed src="artifact:art_0000000000#chart=x"></sixb-embed>')
    expect(
      await refusal(
        publish({
          "index.html":
            '<section class="slide"><sixb-embed src="chart.png"></sixb-embed></section>',
        })
      )
    ).toContain('give it src="artifact:…"')
    expect(
      await refusal(
        publish({
          "index.html":
            '<section class="slide"><iframe src="artifact:art_0000000000"></iframe></section>',
        })
      )
    ).toContain("show another artifact with <sixb-embed")
  })
})

describe("a frame's start", () => {
  test("goes in the fragment, and says nothing for the first slide on the stage", () => {
    expect(frameStartHash({})).toBe("")
    expect(frameStartHash({ slide: 1 })).toBe("")
    expect(frameStartHash({ slide: 3 })).toBe("#sixb-slide=3")
    expect(frameStartHash({ slide: 3, fill: true })).toBe("#sixb-slide=3&sixb-fill")
    expect(frameStartHash({ fill: true })).toBe("#sixb-fill")
  })
})

describe("the frame runtime", () => {
  test("speaks the protocol and passes exactly the keys the app declares", () => {
    // The runtime is served as its own source, so it repeats these instead of importing them.
    // Reproduce by adding or dropping a key in the runtime's KEYS: the lists no longer match.
    const source = frameRuntime.toString()
    expect(source).toContain(`"${FRAME_PROTOCOL}"`)
    const keys = /\bKEYS\s*=\s*\[([^\]]*)\]/.exec(source)?.[1]
    expect(keys).toBeDefined()
    const runtimeKeys = Array.from(keys?.matchAll(/"((?:[^"\\]|\\.)*)"/g) ?? [], (match) =>
      JSON.parse(match[0])
    )
    expect(runtimeKeys).toEqual([...DECK_KEYS])
    for (const key of ["sixb-slide", "sixb-fill"]) expect(source).toContain(`"${key}"`)
    // It names nothing outside itself: its source runs on its own.
    expect(() => new Function(`return (${source})`)()).not.toThrow()
  })

  test("refuses the values storage would, by the limits Core declares", () => {
    // The runtime repeats the limits instead of importing them, and its source as served has
    // them inlined. Reproduce by changing one there.
    const source = frameRuntime.toString()
    expect(source).toMatch(
      new RegExp(`length > (MAX_KEY_LENGTH|${ARTIFACT_STATE_LIMITS.maxKeyLength})\\b`)
    )
    expect(source).toMatch(
      new RegExp(`byteLength > (MAX_VALUE_BYTES|${ARTIFACT_STATE_LIMITS.maxValueBytes})\\b`)
    )
    for (const [name, value] of [
      ["MAX_KEY_LENGTH", ARTIFACT_STATE_LIMITS.maxKeyLength],
      ["MAX_VALUE_BYTES", ARTIFACT_STATE_LIMITS.maxValueBytes],
    ] as const) {
      // Where the constant is kept by name, it is the limit's value.
      const declared = new RegExp(`${name} = (\\d+)`).exec(source)?.[1]
      if (declared !== undefined) expect(Number(declared)).toBe(value)
    }
  })

  test("refuses a key that would name another route", async () => {
    // Reproduce by accepting "." and ".." in the runtime's checkKey: delete("..") resolves.
    // Opened on its own, as the layout check opens a page, it keeps the values in memory.
    const window: Record<string, unknown> = {
      location: { hash: "" },
      innerWidth: 1280,
      innerHeight: 720,
      addEventListener: () => {},
      postMessage: () => {},
    }
    window.parent = window
    const document = {
      documentElement: { classList: { add: () => {} }, dataset: {}, style: {} },
      currentScript: { getAttribute: () => "page" },
      readyState: "complete",
      body: null,
      addEventListener: () => {},
      querySelectorAll: () => [],
    }
    const ResizeObserver = class {
      observe() {}
    }
    new Function(
      "window",
      "document",
      "ResizeObserver",
      "requestAnimationFrame",
      `(${frameRuntime.toString()})()`
    )(window, document, ResizeObserver, () => 0)
    const { state } = window.sixb as {
      state: {
        set: (key: string, value: unknown) => Promise<void>
        delete: (key: string) => Promise<unknown>
        keys: () => Promise<unknown>
      }
    }

    for (const key of ["..", "."]) {
      expect(await state.delete(key).catch((error: unknown) => error), key).toBeInstanceOf(
        TypeError
      )
    }

    // A key with dots in it is still one.
    await state.set("v1..2", 1)
    expect(await state.keys()).toEqual(["v1..2"])
  })

  test("reads a query from beside the runtime when it is opened on its own", async () => {
    // Opened alone, as the layout check opens a page or a board, there is no app to run a query:
    // the check serves its rows at __sixb/queries/<name>.json. Reproduce by making the call alone
    // too: the values kept in memory answer it, and the page reads no rows. The names it sends
    // are those Core reads.
    const window: Record<string, unknown> = {
      location: { hash: "", href: "http://127.0.0.1:4100/boards/region.html" },
      innerWidth: 1280,
      innerHeight: 720,
      addEventListener: () => {},
      postMessage: () => {},
    }
    window.parent = window
    const document = {
      documentElement: { classList: { add: () => {} }, dataset: {}, style: {} },
      // A board in its folder loads the runtime from the frame's root.
      currentScript: {
        getAttribute: () => "page",
        src: "http://127.0.0.1:4100/__sixb/runtime.js",
      },
      readyState: "complete",
      body: null,
      addEventListener: () => {},
      querySelectorAll: () => [],
    }
    const ResizeObserver = class {
      observe() {}
    }
    const fetched: string[] = []
    const overdue = { kind: "objects", objects: [], total: 0, truncated: false }
    const fetch = async (url: URL) => {
      fetched.push(url.href)
      return url.pathname === "/__sixb/queries/overdue.json"
        ? Response.json(overdue)
        : new Response(null, { status: 404 })
    }
    new Function(
      "window",
      "document",
      "ResizeObserver",
      "requestAnimationFrame",
      "fetch",
      `(${frameRuntime.toString()})()`
    )(window, document, ResizeObserver, () => 0, fetch)
    const { query } = window.sixb as { query: (name: string) => Promise<unknown> }

    expect(await query("overdue")).toEqual(overdue)
    expect(fetched).toEqual(["http://127.0.0.1:4100/__sixb/queries/overdue.json"])

    const missing = await query("missing").catch((error: unknown) => error)
    expect(missing).toBeInstanceOf(Error)
    expect((missing as Error).message).toBe("[Sixb] No query 'missing' in this page's version.")

    for (const name of ["by-region", "q3", "a".repeat(64), "", "-lead", "Overdue", "../x"]) {
      const accepted = !((await query(name).catch((error: unknown) => error)) instanceof TypeError)
      expect(accepted, name).toBe(isArtifactQueryName(name))
    }
  })

  test("gives each embed of a page one id, the same as the page scrolls", () => {
    // Reproduce by giving an embed its rank among those reported: once the first scrolls out of
    // reach, the next takes its id, and the app mounts what it draws there again.
    const listeners = new Map<string, () => void>()
    const posted: Record<string, unknown>[] = []
    const window: Record<string, unknown> = {
      location: { hash: "" },
      innerWidth: 1280,
      innerHeight: 720,
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      postMessage: (message: Record<string, unknown>) => posted.push(message),
    }
    window.parent = window

    // Three embeds down a page, the last more than a screen below the view.
    let scrolled = 0
    const embed = (src: string, top: number) => ({
      getAttribute: () => src,
      getBoundingClientRect: () => ({
        left: 0,
        top: top - scrolled,
        bottom: top - scrolled + 360,
        width: 640,
        height: 360,
      }),
    })
    const embeds = [
      embed("artifact:art_0123456789#chart=a", 0),
      embed("artifact:art_0123456789#chart=b", 1000),
      embed("artifact:art_0123456789#chart=c", 1800),
    ]
    const document = {
      documentElement: { classList: { add: () => {} }, dataset: {}, style: {} },
      currentScript: { getAttribute: () => "page" },
      readyState: "complete",
      body: null,
      addEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === "sixb-embed[src]" ? embeds : []),
    }
    const ResizeObserver = class {
      observe() {}
    }
    new Function(
      "window",
      "document",
      "ResizeObserver",
      "requestAnimationFrame",
      `(${frameRuntime.toString()})()`
    )(window, document, ResizeObserver, (callback: () => void) => callback())

    // The reader scrolls past the first one, and the last comes within reach.
    scrolled = 1200
    listeners.get("scroll")?.()

    const [before = {}, after = {}] = posted.flatMap((message) => {
      const event = parseFrameEvent(message)
      if (event?.event !== "embeds") return []

      // Each report, as the app reads it: the chart's name, and the id it came with.
      return [
        Object.fromEntries(event.params.embeds.map((each) => [each.address.slice(-1), each.id])),
      ]
    })
    expect(Object.keys(before)).toEqual(["a", "b"])
    expect(Object.keys(after)).toEqual(["b", "c"])

    expect(after.b).toBe(before.b as number)
    expect(new Set([before.a, before.b, after.c]).size).toBe(3)
  })

  test("leaves the page only through the app, which opens what the reader follows", () => {
    // The frame opens no window and navigates nowhere but the frames' origin: a link out goes to
    // the app as a message. Reproduce by giving a web link `target="_blank"` again in the
    // runtime's click handler, as it once did: nothing is posted, and the frame tries to open it.
    let click: ((event: unknown) => void) | undefined
    const posted: Record<string, unknown>[] = []
    const window: Record<string, unknown> = {
      location: { hash: "" },
      innerWidth: 1280,
      innerHeight: 720,
      addEventListener: () => {},
      postMessage: (message: Record<string, unknown>) => posted.push(message),
    }
    window.parent = window
    const document = {
      documentElement: { classList: { add: () => {} }, dataset: {}, style: {} },
      currentScript: { getAttribute: () => "page" },
      readyState: "complete",
      baseURI: "https://api.sixb.test/api/artifact-frames/token/index.html",
      body: null,
      addEventListener: (name: string, listener: (event: unknown) => void) => {
        if (name === "click") click = listener
      },
      querySelectorAll: () => [],
    }
    const ResizeObserver = class {
      observe() {}
    }
    new Function(
      "window",
      "document",
      "ResizeObserver",
      "requestAnimationFrame",
      `(${frameRuntime.toString()})()`
    )(window, document, ResizeObserver, () => 0)

    /** A click on a link to `href`, as the runtime hears it: what it posts, and if it stops it. */
    const follow = (href: string, handled = false) => {
      posted.length = 0
      const link = { getAttribute: () => href }
      const event = {
        target: { closest: () => link },
        defaultPrevented: handled,
        stopped: false,
        preventDefault() {
          this.stopped = true
        },
      }
      click?.(event)
      const sent = posted.flatMap((message) => parseFrameEvent(message) ?? [])
      return { sent, stopped: event.stopped }
    }

    expect(follow("https://example.com/report?q=1")).toEqual({
      sent: [
        {
          protocol: FRAME_PROTOCOL,
          event: "link",
          params: { url: "https://example.com/report?q=1" },
        },
      ],
      stopped: true,
    })
    // A file of the page is a web page too, at the frame's address.
    expect(follow("notes.html").sent).toEqual([
      {
        protocol: FRAME_PROTOCOL,
        event: "link",
        params: { url: "https://api.sixb.test/api/artifact-frames/token/notes.html" },
      },
    ])
    expect(follow("artifact:art_0123456789").sent).toEqual([
      { protocol: FRAME_PROTOCOL, event: "open", params: { address: "artifact:art_0123456789" } },
    ])

    // Any other address goes nowhere, in the frame or out of it.
    for (const href of ["mailto:ops@example.com", "javascript:void 0", "data:text/html,hi"]) {
      expect(follow(href), href).toEqual({ sent: [], stopped: true })
    }

    // A link within the page, or one the page's own script handled, is the page's.
    expect(follow("#totals")).toEqual({ sent: [], stopped: false })
    expect(follow("https://example.com", true)).toEqual({ sent: [], stopped: false })
  })

  test("reads its layout from the tag the frame injects it with", () => {
    // Reproduce by renaming the attribute on either side: every page lays out as a deck.
    expect(frameRuntime.toString()).toContain('"data-sixb-layout"')
    expect(injectFrameAssets("<head></head>", "deck")).toContain(
      '<link rel="stylesheet" href="__sixb/deck.css"><script src="__sixb/runtime.js" data-sixb-layout="deck">'
    )
  })
})

describe("frames", () => {
  test("open the kinds with a layout, serving their entry as a page", () => {
    expect(frameLayout("slides")).toBe("deck")
    expect(["document", "sheet", "file"].map((kind) => frameLayout(kind as "file"))).toEqual([
      null,
      null,
      null,
    ])
    const outline = { kind: "slides" as const, slides: [] }
    expect(frameEntries({ entry: "index.html", outline })).toEqual(["index.html"])
    expect(
      frameEntries({ entry: "document.md", outline: { kind: "document", headings: [] } })
    ).toEqual([])
  })
})

describe("a frame's events", () => {
  const event = (name: string, params: unknown) =>
    parseFrameEvent({ protocol: FRAME_PROTOCOL, event: name, params })
  const rect = { x: 10, y: 20, width: 300, height: 200 }

  test("read as the protocol declares them", () => {
    expect(event("ready", { slides: 3 })).toEqual({
      protocol: FRAME_PROTOCOL,
      event: "ready",
      params: { slides: 3 },
    })
    // A frame that is no deck has no slides to count.
    expect(event("ready", {})?.params).toEqual({})
    expect(event("select", { slide: 2 })?.params).toEqual({ slide: 2 })
    expect(event("key", { key: "ArrowRight" })?.params).toEqual({ key: "ArrowRight" })
    expect(event("open", { address: "artifact:art_0123456789" })?.params).toEqual({
      address: "artifact:art_0123456789",
    })
    expect(event("link", { url: "https://example.com/a?b=1" })?.params).toEqual({
      url: "https://example.com/a?b=1",
    })
    expect(
      event("embeds", {
        embeds: [{ id: 1, address: "artifact:art_0123456789#1", rect, scale: 0.5 }],
      })?.params
    ).toEqual({ embeds: [{ id: 1, address: "artifact:art_0123456789#1", rect, scale: 0.5 }] })
    expect(event("size", { height: 1240 })?.params).toEqual({ height: 1240 })
  })

  test("give a page's height as at most 100,000 pixels", () => {
    // A page that grows with its frame would grow a document's frame without end. Reproduce by
    // dropping the cap in parseFrameEvent: the height comes through as posted.
    expect(event("size", { height: 1e9 })?.params).toEqual({ height: 100_000 })
  })

  test("that a deck's own scripts could post out of shape are dropped", () => {
    // A deck runs inline scripts: reproduce by returning `data` as a FrameEvent unchecked.
    for (const [name, params] of [
      ["ready", { slides: -1 }],
      ["ready", { slides: 2.5 }],
      ["ready", { slides: "100000000" }],
      ["select", { slide: 0 }],
      ["select", { slide: Number.POSITIVE_INFINITY }],
      ["key", { key: "q" }],
      ["open", { address: 42 }],
      ["open", { address: `artifact:${"a".repeat(3000)}` }],
      // The app opens only a web page: reproduce by accepting any address in parseFrameEvent.
      ["link", { url: "javascript:alert(1)" }],
      ["link", { url: "data:text/html,hi" }],
      ["link", { url: "/relative" }],
      ["link", { url: `https://example.com/${"a".repeat(9000)}` }],
      ["embeds", { embeds: "all" }],
      ["embeds", { embeds: [{ id: 1, address: "artifact:art_0123456789", rect, scale: 0 }] }],
      [
        "embeds",
        { embeds: [{ id: 1, address: "artifact:art_0123456789", rect: { ...rect, x: "1" } }] },
      ],
      [
        "embeds",
        {
          embeds: Array.from({ length: 201 }, (_, id) => ({ id, address: "a", rect, scale: 1 })),
        },
      ],
      ["embeds", { embeds: [{ address: "artifact:art_0123456789", rect, scale: 1 }] }],
      ["embeds", { embeds: [{ id: -1, address: "artifact:art_0123456789", rect, scale: 1 }] }],
      [
        "embeds",
        {
          embeds: [
            { id: 1, address: "artifact:art_0123456789#1", rect, scale: 1 },
            { id: 1, address: "artifact:art_0123456789#2", rect, scale: 1 },
          ],
        },
      ],
      ["size", { height: -1 }],
      ["size", { height: "tall" }],
      ["size", { height: Number.NaN }],
      ["unknown", {}],
    ] as const) {
      expect(event(name, params)).toBeNull()
    }
    expect(parseFrameEvent({ protocol: "other/1", event: "ready", params: { slides: 1 } })).toBe(
      null
    )
    expect(parseFrameEvent(null)).toBeNull()
    expect(parseFrameEvent({ protocol: FRAME_PROTOCOL, event: "ready" })).toBeNull()
  })
})

describe("a frame's calls", () => {
  const call = (method: string, params: unknown, id: unknown = 1) =>
    parseFrameCall({ protocol: FRAME_PROTOCOL, call: id, method, params })

  test("read as the protocol declares them", () => {
    expect(call("state.get", { key: "inputs" })).toEqual({
      protocol: FRAME_PROTOCOL,
      call: 1,
      method: "state.get",
      params: { key: "inputs" },
    })
    expect(call("state.set", { key: "inputs", value: { rate: 450 } })?.params).toEqual({
      key: "inputs",
      value: { rate: 450 },
    })
    // null is a value a page keeps.
    expect(call("state.set", { key: "cleared", value: null })?.params).toEqual({
      key: "cleared",
      value: null,
    })
    expect(call("state.delete", { key: "inputs" })?.method).toBe("state.delete")
    expect(call("state.keys", {})?.params).toEqual({})
    expect(call("query.run", { name: "overdue" })).toEqual({
      protocol: FRAME_PROTOCOL,
      call: 1,
      method: "query.run",
      params: { name: "overdue" },
    })
  })

  test("that a page's own scripts could post out of shape are dropped", () => {
    // A page writes what it posts: reproduce by returning `data` as a FrameCall unchecked.
    const value = "x".repeat(ARTIFACT_STATE_LIMITS.maxValueBytes)
    for (const [method, params, id] of [
      ["state.get", { key: "" }, 1],
      ["state.get", { key: "a".repeat(129) }, 1],
      ["state.get", { key: "line\nbreak" }, 1],
      ["state.get", { key: 42 }, 1],
      // The client puts a key in the path, where these name another route.
      ["state.delete", { key: ".." }, 1],
      ["state.delete", { key: "." }, 1],
      ["state.set", { key: "inputs" }, 1],
      ["state.set", { key: "big", value }, 1],
      ["state.set", { key: "loop", value: 10n }, 1],
      ["state.clear", {}, 1],
      ["state.keys", {}, -1],
      ["state.keys", {}, "1"],
      // A query's name is its file's: the client puts it in the path too.
      ["query.run", { name: "../state" }, 1],
      ["query.run", { name: "Overdue" }, 1],
      ["query.run", { name: "" }, 1],
      ["query.run", { name: 7 }, 1],
      ["query.run", {}, 1],
    ] as const) {
      expect(call(method, params, id)).toBeNull()
    }
    expect(parseFrameCall({ protocol: FRAME_PROTOCOL, event: "ready", params: {} })).toBeNull()
  })
})
