import { describe, expect, test } from "bun:test"
import type { ArtifactFile } from "../src"
import { ArtifactRequestError, SixbHost } from "../src"
import { DECK_KEYS, FRAME_PROTOCOL, frameStartHash } from "../src/artifacts/frames/protocol"
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
  test("speaks the protocol and passes the keys the app declares", () => {
    // The runtime is served as its own source, so it repeats these instead of importing them.
    const source = frameRuntime.toString()
    expect(source).toContain(`"${FRAME_PROTOCOL}"`)
    for (const key of DECK_KEYS) expect(source).toContain(JSON.stringify(key))
    for (const key of ["sixb-slide", "sixb-fill"]) expect(source).toContain(`"${key}"`)
    // It names nothing outside itself: its source runs on its own.
    expect(() => new Function(`return (${source})`)()).not.toThrow()
  })
})
