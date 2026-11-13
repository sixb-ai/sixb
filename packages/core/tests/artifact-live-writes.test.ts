import { describe, expect, test } from "bun:test"
import * as Y from "yjs"
import type { ArtifactFile, Principal, UpdateArtifactRuntimeInput } from "../src"
import { SixbHost } from "../src"
import { CANVAS_FILE, parseCanvas } from "../src/artifacts/canvas"
import { writeLiveArtifact } from "../src/artifacts/execution"
import { documentCanvas, documentFiles } from "../src/artifacts/live/document"
import { storeLiveFiles } from "../src/artifacts/live/files"
import { loadArtifactDocument } from "../src/artifacts/live/state"
import { mergeArtifactWrite, undoneTurnDocuments } from "../src/artifacts/publish/merge"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A canvas is written by many at once: a write made from an earlier revision is merged into what
// the latest version holds, as a diff against the files it was made from, never refused for it.
// Every write is made into the canvas's stored Yjs document, so live editors share its history.

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
  const artifacts = () => {
    const storage = deps.storage.artifacts
    if (!storage) throw new Error("Expected artifact storage.")
    return storage
  }
  const latest = async (id: string) => {
    const artifact = await artifacts().get({ projectId: "live-writes", id })
    const version =
      artifact &&
      (await artifacts().getVersion({
        projectId: "live-writes",
        artifactId: id,
        version: artifact.latestVersion,
      }))
    if (!artifact || !version) throw new Error(`Expected artifact ${id}.`)
    return { artifact, version }
  }
  /** The artifact's document as a server loads it to edit live. */
  const load = async (id: string) => {
    const { artifact, version } = await latest(id)
    return loadArtifactDocument(deps.blobStorage, artifact, version.files)
  }
  /** Writes a live editor's document back, as a server holding it does. */
  const writeBack = async (id: string, doc: Y.Doc, baseRevision: number) => {
    const { version } = await latest(id)
    return writeLiveArtifact(sixb.artifacts, id, {
      title: "Flow",
      baseTitle: "Flow",
      files: await storeLiveFiles(deps.blobStorage, documentFiles(doc), version.files),
      baseRevision,
      update: Y.encodeStateAsUpdate(doc),
    })
  }
  /** Applies what storage holds now to a live editor's document, as a server does on a write. */
  const follow = async (id: string, doc: Y.Doc) => {
    const { artifact } = await latest(id)
    if (!artifact.document) throw new Error("Expected the canvas to keep its document.")
    const stored = await load(id)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(stored))
  }
  /** Writes content as a writer that stores no document would, leaving the canvas's behind. */
  const writeWithout = async (id: string, files: readonly ArtifactFile[]) => {
    const { version } = await latest(id)
    const {
      projectId: _,
      artifactId: __,
      version: ___,
      revision: ____,
      createdAt: _____,
      ...content
    } = version
    return artifacts().publish({
      projectId: "live-writes",
      artifactId: id,
      kind: "canvas",
      version: { ...content, files, updatedAt: new Date() },
    })
  }
  return {
    deps,
    host,
    sixb,
    put,
    read,
    items,
    artifacts,
    latest,
    load,
    writeBack,
    follow,
    writeWithout,
  }
}

/** A note's words in a document. */
function noteText(doc: Y.Doc, id = "hi"): Y.Text {
  return documentCanvas(doc)?.items.get(id)?.get("text") as Y.Text
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

  // Reproduce by throwing at once in withMergedWrite instead of merging again: the save is refused
  // with artifact_moved, which a canvas's writer is never to see.
  test("is merged again when another write is stored between its merge and its store", async () => {
    const context = setup()
    const { files, published } = await canvas(context)
    const { id } = published.artifact

    // A save from revision 1 types in the note, while someone else's save, from revision 1 too,
    // moves it: the other one is stored as the first save's merge stores its files.
    const typed = await context.put({
      [CANVAS_FILE]: JSON.stringify({
        items: [
          board("welcome"),
          { id: "hi", type: "note", x: 0, y: 900, w: 200, text: "Hello, team" },
        ],
      }),
      "boards/welcome.html": WELCOME,
    })
    const moved = await context.put({
      [CANVAS_FILE]: JSON.stringify({
        items: [
          board("welcome"),
          { id: "hi", type: "note", x: 400, y: 900, w: 200, text: "Hello" },
        ],
      }),
      "boards/welcome.html": WELCOME,
    })

    const { blobStorage } = context.deps
    const put = blobStorage.put.bind(blobStorage)
    let other: Promise<unknown> | undefined
    blobStorage.put = async (input) => {
      if (!other) {
        other = context.sixb.artifacts.update(id, {
          kind: "canvas",
          title: "Flow",
          files: moved,
          baseRevision: 1,
          baseFiles: files,
        })
        await other
      }
      return put(input)
    }
    const written = await context.sixb.artifacts
      .update(id, {
        kind: "canvas",
        title: "Flow",
        files: typed,
        baseRevision: 1,
        baseFiles: files,
      })
      .finally(() => {
        blobStorage.put = put
      })

    expect(await other).toMatchObject({ version: { revision: 2 } })
    expect(written).toMatchObject({ merged: true, version: { revision: 3 } })
    expect(await context.items(written.version.files)).toContainEqual({
      id: "hi",
      type: "note",
      x: 400,
      y: 900,
      w: 200,
      text: "Hello, team",
    })
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
    const files = await context.put({ "regions.csv": "region,visits\nNorth,1284\n" })
    const { artifact } = await context.sixb.artifacts.create({
      kind: "file",
      title: "Regions",
      files,
    })
    await context.sixb.artifacts.update(artifact.id, {
      kind: "file",
      title: "Regions",
      files: await context.put({ "regions.csv": "region,visits\nNorth,1290\n" }),
    })

    const stale = await context.sixb.artifacts
      .update(artifact.id, {
        kind: "file",
        title: "Regions",
        files,
        baseRevision: 1,
        baseFiles: files,
      })
      .catch((error: unknown) => error)
    expect(stale).toMatchObject({ code: "artifact_moved" })
  })
})

describe("a designed document", () => {
  const html = (heading: string, fee: string) =>
    `<!doctype html><html><head><title>Plan</title></head><body><h1>${heading}</h1><p>A fixed fee of ${fee}.</p></body></html>`

  // Reproduce by making keepsDocument answer for a canvas alone: the designed document keeps no
  // document to edit live, and the stale save is refused with artifact_moved.
  test("keeps a document, and merges a write made from an earlier revision, as a canvas does", async () => {
    const context = setup()
    const files = await context.put({ "document.html": html("Service proposal", "$4,000") })
    const { artifact } = await context.sixb.artifacts.create({
      kind: "document",
      title: "Proposal",
      files,
    })
    expect((await context.latest(artifact.id)).artifact.document).toBeDefined()

    await context.sixb.artifacts.update(artifact.id, {
      kind: "document",
      title: "Proposal",
      files: await context.put({ "document.html": html("Service proposal", "$4,500") }),
    })
    const written = await context.sixb.artifacts.update(artifact.id, {
      kind: "document",
      title: "Proposal",
      files: await context.put({ "document.html": html("Repair proposal", "$4,000") }),
      baseRevision: 1,
      baseFiles: files,
    })

    expect(written).toMatchObject({ merged: true, version: { revision: 3 } })
    expect(await context.read(written.version.files, "document.html")).toBe(
      html("Repair proposal", "$4,500")
    )
  })
})

describe("a Markdown document", () => {
  // Reproduce by making keepsDocument answer for a canvas and a designed document alone: the
  // Markdown document keeps no document to edit live, and the stale save is refused as moved.
  test("keeps a document of its blocks, and merges a write made from an earlier revision", async () => {
    const context = setup()
    const plan = (lede: string, step: string) =>
      `# Pilot plan\n\n${lede}\n\n- Install the app\n- ${step}\n`
    const files = await context.put({ "document.md": plan("Three weeks in North.", "First job") })
    const { artifact } = await context.sixb.artifacts.create({
      kind: "document",
      title: "Pilot plan",
      files,
    })
    const doc = await context.load(artifact.id)
    expect(doc.getMap("files").get("document.md")).toBeInstanceOf(Y.XmlFragment)

    await context.sixb.artifacts.update(artifact.id, {
      kind: "document",
      title: "Pilot plan",
      files: await context.put({ "document.md": plan("Four weeks in North.", "First job") }),
    })
    const written = await context.sixb.artifacts.update(artifact.id, {
      kind: "document",
      title: "Pilot plan",
      files: await context.put({ "document.md": plan("Three weeks in North.", "First paid job") }),
      baseRevision: 1,
      baseFiles: files,
    })

    expect(written).toMatchObject({ merged: true, version: { revision: 3 } })
    expect(await context.read(written.version.files, "document.md")).toBe(
      plan("Four weeks in North.", "First paid job")
    )
  })
})

describe("a canvas's document", () => {
  // Guard proof: in mergeArtifactWrite, merge a live editor's files as a diff instead of applying
  // its update; the second write-back, made from a revision nothing kept, is then refused.
  test("is stored with each write, and editors on two servers merge as one history", async () => {
    const context = setup()
    const { published } = await canvas(context)
    const { id } = published.artifact
    expect(published.artifact.document).toBeDefined()

    // Two servers load it, and their editors type in the same note at once.
    const first = await context.load(id)
    const second = await context.load(id)
    noteText(first).insert(5, ", team")
    noteText(second).insert(0, "Oh. ")
    documentCanvas(second)?.items.get("hi")?.set("x", 400)

    await context.writeBack(id, first, 1)
    const merged = await context.writeBack(id, second, 1)
    expect(merged).toMatchObject({ merged: true, version: { revision: 3 } })
    expect(await context.items(merged.version.files)).toContainEqual({
      id: "hi",
      type: "note",
      x: 400,
      y: 900,
      w: 200,
      text: "Oh. Hello, team",
    })

    // Each takes back what storage holds, and holds the same.
    await context.follow(id, first)
    await context.follow(id, second)
    expect(noteText(first).toString()).toBe("Oh. Hello, team")
    expect(documentFiles(first)).toEqual(documentFiles(second))
    expect(documentFiles(await context.load(id))).toEqual(documentFiles(first))
  })

  test("is written back through the server's own entry, never the public update", async () => {
    // Reproduce by giving UpdateArtifactRuntimeInput its `document` back: the line marked below
    // type-checks, and an app's own Yjs state, from another history, is merged in place of the
    // files it passes. Or drop the kind check in writeLive: the document's write is stored, its files as they were.
    const context = setup()
    const { published } = await canvas(context)
    const plan = await context.sixb.artifacts.create({
      kind: "file",
      title: "Plan",
      files: await context.put({ "plan.txt": "Plan\n" }),
    })
    const doc = await context.load(published.artifact.id)

    const input: UpdateArtifactRuntimeInput = {
      kind: "canvas",
      title: "Flow",
      files: [],
      // @ts-expect-error A live document is the server's to write back, with writeLiveArtifact.
      document: Y.encodeStateAsUpdate(doc),
    }
    const refused = await writeLiveArtifact(context.sixb.artifacts, plan.artifact.id, {
      title: "Plan",
      baseTitle: "Plan",
      files: plan.version.files,
      baseRevision: plan.version.revision,
      update: Y.encodeStateAsUpdate(doc),
    }).catch((error: unknown) => error)

    expect(input.files).toEqual([])
    expect(refused).toMatchObject({ code: "invalid_artifact" })
  })

  test("takes a write of files between live edits as a change, keeping the editor's", async () => {
    const context = setup()
    const { published } = await canvas(context)
    const { id } = published.artifact
    const live = await context.load(id)
    noteText(live).insert(5, ", team")

    // Someone saves files over HTTP while the editor types: the board moves.
    const moved = await context.put({
      [CANVAS_FILE]: JSON.stringify({
        items: [
          board("welcome", 80),
          { id: "hi", type: "note", x: 0, y: 900, w: 200, text: "Hello" },
        ],
      }),
      "boards/welcome.html": WELCOME,
    })
    await context.sixb.artifacts.update(id, { kind: "canvas", title: "Flow", files: moved })
    await context.follow(id, live)
    expect(documentCanvas(live)?.items.get("welcome")?.get("x")).toBe(80)

    const written = await context.writeBack(id, live, 1)
    expect(await context.items(written.version.files)).toEqual([
      board("welcome", 80),
      { id: "hi", type: "note", x: 0, y: 900, w: 200, text: "Hello, team" },
    ])
  })

  // Guard proof: pass no document to restoreTo in ArtifactsRuntime.restore; storage then clears
  // the canvas's document, and the editor has none to follow.
  test("takes a restore and a retried turn's undo as changes a live editor follows", async () => {
    const context = setup()
    const { published } = await canvas(context)
    const { id } = published.artifact
    const live = await context.load(id)

    // An Agent turn moves the board, keeping a restore point of what it replaces.
    const turn = async (x: number, turnRunId: string) => {
      const { version } = await context.latest(id)
      const files = await context.put({
        [CANVAS_FILE]: JSON.stringify({
          items: [
            board("welcome", x),
            { id: "hi", type: "note", x: 0, y: 900, w: 200, text: "Hello" },
          ],
        }),
        "boards/welcome.html": WELCOME,
      })
      const write = await mergeArtifactWrite(
        {
          projectId: "live-writes",
          storage: context.artifacts(),
          blobStorage: context.deps.blobStorage,
        },
        { artifactId: id, kind: "canvas", files }
      )
      const {
        projectId: _,
        artifactId: __,
        version: ___,
        revision: ____,
        createdAt: _____,
        ...content
      } = version
      await context.artifacts().publish({
        projectId: "live-writes",
        artifactId: id,
        kind: "canvas",
        version: { ...content, files: write.files, updatedAt: new Date() },
        ...(write.baseRevision === undefined ? {} : { baseRevision: write.baseRevision }),
        turnRunId,
        ...(write.document ? { document: write.document } : {}),
      })
    }
    const x = async () => documentCanvas(live)?.items.get("welcome")?.get("x")

    await turn(160, "run_first")
    await context.follow(id, live)
    expect(await x()).toBe(160)

    // Restored to revision 1, then that restore undone: each is a change on the same history.
    await context.sixb.artifacts.restore(id, 1)
    await context.follow(id, live)
    expect(await x()).toBe(0)
    const [undo] = await context.artifacts().listRestorePoints({ projectId: "live-writes", id })
    await context.sixb.artifacts.restore(id, undo?.revision ?? 0)
    await context.follow(id, live)
    expect(await x()).toBe(160)

    // A turn's retry puts back what it replaced.
    await turn(240, "run_retried")
    await context.follow(id, live)
    const documents = await undoneTurnDocuments(
      {
        projectId: "live-writes",
        storage: context.artifacts(),
        blobStorage: context.deps.blobStorage,
      },
      "run_retried"
    )
    await context
      .artifacts()
      .undoTurnWrites({ projectId: "live-writes", turnRunId: "run_retried", documents })
    await context.follow(id, live)
    expect(await x()).toBe(160)
    expect(documentFiles(live)).toEqual(documentFiles(await context.load(id)))
  })

  test("of a canvas that kept none yet is built the same by every server that loads it", async () => {
    const context = setup()
    const { files, published } = await canvas(context)
    const {
      projectId: _,
      artifactId: __,
      version: ___,
      revision: ____,
      createdAt: _____,
      ...content
    } = published.version

    // As a canvas written before documents were kept.
    const { artifact } = await context.artifacts().create({
      projectId: "live-writes",
      id: "art_legacy",
      kind: "canvas",
      owner: alice,
      version: { ...content, files },
    })
    expect(artifact).not.toHaveProperty("document")

    const first = await context.load(artifact.id)
    const second = await context.load(artifact.id)
    expect(Y.encodeStateAsUpdate(first)).toEqual(Y.encodeStateAsUpdate(second))

    noteText(first).insert(5, ", team")
    noteText(second).insert(0, "Oh. ")
    await context.writeBack(artifact.id, first, 1)
    const merged = await context.writeBack(artifact.id, second, 1)
    expect(await context.items(merged.version.files)).toContainEqual(
      expect.objectContaining({ id: "hi", text: "Oh. Hello, team" })
    )
  })

  // Guard proof: in loadArtifactDocument, use a stored document whatever revision it holds; the
  // board the write moved stays where it was, for every editor and in the next write.
  test("left behind by a write that stored none is brought up to the content, losing nothing", async () => {
    const context = setup()
    const { published } = await canvas(context)
    const { id } = published.artifact
    const live = await context.load(id)
    noteText(live).insert(5, ", team")

    // A writer that stores no document, as a server from before them, moves the board.
    const moved = await context.writeWithout(
      id,
      await context.put({
        [CANVAS_FILE]: JSON.stringify({
          items: [
            board("welcome", 80),
            { id: "hi", type: "note", x: 0, y: 900, w: 200, text: "Hello" },
          ],
        }),
        "boards/welcome.html": WELCOME,
      })
    )
    expect(moved.artifact).toMatchObject({ revision: 2, document: { revision: 1 } })

    // Every server brings it up the same way, and the editor's change stays with the write's.
    const first = await context.load(id)
    expect(Y.encodeStateAsUpdate(first)).toEqual(Y.encodeStateAsUpdate(await context.load(id)))
    expect(documentCanvas(first)?.items.get("welcome")?.get("x")).toBe(80)
    await context.follow(id, live)
    expect(documentCanvas(live)?.items.get("welcome")?.get("x")).toBe(80)
    expect(noteText(live).toString()).toBe("Hello, team")

    // The next write stores the document again, at its revision.
    const written = await context.writeBack(id, live, 2)
    expect(written.artifact.document?.revision).toBe(written.artifact.revision)
    expect(await context.items(written.version.files)).toEqual([
      board("welcome", 80),
      { id: "hi", type: "note", x: 0, y: 900, w: 200, text: "Hello, team" },
    ])
    expect(documentFiles(await context.load(id))).toEqual(documentFiles(live))
  })
})
