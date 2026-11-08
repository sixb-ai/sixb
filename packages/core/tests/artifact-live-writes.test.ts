import { describe, expect, test } from "bun:test"
import type { ArtifactFile, Principal } from "../src"
import { SixbHost } from "../src"
import { CANVAS_FILE, parseCanvas } from "../src/artifacts/canvas"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A canvas is written by many at once: a write made from an earlier revision is merged into what
// the latest version holds, as a diff against the files it was made from, never refused for it.

const alice: Principal = { type: "user", id: "alice" }

const board = (id: string, x = 0) => ({
  id,
  type: "board" as const,
  file: `boards/${id}.html`,
  x,
  y: 0,
  w: 390,
  h: 844,
})

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ id: "live-writes", ontology: [], ...deps })
  const sixb = createTestSixb(host, {
    authorization: { principal: alice, groupIds: [], roleIds: [], grants: emptyGrantIndex() },
  })
  const put = async (contents: Record<string, string>): Promise<ArtifactFile[]> =>
    Promise.all(
      Object.entries(contents).map(async ([path, body]) => ({
        path,
        file: await deps.blobStorage.put({ body: new TextEncoder().encode(body), fileName: path }),
      }))
    )
  const read = async (files: readonly ArtifactFile[], path: string) => {
    const file = files.find((entry) => entry.path === path)
    if (!file) throw new Error(`Expected ${path}.`)
    return new Response(await deps.blobStorage.open(file.file.blobId)).text()
  }
  const items = async (files: readonly ArtifactFile[]) => {
    const parsed = parseCanvas(await read(files, CANVAS_FILE))
    if (!("canvas" in parsed)) throw new Error(parsed.error)
    return parsed.canvas.items
  }
  return { deps, host, sixb, put, read, items }
}

const WELCOME = "<main>\n  <h1>Welcome</h1>\n  <p>Pick a region.</p>\n</main>\n"

async function canvas(context: ReturnType<typeof setup>) {
  const files = await context.put({
    [CANVAS_FILE]: JSON.stringify({
      items: [board("welcome"), { id: "hi", type: "note", x: 0, y: 900, w: 200, text: "Hello" }],
    }),
    "boards/welcome.html": WELCOME,
  })
  return {
    files,
    published: await context.sixb.artifacts.create({ kind: "canvas", title: "Flow", files }),
  }
}

describe("a write to a canvas made from an earlier revision", () => {
  // Reproduce by dropping `withMergedWrite` from ArtifactsRuntime.update: the stale save is
  // refused with artifact_moved.
  test("is merged into what was written since, and says so", async () => {
    const context = setup()
    const { files, published } = await canvas(context)
    const { id } = published.artifact

    // Someone moves the note and edits the board's paragraph.
    const moved = await context.put({
      [CANVAS_FILE]: JSON.stringify({
        items: [
          board("welcome"),
          { id: "hi", type: "note", x: 400, y: 900, w: 200, text: "Hello" },
        ],
      }),
      "boards/welcome.html": WELCOME.replace("Pick a region.", "Pick a region near you."),
    })
    await context.sixb.artifacts.update(id, { kind: "canvas", title: "Flow", files: moved })

    // A save made from revision 1 retitles the board and types in the note.
    const stale = await context.put({
      [CANVAS_FILE]: JSON.stringify({
        items: [
          { ...board("welcome"), title: "Start" },
          { id: "hi", type: "note", x: 0, y: 900, w: 200, text: "Hello, team" },
        ],
      }),
      "boards/welcome.html": WELCOME.replace("Welcome", "Hi"),
    })
    const written = await context.sixb.artifacts.update(id, {
      kind: "canvas",
      title: "Flow",
      files: stale,
      baseRevision: 1,
      baseFiles: files,
    })

    expect(written).toMatchObject({ merged: true, version: { version: 1, revision: 3 } })
    expect(await context.items(written.version.files)).toEqual([
      { ...board("welcome"), title: "Start" },
      { id: "hi", type: "note", x: 400, y: 900, w: 200, text: "Hello, team" },
    ])
    expect(await context.read(written.version.files, "boards/welcome.html")).toBe(
      "<main>\n  <h1>Hi</h1>\n  <p>Pick a region near you.</p>\n</main>\n"
    )
  })

  test("finds the files of its base among the artifact's versions and restore points", async () => {
    const context = setup()
    const { published } = await canvas(context)
    const { id } = published.artifact
    await context.sixb.artifacts.freeze(id)
    const moved = await context.put({
      [CANVAS_FILE]: JSON.stringify({
        items: [
          board("welcome", 40),
          { id: "hi", type: "note", x: 0, y: 900, w: 200, text: "Hello" },
        ],
      }),
      "boards/welcome.html": WELCOME,
    })
    await context.sixb.artifacts.update(id, { kind: "canvas", title: "Flow", files: moved })

    // Made from the frozen version 1, at revision 2.
    const stale = await context.put({
      [CANVAS_FILE]: JSON.stringify({
        items: [board("welcome"), { id: "hi", type: "note", x: 0, y: 900, w: 200, text: "Bye" }],
      }),
      "boards/welcome.html": WELCOME,
    })
    const written = await context.sixb.artifacts.update(id, {
      kind: "canvas",
      title: "Flow",
      files: stale,
      baseRevision: 2,
    })
    expect(written.merged).toBe(true)
    expect(
      (await context.items(written.version.files)).map((item) =>
        "x" in item ? [item.id, item.x] : []
      )
    ).toEqual([
      ["welcome", 40],
      ["hi", 0],
    ])
  })

  test("is refused as moved when nothing holds its base any more, and as invalid when the merge is", async () => {
    const context = setup()
    const { files, published } = await canvas(context)
    const { id } = published.artifact
    const write = (text: string, baseRevision: number, baseFiles?: readonly ArtifactFile[]) =>
      context
        .put({
          [CANVAS_FILE]: JSON.stringify({
            items: [board("welcome"), { id: "hi", type: "note", x: 0, y: 900, w: 200, text }],
          }),
          "boards/welcome.html": WELCOME,
        })
        .then((next) =>
          context.sixb.artifacts.update(id, {
            kind: "canvas",
            title: "Flow",
            files: next,
            baseRevision,
            ...(baseFiles ? { baseFiles } : {}),
          })
        )

    // Revision 1's files are replaced, and nothing kept them: a save from it cannot be merged.
    await write("Hello again", 1)
    expect(await write("Bye", 1).catch((error: unknown) => error)).toMatchObject({
      code: "artifact_moved",
    })

    // Both made the note longer: merged, its words pass what a note holds.
    await write("x".repeat(1_990), 2)
    const refused = await write(`Hello${"y".repeat(100)}`, 1, files).catch(
      (error: unknown) => error
    )
    expect(refused).toMatchObject({ code: "invalid_artifact" })
    expect(String((refused as Error).message)).toContain("note 'hi' \"text\"")
  })
})

describe("a write to another kind made from an earlier revision", () => {
  test("is refused as moved, as before", async () => {
    const context = setup()
    const files = await context.put({ "document.md": "# Plan\n" })
    const { artifact } = await context.sixb.artifacts.create({
      kind: "document",
      title: "Plan",
      files,
    })
    await context.sixb.artifacts.update(artifact.id, {
      kind: "document",
      title: "Plan",
      files: await context.put({ "document.md": "# Plan, 2\n" }),
    })

    const stale = await context.sixb.artifacts
      .update(artifact.id, {
        kind: "document",
        title: "Plan",
        files,
        baseRevision: 1,
        baseFiles: files,
      })
      .catch((error: unknown) => error)
    expect(stale).toMatchObject({ code: "artifact_moved" })
  })
})
