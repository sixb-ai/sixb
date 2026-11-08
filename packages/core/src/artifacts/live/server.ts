/**
 * The live layer for this repo's packages: the server builds an artifact's document from its open
 * version, merges what others wrote into it, and writes it back.
 */

export { createArtifactDocument } from "./document"
export { readLiveFiles, sameArtifactFiles, storeLiveFiles } from "./files"
export {
  AGENT_PRESENCE_MS,
  appendArtifactLive,
  artifactLiveStream,
  parseArtifactLiveRecord,
} from "./presence"
