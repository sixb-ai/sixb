import { afterEach, describe, expect, jest, spyOn, test } from "bun:test"
import {
  type ArtifactFile,
  artifactRef,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  ref,
  type SandboxFactory,
  type SixbErrorContext,
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
  liveSync,
} from "@sixb/core/artifacts/live"
import { appendArtifactLive } from "@sixb/core/internal/artifacts/live"
import { BOARD_PREVIEW_JOB } from "@sixb/core/internal/artifacts/publish"
import { emptyGrantIndex, type GrantIndex } from "@sixb/core/internal/authorization"
import { flushSixbErrors } from "@sixb/core/internal/error-reporting"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import { createTestSixb } from "@sixb/core/testing"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as awarenessProtocol from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import * as Y from "yjs"
import { patchText } from "../../core/src/artifacts/live/document"
import { LIVE_SYNC_PART_BYTES } from "../../core/src/artifacts/live/protocol"
import {
  ACCESS_RECHECK_MS,
  AWARENESS_SHARE_MS,
  HEARD_SAVE_MS,
  type LiveConnection,
  SAVE_IDLE_MS,
  SAVE_MAX_MS,
} from "../src/live/room"
import { LiveRooms, MAX_LIVE_ARTIFACTS_PER_CONNECTION } from "../src/live/rooms"
import { SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const projectId = "artifact-live"

/** A meeting holds the canvas it is planned on. */
const Meeting = defineObjectType({
  id: "Meeting",
  name: "Meeting",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("board", ref.artifact(), { nullable: true }),
  ],
})

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

/**
 * A project with Marie's canvas, shared in her conversation, which Bob takes part in. With
 * sandboxes, its boards are pictured: the agent worker would claim the jobs in its queue.
 */
async function setup(options: { readonly sandboxes?: boolean } = {}) {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const broker = new InMemoryBroker()
  const queues = new InMemoryQueues()
  const reported: SixbErrorContext[] = []
  const host = new SixbHost({
    id: projectId,
    ontology: [Meeting],
    storage,
    blobStorage,
    broker,
    lakeStorage: new InMemoryLakeStorage(),
    queues,
    ...(options.sandboxes ? { sandboxes: unusedSandboxes } : {}),
    onError: (_error, context) => {
      reported.push(context)
    },
  })
  /** What the project's `onError` heard. */
  const errors = async () => {
    await flushSixbErrors(host)
    return reported
  }

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
    ...(created.artifact.document ? { document: created.artifact.document.file } : {}),
  })

  const rooms = (instance = "server-a") =>
    new LiveRooms({
      projectId,
      storage,
      blobStorage,
      broker,
      events: host.events,
      instance,
      errorReporterHost: host,
    })

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
    queues,
    errors,
    artifactId,
    revision: shared.version.revision,
    marie,
    bob: as("bob"),
    olivia: as("olivia", { "observe:agentThreads": true }),
    as,
    rooms,
    put,
    read,
    latest,
    items,
  }
}

/** Sandboxes nothing here opens: only the agent worker would, for the jobs it claims. */
const unusedSandboxes: SandboxFactory = {
  supportsRequestCredentials: true,
  create: async () => {
    throw new Error("Nothing here opens a sandbox.")
  },
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
      user: { id: "user:marie", name: "marie", color: expect.stringMatching(/^#[0-9a-f]{6}$/) },
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
      snapshot: expect.any(String),
    })
    // Written as the last editor.
    expect(version.author).toEqual({ type: "user", id: "bob" })
  })

  // Guard proof: send a snapshot of the document as it is now in LiveRoom.status, rather than the
  // one written back; a change made since reads as written, and a client forgets it.
  test("says what it wrote back as a snapshot, its deletions too, which a change made since is past", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    await marie.join()
    await marie.settle()

    const written = () => {
      const status = marie.statuses().at(-1)
      if (status?.type !== "status") throw new Error("Expected a status.")
      return Y.decodeSnapshot(decodeLiveData(status.snapshot) as Uint8Array)
    }
    const save = async () => {
      jest.advanceTimersByTime(SAVE_IDLE_MS)
      await marie.settle()
    }
    /** Every deletion an update makes is in the snapshot's delete set. */
    const deletes = (update: Uint8Array, snapshot: Y.Snapshot) =>
      [...Y.decodeUpdate(update).ds.clients].every(([client, ranges]) =>
        ranges.every((range) => Y.isDeleted(snapshot.ds, Y.createID(client, range.clock)))
      )

    marie.canvas.items.get("hi")?.set("x", 320)
    await marie.settle()
    await save()
    expect(marie.statuses().at(-1)).toMatchObject({ state: "saved" })
    expect(written().sv.get(marie.doc.clientID)).toBe(
      Y.getState(marie.doc.store, marie.doc.clientID)
    )

    // Deleting the note moves no clock: only the delete set says it was written.
    let removal: Uint8Array | undefined
    marie.doc.once("update", (update: Uint8Array) => {
      removal = update
    })
    marie.canvas.items.delete("hi")
    await marie.settle()
    if (!removal) throw new Error("Expected the deletion's update.")
    expect(marie.statuses().at(-1)).toMatchObject({ state: "unsaved" })
    expect(deletes(removal, written())).toBe(false)

    await save()
    expect(marie.statuses().at(-1)).toMatchObject({ state: "saved" })
    expect(deletes(removal, written())).toBe(true)
  })

  // Yjs keeps both of two insertions made at once, alike or not, and so does the write-back: a
  // merge that took alike insertions once would leave "Hello!".
  test("keeps the same words two people type at once in the same place, both times", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    const bob = new Client(rooms, context.bob, context.artifactId, "bob-1")
    await marie.join()
    await bob.join()
    await marie.settle()

    // Each types before hearing of the other's.
    const note = (client: Client) => client.canvas.items.get("hi")?.get("text") as Y.Text
    for (const client of [marie, bob]) note(client).insert(5, "!")
    await marie.settle()
    jest.advanceTimersByTime(SAVE_IDLE_MS)
    await marie.settle()

    expect(note(marie).toString()).toBe("Hello!!")
    expect(note(bob).toString()).toBe("Hello!!")
    expect((await context.items()).find((item) => item.id === "hi")).toMatchObject({
      text: "Hello!!",
    })
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

  test("has its boards pictured once its editors pause, at the latest revision only", async () => {
    // Reproduce by asking for the pictures at once, or in a job per revision: the first write's
    // job is due while Marie still types, and pictures words she has since changed.
    jest.useFakeTimers()
    const context = await setup({ sandboxes: true })
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    await marie.join()
    await marie.settle()

    const claimable = async () =>
      (await context.queues.agents.claim({ projectId, workerId: "worker", limit: 10 })).map(
        ({ job }) => ({ id: job.id, payload: job.payload })
      )

    // Marie types in the board for half a minute, never pausing long enough to be written back
    // before SAVE_MAX_MS.
    for (let typed = 0; typed < 30_000; typed += SAVE_IDLE_MS - 500) {
      marie.html("boards/welcome.html").insert(0, "x")
      await marie.settle()
      jest.advanceTimersByTime(SAVE_IDLE_MS - 500)
      await marie.settle()
    }
    expect((await context.latest()).revision).toBeGreaterThan(context.revision + 2)
    expect(await claimable()).toEqual([])

    jest.advanceTimersByTime(SAVE_IDLE_MS)
    await marie.settle()
    const written = await context.latest()
    jest.advanceTimersByTime(BOARD_PREVIEW_JOB.settleMs)

    expect(await claimable()).toEqual([
      {
        id: `art_previews_${context.artifactId}`,
        payload: {
          artifactId: context.artifactId,
          version: written.version,
          updatedAt: written.updatedAt.toISOString(),
        },
      },
    ])
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

  test("lets whoever reads an object that holds it watch, and whoever edits one edit", async () => {
    const context = await setup()
    await createTestSixb(context.host)
      .objects(Meeting)
      .upsert({ properties: { id: "m1", board: artifactRef(context.artifactId) } })
    const rooms = context.rooms()

    const reader = context.as("rita", { "view:object": new Set([Meeting.id]) })
    const editor = context.as("ed", {
      "view:object": new Set([Meeting.id]),
      "edit:object": new Set([Meeting.id]),
    })
    const rita = new Client(rooms, reader, context.artifactId, "rita-1")
    const ed = new Client(rooms, editor, context.artifactId, "ed-1")
    const stranger = new Client(rooms, context.as("sam"), context.artifactId, "sam-1")
    await rita.join()
    await ed.join()
    await stranger.join()
    await rita.settle()

    expect(rita.messages[0]).toMatchObject({ type: "joined", access: "watch" })
    expect(ed.messages[0]).toMatchObject({ type: "joined", access: "edit" })
    expect(stranger.messages).toEqual([
      { type: "left", artifactId: context.artifactId, reason: "not_shared" },
    ])
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

  // Guard proof: drop `this.share("update", ...)` from LiveRoom's update handler; Bob on the other
  // server sees Marie's move only once her server writes it back.
  test("keeps editors on two servers in step at once, through the broker", async () => {
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

    marie.awareness.setLocalStateField("cursor", { x: 10, y: 20 })
    await settle()
    jest.advanceTimersByTime(AWARENESS_SHARE_MS)
    await settle()
    expect(others(bob)).toContainEqual({
      cursor: { x: 10, y: 20 },
      user: expect.objectContaining({ id: "user:marie" }),
    })

    // Both edit the note at once: each sees the other's change before anything is written.
    marie.canvas.items.get("hi")?.set("x", 320)
    ;(bob.canvas.items.get("hi")?.get("text") as Y.Text).insert(5, ", team")
    ;(marie.canvas.items.get("hi")?.get("text") as Y.Text).insert(0, "Oh. ")
    await settle()
    expect((await context.latest()).revision).toBe(context.revision)
    for (const client of [marie, bob]) {
      expect(client.canvas.items.get("hi")?.get("x")).toBe(320)
      expect(client.canvas.items.get("hi")?.get("text")?.toString()).toBe("Oh. Hello, team")
    }

    // Each server writes back what its editor changed; storage holds it all, once.
    jest.advanceTimersByTime(SAVE_IDLE_MS)
    await settle()
    expect((await context.items()).find((item) => item.id === "hi")).toMatchObject({
      x: 320,
      text: "Oh. Hello, team",
    })
    expect(documentFiles(marie.doc)).toEqual(documentFiles(bob.doc))
  })

  // Guard proof: in vouchedAwareness, keep a client's own `user` and `sixbAgent`; Bob then sees
  // Marie as Bob, and an Agent at work.
  test("names each person as the server knows them, and lets nobody speak for another or the Agent", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    const bob = new Client(rooms, context.bob, context.artifactId, "bob-1")
    await marie.join()
    await bob.join()
    bob.awareness.setLocalStateField("cursor", { x: 1, y: 1 })
    await marie.settle()

    // Marie claims to be Bob, and the Agent at work on a board.
    marie.awareness.setLocalState({
      cursor: { x: 5, y: 5 },
      user: { id: "user:bob", name: "Bob", color: "#000000" },
      [AGENT_AWARENESS_FIELD]: [{ runId: "run_forged", boards: ["welcome"] }],
    })
    // And she sends a state for Bob's own client.
    const forged = encoding.createEncoder()
    encoding.writeVarUint(forged, 1)
    encoding.writeVarUint(forged, bob.doc.clientID)
    encoding.writeVarUint(forged, 99)
    encoding.writeVarString(forged, JSON.stringify({ cursor: { x: 0, y: 0 }, forged: true }))
    await rooms.receive(marie.connection, {
      type: "awareness",
      artifactId: context.artifactId,
      data: encodeLiveData(encoding.toUint8Array(forged)),
    })
    await marie.settle()

    const marieUser = { id: "user:marie", name: "marie", color: expect.any(String) }
    expect(others(bob)).toEqual([{ cursor: { x: 5, y: 5 }, user: marieUser }])
    expect(others(marie)).toEqual([
      { cursor: { x: 1, y: 1 }, user: { id: "user:bob", name: "bob", color: expect.any(String) } },
    ])
  })

  // Guard proof: drop the check of the room's own client and of other servers' in LiveRoom.mayUse;
  // Bob's entry takes the Agent's place, and Bob's on the other server is Marie's cursor.
  test("lets nobody speak for the room's own entry, or for a person on another server", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const [a, b] = [context.rooms("server-a"), context.rooms("server-b")]
    const marie = new Client(a, context.marie, context.artifactId, "marie-1")
    const bob = new Client(a, context.bob, context.artifactId, "bob-1")
    const elsewhere = new Client(b, context.bob, context.artifactId, "bob-2")
    const settle = async () => {
      await marie.settle()
      await elsewhere.settle()
      await marie.settle()
    }
    await marie.join()
    await bob.join()
    await elsewhere.join()
    elsewhere.awareness.setLocalStateField("cursor", { x: 7, y: 7 })
    await appendArtifactLive(context.broker, projectId, context.artifactId, {
      name: "agent",
      payload: { runId: "run_1", boards: ["welcome"], at: new Date().toISOString() },
    })
    await settle()
    jest.advanceTimersByTime(AWARENESS_SHARE_MS)
    await settle()

    // Bob sends states for the room's entry, which carries the Agent's turn, and for himself
    // on the other server, as newer than theirs.
    const room = [...bob.awareness.getStates()].find(([, state]) => AGENT_AWARENESS_FIELD in state)
    const forged = encoding.createEncoder()
    encoding.writeVarUint(forged, 2)
    for (const client of [room?.[0] ?? -1, elsewhere.doc.clientID]) {
      encoding.writeVarUint(forged, client)
      encoding.writeVarUint(forged, 99)
      encoding.writeVarString(forged, JSON.stringify({ cursor: { x: 0, y: 0 } }))
    }
    await a.receive(bob.connection, {
      type: "awareness",
      artifactId: context.artifactId,
      data: encodeLiveData(encoding.toUint8Array(forged)),
    })
    await settle()

    expect(room).toBeDefined()
    expect(others(marie)).toContainEqual({
      [AGENT_AWARENESS_FIELD]: [{ runId: "run_1", boards: ["welcome"] }],
    })
    expect(others(marie)).toContainEqual({
      cursor: { x: 7, y: 7 },
      user: expect.objectContaining({ id: "user:bob" }),
    })
    expect(others(marie)).not.toContainEqual(expect.objectContaining({ cursor: { x: 0, y: 0 } }))
  })

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

  // Guard proof: give up after a few attempts once nobody holds the room, as it once did; what
  // Marie typed before she left, while storage was down, is never written.
  test("keeps changes nobody holds any more until storage takes them, however long", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    await marie.join()
    await marie.settle()

    const put = context.blobStorage.put.bind(context.blobStorage)
    let down = true
    context.blobStorage.put = async (input) => {
      if (down) throw new Error("blob storage is unavailable")
      return put(input)
    }
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      ;(marie.canvas.items.get("hi")?.get("text") as Y.Text).insert(5, " again")
      await marie.settle()
      await marie.leave()
      await marie.settle()

      // Ten minutes of attempts, each refused.
      for (let waited = 0; waited < 10 * 60_000; waited += 30_000) {
        jest.advanceTimersByTime(30_000)
        await marie.settle()
      }
      expect((await context.latest()).revision).toBe(context.revision)

      down = false
      jest.advanceTimersByTime(30_000)
      await marie.settle()
      expect((await context.items()).find((item) => item.id === "hi")).toMatchObject({
        text: "Hello again",
      })
      expect(await context.errors()).toEqual([])
    } finally {
      warn.mockRestore()
      context.blobStorage.put = put
    }
  })

  // Guard proof: drop `lose()` from LiveRoom.close; the server stops with Marie's words unwritten,
  // and the project's onError never hears of it.
  test("reports the changes it could not store before the server stopped", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    await marie.join()
    await marie.settle()

    const put = context.blobStorage.put.bind(context.blobStorage)
    context.blobStorage.put = async () => {
      throw new Error("blob storage is unavailable")
    }
    try {
      ;(marie.canvas.items.get("hi")?.get("text") as Y.Text).insert(5, " again")
      await marie.settle()
      jest.advanceTimersByTime(SAVE_IDLE_MS)
      await marie.settle()
      await rooms.close()
    } finally {
      context.blobStorage.put = put
    }

    expect(await context.errors()).toEqual([
      expect.objectContaining({
        type: "artifact.live_write.failed",
        artifactId: context.artifactId,
        revision: context.revision,
        attempts: 2,
        failure: expect.objectContaining({ code: "internal.unexpected" }),
      }),
    ])
  })

  // Guard proof: leave the refused author an editor in LiveRoom.failed; the room tries the same
  // refused write as Bob again at once, over and over, and Marie's room never writes as her.
  test("writes as another editor when the one who changed it may no longer, and stops trying", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const bob = new Client(rooms, context.bob, context.artifactId, "bob-1")
    await bob.join()
    await bob.settle()

    // Bob, the only editor, types, and is taken out of the conversation before it is written.
    const removeBob = () =>
      context.storage.agents.threads.removeParticipant({
        projectId,
        threadId: "thr_marie",
        principal: { type: "user", id: "bob" },
      })
    ;(bob.canvas.items.get("hi")?.get("text") as Y.Text).insert(5, " from Bob")
    await bob.settle()
    await removeBob()
    jest.advanceTimersByTime(SAVE_IDLE_MS)
    await bob.settle()
    for (let tick = 0; tick < 20; tick += 1) {
      jest.advanceTimersByTime(1)
      await bob.settle()
    }

    expect(
      bob.statuses().filter((status) => status.type === "status" && status.state === "failed")
    ).toHaveLength(1)
    expect(bob.messages).toContainEqual({
      type: "access",
      artifactId: context.artifactId,
      access: "watch",
    })
    expect((await context.latest()).revision).toBe(context.revision)

    // Once he leaves, nobody may write what he typed: the project's onError hears of it.
    await bob.leave()
    await bob.settle()
    expect(await context.errors()).toEqual([
      expect.objectContaining({
        type: "artifact.live_write.failed",
        artifactId: context.artifactId,
      }),
    ])
  })

  // Guard proof: drop the retry as the next editor from LiveRoom.failed; what Bob typed waits
  // for the next change.
  test("writes as another editor at once when the one who changed it may no longer", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    const bob = new Client(rooms, context.bob, context.artifactId, "bob-1")
    await marie.join()
    await bob.join()
    await marie.settle()

    ;(bob.canvas.items.get("hi")?.get("text") as Y.Text).insert(5, " from Bob")
    await marie.settle()
    await context.storage.agents.threads.removeParticipant({
      projectId,
      threadId: "thr_marie",
      principal: { type: "user", id: "bob" },
    })
    jest.advanceTimersByTime(SAVE_IDLE_MS)
    await marie.settle()
    jest.advanceTimersByTime(0)
    await marie.settle()

    const version = await context.latest()
    expect(version.revision).toBe(context.revision + 1)
    expect(version.author).toEqual({ type: "user", id: "marie" })
    expect((await context.items()).find((item) => item.id === "hi")).toMatchObject({
      text: "Hello from Bob",
    })
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

  // Guard proof: build the room's document from the version's files in LiveRoom.open instead of
  // loading the stored one; the new room's `canvas.json` then collides with Marie's, and her move
  // lands only when her client id wins.
  test("syncs what a client changed while away, once the room was dropped and loaded again", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    await marie.join()
    await marie.settle()
    marie.canvas.items.get("hi")?.set("x", 40)
    await marie.settle()
    await marie.leave()
    await marie.settle()

    // Told she left, and written back as she did: the room closes with her.
    expect(marie.messages.at(-1)).toEqual({
      type: "left",
      artifactId: context.artifactId,
      reason: "left",
    })
    expect((await context.latest()).revision).toBe(context.revision + 1)

    // Offline, she moves the board; reconnected, her document syncs it as it is.
    marie.canvas.items.get("welcome")?.set("x", 80)
    const again = new Client(rooms, context.marie, context.artifactId, "marie-2")
    Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(marie.doc))
    await again.join()
    await again.settle()
    jest.advanceTimersByTime(SAVE_IDLE_MS)
    await again.settle()

    const items = await context.items()
    expect(items.find((item) => item.id === "welcome")).toMatchObject({ x: 80 })
    expect(items.find((item) => item.id === "hi")).toMatchObject({ x: 40 })
    expect(items).toHaveLength(2)
  })
})

describe("an artifact edited live, under strain", () => {
  // Guard proof: in LiveRooms.join, take the slot after the awaits, as it was; the joins at
  // once all pass the cap.
  test("counts joins at once against a connection's cap", async () => {
    const context = await setup()
    const rooms = context.rooms()
    const ids: string[] = []
    for (let index = 0; index < MAX_LIVE_ARTIFACTS_PER_CONNECTION + 2; index += 1) {
      const created = await context.marie.artifacts.create({
        kind: "canvas",
        title: `Canvas ${index}`,
        files: await context.put({
          [CANVAS_FILE]: JSON.stringify({
            items: [{ id: "n", type: "note", x: 0, y: 0, w: 100, text: "a" }],
          }),
        }),
      })
      ids.push(created.artifact.id)
    }
    const sent: ArtifactLiveServerMessage[] = []
    const connection = {
      id: "c-1",
      sixb: context.marie,
      send: (m: ArtifactLiveServerMessage) => sent.push(m),
    }
    await Promise.all(
      ids.map((artifactId) => rooms.receive(connection, { type: "join", artifactId }))
    )

    expect(sent.filter((message) => message.type === "joined")).toHaveLength(
      MAX_LIVE_ARTIFACTS_PER_CONNECTION
    )
    expect(sent.filter((message) => message.type === "error")).toHaveLength(2)
  })

  // Guard proof: drop the ticket check after the awaits in LiveRooms.join; Marie, gone, is
  // joined anyway.
  test("leaves out a connection that closed while its join was on the way", async () => {
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    const joining = rooms.receive(marie.connection, {
      type: "join",
      artifactId: context.artifactId,
    })
    await rooms.disconnect(marie.connection)
    await joining
    await marie.settle()

    expect(marie.messages.some((message) => message.type === "joined")).toBe(false)
  })

  // Guard proof: return from LiveRoom.updated for a REMOTE update without `heard()`; Marie's move,
  // heard by server B from server A, which died, is never written.
  test("writes back what it heard from a server that died before writing it", async () => {
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

    marie.canvas.items.get("hi")?.set("x", 777)
    await settle()
    expect(bob.canvas.items.get("hi")?.get("x")).toBe(777)

    // Server A dies before it writes back: its room stops, nothing saved. Everyone on B leaves.
    const held = (a as unknown as { rooms: Map<string, Promise<unknown>> }).rooms
    ;((await held.get(context.artifactId)) as { close(): void }).close()
    await bob.leave()
    await settle()
    jest.advanceTimersByTime(HEARD_SAVE_MS)
    await settle()

    expect((await context.items()).find((item) => item.id === "hi")).toMatchObject({ x: 777 })
  })

  // Guard proof: drop the recheck from LiveRoom.written; Bob, idle, keeps watching the canvas
  // after he lost the right to read it.
  test("reads every member's right again when the artifact is written, and drops who lost it", async () => {
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
    const latest = await context.latest()
    await context.marie.artifacts.update(context.artifactId, {
      kind: "canvas",
      title: "Flow",
      files: latest.files,
      baseRevision: latest.revision,
    })
    await marie.settle()

    expect(bob.messages).toContainEqual({
      type: "left",
      artifactId: context.artifactId,
      reason: "not_shared",
    })
  })

  // Guard proof: drop the shadow check in LiveRoom.sync; the poisoned board reaches Bob, the
  // write-back throws, and the room never closes.
  test("refuses a change that leaves the document unreadable, before anyone gets it", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    const bob = new Client(rooms, context.bob, context.artifactId, "bob-1")
    await marie.join()
    await bob.join()
    await marie.settle()

    marie.doc.getMap("files").set("boards/x.html", new Y.Map())
    await marie.settle()
    expect(marie.messages.at(-1)).toMatchObject({ type: "error" })
    expect(bob.doc.getMap("files").has("boards/x.html")).toBe(false)

    // A sound change after it is kept, and written back.
    ;(bob.canvas.items.get("hi")?.get("text") as Y.Text).insert(5, "!")
    await marie.settle()
    jest.advanceTimersByTime(SAVE_IDLE_MS)
    await marie.settle()
    expect((await context.items()).find((item) => item.id === "hi")).toMatchObject({
      text: "Hello!",
    })
  })

  // Guard proof: drop `baseTitle` from LiveRoom.flush's publish; the write-back puts the old
  // title back.
  test("keeps a title given while the canvas was edited", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    await marie.join()
    await marie.settle()
    marie.canvas.items.get("hi")?.set("x", 40)
    await marie.settle()

    // Renamed elsewhere before the write-back.
    const latest = await context.latest()
    await context.storage.artifacts.publish({
      projectId,
      artifactId: context.artifactId,
      kind: "canvas",
      version: { ...latest, title: "Onboarding" },
    })
    jest.advanceTimersByTime(SAVE_IDLE_MS)
    await marie.settle()

    const written = await context.latest()
    expect(written.title).toBe("Onboarding")
    expect(written.revision).toBe(latest.revision + 2)
  })

  // Guard proof: reset nothing when the events feed fails in LiveRooms.followEvents; no room
  // ever hears of a write again.
  test("follows the artifacts' writes again after the feed failed to start", async () => {
    jest.useFakeTimers()
    const context = await setup()
    let calls = 0
    const events = {
      subscribe: ((...args: Parameters<typeof context.host.events.subscribe>) => {
        calls += 1
        return calls === 1
          ? Promise.reject(new Error("down"))
          : context.host.events.subscribe(...args)
      }) as typeof context.host.events.subscribe,
    }
    const rooms = new LiveRooms({
      projectId,
      storage: context.storage,
      blobStorage: context.blobStorage,
      broker: context.broker,
      events: events as typeof context.host.events,
      instance: "server-a",
      errorReporterHost: context.host,
    })
    const error = spyOn(console, "error").mockImplementation(() => {})
    try {
      const first = new Client(rooms, context.marie, context.artifactId, "marie-1")
      await first.join()
      await first.settle()
      await first.leave()
      await first.settle()

      const marie = new Client(rooms, context.marie, context.artifactId, "marie-2")
      await marie.join()
      await marie.settle()
      const latest = await context.latest()
      await context.marie.artifacts.update(context.artifactId, {
        kind: "canvas",
        title: "Flow",
        files: await context.put({
          [CANVAS_FILE]: JSON.stringify({ items: [board("welcome", 120)] }),
          "boards/welcome.html": WELCOME,
        }),
        baseRevision: latest.revision,
      })
      await marie.settle()
      expect(marie.canvas.items.get("welcome")?.get("x")).toBe(120)
    } finally {
      error.mockRestore()
    }
  })

  // Guard proof: drop the `room.close()` from LiveRoom.open's failed follow; the room's awareness
  // check keeps running for good.
  test("leaves nothing running when a room cannot follow its stream", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const broker = {
      ensureStream: context.broker.ensureStream.bind(context.broker),
      append: context.broker.append.bind(context.broker),
      read: context.broker.read.bind(context.broker),
      tail: context.broker.tail.bind(context.broker),
      subscribe: () => Promise.reject(new Error("broker down")),
    } as unknown as typeof context.broker
    const rooms = new LiveRooms({
      projectId,
      storage: context.storage,
      blobStorage: context.blobStorage,
      broker,
      events: context.host.events,
      instance: "server-a",
      errorReporterHost: context.host,
    })
    // The client's own awareness keeps a timer: counted before the join.
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    const before = jest.getTimerCount()
    const refused = await rooms
      .receive(marie.connection, { type: "join", artifactId: context.artifactId })
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(Error)
    expect(jest.getTimerCount()).toBe(before)
  })

  // Guard proof: share each awareness change at once, on the live stream; Marie's cursor moves
  // fill the document's stream.
  test("shares presence a few times a second at most, apart from the document's updates", async () => {
    jest.useFakeTimers()
    const context = await setup()
    const rooms = context.rooms()
    const marie = new Client(rooms, context.marie, context.artifactId, "marie-1")
    await marie.join()
    await marie.settle()

    for (let x = 0; x < 20; x += 1) {
      marie.awareness.setLocalStateField("cursor", { x, y: 0 })
      await marie.settle()
    }
    jest.advanceTimersByTime(AWARENESS_SHARE_MS)
    await marie.settle()

    const read = async (streamId: string) =>
      (await context.broker.read({ projectId, streamId })).records.map((record) => record.name)
    expect(await read(`artifacts.presence.${context.artifactId}`)).toEqual(["awareness"])
    expect(await read(`artifacts.live.${context.artifactId}`)).not.toContain("awareness")
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
        user: { id: "system", name: "Project", color: expect.any(String) },
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
