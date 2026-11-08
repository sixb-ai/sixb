/**
 * An artifact edited live, as a viewer holds it: its open version as a Yjs document that everyone
 * editing it changes at once, read as files or, for a canvas, as its items; and the messages of
 * the `/ws/artifacts` socket that keeps it in step. Browser-safe.
 */

export {
  documentCanvas,
  documentFiles,
  documentKind,
  isLiveTextPath,
  LIVE_FILES,
  type LiveFile,
  type LiveFiles,
  mergeIntoDocument,
  patchText,
} from "./document"
export {
  AGENT_AWARENESS_FIELD,
  ARTIFACT_LIVE_ROUTE,
  type ArtifactAgentPresence,
  type ArtifactLiveAccess,
  type ArtifactLiveClientMessage,
  type ArtifactLiveLeftReason,
  type ArtifactLiveSaveState,
  type ArtifactLiveServerMessage,
  decodeLiveData,
  encodeLiveData,
} from "./protocol"
