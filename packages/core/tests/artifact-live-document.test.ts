import { describe, expect, test } from "bun:test"
import * as Y from "yjs"
import { CANVAS_FILE, formatCanvas, parseCanvas } from "../src/artifacts/canvas"
import {
  diffSequences,
  diffText,
  interleave,
  mergeSequences,
  mergeText,
} from "../src/artifacts/live/diff"
import {
  createArtifactDocument,
  documentCanvas,
  documentFiles,
  type LiveFile,
  type LiveFiles,
  mergeIntoDocument,
  patchText,
} from "../src/artifacts/live/document"
import type { FileRef } from "../src/blob-storage/types"

/** A deterministic sequence of numbers in [0, 1). */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 48_271) % 2_147_483_647
    return state / 2_147_483_647
  }
}

function applyHunks<T>(a: readonly T[], b: readonly T[]): T[] {
  const out: T[] = []
  let at = 0
  for (const hunk of diffSequences(a, b)) {
    out.push(...a.slice(at, hunk.aStart), ...b.slice(hunk.bStart, hunk.bEnd))
    at = hunk.aEnd
  }
  return [...out, ...a.slice(at)]
}

function applyEdits(from: string, to: string): string {
  let out = ""
  let at = 0
  for (const edit of diffText(from, to)) {
    out += from.slice(at, edit.start) + edit.insert
    at = edit.end
  }
  return out + from.slice(at)
}

const ref = (seed: string): FileRef => ({
  blobId: `blob_${seed.repeat(64).slice(0, 64)}`,
  digest: `sha256:${seed.repeat(64).slice(0, 64)}`,
  sizeBytes: 3,
  mediaType: "image/png",
})

const board = (id: string, x: number) => ({
  id,
  type: "board" as const,
  file: `boards/${id}.html`,
  x,
  y: 0,
  w: 390,
  h: 844,
})

/** A canvas's files: canvas.json with `items`, each board's HTML, and a logo. */
function canvasFiles(
  items: readonly Record<string, unknown>[],
  html: Record<string, string> = {}
): LiveFiles {
  const parsed = parseCanvas(JSON.stringify({ items }))
  if (!("canvas" in parsed)) throw new Error(parsed.error)
  return new Map<string, LiveFile>([
    [CANVAS_FILE, { text: formatCanvas(parsed.canvas) }],
    ...Object.entries(html).map(([path, text]): [string, LiveFile] => [path, { text }]),
    ["logo.png", { file: ref("a") }],
  ])
}

function canvasOf(files: LiveFiles) {
  const file = files.get(CANVAS_FILE)
  if (!file || !("text" in file)) throw new Error("Expected canvas.json as text.")
  const parsed = parseCanvas(file.text)
  if (!("canvas" in parsed)) throw new Error(parsed.error)
  return parsed.canvas.items
}

function textAt(files: LiveFiles, path: string): string {
  const file = files.get(path)
  if (!file || !("text" in file)) throw new Error(`Expected ${path} as text.`)
  return file.text
}

/** Two documents of one artifact, kept in step by their updates, as two editors' are. */
function pair(files: LiveFiles) {
  const left = createArtifactDocument("canvas", files)
  const right = new Y.Doc()
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
  const sync = () => {
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left, Y.encodeStateVector(right)))
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right, Y.encodeStateVector(left)))
  }
  return { left, right, sync }
}

describe("a sequence diff", () => {
  test("turns one sequence into the other, by a shortest script", () => {
    const next = random(7)
    for (let trial = 0; trial < 2_000; trial += 1) {
      const word = () =>
        Array.from({ length: Math.floor(next() * 14) }, () => "abc"[Math.floor(next() * 3)] ?? "a")
      const [a, b] = [word(), word()]
      expect(applyHunks(a, b)).toEqual(b)
    }
    // One change in the middle is one hunk.
    expect(diffSequences([..."abcdef"], [..."abXdef"])).toEqual([
      { aStart: 2, aEnd: 3, bStart: 2, bEnd: 3 },
    ])
  })

  test("turns one text into the other by edits narrowed to the characters that changed", () => {
    const next = random(11)
    for (let trial = 0; trial < 1_000; trial += 1) {
      const line = () =>
        Array.from(
          { length: Math.floor(next() * 5) },
          () => "ab"[Math.floor(next() * 2)] ?? "a"
        ).join("")
      const text = () => Array.from({ length: Math.floor(next() * 6) }, line).join("\n")
      const [from, to] = [text(), text()]
      expect(applyEdits(from, to)).toBe(to)
    }
    expect(
      diffText('<h1 class="a">Hi</h1>\n<p>One</p>\n', '<h1 class="b">Hi</h1>\n<p>One</p>\n')
    ).toEqual([{ start: 11, end: 12, insert: "b" }])
  })
})

describe("a three-way text merge", () => {
  test("takes what one side changed, and what both changed alike once", () => {
    expect(mergeText("a\nb\n", "a\nB\n", "a\nb\n")).toBe("a\nB\n")
    expect(mergeText("a\nb\n", "a\nb\n", "a\nB\n")).toBe("a\nB\n")
    expect(mergeText("a\nb\nc\n", "a\nB\nc\n", "a\nB\nc\n")).toBe("a\nB\nc\n")
  })

  test("keeps both sides' changes to different lines, and to one line's different characters", () => {
    expect(mergeText("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n")).toBe("A\nb\nC\n")
    expect(mergeText("hello world\n", "hello brave world\n", "hello world!\n")).toBe(
      "hello brave world!\n"
    )
  })

  test("keeps both sides' words typed at one place, ours first, and both sides' deletions", () => {
    expect(mergeText("abc", "abXc", "abYc")).toBe("abXYc")
    expect(mergeText("abcdef", "abef", "abcdeZf")).toBe("abeZf")
  })

  test("merges sequences of ids the same way, deciding conflicts as concurrent edits", () => {
    const merged = mergeSequences(["a", "b", "c"], ["a", "c"], ["a", "b", "c", "d"], interleave)
    expect(merged).toEqual(["a", "c", "d"])
  })
})

describe("an artifact's document", () => {
  test("holds an artifact's files as text, references, and a canvas's items, and gives them back", () => {
    const files = canvasFiles(
      [board("welcome", 0), { id: "hi", type: "note", x: 0, y: 900, w: 200, text: "Hello" }],
      {
        "boards/welcome.html": "<main>Welcome</main>\n",
      }
    )
    const doc = createArtifactDocument("canvas", files)

    expect(documentFiles(doc)).toEqual(new Map(files))
    const canvas = documentCanvas(doc)
    expect(canvas?.order.toArray()).toEqual(["welcome", "hi"])
    expect(canvas?.items.get("hi")?.get("text")).toBeInstanceOf(Y.Text)
    expect(doc.getMap("files").get("boards/welcome.html")).toBeInstanceOf(Y.Text)
  })

  test("holds a canvas.json that does not parse as text, so nothing is lost", () => {
    const doc = createArtifactDocument("canvas", new Map([[CANVAS_FILE, { text: "{ nope" }]]))
    expect(documentCanvas(doc)).toBeNull()
    expect(documentFiles(doc).get(CANVAS_FILE)).toEqual({ text: "{ nope" })
  })

  test("is the same document for every kind but a canvas's structured file", () => {
    const doc = createArtifactDocument("page", new Map([[CANVAS_FILE, { text: '{"items":[]}' }]]))
    expect(doc.getMap("files").get(CANVAS_FILE)).toBeInstanceOf(Y.Text)
  })
})

describe("merging files into a document", () => {
  const base = canvasFiles(
    [
      board("welcome", 0),
      board("region", 480),
      { id: "hi", type: "note", x: 0, y: 900, w: 200, text: "Hello" },
    ],
    {
      "boards/welcome.html": "<main>\n  <h1>Welcome</h1>\n  <p>Pick a region.</p>\n</main>\n",
      "boards/region.html": "<main><h1>Regions</h1></main>\n",
    }
  )

  test("gives `next` back when nothing else changed", () => {
    const doc = createArtifactDocument("canvas", base)
    const next = canvasFiles([board("welcome", 40), board("pricing", 960)], {
      "boards/welcome.html": "<main>\n  <h1>Hello</h1>\n</main>\n",
      "boards/pricing.html": "<main>Pricing</main>\n",
    })
    mergeIntoDocument(doc, base, next)
    expect(documentFiles(doc)).toEqual(new Map(next))
  })

  // Reproduce by setting a changed text whole in mergeIntoDocument: the person's paragraph goes.
  test("keeps a person's edit to a board the agent changed elsewhere in", () => {
    const { left: person, right: server, sync } = pair(base)
    const paragraph = documentFiles(person)
    const html = person.getMap("files").get("boards/welcome.html") as Y.Text
    patchText(
      html,
      textAt(paragraph, "boards/welcome.html").replace("Pick a region.", "Pick a region near you.")
    )

    // The agent rewrote the heading from the version it started from.
    const next = new Map(base)
    next.set("boards/welcome.html", {
      text: "<main>\n  <h1>Welcome back</h1>\n  <p>Pick a region.</p>\n</main>\n",
    })
    mergeIntoDocument(server, base, next)
    sync()

    const merged = "<main>\n  <h1>Welcome back</h1>\n  <p>Pick a region near you.</p>\n</main>\n"
    expect(textAt(documentFiles(person), "boards/welcome.html")).toBe(merged)
    expect(textAt(documentFiles(server), "boards/welcome.html")).toBe(merged)
  })

  test("keeps both when a person and the agent change the same line", () => {
    const doc = createArtifactDocument("canvas", base)
    const html = doc.getMap("files").get("boards/region.html") as Y.Text
    patchText(html, "<main><h1>Regions near you</h1></main>\n")
    const next = new Map(base)
    next.set("boards/region.html", { text: "<main><h1>All regions</h1></main>\n" })

    mergeIntoDocument(doc, base, next)
    expect(textAt(documentFiles(doc), "boards/region.html")).toBe(
      "<main><h1>All regions near you</h1></main>\n"
    )
  })

  // Reproduce by replacing canvas.json whole in mergeIntoDocument: the note's words go.
  test("keeps a note typed in while another moves it, and a board the agent moved", () => {
    const { left: person, right: other, sync } = pair(base)
    const note = documentCanvas(person)?.items.get("hi")
    ;(note?.get("text") as Y.Text).insert(5, ", team")
    documentCanvas(other)?.items.get("hi")?.set("x", 320)
    sync()

    // Meanwhile the agent moved a board and retitled the region board, from the base.
    const next = canvasFiles(
      [
        board("welcome", 0),
        { ...board("region", 520), title: "Regions" },
        { id: "hi", type: "note", x: 0, y: 900, w: 200, text: "Hello" },
      ],
      Object.fromEntries(
        [...base].flatMap(([path, file]) =>
          path.endsWith(".html") && "text" in file ? [[path, file.text]] : []
        )
      )
    )
    mergeIntoDocument(other, base, next)
    sync()

    for (const doc of [person, other]) {
      const items = canvasOf(documentFiles(doc))
      expect(items.find((item) => item.id === "hi")).toMatchObject({ x: 320, text: "Hello, team" })
      expect(items.find((item) => item.id === "region")).toMatchObject({ x: 520, title: "Regions" })
    }
  })

  test("adds and deletes items, keeps an item someone added, and keeps the order both changed", () => {
    const doc = createArtifactDocument("canvas", base)
    const canvas = documentCanvas(doc)
    canvas?.items.set(
      "todo",
      new Y.Map(
        Object.entries({
          id: "todo",
          type: "note",
          x: 0,
          y: 1200,
          w: 200,
          text: new Y.Text("Ship"),
        })
      )
    )
    canvas?.order.push(["todo"])

    const next = canvasFiles([board("region", 480), board("welcome", 0), board("pricing", 960)], {
      "boards/welcome.html": textAt(base, "boards/welcome.html"),
      "boards/region.html": textAt(base, "boards/region.html"),
      "boards/pricing.html": "<main>Pricing</main>\n",
    })
    mergeIntoDocument(doc, base, next)

    const items = canvasOf(documentFiles(doc))
    expect(items.map((item) => item.id)).toEqual(["region", "welcome", "pricing", "todo"])
    expect(documentFiles(doc).has("boards/pricing.html")).toBe(true)
  })

  test("drops an arrow whose item another deleted while it was drawn", () => {
    const { left: person, right: other, sync } = pair(base)
    const canvas = documentCanvas(person)
    canvas?.items.set(
      "go",
      new Y.Map(
        Object.entries({ id: "go", type: "arrow", from: "welcome", to: "region", dashed: false })
      )
    )
    canvas?.order.push(["go"])
    documentCanvas(other)?.items.delete("region")
    documentCanvas(other)?.order.delete(1, 1)
    sync()

    expect(canvasOf(documentFiles(person)).map((item) => item.id)).toEqual(["welcome", "hi"])
  })

  test("replaces a binary file, deletes a removed one, and takes `next` for a file both added", () => {
    const doc = createArtifactDocument("canvas", base)
    doc.getMap("files").set("notes.md", new Y.Text("Mine\n"))

    const next = new Map(base)
    next.set("logo.png", { file: ref("b") })
    next.delete("boards/region.html")
    next.set("notes.md", { text: "Theirs\n" })
    mergeIntoDocument(doc, base, next)

    const files = documentFiles(doc)
    expect(files.get("logo.png")).toEqual({ file: ref("b") })
    expect(files.has("boards/region.html")).toBe(false)
    expect(files.get("notes.md")).toEqual({ text: "Theirs\n" })
  })

  test("is idempotent: merging the same change twice changes nothing more", () => {
    const doc = createArtifactDocument("canvas", base)
    const next = new Map(base)
    next.set("boards/region.html", { text: "<main><h1>Regions, by city</h1></main>\n" })
    mergeIntoDocument(doc, base, next)
    mergeIntoDocument(doc, base, next)
    expect(textAt(documentFiles(doc), "boards/region.html")).toBe(
      "<main><h1>Regions, by city</h1></main>\n"
    )
  })

  test("converges when editors change one board at once and one of them merges the agent's diff", () => {
    const { left, right, sync } = pair(base)
    const leftHtml = left.getMap("files").get("boards/welcome.html") as Y.Text
    const rightHtml = right.getMap("files").get("boards/welcome.html") as Y.Text
    leftHtml.insert(0, "<!-- left -->\n")
    rightHtml.insert(rightHtml.length, "<!-- right -->\n")
    const next = new Map(base)
    next.set("boards/welcome.html", {
      text: textAt(base, "boards/welcome.html").replace("Welcome", "Hi"),
    })
    mergeIntoDocument(right, base, next)
    sync()

    expect(documentFiles(left)).toEqual(documentFiles(right))
    expect(textAt(documentFiles(left), "boards/welcome.html")).toBe(
      "<!-- left -->\n<main>\n  <h1>Hi</h1>\n  <p>Pick a region.</p>\n</main>\n<!-- right -->\n"
    )
  })
})
