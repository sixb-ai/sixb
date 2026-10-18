import { describe, expect, test } from "bun:test"
import type { ArtifactFile } from "../src"
import { ArtifactRequestError, SixbHost } from "../src"
import { parseArtifactAddress } from "../src/artifacts/address"
import { parseCanvas } from "../src/artifacts/canvas"
import { resolveArtifactAddress } from "../src/artifacts/resolve"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const board = (id: string, x = 0) => ({
  id,
  type: "board",
  file: `boards/${id}.html`,
  x,
  y: 0,
  w: 1280,
  h: 800,
  title: id[0]?.toUpperCase() + id.slice(1),
})

const CANVAS = {
  items: [
    { id: "signup", type: "section", x: -60, y: -140, w: 2900, h: 1060, title: "Sign-up flow" },
    board("home"),
    board("pricing", 1400),
    { id: "to-pricing", type: "arrow", from: "home", to: "pricing", label: "Start trial" },
    {
      id: "annual",
      type: "note",
      x: 0,
      y: 860,
      w: 280,
      text: "Lead with annual pricing?",
      tone: "chart-3",
    },
    { id: "heading", type: "text", x: 0, y: -420, text: "Trial onboarding", size: "xl" },
    {
      id: "decide",
      type: "shape",
      shape: "diamond",
      x: 3000,
      y: 600,
      w: 200,
      h: 140,
      text: "Paid?",
    },
    { id: "loose", type: "arrow", from: { x: 3100, y: 400 }, to: "decide", dashed: true },
  ],
}

describe("parseCanvas", () => {
  test("fills the full form", () => {
    const parsed = parseCanvas(JSON.stringify(CANVAS))
    if (!("canvas" in parsed)) throw new Error(parsed.error)
    expect(parsed.canvas.items.find((item) => item.id === "to-pricing")).toEqual({
      id: "to-pricing",
      type: "arrow",
      from: "home",
      to: "pricing",
      label: "Start trial",
      dashed: false,
    })
    expect(parsed.canvas.items.find((item) => item.id === "heading")).toMatchObject({ size: "xl" })
  })

  const withItems = (...items: unknown[]) => JSON.stringify({ items })
  test.each([
    ["{", "is not valid JSON"],
    [JSON.stringify({ items: [] }), '"items" must list at least one item'],
    [withItems({ id: "Home", type: "board" }), 'item 1 needs an "id" of lowercase letters'],
    [
      withItems({ id: "a", type: "frame" }),
      "item 'a' has type \"frame\"; use one of board, section",
    ],
    [withItems({ ...board("a"), color: "red" }), "board 'a' has 'color'; it takes"],
    [withItems({ ...board("a"), file: "a.png" }), "board 'a' needs a \"file\", the HTML it shows"],
    [withItems({ ...board("a"), w: 20 }), "board 'a' needs \"w\", a size of 40 to 8000 pixels"],
    [
      withItems({ ...board("a"), x: 200_000 }),
      "board 'a' needs \"x\", a number of pixels within ±100,000",
    ],
    [withItems(board("a"), board("a")), "two items have the id 'a'"],
    [
      withItems({ id: "n", type: "note", x: 0, y: 0, w: 200, text: " " }),
      "note 'n' needs \"text\"",
    ],
    [
      withItems({ id: "n", type: "note", x: 0, y: 0, w: 200, text: "Hi", tone: "red" }),
      'has the tone "red"',
    ],
    [withItems({ id: "t", type: "text", x: 0, y: 0, text: "Hi", size: "xxl" }), '"size" is "xxl"'],
    [
      withItems({ id: "s", type: "shape", shape: "star", x: 0, y: 0, w: 80, h: 80 }),
      '"shape" is "star"',
    ],
    [
      withItems({ id: "e", type: "embed", src: "https://x", x: 0, y: 0, w: 80, h: 80 }),
      'needs a "src", another artifact\'s address',
    ],
    [
      withItems(board("a"), { id: "r", type: "arrow", from: "a", to: "b" }),
      "arrow 'r' \"to\" names 'b', which the canvas does not have",
    ],
    [
      withItems(board("a"), { id: "r", type: "arrow", from: "a", to: "a" }),
      "arrow 'r' starts and ends at 'a'",
    ],
    [
      withItems(
        board("a"),
        board("b"),
        { id: "r", type: "arrow", from: "a", to: "b" },
        { id: "q", type: "arrow", from: "r", to: "b" }
      ),
      "an arrow joins items, not arrows",
    ],
    [
      withItems({ id: "r", type: "arrow", from: 4, to: "a" }),
      "arrow 'r' needs \"from\": an item's id, or a point",
    ],
    [
      JSON.stringify({ items: [board("a")], start: "a" }),
      // A canvas opens fitted to everything: there is no item to start on.
      "the canvas has 'start'; it takes \"items\"",
    ],
    [
      withItems(...Array.from({ length: 41 }, (_, index) => board(`b${index}`))),
      "at most 40 boards",
    ],
  ])("refuses %s", (text, message) => {
    const parsed = parseCanvas(text)
    expect("error" in parsed && parsed.error).toContain(message)
  })
})

describe("publishing a canvas", () => {
  function setup() {
    const deps = createTestRuntimeDeps()
    const host = new SixbHost({ id: "canvases", ontology: [], ...deps })
    const sixb = createTestSixb(host, {
      authorization: {
        principal: { type: "user", id: "alice" },
        groupIds: [],
        roleIds: [],
        grants: emptyGrantIndex(),
      },
    })
    const files = async (contents: Record<string, string>) => {
      const list: ArtifactFile[] = []
      for (const [path, body] of Object.entries(contents)) {
        list.push({
          path,
          file: await deps.blobStorage.put({
            body: new TextEncoder().encode(body),
            fileName: path.split("/").at(-1) ?? path,
          }),
        })
      }
      return list
    }
    const publish = async (
      contents: Record<string, string>,
      kind: "canvas" | "document" = "canvas"
    ) => sixb.artifacts.create({ kind, title: "Trial onboarding", files: await files(contents) })
    return { publish }
  }
  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(ArtifactRequestError)
    return (error as Error).message
  }

  test("outlines its boards and sections, and resolves what its boards and embeds show", async () => {
    const { publish } = setup()
    const report = await publish({ "document.md": "# Pricing\n\n## Plans\n" }, "document")
    const published = await publish({
      "canvas.json": JSON.stringify({
        ...CANVAS,
        items: [
          ...CANVAS.items,
          {
            id: "plans",
            type: "embed",
            src: `artifact:${report.artifact.id}#plans`,
            x: 3400,
            y: 0,
            w: 640,
            h: 400,
          },
        ],
      }),
      "boards/home.html": `<main><a href="artifact:${report.artifact.id}">Pricing notes</a></main>`,
      "boards/pricing.html": "<main><h1>Pricing</h1></main>",
      "boards/shared.css": "main { padding: 40px }",
    })
    expect(published.version.entry).toBe("canvas.json")
    expect(published.version.outline).toEqual({
      kind: "canvas",
      items: [
        { id: "signup", type: "section", title: "Sign-up flow" },
        { id: "home", type: "board", title: "Home" },
        { id: "pricing", type: "board", title: "Pricing" },
      ],
    })
    expect(
      published.version.references.map(({ address, as, at }) => ({ address, as, at }))
    ).toEqual([
      { address: `artifact:${report.artifact.id}`, as: "link", at: "home" },
      { address: `artifact:${report.artifact.id}#plans`, as: "embed", at: "plans" },
    ])

    // An address names a board or a section by its id.
    const target = {
      kind: "canvas" as const,
      outline: published.version.outline,
      files: published.version.files,
    }
    const resolve = (part: string) =>
      resolveArtifactAddress(
        parseArtifactAddress(`artifact:${published.artifact.id}#${part}`)!,
        target
      )
    expect(resolve("pricing")).toEqual({ part: { type: "board", id: "pricing" } })
    expect(resolve("signup")).toEqual({ part: { type: "region", id: "signup" } })
    expect(resolve("annual")).toEqual({
      problem:
        "has no board or section 'annual'; its boards and sections are 'signup', 'home', 'pricing'",
    })
  })

  test("refuses a board without its file, and what its HTML can't show", async () => {
    const { publish } = setup()
    const canvas = JSON.stringify({ items: [board("home")] })
    expect(await refusal(publish({ "boards/home.html": "<main></main>" }))).toContain(
      "A canvas is 'canvas.json'"
    )
    expect(await refusal(publish({ "canvas.json": canvas }))).toContain(
      "board 'home' shows 'boards/home.html', which is not one of the canvas's files"
    )
    expect(
      await refusal(
        publish({
          "canvas.json": canvas,
          "boards/home.html": '<iframe src="artifact:art_0000000000"></iframe>',
        })
      )
    ).toContain("Board 'home': boards/home.html frames 'artifact:art_0000000000'")
    expect(
      await refusal(
        publish({
          "canvas.json": canvas,
          "boards/home.html": "<main></main>",
          "__sixb/page.css": "",
        })
      )
    ).toContain("where Sixb serves the canvas's kit")
  })
})
