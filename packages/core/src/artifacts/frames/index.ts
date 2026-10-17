/**
 * Frames for this repo's packages: the server issues and serves them, with the kit and runtime,
 * and the Agent's layout check lays a deck out in them.
 */

export { SLIDES_ENTRY } from "../publish/validate/slides"
export { FRAME_ASSETS, FRAME_DEFAULT_THEMES, injectFrameAssets } from "./assets"
export {
  ARTIFACT_FRAME_ROUTE_PREFIX,
  createArtifactFrame,
  resolveArtifactFrame,
} from "./grants"
export { type LayoutProblem, layoutProbe } from "./probe"
