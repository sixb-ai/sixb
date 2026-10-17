/** Frames for this repo's packages: the server issues and serves them, with the kit and runtime. */

export { FRAME_ASSET_PREFIX, SLIDES_ENTRY } from "../publish/validate/slides"
export {
  ARTIFACT_FRAME_ROUTE_PREFIX,
  type ArtifactFrame,
  createArtifactFrame,
  resolveArtifactFrame,
} from "./grants"
export { FRAME_KIT_CSS } from "./kit"
export { frameRuntime } from "./runtime"
