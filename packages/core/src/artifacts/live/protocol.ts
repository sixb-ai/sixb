// The `/ws/artifacts` socket: JSON messages, each about one artifact the connection joined, with
// Yjs's own messages inside in base64. `sync` carries y-protocols' sync messages (step 1, step 2,
// update), `awareness` its awareness updates. A client joins, sends sync step 1, applies what it
// is sent, and sends its document's updates and its awareness as they happen.
//
// Only documents of one copy sync: `joined` names the copy the server holds. A client whose
// document came from another copy (the server reloaded the artifact, or another server holds it)
// starts from an empty document and, once in step, applies what it changed meanwhile with
// `mergeIntoDocument`.

/** Where an artifact is edited live. */
export const ARTIFACT_LIVE_ROUTE = "/ws/artifacts"

/** What a connection may do with an artifact it joined: edit it, or watch others edit it. */
export type ArtifactLiveAccess = "edit" | "watch"

export type ArtifactLiveClientMessage =
  | { readonly type: "join"; readonly artifactId: string }
  | { readonly type: "leave"; readonly artifactId: string }
  | { readonly type: "sync"; readonly artifactId: string; readonly data: string }
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
      /** The copy of the document the server holds; only a document of this copy syncs with it. */
      readonly document: string
    }
  | { readonly type: "sync"; readonly artifactId: string; readonly data: string }
  | { readonly type: "awareness"; readonly artifactId: string; readonly data: string }
  | {
      readonly type: "status"
      readonly artifactId: string
      readonly state: ArtifactLiveSaveState
      readonly revision: number
      readonly error?: string
    }
  /** The connection may now only watch: the person lost the right to change the artifact. */
  | { readonly type: "access"; readonly artifactId: string; readonly access: ArtifactLiveAccess }
  | { readonly type: "left"; readonly artifactId: string; readonly reason: ArtifactLiveLeftReason }
  | { readonly type: "error"; readonly artifactId?: string; readonly message: string }

/**
 * The awareness field the server sets for the Agent while a turn changes boards of the canvas:
 * each turn at work, with the boards it changed. Every other field is what clients set.
 */
export const AGENT_AWARENESS_FIELD = "sixbAgent"

export interface ArtifactAgentPresence {
  readonly runId: string
  readonly boards: readonly string[]
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
