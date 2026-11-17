/**
 * The live layer for this repo's packages: the server loads an artifact's document from storage,
 * follows what others write into it, and writes it back.
 */

export { type LiveArtifactWrite, writeLiveArtifact } from "../execution"
export { mergeIntoDocument, readChange } from "./document"
export { readLiveFiles, sameArtifactFiles, storeLiveFiles } from "./files"
export {
  AGENT_PRESENCE_MS,
  appendArtifactLive,
  artifactLiveStream,
  artifactPresenceStream,
  parseArtifactLiveRecord,
} from "./presence"
export { keepsDocument, loadArtifactDocument, readDocumentState } from "./state"
