import { afterEach, describe, expect, jest, test } from "bun:test"
import { type Canvas, type CanvasItem, formatCanvas } from "@sixb/core/artifacts"
import { LIVE_FILES } from "@sixb/core/artifacts/live"
import * as Y from "yjs"
import { LiveCanvas, liveCanvasOf } from "../src/artifacts/live/canvas"
import { type LiveArtifact, LiveHub, type LiveKeeper } from "../src/artifacts/live/session"
import { moveItems, setItemText } from "../src/artifacts/renderers/canvas/draft"
import { canvasGraph } from "../src/artifacts/renderers/canvas/layout"
import {
  canvasOf,
  type FakeConnection,
  FakeServer,
  settle,
  storedDocument,
} from "./helpers/live-server"

const ARTIFACT = "art_c4nv4s0000"

const CANVAS = canvasOf({
  items: [
    { id: "home", type: "board", file: "boards/home.html", x: 0, y: 0, w: 390, h: 400 },
    { id: "pay", type: "board", file: "boards/pay.html", x: 520, y: 0, w: 390, h: 400 },
    { id: "next", type: "arrow", from: "home", to: "pay", label: "Continue" },
    { id: "ask", type: "note", x: 0, y: 560, w: 260, text: "Annual first?" },
  ],
})

const held: { hub: LiveHub; artifact: LiveArtifact }[] = []

/** One tab holding the artifact live through its own hub. */
/** A page's local storage, shared by the tabs and reloads of one test. */
function memoryKeeper(): LiveKeeper & { readonly kept: Map<string, Uint8Array> } {
  const kept = new Map<string, Uint8Array>()
  return {
    kept,
    read: (id) => kept.get(id) ?? null,
    write: (id, update) => kept.set(id, update),
    clear: (id) => kept.delete(id),
  }
}

function tab(
  server: FakeServer,
  keeper: LiveKeeper = memoryKeeper()
): {
  readonly hub: LiveHub
  readonly artifact: LiveArtifact
  readonly canvas: () => LiveCanvas
  readonly connection: () => FakeConnection
} {
  let connection: FakeConnection | undefined
  const hub = new LiveHub((handlers) => {
    const socket = server.open(handlers) as FakeConnection
    connection = socket
    return socket
  }, keeper)
  const artifact = hub.acquire(ARTIFACT)
  held.push({ hub, artifact })
  return {
    hub,
    artifact,
    canvas: () => liveCanvasOf(artifact),
    connection: () => {
      if (!connection) throw new Error("No connection opened.")
      return connection
    },
  }
}

const item = (canvas: Canvas | null, id: string) =>
  canvas?.items.find((entry) => entry.id === id) as CanvasItem & { x: number; y: number }

afterEach(() => {
  for (const { artifact } of held.splice(0)) artifact.destroy()
})

describe("a live artifact", () => {
  test("joins, takes the document from the server, and sends its changes to the others", async () => {
    // Reproduce by dropping sync step 1 from `joined` in session.ts: the document never fills.
    const server = new FakeServer(ARTIFACT, CANVAS)
    const alice = tab(server)
    const bob = tab(server)
    await settle()

    expect(alice.artifact.getState()).toMatchObject({ access: "edit", synced: true })
    expect(
      alice
        .canvas()
        .getCanvas()
        ?.items.map((entry) => entry.id)
    ).toEqual(CANVAS.items.map((entry) => entry.id))

    alice.canvas().apply(moveItems(new Map([["ask", { x: 400, y: 600 }]])))
    await settle()
    expect(item(bob.canvas().getCanvas(), "ask")).toMatchObject({ x: 400, y: 600 })
    expect(alice.artifact.getState().pending).toBe(true)
  })

  test("keeps its document across a reconnect, and the server gets what changed meanwhile", async () => {
    // Reproduce by making a new document on reconnect, or by not sending sync step 1 on `joined`:
    // what Alice changed while offline never reaches Bob.
    const server = new FakeServer(ARTIFACT, CANVAS)
    const alice = tab(server)
    const bob = tab(server)
    await settle()
    const document = alice.artifact.doc

    alice.connection().drop()
    expect(alice.artifact.getState().connection).toBe("offline")
    alice.canvas().apply(moveItems(new Map([["ask", { x: 80, y: 900 }]])))
    bob.canvas().apply(moveItems(new Map([["home", { x: -200, y: 0 }]])))
    await settle()
    expect(item(bob.canvas().getCanvas(), "ask")).toMatchObject({ x: 0, y: 560 })

    alice.connection().connect()
    await settle()
    expect(alice.artifact.doc).toBe(document)
    expect(alice.artifact.getState().connection).toBe("online")
    for (const each of [alice, bob]) {
      expect(item(each.canvas().getCanvas(), "ask")).toMatchObject({ x: 80, y: 900 })
      expect(item(each.canvas().getCanvas(), "home")).toMatchObject({ x: -200, y: 0 })
    }
  })

  test("keeps what changed offline after its view went away, until the server took it", async () => {
    // Reproduce by leaving an artifact LINGER_MS after its last view whatever it holds: the view
    // that comes back after the outage gets a new document, and Alice's move is lost.
    jest.useFakeTimers()
    try {
      const server = new FakeServer(ARTIFACT, CANVAS)
      const alice = tab(server)
      const bob = tab(server)
      await settle()

      alice.connection().drop()
      alice.canvas().apply(moveItems(new Map([["ask", { x: 80, y: 900 }]])))
      // The view goes away during the outage, and long enough for the artifact to be left.
      alice.hub.release(alice.artifact)
      jest.advanceTimersByTime(60_000)
      expect(alice.hub.acquire(ARTIFACT)).toBe(alice.artifact)
      alice.hub.release(alice.artifact)

      alice.connection().connect()
      await settle()
      expect(item(bob.canvas().getCanvas(), "ask")).toMatchObject({ x: 80, y: 900 })

      // Once the server says it saved, nothing keeps it.
      alice
        .connection()
        .deliver({ type: "status", artifactId: ARTIFACT, state: "saved", revision: 2 })
      await settle()
      jest.advanceTimersByTime(60_000)
      const again = alice.hub.acquire(ARTIFACT)
      held.push({ hub: alice.hub, artifact: again })
      expect(again).not.toBe(alice.artifact)
    } finally {
      jest.useRealTimers()
    }
  })

  test("keeps what changed offline across a reload, and forgets it once the server saved it", async () => {
    // Reproduce by dropping the keeper from LiveArtifact: the page reloaded during the outage
    // starts from the server's document, and Alice's move is lost.
    const server = new FakeServer(ARTIFACT, CANVAS)
    const keeper = memoryKeeper()
    const alice = tab(server, keeper)
    const bob = tab(server)
    await settle()

    alice.connection().drop()
    alice.canvas().apply(moveItems(new Map([["ask", { x: 80, y: 900 }]])))
    expect(keeper.kept.has(ARTIFACT)).toBe(true)

    // The page reloads while the server is away: a new hub, a new document.
    const reloaded = tab(server, keeper)
    await settle()
    expect(reloaded.artifact.doc).not.toBe(alice.artifact.doc)
    expect(item(reloaded.canvas().getCanvas(), "ask")).toMatchObject({ x: 80, y: 900 })
    expect(item(bob.canvas().getCanvas(), "ask")).toMatchObject({ x: 80, y: 900 })

    reloaded
      .connection()
      .deliver({ type: "status", artifactId: ARTIFACT, state: "saved", revision: 2 })
    await settle()
    expect(keeper.kept.has(ARTIFACT)).toBe(false)
  })

  test("sends nothing once it may only watch, and leaves when the server says so", async () => {
    // Reproduce by sending every change in session.ts whatever the access: the server takes
    // Alice's move after she lost the right to make it.
    const server = new FakeServer(ARTIFACT, CANVAS)
    const alice = tab(server)
    await settle()

    alice.connection().deliver({ type: "access", artifactId: ARTIFACT, access: "watch" })
    await settle()
    expect(alice.artifact.getState().access).toBe("watch")
    alice.canvas().apply(moveItems(new Map([["ask", { x: 400, y: 600 }]])))
    await settle()
    expect(alice.connection().sent.filter((message) => message.type === "sync")).toHaveLength(2)
    expect(formatCanvas(storedCanvas(server.doc))).toBe(formatCanvas(CANVAS))

    alice.connection().deliver({ type: "left", artifactId: ARTIFACT, reason: "not_shared" })
    await settle()
    expect(alice.artifact.getState().left).toBe("not_shared")
    // A reconnect joins nothing it was told to leave.
    const joins = alice.connection().sent.filter((message) => message.type === "join").length
    alice.connection().drop()
    alice.connection().connect()
    await settle()
    expect(alice.connection().sent.filter((message) => message.type === "join")).toHaveLength(joins)
  })
})

/** The canvas a document holds, read back as `canvas.json` would be. */
function storedCanvas(doc: Y.Doc): Canvas {
  const structure = doc.getMap<Y.Map<unknown>>(LIVE_FILES).get("canvas.json") as Y.Map<unknown>
  const items = structure.get("items") as Y.Map<Y.Map<unknown>>
  const order = (structure.get("order") as Y.Array<string>).toArray()
  return canvasOf({
    items: order.map((id) => {
      const entry: Record<string, unknown> = {}
      ;(items.get(id) as Y.Map<unknown>).forEach((value, key) => {
        entry[key] = value instanceof Y.Text ? value.toString() : value
      })
      return entry
    }),
  })
}

/** Two readers' documents of one canvas, each change sent to the other at once. */
function pair(): { readonly alice: LiveCanvas; readonly bob: LiveCanvas } {
  const first = storedDocument(CANVAS)
  const second = new Y.Doc()
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
  first.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "peer") Y.applyUpdate(second, update, "peer")
  })
  second.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "peer") Y.applyUpdate(first, update, "peer")
  })
  return { alice: new LiveCanvas(first), bob: new LiveCanvas(second) }
}

describe("a live canvas", () => {
  test("reads again only the items a change touched, so the board draws only those", () => {
    // Reproduce by reading every item at each change in LiveCanvas.rebuild: the board draws all
    // the canvas's items again for one note someone else moved.
    const { alice, bob } = pair()
    const before = alice.getCanvas() as Canvas
    const graph = canvasGraph(before)

    bob.apply(moveItems(new Map([["ask", { x: 400, y: 600 }]])))
    const after = alice.getCanvas() as Canvas
    expect(after).not.toBe(before)
    for (const [index, entry] of after.items.entries()) {
      if (entry.id === "ask") expect(entry).not.toBe(before.items[index])
      else expect(entry).toBe(before.items[index] as CanvasItem)
    }
    const next = canvasGraph(after)
    const node = (nodes: typeof graph.nodes, id: string) => nodes.find((entry) => entry.id === id)
    expect(node(next.nodes, "home")).toBe(node(graph.nodes, "home"))
    expect(node(next.nodes, "ask")).not.toBe(node(graph.nodes, "ask"))
  })

  test("undoes only this reader's own changes, a drag as one step", () => {
    // Reproduce by tracking every origin in LiveCanvas's undo manager: Alice's undo takes back
    // Bob's move.
    const { alice, bob } = pair()
    alice.stopCapturing()
    for (const x of [100, 200, 300]) alice.apply(moveItems(new Map([["ask", { x, y: 560 }]])))
    alice.stopCapturing()
    bob.apply(moveItems(new Map([["home", { x: -300, y: 0 }]])))
    expect(alice.getHistory()).toEqual({ undo: true, redo: false })

    alice.undo()
    expect(item(alice.getCanvas(), "ask")).toMatchObject({ x: 0, y: 560 })
    expect(item(alice.getCanvas(), "home")).toMatchObject({ x: -300, y: 0 })
    expect(item(bob.getCanvas(), "ask")).toMatchObject({ x: 0, y: 560 })
    expect(bob.getHistory().undo).toBe(true)

    alice.redo()
    expect(item(bob.getCanvas(), "ask")).toMatchObject({ x: 300, y: 560 })
  })

  test("writes typed words as edits to the text, so both readers' words stay", () => {
    // Reproduce by setting a new Y.Text for a changed text in live/canvas.ts: one of the two
    // edits made at once is lost.
    const first = storedDocument(CANVAS)
    const second = new Y.Doc()
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
    const alice = new LiveCanvas(first)
    const bob = new LiveCanvas(second)

    alice.apply(setItemText("ask", "Annual first? Yes"))
    bob.apply(setItemText("ask", "Monthly or annual first?"))
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
    Y.applyUpdate(first, Y.encodeStateAsUpdate(second))

    const text = (canvas: LiveCanvas) => (item(canvas.getCanvas(), "ask") as { text: string }).text
    expect(text(alice)).toBe(text(bob))
    expect(text(alice)).toContain("Yes")
    expect(text(alice)).toContain("Monthly")
  })
})
