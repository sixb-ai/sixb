import { describe, expect, test } from "bun:test"
import type { ArtifactFile } from "../src"
import { ArtifactRequestError, SixbHost } from "../src"
import { injectFrameAssets } from "../src/artifacts/frames/assets"
import { frameEntries, frameLayout } from "../src/artifacts/frames/entries"
import {
  DECK_KEYS,
  FRAME_PROTOCOL,
  frameStartHash,
  parseFrameEvent,
} from "../src/artifacts/frames/protocol"
import { frameRuntime } from "../src/artifacts/frames/runtime"
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
    expect(
      event("embeds", { embeds: [{ address: "artifact:art_0123456789#1", rect, scale: 0.5 }] })
        ?.params
    ).toEqual({ embeds: [{ address: "artifact:art_0123456789#1", rect, scale: 0.5 }] })
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
      ["embeds", { embeds: "all" }],
      ["embeds", { embeds: [{ address: "artifact:art_0123456789", rect, scale: 0 }] }],
      ["embeds", { embeds: [{ address: "artifact:art_0123456789", rect: { ...rect, x: "1" } }] }],
      ["embeds", { embeds: Array.from({ length: 201 }, () => ({ address: "a", rect, scale: 1 })) }],
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
