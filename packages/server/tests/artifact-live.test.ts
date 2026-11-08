import { afterEach, describe, expect, jest, test } from "bun:test"
import {
  type ArtifactFile,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { CANVAS_FILE, parseCanvas } from "@sixb/core/artifacts"
import {
  AGENT_AWARENESS_FIELD,
  type ArtifactLiveServerMessage,
  decodeLiveData,
  documentCanvas,
  documentFiles,
  encodeLiveData,
  LIVE_SYNC_PART_BYTES,
  liveSync,
  mergeIntoDocument,
  patchText,
} from "@sixb/core/artifacts/live"
import { appendArtifactLive } from "@sixb/core/internal/artifacts/live"
import { emptyGrantIndex, type GrantIndex } from "@sixb/core/internal/authorization"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as awarenessProtocol from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import * as Y from "yjs"
import {
  ACCESS_RECHECK_MS,
  type LiveConnection,
  ROOM_LINGER_MS,
  SAVE_IDLE_MS,
  SAVE_MAX_MS,
} from "../src/live/room"
import { LiveRooms } from "../src/live/rooms"
import { SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const projectId = "artifact-live"

afterEach(() => {
  jest.useRealTimers()
})

const board = (id: string, x = 0) => ({
  id,
  type: "board",
  file: `boards/${id}.html`,
  x,
  y: 0,
  w: 390,
  h: 844,
})

const WELCOME = "<main>\n  <h1>Welcome</h1>\n  <p>Pick a region.</p>\n</main>\n"

/** A project with Marie's canvas, shared in her conversation, which Bob takes part in. */
async function setup() {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const broker = new InMemoryBroker()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    storage,
    blobStorage,
    broker,
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
  })

  // Signed in with a session, the only credential a conversation shares artifacts with.
  const as = (id: string, grants: Partial<GrantIndex> = {}) =>
    bindRequestExecution(host, {
      request: new Request("http://localhost/test"),
      authorization: {
        type: "principal",
        credential: { type: "session", id: `session-${id}` },
        context: {
          principal: { type: "user", id },
          sessionId: `session-${id}`,
          groupIds: [],
          roleIds: [],
          grants: { ...emptyGrantIndex(), "run:agent": true, ...grants },
        },
      },
    })
  const marie = as("marie")

  await storage.agents.threads.create({
    projectId,
    id: "thr_marie",
    ownerPrincipal: { type: "user", id: "marie" },
  })
  await storage.agents.threads.addParticipants({
    projectId,
    threadId: "thr_marie",
    principals: [{ type: "user", id: "bob" }],
    addedBy: { type: "user", id: "marie" },
    maxParticipants: 50,
  })

  const put = async (contents: Record<string, string>): Promise<ArtifactFile[]> =>
    Promise.all(
      Object.entries(contents).map(async ([path, body]) => ({
        path,
        file: await blobStorage.put({ body: new TextEncoder().encode(body), fileName: path }),
      }))
    )
  const created = await marie.artifacts.create({
    kind: "canvas",
    title: "Flow",
    files: await put({
      [CANVAS_FILE]: JSON.stringify({
        items: [board("welcome"), { id: "hi", type: "note", x: 0, y: 900, w: 200, text: "Hello" }],
      }),
      "boards/welcome.html": WELCOME,
    }),
  })
  const artifactId = created.artifact.id
  // The conversation shares it, as a turn's write there would.
  const shared = await storage.artifacts.publish({
    projectId,
    artifactId,
    kind: "canvas",
    version: { ...created.version, origin: { threadId: "thr_marie", runId: "run_marie" } },
  })

  const rooms = (instance = "server-a") =>
    new LiveRooms({ projectId, storage, blobStorage, broker, events: host.events, instance })

  const read = async (files: readonly ArtifactFile[], path: string) => {
    const file = files.find((entry) => entry.path === path)
    if (!file) throw new Error(`Expected ${path}.`)
    return new Response(await blobStorage.open(file.file.blobId)).text()
  }
  const latest = async () => {
    const artifact = await storage.artifacts.get({ projectId, id: artifactId })
    if (!artifact) throw new Error("Expected the artifact.")
    const version = await storage.artifacts.getVersion({
      projectId,
      artifactId,
      version: artifact.latestVersion,
    })
    if (!version) throw new Error("Expected its version.")
    return version
  }
  const items = async () => {
    const parsed = parseCanvas(await read((await latest()).files, CANVAS_FILE))
    if (!("canvas" in parsed)) throw new Error(parsed.error)
    return parsed.canvas.items
  }

  return {
    host,
    storage,
    blobStorage,
    broker,
    artifactId,
    revision: shared.version.revision,
    marie,
    bob: as("bob"),
    olivia: as("olivia", { "observe:agentThreads": true }),
    rooms,
    put,
    read,
    latest,
    items,
  }
}

/**
 * A client of the live socket, as the app is: a Yjs document and its awareness, kept in step with
 * the server through the room's messages.
 */
class Client {
  readonly doc = new Y.Doc()
  readonly awareness = new awarenessProtocol.Awareness(this.doc)
  readonly messages: ArtifactLiveServerMessage[] = []
  readonly connection: LiveConnection
  private readonly pending = new Set<Promise<void>>()

  constructor(
    readonly rooms: LiveRooms,
    sixb: LiveConnection["sixb"],
    readonly artifactId: string,
    id: string
  ) {
    this.connection = { id, sixb, send: (message) => this.receive(message) }
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "server") return
      const encoder = encoding.createEncoder()
      syncProtocol.writeUpdate(encoder, update)
      this.sync(encoding.toUint8Array(encoder))
    })
    this.awareness.on(
      "update",
      ({ added, updated, removed }: AwarenessChanges, origin: unknown) => {
        if (origin === "server") return
        const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
          ...added,
          ...updated,
          ...removed,
        ])
        this.track(
          this.rooms.receive(this.connection, {
            type: "awareness",
            artifactId: this.artifactId,
            data: encodeLiveData(update),
          })
        )
      }
    )
  }

  /** Joins, then starts the sync as a client does: with its state vector. */
  async join(): Promise<void> {
    await this.rooms.receive(this.connection, { type: "join", artifactId: this.artifactId })
    if (!this.messages.some((message) => message.type === "joined")) return
    const encoder = encoding.createEncoder()
    syncProtocol.writeSyncStep1(encoder, this.doc)
    this.sync(encoding.toUint8Array(encoder))
  }

  leave(): Promise<void> {
    return this.rooms.receive(this.connection, { type: "leave", artifactId: this.artifactId })
  }

  /** Settles what the client and every room it reaches are doing. */
  async settle(): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
      await Promise.all([...this.pending])
      await this.rooms.settled()
      await new Promise<void>((resolve) => queueMicrotask(resolve))
    }
  }

  get canvas() {
    const canvas = documentCanvas(this.doc)
    if (!canvas) throw new Error("Expected the canvas's structure.")
    return canvas
  }

  html(path: string): Y.Text {
    return this.doc.getMap("files").get(path) as Y.Text
  }

  statuses(): ArtifactLiveServerMessage[] {
    return this.messages.filter((message) => message.type === "status")
  }

  private sync(bytes: Uint8Array): void {
    for (const message of liveSync(this.artifactId, bytes)) {
      this.track(this.rooms.receive(this.connection, message))
    }
  }

  private track(work: Promise<void>): void {
    this.pending.add(work)
    void work.finally(() => this.pending.delete(work))
  }

  private receive(message: ArtifactLiveServerMessage): void {
    this.messages.push(message)
    if (message.type === "sync") {
      const bytes = decodeLiveData(message.data) as Uint8Array
      const encoder = encoding.createEncoder()
      syncProtocol.readSyncMessage(decoding.createDecoder(bytes), encoder, this.doc, "server")
      if (encoding.length(encoder) > 0) this.sync(encoding.toUint8Array(encoder))
    }
    if (message.type === "awareness") {
      const bytes = decodeLiveData(message.data) as Uint8Array
      awarenessProtocol.applyAwarenessUpdate(this.awareness, bytes, "server")
    }
  }
}

interface AwarenessChanges {
  readonly added: number[]
  readonly updated: number[]
  readonly removed: number[]
}

/** The copy of the document a client joined. */
function joinedCopy(client: Client): string | undefined {
  const joined = client.messages.find((message) => message.type === "joined")
  return joined?.type === "joined" ? joined.document : undefined
}

/** Every awareness state a client sees but its own. */
function others(client: Client): Record<string, unknown>[] {
  return [...client.awareness.getStates()]
    .filter(([id]) => id !== client.doc.clientID)
    .map(([, state]) => state)
}

describe("an artifact edited live", () => {
  // Guard proof: drop the broadcast in LiveRoom's update handler; Bob never sees Marie's move.
  test("keeps two editors in step, and writes their changes back after a pause", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    const bob = new Client(rooms, context.bob, context.artifactId, "bob-1")
    await marie.join()
    await bob.join()
    await marie.settle()

    expect(marie.messages[0]).toEqual({
      type: "joined",
      artifactId: context.artifactId,
      access: "edit",
      revision: context.revision,
      document: expect.any(String),
    })
    expect(documentFiles(bob.doc).get("boards/welcome.html")).toEqual({ text: WELCOME })

    // Marie moves the note while Bob types in it.
    marie.canvas.items.get("hi")?.set("x", 320)
    ;(bob.canvas.items.get("hi")?.get("text") as Y.Text).insert(5, ", team")
    await marie.settle()
    expect(documentFiles(marie.doc)).toEqual(documentFiles(bob.doc))
    expect(bob.canvas.items.get("hi")?.get("x")).toBe(320)

    // Nothing is written while they work; a pause writes it back, as one write.
    expect((await context.latest()).revision).toBe(context.revision)
    const cursor = await context.host.events.latestCursor()
    jest.advanceTimersByTime(SAVE_IDLE_MS)
    await marie.settle()

    const version = await context.latest()
    expect(version.revision).toBe(context.revision + 1)
    expect((await context.items()).find((item) => item.id === "hi")).toMatchObject({
      x: 320,
      text: "Hello, team",
    })
    expect(
      (
        await context.host.events.read({
          ...(cursor ? { afterCursor: cursor } : {}),
          types: ["artifact.updated"],
        })
      ).map((event) => event.payload)
    ).toEqual([
      { artifactId: context.artifactId, version: 1, revision: version.revision, frozen: false },
    ])
    expect(bob.statuses().at(-1)).toEqual({
      type: "status",
      artifactId: context.artifactId,
      state: "saved",
      revision: version.revision,
    })
    // Written as the last editor.
    expect(version.author).toEqual({ type: "user", id: "bob" })
  })

  test("writes back changes made without pause at most every few seconds, and when the last editor leaves", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    await marie.join()
    await marie.settle()

    for (let step = 0; step * (SAVE_IDLE_MS - 500) < SAVE_MAX_MS; step += 1) {
      marie.canvas.items.get("hi")?.set("x", step)
      await marie.settle()
      jest.advanceTimersByTime(SAVE_IDLE_MS - 500)
      await marie.settle()
    }
    expect((await context.latest()).revision).toBe(context.revision + 1)

    marie.canvas.items.get("hi")?.set("y", 1200)
    await marie.settle()
    await marie.leave()
    await marie.settle()
    expect((await context.items()).find((item) => item.id === "hi")).toMatchObject({ y: 1200 })
  })

  // Guard proof: let a watcher's update through in LiveRoom.sync; Olivia's note lands.
  test("lets a reader watch, never write", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const olivia = new Client(rooms, context.olivia, context.artifactId, "olivia-1")
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    await olivia.join()
    await marie.join()
    await olivia.settle()
    expect(olivia.messages[0]).toMatchObject({ type: "joined", access: "watch" })

    ;(olivia.canvas.items.get("hi")?.get("text") as Y.Text).insert(0, "Mine: ")
    await olivia.settle()
    expect(olivia.messages).toContainEqual(
      expect.objectContaining({ type: "error", message: expect.stringContaining("You watch") })
    )
    expect(marie.canvas.items.get("hi")?.get("text")?.toString()).toBe("Hello")

    // She sees what the editors do.
    marie.canvas.items.get("hi")?.set("x", 640)
    await olivia.settle()
    expect(olivia.canvas.items.get("hi")?.get("x")).toBe(640)
  })

  test("refuses whoever may not read the artifact, and an artifact that is not a canvas", async () => {
    const context = await setup()
    const rooms = context.rooms()
    const stranger = new Client(rooms, context.olivia, "art_0000000000", "x-1")
    await stranger.join()
    expect(stranger.messages).toEqual([
      { type: "left", artifactId: "art_0000000000", reason: "not_found" },
    ])

    const { artifact } = await context.marie.artifacts.create({
      kind: "document",
      title: "Plan",
      files: await context.put({ "document.md": "# Plan\n" }),
    })
    const document = new Client(rooms, context.marie, artifact.id, "marie-2")
    await document.join()
    expect(document.messages).toEqual([
      { type: "left", artifactId: artifact.id, reason: "not_live" },
    ])
  })

  // Guard proof: drop `written` from LiveRooms' events feed; the Agent's heading never reaches
  // Marie, and her next write-back is merged with it only in storage.
  test("merges into the document what the Agent wrote meanwhile, keeping what the editor did", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    await marie.join()
    await marie.settle()

    // Marie edits the paragraph, not written back yet.
    const html = marie.html("boards/welcome.html")
    patchText(html, WELCOME.replace("Pick a region.", "Pick a region near you."))
    await marie.settle()

    // The Agent, from the copy it installed, rewrites the heading.
    const base = await context.latest()
    await context.marie.artifacts.update(context.artifactId, {
      kind: "canvas",
      title: "Flow",
      files: [
        ...base.files.filter((entry) => entry.path !== "boards/welcome.html"),
        ...(await context.put({ "boards/welcome.html": WELCOME.replace("Welcome", "Hello") })),
      ],
      baseRevision: base.revision,
      baseFiles: base.files,
    })
    await marie.settle()

    const merged = "<main>\n  <h1>Hello</h1>\n  <p>Pick a region near you.</p>\n</main>\n"
    expect(html.toString()).toBe(merged)

    jest.advanceTimersByTime(SAVE_IDLE_MS)
    await marie.settle()
    expect(await context.read((await context.latest()).files, "boards/welcome.html")).toBe(merged)
  })

  // Guard proof: drop the broker appends in LiveRoom.presenceChanged; Bob on the other server
  // never sees Marie.
  test("keeps editors on two servers in step through storage, and their presence through the broker", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const [a, b] = [context.rooms("server-a"), context.rooms("server-b")]
    const marie = new Client(a, context.marie, context.artifactId, "marie-1")
    const bob = new Client(b, context.bob, context.artifactId, "bob-1")
    const settle = async () => {
      await marie.settle()
      await bob.settle()
      await marie.settle()
    }
    await marie.join()
    await bob.join()
    await settle()

    marie.awareness.setLocalStateField("user", { name: "Marie" })
    await settle()
    expect(others(bob)).toContainEqual({ user: { name: "Marie" } })

    // Marie's change reaches Bob once her server writes it back, and Bob's goes the other way.
    marie.canvas.items.get("hi")?.set("x", 320)
    ;(bob.canvas.items.get("hi")?.get("text") as Y.Text).insert(5, ", team")
    await settle()
    jest.advanceTimersByTime(SAVE_IDLE_MS)
    await settle()
    jest.advanceTimersByTime(SAVE_IDLE_MS)
    await settle()

    for (const client of [marie, bob]) {
      expect(client.canvas.items.get("hi")?.get("x")).toBe(320)
      expect(client.canvas.items.get("hi")?.get("text")?.toString()).toBe("Hello, team")
    }
    expect((await context.items()).find((item) => item.id === "hi")).toMatchObject({
      x: 320,
      text: "Hello, team",
    })
  })

  // Guard proof: drop `showAgents` from LiveRoom.heard; nothing says the Agent is at work.
  test("shows the boards an Agent turn is changing until the turn ends", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const marie = new Client(context.rooms(), context.marie, context.artifactId, "marie-1")
    await marie.join()
    await marie.settle()

    await appendArtifactLive(context.broker, projectId, context.artifactId, {
      name: "agent",
      payload: { runId: "run_1", boards: ["welcome"], at: new Date().toISOString() },
    })
    await marie.settle()
    expect(others(marie)).toEqual([
      { [AGENT_AWARENESS_FIELD]: [{ runId: "run_1", boards: ["welcome"] }] },
    ])

    await appendArtifactLive(context.broker, projectId, context.artifactId, {
      name: "agent-ended",
      payload: { runId: "run_1" },
    })
    await marie.settle()
    expect(others(marie)).toEqual([])
  })

  // Guard proof: clear `dirty` before the publish in LiveRoom.flush and leave it on failure; the
  // note's words are lost once storage refuses the first write-back.
  test("says when a write-back fails, keeps the changes, and tries again", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const marie = new Client(context.rooms(), context.marie, context.artifactId, "marie-1")
    await marie.join()
    await marie.settle()

    const put = context.blobStorage.put.bind(context.blobStorage)
    let refusals = 1
    context.blobStorage.put = async (input) => {
      if (refusals-- > 0) throw new Error("blob storage is unavailable")
      return put(input)
    }
    const error = console.error
    console.error = () => {}
    try {
      ;(marie.canvas.items.get("hi")?.get("text") as Y.Text).insert(5, " again")
      await marie.settle()
      jest.advanceTimersByTime(SAVE_IDLE_MS)
      await marie.settle()
      expect(marie.statuses().at(-1)).toMatchObject({
        state: "failed",
        error: "blob storage is unavailable",
      })
      expect((await context.latest()).revision).toBe(context.revision)

      jest.advanceTimersByTime(2_000)
      await marie.settle()
      expect(marie.statuses().at(-1)).toMatchObject({ state: "saved" })
      expect((await context.items()).find((item) => item.id === "hi")).toMatchObject({
        text: "Hello again",
      })

      // What publishing refuses waits for the next change, saying why.
      ;(marie.canvas.items.get("hi")?.get("text") as Y.Text).insert(0, "x".repeat(2_000))
      await marie.settle()
      jest.advanceTimersByTime(SAVE_IDLE_MS)
      await marie.settle()
      expect(marie.statuses().at(-1)).toMatchObject({
        state: "failed",
        error: expect.stringContaining("note 'hi'"),
      })
      ;(marie.canvas.items.get("hi")?.get("text") as Y.Text).delete(0, 2_000)
      await marie.settle()
      jest.advanceTimersByTime(SAVE_IDLE_MS)
      await marie.settle()
      expect(marie.statuses().at(-1)).toMatchObject({ state: "saved" })
    } finally {
      console.error = error
      context.blobStorage.put = put
    }
  })

  // Guard proof: answer `true` for any editor in LiveRoom.mayEdit; Bob's change after his removal
  // reaches Marie and storage.
  test("stops the writes of an editor who lost the right to change the artifact", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    const bob = new Client(rooms, context.bob, context.artifactId, "bob-1")
    await marie.join()
    await bob.join()
    await marie.settle()

    await context.storage.agents.threads.removeParticipant({
      projectId,
      threadId: "thr_marie",
      principal: { type: "user", id: "bob" },
    })
    jest.advanceTimersByTime(ACCESS_RECHECK_MS)
    ;(bob.canvas.items.get("hi")?.get("text") as Y.Text).insert(0, "Bob: ")
    await marie.settle()

    expect(bob.messages).toContainEqual({
      type: "left",
      artifactId: context.artifactId,
      reason: "not_shared",
    })
    expect(marie.canvas.items.get("hi")?.get("text")?.toString()).toBe("Hello")
  })

  // Guard proof: in LiveRooms.assemble, pass each part on alone instead of keeping it; the room
  // reads half a message and Bob never sees the comment.
  test("takes a change larger than a socket message in parts", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    const bob = new Client(rooms, context.bob, context.artifactId, "bob-1")
    await marie.join()
    await bob.join()
    await marie.settle()

    const comment = `<!-- ${"a".repeat(LIVE_SYNC_PART_BYTES * 2)} -->`
    marie.html("boards/welcome.html").insert(0, comment)
    await marie.settle()
    expect(bob.html("boards/welcome.html").toString()).toBe(comment + WELCOME)

    jest.advanceTimersByTime(SAVE_IDLE_MS)
    await marie.settle()
    expect(await context.read((await context.latest()).files, "boards/welcome.html")).toBe(
      comment + WELCOME
    )
  })

  // Guard proof: close the room as soon as the last connection leaves, with no linger. Marie then
  // rejoins another copy, whose `canvas.json` collides with hers: her move lands only when her
  // client id wins.
  test("is resynced on reconnect, keeping what the client edited while away", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    await marie.join()
    await marie.settle()
    await marie.leave()
    await marie.settle()

    // Offline, she moves the board; reconnected to the same copy, her document syncs it.
    marie.canvas.items.get("welcome")?.set("x", 80)
    const again = new Client(rooms, context.marie, context.artifactId, "marie-2")
    Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(marie.doc))
    await again.join()
    await again.settle()
    expect(joinedCopy(again)).toBe(joinedCopy(marie))
    jest.advanceTimersByTime(SAVE_IDLE_MS)
    await again.settle()

    expect((await context.items()).find((item) => item.id === "welcome")).toMatchObject({ x: 80 })
  })

  // Guard proof: apply Marie's old document to the new copy instead of merging her changes; the
  // two copies' `canvas.json` collide and her move lands only when her client id wins.
  test("drops a room nobody holds, and a client from the dropped copy merges what it changed", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    await marie.join()
    await marie.settle()
    await marie.leave()
    await marie.settle()
    jest.advanceTimersByTime(ROOM_LINGER_MS)
    await marie.settle()

    // Away past the linger, she moves the board; her document is of a copy the server dropped.
    const base = documentFiles(marie.doc)
    marie.canvas.items.get("welcome")?.set("x", 80)
    const again = new Client(rooms, context.marie, context.artifactId, "marie-2")
    await again.join()
    await again.settle()
    expect(joinedCopy(again)).not.toBe(joinedCopy(marie))

    mergeIntoDocument(again.doc, base, documentFiles(marie.doc))
    await again.settle()
    jest.advanceTimersByTime(SAVE_IDLE_MS)
    await again.settle()

    expect((await context.items()).find((item) => item.id === "welcome")).toMatchObject({ x: 80 })
    expect((await context.latest()).revision).toBe(context.revision + 1)
  })
})

describe("/ws/artifacts", () => {
  test("joins an artifact over the socket and answers its sync", async () => {
    const storage = new InMemoryStorage()
    const blobStorage = new InMemoryBlobStorage()
    const host = new SixbHost({
      id: projectId,
      ontology: [],
      storage,
      blobStorage,
      broker: new InMemoryBroker(),
      lakeStorage: new InMemoryLakeStorage(),
      queues: new InMemoryQueues(),
    })
    const file = async (path: string, body: string) => ({
      path,
      file: await blobStorage.put({ body: new TextEncoder().encode(body), fileName: path }),
    })
    // Without auth configured, the socket runs as the project's own code, which reaches it all.
    const { artifact } = await bindRequestExecution(host, {
      request: new Request("http://localhost/test"),
      authorization: { type: "disabled" },
    }).artifacts.create({
      kind: "canvas",
      title: "Flow",
      files: [
        await file(CANVAS_FILE, JSON.stringify({ items: [board("welcome")] })),
        await file("boards/welcome.html", WELCOME),
      ],
    })
    const server = new SixbServer({
      host,
      hostname: "127.0.0.1",
      port: 0,
      quiet: true,
      browser: createTestBrowserPolicy(),
    })
    await server.start()
    const ws = new WebSocket(`ws://127.0.0.1:${server.getPort()}/ws/artifacts`)
    // Every message, in order: several arrive at once.
    const inbox: Record<string, unknown>[] = []
    const waiting: ((message: Record<string, unknown>) => void)[] = []
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>
      const next = waiting.shift()
      if (next) next(message)
      else inbox.push(message)
    })
    const next = () =>
      inbox.length > 0
        ? Promise.resolve(inbox.shift() as Record<string, unknown>)
        : new Promise<Record<string, unknown>>((resolve) => waiting.push(resolve))
    try {
      expect(await next()).toEqual({ type: "connected", channel: "artifacts" })
      ws.send(JSON.stringify({ type: "join", artifactId: artifact.id }))
      expect(await next()).toEqual({
        type: "joined",
        artifactId: artifact.id,
        access: "edit",
        revision: 1,
        document: expect.any(String),
      })
      expect(await next()).toMatchObject({ type: "sync", artifactId: artifact.id })

      const doc = new Y.Doc()
      const step1 = encoding.createEncoder()
      syncProtocol.writeSyncStep1(step1, doc)
      ws.send(
        JSON.stringify({
          type: "sync",
          artifactId: artifact.id,
          data: encodeLiveData(encoding.toUint8Array(step1)),
        })
      )
      // The status, then the server's answer: the whole document.
      let answer: Record<string, unknown> | undefined
      while (!answer) {
        const message = await next()
        if (message.type === "sync") answer = message
      }
      const encoder = encoding.createEncoder()
      syncProtocol.readSyncMessage(
        decoding.createDecoder(decodeLiveData(String(answer.data)) as Uint8Array),
        encoder,
        doc,
        "server"
      )
      expect(documentFiles(doc).get("boards/welcome.html")).toEqual({ text: WELCOME })
    } finally {
      ws.close()
      await server.stop()
    }
  })
})
