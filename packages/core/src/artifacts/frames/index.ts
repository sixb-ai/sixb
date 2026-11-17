/**
 * Frames for this repo's packages: the server issues and serves them, with the kit and runtime,
 * and the Agent's layout check lays a version out in them.
 */

// A frozen designed document as its frame shows it: the values written in, none read again.
export { frozenDocumentHtml } from "../document-fill"
export { HTML_ENTRY } from "../publish/validate/html"
// What a frame's `sixb.query` reads: the route serves it, and the layout check serves it too.
export {
  type SerializedArtifactQueryResult,
  serializeArtifactQueryResult,
} from "../serialize-query"
export {
  FRAME_ASSETS,
  FRAME_CDN_ALLOWLIST,
  FRAME_REFERENCE_PATH,
  FRAME_REFERENCE_PREFIX,
  injectFrameAssets,
  markDocumentSections,
  rewriteFrameReferences,
} from "./assets"
export { type FrameLayout, frameEntries, frameLayout } from "./entries"
export { ARTIFACT_FRAME_ROUTE_PREFIX, createArtifactFrame, resolveArtifactFrame } from "./grants"
export { FRAME_DEFAULT_THEMES } from "./kit"
export { type LayoutProblem, layoutProbe } from "./probe"
