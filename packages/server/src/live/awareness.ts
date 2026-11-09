import { createHash } from "node:crypto"
import {
  AGENT_AWARENESS_FIELD,
  type ArtifactLiveUser,
  USER_AWARENESS_FIELD,
} from "@sixb/core/artifacts/live"
import type { Storage } from "@sixb/core/storage"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"

// What a connection says of itself in awareness, as the server lets others see it: only its own
// clients' states, each naming the person the server knows it to be, and never the Agent's field,
// which only servers set.

/** The most awareness clients one connection may speak for: a browser tab holds one. */
export const MAX_AWARENESS_CLIENTS = 4
/** The most a client's awareness state may weigh, as JSON. */
export const MAX_AWARENESS_STATE_BYTES = 4 * 1024

/** Colors a person's cursor may take: one per person, the same wherever they connect. */
const COLORS = [
  "#e5484d",
  "#f76b15",
  "#ffc53d",
  "#46a758",
  "#12a594",
  "#0090ff",
  "#8e4ec6",
  "#d6409f",
] as const

/** What the project's own code, and everyone where nobody signs in, is called. */
export const PROJECT_NAME = "Project"

/**
 * The name others see for someone: a member's profile name, else their email, and the project's
 * for its own code. Null for anyone else, or a member the project no longer knows. Without
 * `email`, for a reader outside the project such as a shared link's guest, a member who gave no
 * name stays unnamed.
 */
export async function principalName(
  storage: Pick<Storage, "auth">,
  projectId: string,
  principal: { readonly type: string; readonly id: string },
  options: { readonly email?: boolean } = {}
): Promise<string | null> {
  if (principal.type === "system") return PROJECT_NAME
  if (principal.type !== "user") return null

  const record = await storage.auth?.users.getById({ projectId, id: principal.id })
  if (options.email === false) return record?.displayName ?? null
  return record?.displayName ?? record?.email ?? null
}

/**
 * Who a connection is: the member it signed in as, by their profile's name, or the service
 * account or project code it runs as.
 *
 * Everyone in the room sees it, a shared link's guest included, and the server shares one state
 * with all: so it is never an email, nor an id. Someone without a profile name has none, which the
 * app names in the reader's language.
 */
export async function liveUserOf(
  storage: Pick<Storage, "auth">,
  projectId: string,
  principal: { readonly type: string; readonly id: string } | undefined
): Promise<ArtifactLiveUser> {
  if (!principal) return { id: "system", name: PROJECT_NAME, color: colorOf("system") }

  const id = `${principal.type}:${principal.id}`
  const name = (await principalName(storage, projectId, principal, { email: false })) ?? ""
  return { id, name, color: colorOf(id) }
}

/**
 * Who a shared link's guest is: one per session, by the name they gave, or none yet, marked as a
 * guest so nobody takes them for a member of the same name.
 */
export function guestLiveUser(sessionId: string, name: string | undefined): ArtifactLiveUser {
  const id = `guest:${sessionId}`
  return { id, name: name ?? "", color: colorOf(id), guest: true }
}

/**
 * An awareness update from a connection, as the server takes it: only the clients it may speak
 * for, each state naming `user`, without the Agent's field, and within its size. Null when none is
 * left, or the update does not read.
 */
export function vouchedAwareness(
  update: Uint8Array,
  input: {
    readonly user: ArtifactLiveUser
    /** Whether the connection may speak for this awareness client. */
    readonly mayUse: (clientID: number) => boolean
  }
): Uint8Array | null {
  const entries: { clientID: number; clock: number; state: string }[] = []
  try {
    const decoder = decoding.createDecoder(update)
    const length = decoding.readVarUint(decoder)
    for (let index = 0; index < length; index += 1) {
      const clientID = decoding.readVarUint(decoder)
      const clock = decoding.readVarUint(decoder)
      const state = vouchedState(decoding.readVarString(decoder), input.user)
      if (state !== undefined && input.mayUse(clientID)) entries.push({ clientID, clock, state })
    }
  } catch {
    return null
  }
  if (entries.length === 0) return null

  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, entries.length)
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientID)
    encoding.writeVarUint(encoder, entry.clock)
    encoding.writeVarString(encoder, entry.state)
  }
  return encoding.toUint8Array(encoder)
}

/** A client's state as JSON, naming `user`; `null` stays, for a client that goes. */
function vouchedState(json: string, user: ArtifactLiveUser): string | undefined {
  if (json.length > MAX_AWARENESS_STATE_BYTES) return undefined

  const state: unknown = JSON.parse(json)
  if (state === null) return "null"
  if (typeof state !== "object" || Array.isArray(state)) return undefined

  const {
    [AGENT_AWARENESS_FIELD]: _agent,
    [USER_AWARENESS_FIELD]: _user,
    ...own
  } = state as Record<string, unknown>
  return JSON.stringify({ ...own, [USER_AWARENESS_FIELD]: user })
}

function colorOf(id: string): string {
  const index = createHash("sha256").update(id).digest()[0] ?? 0
  return COLORS[index % COLORS.length] as string
}
