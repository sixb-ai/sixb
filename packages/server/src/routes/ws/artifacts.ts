import { randomUUID } from "node:crypto"
import { ARTIFACT_LIVE_ROUTE, type ArtifactLiveClientMessage } from "@sixb/core/artifacts/live"
import type { Elysia } from "elysia"
import { z } from "zod"
import { guestLiveUser } from "../../live/awareness"
import type { LiveConnection } from "../../live/room"
import { LiveRooms } from "../../live/rooms"
import type { SixbServer } from "../../server"
import {
  decodeWsMessage,
  safeSend,
  wsRequestSixb,
  wsSharedSession,
  wsStateKey,
} from "../../utils/ws"
import type { ClosableSocket, SharedSockets } from "./shared-sockets"

const ArtifactId = z.string().min(1).max(200)

const LiveMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), artifactId: ArtifactId }),
  z.object({ type: z.literal("leave"), artifactId: ArtifactId }),
  z.object({
    type: z.literal("sync"),
    artifactId: ArtifactId,
    data: z.string().min(1),
    more: z.literal(true).optional(),
  }),
  z.object({ type: z.literal("awareness"), artifactId: ArtifactId, data: z.string().min(1) }),
])

/**
 * The message as JSON. Elysia hands a JSON text over parsed, and the live messages carry their
 * bytes in `data`, which `decodeWsMessage` would take for a wrapper: a parsed message is kept.
 */
async function decodeLiveMessage(message: unknown): Promise<unknown> {
  if (typeof message === "object" && message !== null && "type" in message) return message
  return decodeWsMessage(message)
}

export function parseArtifactLiveMessage(
  payload: unknown
): { ok: true; data: ArtifactLiveClientMessage } | { ok: false; error: string } {
  const parsed = LiveMessageSchema.safeParse(payload)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid websocket message." }
  }
  return { ok: true, data: parsed.data }
}

/**
 * `/ws/artifacts`: artifacts edited live, through Yjs's sync and awareness protocols. Whoever may
 * change an artifact edits it; whoever may only read it watches, a shared link's guest included,
 * under the name they gave. See `../../live/README.md`.
 */
export function registerArtifactLiveRoutes(app: Elysia, server: SixbServer, shared: SharedSockets) {
  const host = server.getHost()
  const rooms = new LiveRooms({
    projectId: host.id,
    storage: host.storage,
    blobStorage: host.blobStorage,
    broker: host.broker,
    events: host.events,
    instance: randomUUID(),
    errorReporterHost: host,
  })
  const connections = new WeakMap<object, LiveConnection>()
  /** The socket's connection, as the person its request authenticated. */
  const connectionOf = (
    ws: ClosableSocket & { send: (message: string) => void }
  ): LiveConnection | null => {
    const known = connections.get(wsStateKey(ws))
    if (known) return known

    const sixb = wsRequestSixb(ws)
    if (!sixb) return null

    // A guest's SDK names nobody: their session says who they are, as it is when they join.
    const guest = wsSharedSession(ws)
    const connection: LiveConnection = {
      id: randomUUID(),
      sixb,
      send: (message) => safeSend(ws, message),
      ...(guest
        ? {
            user: async () => guestLiveUser(guest.sessionId, (await shared.session(ws))?.guestName),
          }
        : {}),
    }
    connections.set(wsStateKey(ws), connection)
    return connection
  }

  app.onStop(() => rooms.close())
  return app.ws(ARTIFACT_LIVE_ROUTE, {
    open(ws) {
      // A guest who gives their name shows under it, in every artifact they hold live.
      shared.open(ws, () => {
        const connection = connections.get(wsStateKey(ws))
        if (connection) void rooms.refreshUser(connection)
      })
      safeSend(ws, { type: "connected", channel: "artifacts" })
    },

    async message(ws, message) {
      if (!(await shared.holds(ws))) return
      const connection = connectionOf(ws)
      if (!connection) {
        safeSend(ws, { type: "error", message: "Execution scope is not available." })
        return
      }

      const parsed = parseArtifactLiveMessage(await decodeLiveMessage(message))
      if (!parsed.ok) {
        safeSend(ws, { type: "error", message: parsed.error })
        return
      }

      try {
        await rooms.receive(connection, parsed.data)
      } catch (error) {
        console.error("[SixbServer] A live artifact message failed:", error)
        safeSend(ws, {
          type: "error",
          artifactId: parsed.data.artifactId,
          message: "[SixbServer] The live artifact could not handle that message.",
        })
      }
    },

    async close(ws) {
      shared.close(ws)
      const connection = connections.get(wsStateKey(ws))
      connections.delete(wsStateKey(ws))
      if (connection) await rooms.disconnect(connection)
    },
  })
}
