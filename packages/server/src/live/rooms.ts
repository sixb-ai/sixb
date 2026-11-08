import type { SixbHostView } from "@sixb/core"
import {
  type ArtifactLiveClientMessage,
  type ArtifactLiveServerMessage,
  type ArtifactLiveUser,
  decodeLiveData,
} from "@sixb/core/artifacts/live"
import { liveUserOf } from "./awareness"
import { type LiveConnection, LiveRoom, type LiveRoomHost } from "./room"

/** How many artifacts one connection may hold live at once. */
export const MAX_LIVE_ARTIFACTS_PER_CONNECTION = 16
/** The largest sync message a connection may send in parts: four boards' worth of HTML. */
export const MAX_LIVE_SYNC_BYTES = 8 * 1024 * 1024

/**
 * The artifacts this server holds live, one room each, opened by the first connection that joins
 * and closed once the last leaves and its changes are written back. Every room learns of the
 * artifact's writes from the project's events, wherever they were made.
 */
export class LiveRooms {
  private readonly rooms = new Map<string, Promise<LiveRoom | "not_found" | "not_live">>()
  /**
   * The artifacts each connection joined, or is joining: the slot is taken before the join reads
   * anything, so joins at once count against the cap, and each is its own ticket, so a join that
   * resumes once the connection left, or joined again, knows it is stale.
   */
  private readonly joined = new Map<string, Map<string, symbol>>()
  /** Who each connection is, read once. */
  private readonly users = new Map<string, Promise<ArtifactLiveUser>>()
  /** The parts of a sync message a connection is sending, by connection and artifact. */
  private readonly parts = new Map<string, { chunks: Uint8Array[]; bytes: number }>()
  private events: Promise<() => void> | undefined
  private closed = false

  constructor(private readonly host: LiveRoomHost & { readonly events: SixbHostView["events"] }) {}

  /** Handles a message from a connection. */
  async receive(connection: LiveConnection, message: ArtifactLiveClientMessage): Promise<void> {
    switch (message.type) {
      case "join":
        return this.join(connection, message.artifactId)
      case "leave":
        return this.leave(connection, message.artifactId)
      case "sync": {
        const room = await this.held(connection, message.artifactId)
        const bytes = room && this.assemble(connection, message)
        if (bytes) await room.sync(connection.id, bytes)
        return
      }
      case "awareness": {
        const room = await this.held(connection, message.artifactId)
        room?.presence(connection.id, message.data)
        return
      }
    }
  }

  /** Leaves every artifact a connection holds: it closed. */
  async disconnect(connection: LiveConnection): Promise<void> {
    for (const artifactId of [...(this.joined.get(connection.id)?.keys() ?? [])]) {
      await this.leave(connection, artifactId)
    }
    this.joined.delete(connection.id)
    this.users.delete(connection.id)
  }

  /**
   * Writes back what every room holds unwritten, then stops them and the events feed: the server
   * stops.
   */
  async close(): Promise<void> {
    this.closed = true
    for (const opening of this.rooms.values()) {
      const room = await opening.catch(() => null)
      if (!(room instanceof LiveRoom)) continue
      room.save()
      await room.settled()
      room.close()
    }
    this.rooms.clear()
    const unsubscribe = await this.events?.catch(() => undefined)
    unsubscribe?.()
  }

  /** Settles once every room's queued work is done. */
  async settled(): Promise<void> {
    for (const opening of [...this.rooms.values()]) {
      const room = await opening.catch(() => null)
      if (room instanceof LiveRoom) await room.settled()
    }
  }

  /**
   * Joins a connection to an artifact it may read: to edit it when it may change it, to watch it
   * otherwise. One it may not read, or that is not edited live, is refused with why.
   */
  private async join(connection: LiveConnection, artifactId: string): Promise<void> {
    const send = (message: ArtifactLiveServerMessage) => connection.send(message)
    const held = this.joined.get(connection.id) ?? new Map<string, symbol>()
    if (held.has(artifactId)) return
    if (held.size >= MAX_LIVE_ARTIFACTS_PER_CONNECTION) {
      send({
        type: "error",
        artifactId,
        message: `[SixbServer] A connection holds at most ${MAX_LIVE_ARTIFACTS_PER_CONNECTION} artifacts live: leave one first.`,
      })
      return
    }

    // Taken now, before anything is read: what follows waits, and other joins run meanwhile.
    const ticket = Symbol(artifactId)
    held.set(artifactId, ticket)
    this.joined.set(connection.id, held)
    const current = () => this.joined.get(connection.id)?.get(artifactId) === ticket
    const release = () => {
      if (current()) this.joined.get(connection.id)?.delete(artifactId)
    }

    try {
      const access = await connection.sixb.artifacts.access(artifactId)
      if (access === null || access === "none") {
        release()
        send({ type: "left", artifactId, reason: access === null ? "not_found" : "not_shared" })
        return
      }

      const user = await this.userOf(connection)
      const room = await this.open(artifactId)
      if (!(room instanceof LiveRoom)) {
        release()
        send({ type: "left", artifactId, reason: room })
        return
      }

      // The connection left, or closed, while this read: it is not here, and a room this join
      // opened for it closes again. Otherwise it joins now, before the room can close.
      if (!current()) {
        room.closeIfUnheld()
        return
      }
      room.join(connection, access === "read" ? "watch" : "edit", user)
    } catch (error) {
      release()
      throw error
    }
  }

  private userOf(connection: LiveConnection): Promise<ArtifactLiveUser> {
    const known = this.users.get(connection.id)
    if (known) return known

    const user = liveUserOf(
      this.host.storage,
      this.host.projectId,
      connection.sixb.execution.requestedBy
    )
    this.users.set(connection.id, user)
    return user
  }

  /** Leaves an artifact, as asked: the connection is told it left, once it did. */
  private async leave(connection: LiveConnection, artifactId: string): Promise<void> {
    this.parts.delete(partsKey(connection, artifactId))
    const held = this.joined.get(connection.id)
    if (!held?.delete(artifactId)) return

    const room = await this.rooms.get(artifactId)
    if (room instanceof LiveRoom) room.leave(connection.id)
    connection.send({ type: "left", artifactId, reason: "left" })
  }

  /**
   * The bytes of a whole sync message: this one's, or, on its last part, every part's. Null while
   * parts are still to come, and for a message that is not base64 or grew too large.
   */
  private assemble(
    connection: LiveConnection,
    message: Extract<ArtifactLiveClientMessage, { type: "sync" }>
  ): Uint8Array | null {
    const key = partsKey(connection, message.artifactId)
    const bytes = decodeLiveData(message.data)
    const parts = this.parts.get(key)
    const size = (parts?.bytes ?? 0) + (bytes?.length ?? 0)

    if (!bytes || size > MAX_LIVE_SYNC_BYTES) {
      this.parts.delete(key)
      connection.send({
        type: "error",
        artifactId: message.artifactId,
        message: bytes
          ? `[SixbServer] A sync message holds at most ${MAX_LIVE_SYNC_BYTES} bytes.`
          : "[SixbServer] A sync message's data is base64.",
      })
      return null
    }

    if (message.more) {
      this.parts.set(key, { chunks: [...(parts?.chunks ?? []), bytes], bytes: size })
      return null
    }
    if (!parts) return bytes

    this.parts.delete(key)
    const whole = new Uint8Array(size)
    let offset = 0
    for (const chunk of [...parts.chunks, bytes]) {
      whole.set(chunk, offset)
      offset += chunk.length
    }
    return whole
  }

  /** The room of an artifact the connection joined. */
  private async held(connection: LiveConnection, artifactId: string): Promise<LiveRoom | null> {
    if (!this.joined.get(connection.id)?.has(artifactId)) {
      connection.send({
        type: "error",
        artifactId,
        message: "[SixbServer] Join the artifact before sending it changes.",
      })
      return null
    }
    const room = await this.rooms.get(artifactId)
    return room instanceof LiveRoom ? room : null
  }

  /** The artifact's room, opened once however many join at once; a refusal is not kept. */
  private async open(artifactId: string): Promise<LiveRoom | "not_found" | "not_live"> {
    const existing = await this.rooms.get(artifactId)
    if (existing instanceof LiveRoom && !existing.isClosed) return existing

    this.followEvents()
    const opening = LiveRoom.open(this.host, artifactId, () => {
      // A room reopened since holds the entry now.
      if (this.rooms.get(artifactId) === opening) this.rooms.delete(artifactId)
    })
    this.rooms.set(artifactId, opening)
    const room = await opening.catch((error: unknown) => {
      this.rooms.delete(artifactId)
      throw error
    })
    if (!(room instanceof LiveRoom)) this.rooms.delete(artifactId)
    return room
  }

  /** Every write to an artifact a room holds reaches it, whichever server or worker made it. */
  private followEvents(): void {
    if (this.events || this.closed) return
    const following = this.host.events.subscribe(
      { from: "latest", types: ["artifact.updated"] },
      async (events) => {
        for (const event of events) {
          if (event.type !== "artifact.updated") continue
          const room = await this.rooms.get(event.payload.artifactId)
          if (room instanceof LiveRoom) room.written(event.payload.revision)
        }
      }
    )
    // A feed that could not start is asked for again by the next room that opens.
    this.events = following
    following.catch((error: unknown) => {
      if (this.events === following) this.events = undefined
      console.error("[SixbServer] Could not follow the artifacts' writes:", error)
    })
  }
}

function partsKey(connection: LiveConnection, artifactId: string): string {
  return `${connection.id}\n${artifactId}`
}
