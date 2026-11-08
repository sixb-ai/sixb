// The `/ws/artifacts` socket: JSON messages, each about one artifact the connection joined, with
// Yjs's own messages inside in base64. `sync` carries y-protocols' sync messages (step 1, step 2,
// update), `awareness` its awareness updates. A client joins, sends sync step 1, applies what it
// is sent, and sends its document's updates and its awareness as they happen.
//
// Every copy of an artifact's document, a client's or a server's, continues the history storage
// keeps, so a client that reconnects, to any server, syncs what it changed while away.

/** Where an artifact is edited live. */
export const ARTIFACT_LIVE_ROUTE = "/ws/artifacts"

/** What a connection may do with an artifact it joined: edit it, or watch others edit it. */
export type ArtifactLiveAccess = "edit" | "watch"

/** The most bytes one `sync` message carries: a larger one is sent in parts, as {@link liveSync} splits it. */
export const LIVE_SYNC_PART_BYTES = 32 * 1024

export type ArtifactLiveClientMessage =
  | { readonly type: "join"; readonly artifactId: string }
  | { readonly type: "leave"; readonly artifactId: string }
  | {
      readonly type: "sync"
      readonly artifactId: string
      readonly data: string
      /** The message goes on in the next `sync`, whose bytes follow these. */
      readonly more?: true
    }
  | { readonly type: "awareness"; readonly artifactId: string; readonly data: string }

/**
 * What the server's copy of the document has written back into the open version: `saved` at
 * `revision`, `unsaved` changes waiting, `saving`, or `failed` with why, until the next attempt.
 */
export type ArtifactLiveSaveState = "saved" | "unsaved" | "saving" | "failed"

/** Why a connection no longer holds an artifact. */
export type ArtifactLiveLeftReason = "not_found" | "not_shared" | "not_live" | "left"

export type ArtifactLiveServerMessage =
  | { readonly type: "connected"; readonly channel: "artifacts" }
  | {
      readonly type: "joined"
      readonly artifactId: string
      readonly access: ArtifactLiveAccess
      readonly revision: number
      /** Who the connection is in the awareness states the server shares. */
      readonly user: ArtifactLiveUser
    }
  | { readonly type: "sync"; readonly artifactId: string; readonly data: string }
  | { readonly type: "awareness"; readonly artifactId: string; readonly data: string }
  | {
      readonly type: "status"
      readonly artifactId: string
      readonly state: ArtifactLiveSaveState
      readonly revision: number
      /**
       * What is written back, as a Yjs snapshot in base64: its state vector and its delete set. A
       * client forgets the changes it kept once this covers them, insertions and deletions, and
       * keeps those it does not, as one sent while this was being written.
       */
      readonly snapshot: string
      readonly error?: string
    }
  /** The connection may now only watch: the person lost the right to change the artifact. */
  | { readonly type: "access"; readonly artifactId: string; readonly access: ArtifactLiveAccess }
  | { readonly type: "left"; readonly artifactId: string; readonly reason: ArtifactLiveLeftReason }
  /** A comment changed, as `artifact.commented` says: read the comments again. */
  | {
      readonly type: "commented"
      readonly artifactId: string
      readonly commentId: string
      readonly parentId?: string
      readonly action: "created" | "resolved" | "reopened" | "deleted"
    }
  | { readonly type: "error"; readonly artifactId?: string; readonly message: string }

/**
 * Who a connection is, as the server says in each awareness state it shares as `user`: whatever
 * a client sets there itself is replaced.
 */
export interface ArtifactLiveUser {
  readonly id: string
  readonly name: string
  /** A color for the person's cursor and selection, the same wherever they connect. */
  readonly color: string
}

/** The awareness field that names who an awareness state is. */
export const USER_AWARENESS_FIELD = "user"

/**
 * The awareness field the server sets for the Agent while a turn changes boards of the canvas:
 * each turn at work, with the boards it changed. A client's own state never holds it.
 */
export const AGENT_AWARENESS_FIELD = "sixbAgent"

export interface ArtifactAgentPresence {
  readonly runId: string
  readonly boards: readonly string[]
}

/**
 * A y-protocols sync message as the `sync` messages that carry it: one, or parts for one larger
 * than a socket message may be.
 */
export function liveSync(artifactId: string, bytes: Uint8Array): ArtifactLiveClientMessage[] {
  const messages: ArtifactLiveClientMessage[] = []
  for (let start = 0; start === 0 || start < bytes.length; start += LIVE_SYNC_PART_BYTES) {
    const end = start + LIVE_SYNC_PART_BYTES
    const data = encodeLiveData(bytes.subarray(start, end))
    messages.push(
      end < bytes.length
        ? { type: "sync", artifactId, data, more: true }
        : { type: "sync", artifactId, data }
    )
  }
  return messages
}

/** Bytes as the socket carries them. */
export function encodeLiveData(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

/** The bytes the socket carried; null for text that is not base64. */
export function decodeLiveData(data: string): Uint8Array | null {
  try {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}
