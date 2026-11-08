import type { ArtifactLiveSocket } from "@sixb/client"
import { type Canvas, parseCanvas } from "@sixb/core/artifacts"
import {
  type ArtifactLiveAccess,
  type ArtifactLiveClientMessage,
  type ArtifactLiveServerMessage,
  decodeLiveData,
  encodeLiveData,
  LIVE_FILES,
} from "@sixb/core/artifacts/live"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as syncProtocol from "y-protocols/sync"
import * as Y from "yjs"
import type { LiveSocketFactory } from "../../src/artifacts/live/session"

export function canvasOf(value: unknown): Canvas {
  const parsed = parseCanvas(JSON.stringify(value))
  if (!("canvas" in parsed)) throw new Error(parsed.error)
  return parsed.canvas
}

/** A canvas's document as storage keeps it: the history every copy continues. */
export function storedDocument(canvas: Canvas): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => {
    doc.getMap("artifact").set("kind", "canvas")
    const structure = new Y.Map<unknown>()
    const items = new Y.Map<Y.Map<unknown>>()
    for (const item of canvas.items) {
      const map = new Y.Map<unknown>()
      for (const [key, value] of Object.entries(item)) {
        map.set(key, ["text", "title", "label"].includes(key) ? new Y.Text(String(value)) : value)
      }
      items.set(item.id, map)
    }
    const order = new Y.Array<string>()
    order.push(canvas.items.map((item) => item.id))
    structure.set("items", items)
    structure.set("order", order)
    doc.getMap(LIVE_FILES).set("canvas.json", structure)
  })
  return doc
}

/**
 * The server's side of `/ws/artifacts`, as the room speaks it: one document, a `joined` and its
 * own sync step 1 on join, each sync message read into the document, and each change it takes
 * sent on to every other connection. Messages arrive a turn later, as over a socket.
 */
export class FakeServer {
  readonly doc: Y.Doc
  readonly connections = new Set<FakeConnection>()
  access: ArtifactLiveAccess = "edit"

  constructor(
    readonly artifactId: string,
    canvas: Canvas
  ) {
    this.doc = storedDocument(canvas)
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const message = encoding.createEncoder()
      syncProtocol.writeUpdate(message, update)
      for (const connection of this.connections) {
        if (connection !== origin) connection.sync(encoding.toUint8Array(message))
      }
    })
  }

  /** A hub's socket factory: each socket a connection to this server. */
  readonly open: LiveSocketFactory = (handlers) => {
    const connection = new FakeConnection(this, handlers)
    this.connections.add(connection)
    connection.connect()
    return connection
  }
}

export class FakeConnection implements ArtifactLiveSocket {
  open = false
  readonly sent: ArtifactLiveClientMessage[] = []

  constructor(
    private readonly server: FakeServer,
    private readonly handlers: Parameters<LiveSocketFactory>[0]
  ) {}

  connect(): void {
    this.open = true
    queueMicrotask(() => this.handlers.onConnected())
  }

  /** The socket drops; the client hears of it at once. */
  drop(): void {
    this.open = false
    this.handlers.onClosed()
  }

  send(message: ArtifactLiveClientMessage): boolean {
    if (!this.open) return false
    this.sent.push(message)
    queueMicrotask(() => this.receive(message))
    return true
  }

  close(): void {
    this.open = false
    this.server.connections.delete(this)
  }

  /** Sends a sync message to the client. */
  sync(bytes: Uint8Array): void {
    this.deliver({ type: "sync", artifactId: this.server.artifactId, data: encodeLiveData(bytes) })
  }

  deliver(message: ArtifactLiveServerMessage): void {
    if (!this.open) return
    queueMicrotask(() => this.handlers.onMessage(message))
  }

  private receive(message: ArtifactLiveClientMessage): void {
    if (message.type === "join") {
      this.deliver({
        type: "joined",
        artifactId: this.server.artifactId,
        access: this.server.access,
        revision: 1,
        user: { id: "user:alice", name: "Alice", color: "#e5484d" },
      })
      const step1 = encoding.createEncoder()
      syncProtocol.writeSyncStep1(step1, this.server.doc)
      this.sync(encoding.toUint8Array(step1))
      return
    }
    if (message.type !== "sync") return

    const bytes = decodeLiveData(message.data)
    if (!bytes) return
    const reply = encoding.createEncoder()
    syncProtocol.readSyncMessage(decoding.createDecoder(bytes), reply, this.server.doc, this)
    if (encoding.length(reply) > 0) this.sync(encoding.toUint8Array(reply))
  }
}

/** Lets every message in flight arrive, and what they set off. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve()
}
