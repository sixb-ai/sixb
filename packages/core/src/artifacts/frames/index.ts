/**
 * Frames for this repo's packages: the server issues and serves them, with the kit and runtime,
 * and the Agent's layout check lays a version out in them.
 */

export { HTML_ENTRY } from "../publish/validate/html"
export {
  FRAME_ASSETS,
  FRAME_REFERENCE_PREFIX,
  injectFrameAssets,
  rewriteFrameReferences,
} from "./assets"
export { type FrameLayout, frameEntries, frameLayout } from "./entries"
export { ARTIFACT_FRAME_ROUTE_PREFIX, createArtifactFrame, resolveArtifactFrame } from "./grants"
export { FRAME_DEFAULT_THEMES } from "./kit"
export { type LayoutProblem, layoutProbe } from "./probe"
