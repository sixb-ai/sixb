import {
  AGENT_AWARENESS_FIELD,
  type ArtifactAgentPresence,
  type ArtifactLiveUser,
  USER_AWARENESS_FIELD,
} from "@sixb/core/artifacts/live"
import { useCallback, useSyncExternalStore } from "react"
import type { LiveArtifact } from "./session"

// Who is on a live artifact, from its awareness: each connection's state, which the server stamps
// with who the person is (`user`), and the server's own, which says which boards an Agent turn is
// changing. A connection says itself what it has selected.

/** The awareness field a connection selects items in, by id. */
export const SELECTION_FIELD = "selection"

/** Someone on the artifact, from one of their connections: a person may have several. */
export interface LivePeer {
  readonly clientId: number
  readonly user: ArtifactLiveUser
  /** The items they have selected. */
  readonly selection: readonly string[]
}

export interface LivePresence {
  /** Everyone else's connections, in the order they came. */
  readonly peers: readonly LivePeer[]
  /** The people among them, once each, for the avatars. */
  readonly people: readonly ArtifactLiveUser[]
  /** The Agent's turns at work, and the boards each is changing. */
  readonly agents: readonly ArtifactAgentPresence[]
}

const NOBODY: LivePresence = { peers: [], people: [], agents: [] }

const presences = new WeakMap<
  LiveArtifact,
  { value: LivePresence; readonly listeners: Set<() => void> }
>()

/** The presence of a live artifact, read again whenever its awareness changes. */
function presenceOf(artifact: LiveArtifact) {
  let entry = presences.get(artifact)
  if (entry) return entry

  const created = { value: readPresence(artifact), listeners: new Set<() => void>() }
  // Awareness changes with every caret that moves, this reader's own included: only a change to
  // who is here, or to what they selected, is told to the readers of it.
  artifact.awareness.on("change", () => {
    const next = readPresence(artifact)
    if (JSON.stringify(next) === JSON.stringify(created.value)) return
    created.value = next
    for (const listener of created.listeners) listener()
  })
  entry = created
  presences.set(artifact, entry)
  return entry
}

function readPresence(artifact: LiveArtifact): LivePresence {
  const own = artifact.doc.clientID
  const peers: LivePeer[] = []
  const agents: ArtifactAgentPresence[] = []
  for (const [clientId, state] of artifact.awareness.getStates()) {
    if (clientId === own) continue

    agents.push(...agentsOf(state[AGENT_AWARENESS_FIELD]))
    const user = userOf(state[USER_AWARENESS_FIELD])
    if (!user) continue

    const selection = state[SELECTION_FIELD]
    peers.push({
      clientId,
      user,
      selection: Array.isArray(selection)
        ? selection.filter((id): id is string => typeof id === "string")
        : [],
    })
  }
  if (peers.length === 0 && agents.length === 0) return NOBODY

  const self = artifact.getState().user?.id
  const people = new Map<string, ArtifactLiveUser>()
  for (const peer of peers) {
    if (peer.user.id !== self && !people.has(peer.user.id)) people.set(peer.user.id, peer.user)
  }
  return { peers, people: [...people.values()], agents }
}

/**
 * What a person on the artifact is called: the name the server gives them, else "Guest" for a
 * shared link's visitor who gave none, and "Team member" for a member without a profile name.
 */
export function livePersonName(
  user: ArtifactLiveUser,
  labels: { readonly guest: string; readonly teamMember: string }
): string {
  return user.name || (user.guest ? labels.guest : labels.teamMember)
}

function userOf(value: unknown): ArtifactLiveUser | null {
  if (typeof value !== "object" || value === null) return null
  const { id, name, color, guest } = value as Record<string, unknown>
  if (typeof id !== "string" || typeof name !== "string" || typeof color !== "string") return null
  return { id, name, color, ...(guest === true ? { guest } : {}) }
}

function agentsOf(value: unknown): ArtifactAgentPresence[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return []
    const { runId, boards } = entry as Record<string, unknown>
    if (typeof runId !== "string" || !Array.isArray(boards)) return []
    return [{ runId, boards: boards.filter((id): id is string => typeof id === "string") }]
  })
}

const noSubscription = () => () => {}

/** Who else is on a live artifact, and what the Agent is changing, as it changes. */
export function useLivePresence(artifact: LiveArtifact | null): LivePresence {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!artifact) return noSubscription()
      const entry = presenceOf(artifact)
      entry.listeners.add(listener)
      return () => {
        entry.listeners.delete(listener)
      }
    },
    [artifact]
  )
  return useSyncExternalStore(
    subscribe,
    () => (artifact ? presenceOf(artifact).value : NOBODY),
    () => NOBODY
  )
}

/** Says to the others what this reader has selected. */
export function shareSelection(artifact: LiveArtifact, ids: readonly string[]): void {
  const current = artifact.awareness.getLocalState()?.[SELECTION_FIELD]
  if (
    Array.isArray(current) &&
    current.length === ids.length &&
    current.every((id, index) => id === ids[index])
  ) {
    return
  }
  artifact.awareness.setLocalStateField(SELECTION_FIELD, [...ids])
}
