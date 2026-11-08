import type { SixbHostView } from "@sixb/core"
import type {
  ArtifactLiveClientMessage,
  ArtifactLiveServerMessage,
} from "@sixb/core/artifacts/live"
import { type LiveConnection, LiveRoom, type LiveRoomHost } from "./room"

/** How many artifacts one connection may hold live at once. */
export const MAX_LIVE_ARTIFACTS_PER_CONNECTION = 16

/**
 * The artifacts this server holds live, one room each, opened by the first connection that joins
 * and closed a while after the last leaves, once its changes are written back. Every room learns of the
 * artifact's writes from the project's events, wherever they were made.
 */
export class LiveRooms {
  private readonly rooms = new Map<string, Promise<LiveRoom | "not_found" | "not_live">>()
  /** The artifacts each connection joined. */
  private readonly joined = new Map<string, Set<string>>()
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
        await room?.sync(connection.id, message.data)
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
    for (const artifactId of [...(this.joined.get(connection.id) ?? [])]) {
      await this.leave(connection, artifactId)
    }
    this.joined.delete(connection.id)
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
    const unsubscribe = await this.events
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
    const held = this.joined.get(connection.id) ?? new Set<string>()
    if (held.has(artifactId)) return
    if (held.size >= MAX_LIVE_ARTIFACTS_PER_CONNECTION) {
      send({
        type: "error",
        artifactId,
        message: `[SixbServer] A connection holds at most ${MAX_LIVE_ARTIFACTS_PER_CONNECTION} artifacts live: leave one first.`,
      })
      return
    }

    const access = await connection.sixb.artifacts.access(artifactId)
    if (access === null || access === "none") {
      send({ type: "left", artifactId, reason: access === null ? "not_found" : "not_shared" })
      return
    }

    const room = await this.open(artifactId)
    if (!(room instanceof LiveRoom)) {
      send({ type: "left", artifactId, reason: room })
      return
    }

    held.add(artifactId)
    this.joined.set(connection.id, held)
    room.join(connection, access === "read" ? "watch" : "edit")
  }

  private async leave(connection: LiveConnection, artifactId: string): Promise<void> {
    const held = this.joined.get(connection.id)
    if (!held?.delete(artifactId)) return

    const room = await this.rooms.get(artifactId)
    if (room instanceof LiveRoom) room.leave(connection.id)
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
    this.events = this.host.events.subscribe(
      { from: "latest", types: ["artifact.updated"] },
      async (events) => {
        for (const event of events) {
          if (event.type !== "artifact.updated") continue
          const room = await this.rooms.get(event.payload.artifactId)
          if (room instanceof LiveRoom) room.written(event.payload.revision)
        }
      }
    )
  }
}
