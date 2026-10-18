import { describe, expect, test } from "bun:test"
import type { ArtifactFile } from "../src"
import { ArtifactRequestError, SixbHost } from "../src"
import { injectFrameAssets } from "../src/artifacts/frames/assets"
import { frameEntries, frameLayout } from "../src/artifacts/frames/entries"
import { FRAME_PAGE_CSS } from "../src/artifacts/frames/kit"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ id: "pages", ontology: [], ...deps })
  const sixb = createTestSixb(host, {
    authorization: {
      principal: { type: "user", id: "alice" },
      groupIds: [],
      roleIds: [],
      grants: emptyGrantIndex(),
    },
  })
  const publish = async (contents: Record<string, string>, kind: "page" | "document" = "page") => {
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
    return sixb.artifacts.create({ kind, title: "Fleet planner", files })
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

describe("publishing a page", () => {
  test("names it by its title, else its first heading, and records the artifacts it uses", async () => {
    const { publish } = setup()
    const report = await publish({ "document.md": "# Q3\n\n## Methodology\n" }, "document")
    const published = await publish({
      "index.html": [
        "<!doctype html><html><head><title> Fleet  planner &amp; crews </title></head><body>",
        "<main><h1>Not the title</h1>",
        `<a href="artifact:${report.artifact.id}#methodology">How we count</a>`,
        `<sixb-embed src="artifact:${report.artifact.id}#methodology"></sixb-embed>`,
        '</main><script src="app.js"></script></body></html>',
      ].join(""),
      "app.js": "console.log('ready')",
      "data/units.json": "[]",
    })
    expect(published.version.entry).toBe("index.html")
    expect(published.version.outline).toEqual({ kind: "page", title: "Fleet planner & crews" })
    expect(published.version.references).toEqual([
      {
        address: `artifact:${report.artifact.id}#methodology`,
        as: "link",
        at: "",
        resolvedVersion: 1,
      },
      {
        address: `artifact:${report.artifact.id}#methodology`,
        as: "embed",
        at: "",
        resolvedVersion: 1,
      },
    ])

    const untitled = await publish({ "index.html": "<main><h1>Crew <em>map</em></h1><h1>Two</h1>" })
    expect(untitled.version.outline).toEqual({ kind: "page", title: "Crew map" })
    const bare = await publish({ "index.html": "<p>Just text</p>" })
    expect(bare.version.outline).toEqual({ kind: "page" })
  })

  test("refuses what would not render, saying what to fix", async () => {
    const { publish } = setup()
    expect(await refusal(publish({ "app.html": "<main></main>" }))).toContain(
      "A page needs 'index.html'"
    )
    expect(
      await refusal(publish({ "index.html": "<main></main>", "__sixb/page.css": "" }))
    ).toContain("'__sixb/page.css' is under __sixb/, where Sixb serves the page's kit")
    expect(
      await refusal(publish({ "index.html": '<iframe src="artifact:art_0000000000"></iframe>' }))
    ).toContain("show another artifact with <sixb-embed")
    expect(
      await refusal(
        publish({ "index.html": '<sixb-embed src="artifact:art_0000000000#chart=x"></sixb-embed>' })
      )
    ).toContain("art_0000000000")
  })
})

describe("a page's frame", () => {
  test("serves its entry in the page layout, with the page's kit", () => {
    expect(frameLayout("page")).toBe("page")
    expect(frameEntries({ entry: "index.html", outline: { kind: "page" } })).toEqual(["index.html"])
    expect(injectFrameAssets("<html><head></head><body></body></html>", "page")).toContain(
      '<link rel="stylesheet" href="__sixb/page.css"><script src="__sixb/runtime.js" data-sixb-layout="page">'
    )
  })

  test("draws plain HTML in the app's theme, inside the kit's layer", () => {
    // The page's own CSS, unlayered, wins over every rule here.
    expect(FRAME_PAGE_CSS).toContain("@layer sixb-kit, sixb-theme;")
    expect(FRAME_PAGE_CSS).not.toContain("section.slide")
    for (const selector of ["main {", ".card {", ".stat .value", "button, .button {", "table {"]) {
      expect(FRAME_PAGE_CSS).toContain(selector)
    }
  })
})
