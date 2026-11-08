import { type ArtifactLiveSocket, createArtifactLiveSocket } from "@sixb/client"
import {
  type ArtifactLiveAccess,
  type ArtifactLiveClientMessage,
  type ArtifactLiveLeftReason,
  type ArtifactLiveSaveState,
  type ArtifactLiveServerMessage,
  type ArtifactLiveUser,
  decodeLiveData,
  encodeLiveData,
  liveSync,
} from "@sixb/core/artifacts/live"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as awarenessProtocol from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import * as Y from "yjs"
import { SELECTION_FIELD } from "./presence"

// The artifacts a page holds live, over one `/ws/artifacts` socket. Each keeps its Yjs document
// and its awareness for as long as a view holds it, across reconnects: a reconnect joins again
// and sends sync step 1, and the server's own step 1 brings back what changed here meanwhile.
//
//   socket ── connected ──▶ join each artifact ── joined ──▶ sync step 1, own awareness
//          ◀── sync / awareness, applied as FROM_SERVER (never sent back)
//          ──▶ the document's own updates, and its awareness, as they happen

/** The origin of what the server sent: applied, never sent back. */
export const FROM_SERVER = Symbol("sixb-live-server")

/** How long an artifact no view holds stays joined, so a view that remounts finds it as it was. */
const LINGER_MS = 3_000

/** Whether the socket is up: `connecting` until the first connection, `offline` between two. */
export type LiveConnection = "connecting" | "online" | "offline"

/** What the server says of the document's write-back, as the last `status` said it. */
export interface LiveSave {
  readonly state: ArtifactLiveSaveState
  readonly revision: number
  readonly error?: string
}

export interface LiveArtifactState {
  readonly connection: LiveConnection
  /** What the connection may do, once joined; null before. */
  readonly access: ArtifactLiveAccess | null
  /** The document holds the artifact: the server's sync step 2 reached it once. */
  readonly synced: boolean
  readonly save: LiveSave | null
  /** Changes made here that the server has not said it took: sent offline, or not saved yet. */
  readonly pending: boolean
  /** Who this connection is to the others, as `joined` said. */
  readonly user: ArtifactLiveUser | null
  /** Why the page no longer holds the artifact live; null while it does. */
  readonly left: ArtifactLiveLeftReason | null
}

const INITIAL: LiveArtifactState = {
  connection: "connecting",
  access: null,
  synced: false,
  save: null,
  pending: false,
  user: null,
  left: null,
}

/**
 * Where a page keeps the changes made to an artifact that the server has not said it saved, so a
 * reload, or a tab closed during an outage, does not lose them: the next copy of the document
 * merges them in, and sends them with its sync.
 */
export interface LiveKeeper {
  read(artifactId: string): Uint8Array | null
  write(artifactId: string, update: Uint8Array): void
  clear(artifactId: string): void
}

/** The browser's local storage, which a private window or a full disk may refuse: then nothing. */
export const browserKeeper: LiveKeeper = {
  read(artifactId) {
    try {
      const kept = globalThis.localStorage?.getItem(keeperKey(artifactId))
      return kept ? decodeLiveData(kept) : null
    } catch {
      return null
    }
  },
  write(artifactId, update) {
    try {
      globalThis.localStorage?.setItem(keeperKey(artifactId), encodeLiveData(update))
    } catch {
      // Kept in the document while the page lasts.
    }
  },
  clear(artifactId) {
    try {
      globalThis.localStorage?.removeItem(keeperKey(artifactId))
    } catch {
      // Nothing was kept.
    }
  },
}

const keeperKey = (artifactId: string) => `sixb.live.unsaved.${artifactId}`

/** The origin of changes taken back from the keeper: this page's own, sent as any other. */
const KEPT = Symbol("sixb-live-kept")

/** One artifact a page holds live: its document, its awareness, and what the server says. */
export class LiveArtifact {
  readonly doc = new Y.Doc()
  readonly awareness = new awarenessProtocol.Awareness(this.doc)
  private state: LiveArtifactState = INITIAL
  private readonly listeners = new Set<() => void>()
  private joined = false
  /** What this page changed that the server has not said it saved, merged into one update. */
  private unsaved: Uint8Array | null = null

  constructor(
    readonly artifactId: string,
    private readonly send: (message: ArtifactLiveClientMessage) => boolean,
    private readonly keeper: LiveKeeper = browserKeeper
  ) {
    this.doc.on("update", this.onUpdate)
    this.awareness.on("update", this.onAwareness)
    // Others take a state only past its first clock, which the empty one starts at: one set now
    // is the first they see.
    this.awareness.setLocalStateField(SELECTION_FIELD, [])

    // What an earlier copy changed and never saw saved: it waits in the document for what it
    // was made on, which the first sync brings, and goes with this copy's own changes.
    const kept = keeper.read(artifactId)
    if (kept) {
      try {
        Y.applyUpdate(this.doc, kept, KEPT)
      } catch {
        keeper.clear(artifactId)
      }
    }
  }

  getState = (): LiveArtifactState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The socket is ready: join, or join again after a reconnect. */
  connected(): void {
    if (this.state.left) return
    this.joined = false
    this.send({ type: "join", artifactId: this.artifactId })
    this.update({ connection: "online" })
  }

  /** The socket closed: others' presence goes with it, until they are heard of again. */
  disconnected(): void {
    this.joined = false
    const others = [...this.awareness.getStates().keys()].filter(
      (client) => client !== this.doc.clientID
    )
    awarenessProtocol.removeAwarenessStates(this.awareness, others, FROM_SERVER)
    if (this.state.connection !== "connecting") this.update({ connection: "offline" })
  }

  receive(message: ArtifactLiveServerMessage): void {
    switch (message.type) {
      case "joined": {
        this.joined = true
        this.update({ access: message.access, user: message.user, left: null })

        const step1 = encoding.createEncoder()
        syncProtocol.writeSyncStep1(step1, this.doc)
        this.sendSync(encoding.toUint8Array(step1))
        this.sendAwareness([this.doc.clientID])
        return
      }
      case "sync": {
        const bytes = decodeLiveData(message.data)
        if (!bytes) return

        const reply = encoding.createEncoder()
        const type = syncProtocol.readSyncMessage(
          decoding.createDecoder(bytes),
          reply,
          this.doc,
          FROM_SERVER
        )
        if (encoding.length(reply) > 0) this.sendSync(encoding.toUint8Array(reply))
        if (type === syncProtocol.messageYjsSyncStep2 && !this.state.synced) {
          this.update({ synced: true })
        }
        return
      }
      case "awareness": {
        const bytes = decodeLiveData(message.data)
        if (bytes) awarenessProtocol.applyAwarenessUpdate(this.awareness, bytes, FROM_SERVER)
        return
      }
      case "status": {
        const { state, revision, error } = message
        if (state === "saved") this.forget()
        this.update({
          save: { state, revision, ...(error ? { error } : {}) },
          pending: state !== "saved",
        })
        return
      }
      case "access":
        this.update({ access: message.access })
        return
      case "left":
        this.joined = false
        if (message.reason !== "left") this.forget()
        this.update({ left: message.reason })
        return
      case "error":
        console.warn(`[SixbApp] Live artifact '${this.artifactId}': ${message.message}`)
        return
      default:
        return
    }
  }

  /** Stops holding the artifact: the server is told, and the document freed. */
  destroy(): void {
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "local")
    if (this.joined) this.send({ type: "leave", artifactId: this.artifactId })
    this.joined = false
    this.doc.off("update", this.onUpdate)
    this.awareness.off("update", this.onAwareness)
    this.awareness.destroy()
    this.doc.destroy()
    this.listeners.clear()
  }

  private onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === FROM_SERVER) return

    // A change made offline, or by a watcher, waits: the next join's sync takes it.
    if (this.joined && this.state.access === "edit") {
      const message = encoding.createEncoder()
      syncProtocol.writeUpdate(message, update)
      this.sendSync(encoding.toUint8Array(message))
    }

    this.unsaved = this.unsaved ? Y.mergeUpdates([this.unsaved, update]) : update
    this.keeper.write(this.artifactId, this.unsaved)
    if (!this.state.pending) this.update({ pending: true })
  }

  /** The server saved what this page changed, or the artifact is gone: nothing is kept. */
  private forget(): void {
    this.unsaved = null
    this.keeper.clear(this.artifactId)
  }

  private onAwareness = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ): void => {
    if (origin === FROM_SERVER || !this.joined) return

    const own = [...changes.added, ...changes.updated, ...changes.removed].filter(
      (client) => client === this.doc.clientID
    )
    if (own.length > 0) this.sendAwareness(own)
  }

  private sendSync(bytes: Uint8Array): void {
    for (const message of liveSync(this.artifactId, bytes)) this.send(message)
  }

  private sendAwareness(clients: readonly number[]): void {
    const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...clients])
    this.send({ type: "awareness", artifactId: this.artifactId, data: encodeLiveData(update) })
  }

  private update(patch: Partial<LiveArtifactState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}

/** Opens the socket a hub speaks through: `createArtifactLiveSocket`, or a test's. */
export type LiveSocketFactory = (handlers: {
  readonly onConnected: () => void
  readonly onMessage: (message: ArtifactLiveServerMessage) => void
  readonly onClosed: () => void
}) => ArtifactLiveSocket

/**
 * The artifacts a page holds live, over one socket opened with the first and closed with the
 * last. Views acquire an artifact and release it; one no view holds for {@link LINGER_MS} leaves.
 */
export class LiveHub {
  private socket: ArtifactLiveSocket | null = null
  private online = false
  private readonly held = new Map<
    string,
    { readonly artifact: LiveArtifact; holders: number; linger?: ReturnType<typeof setTimeout> }
  >()

  constructor(
    private readonly open: LiveSocketFactory = openLiveSocket,
    private readonly keeper: LiveKeeper = browserKeeper
  ) {}

  acquire(artifactId: string): LiveArtifact {
    const entry = this.held.get(artifactId)
    if (entry) {
      entry.holders += 1
      if (entry.linger) clearTimeout(entry.linger)
      entry.linger = undefined
      return entry.artifact
    }

    const artifact = new LiveArtifact(
      artifactId,
      (message) => this.socket?.send(message) ?? false,
      this.keeper
    )
    this.held.set(artifactId, { artifact, holders: 1 })
    if (!this.socket) this.connect()
    else if (this.online) artifact.connected()
    return artifact
  }

  release(artifact: LiveArtifact): void {
    const entry = this.held.get(artifact.artifactId)
    if (!entry || entry.artifact !== artifact) return

    entry.holders -= 1
    if (entry.holders > 0) return

    this.linger(entry)
  }

  /**
   * Leaves an artifact no view holds after {@link LINGER_MS}, once the server took what was
   * changed in it: changes made offline, or whose view went away before they were saved, wait
   * in it for the next connection, and a view that comes back finds them.
   */
  private linger(entry: {
    readonly artifact: LiveArtifact
    linger?: ReturnType<typeof setTimeout>
  }) {
    const { artifact } = entry
    entry.linger = setTimeout(() => {
      const { pending, left } = artifact.getState()
      if (pending && !left) {
        this.linger(entry)
        return
      }

      this.held.delete(artifact.artifactId)
      artifact.destroy()
      if (this.held.size === 0) this.disconnect()
    }, LINGER_MS)
  }

  private connect(): void {
    this.socket = this.open({
      onConnected: () => {
        this.online = true
        for (const { artifact } of this.held.values()) artifact.connected()
      },
      onMessage: (message) => {
        const artifactId = "artifactId" in message ? message.artifactId : undefined
        const artifact = artifactId ? this.held.get(artifactId)?.artifact : undefined
        if (artifact) artifact.receive(message)
        else if (message.type === "error")
          console.warn(`[SixbApp] Live artifacts: ${message.message}`)
      },
      onClosed: () => {
        this.online = false
        for (const { artifact } of this.held.values()) artifact.disconnected()
      },
    })
  }

  private disconnect(): void {
    this.socket?.close()
    this.socket = null
    this.online = false
  }
}

function openLiveSocket(handlers: Parameters<LiveSocketFactory>[0]): ArtifactLiveSocket {
  let connected = false
  return createArtifactLiveSocket({
    onConnected: () => {
      connected = true
      handlers.onConnected()
    },
    onMessage: handlers.onMessage,
    onStateChange: (state) => {
      if (state.connected || !connected) return
      connected = false
      handlers.onClosed()
    },
  })
}
