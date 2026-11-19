/**
 * Publishing for this repo's packages: the Agent publishes through the same checks as the API, and
 * the pictures of a canvas's boards, and what is derived of a version's media, are kept beside
 * what it publishes.
 */

export { BOARD_PREVIEW_JOB } from "../canvas-display"
export { artifactAccessRule, artifactQueryChecker } from "../execution"
export { isArtifactId } from "../ids"
export { ARTIFACT_LIMITS, artifactSizeLimits } from "../limits"
export {
  isMediaFile,
  MAX_MEDIA_DURATION_MS,
  MEDIA_JOB,
  MEDIA_PARTS,
  type MediaJobBudget,
  mapMediaParts,
  mediaJobBudget,
  unmadeMediaParts,
} from "../media/media"
export { artifactQueryName, DOCUMENT_HOLDER_QUERY } from "../queries"
export { artifactThemeModes } from "../theme"
export {
  VIDEO_ENGINE,
  VIDEO_EXPORT_JOB,
  VIDEO_SEGMENT_JOB,
  VIDEO_SEGMENT_SETTINGS,
  type VideoExportPlan,
  type VideoMediaFile,
  type VideoSegment,
  videoExportJobId,
  videoExportKeys,
  videoExportPlan,
  videoExportStatus,
  videoSegmentJobId,
  videoSegmentTimeoutMs,
} from "../video/export"
export {
  frameAtOrBefore,
  playTogether,
  videoFrameCount,
  videoSegmentIndex,
  videoSegmentRender,
} from "../video/project"
export {
  missingVideoStills,
  VIDEO_STILL_WIDTH,
  VIDEO_STILLS_JOB,
  type VideoStill,
  videoPoster,
  videoStillKey,
  videoStills,
} from "../video/stills"
export {
  DOCUMENT_PDF_JOB,
  documentPdfKey,
  MAX_DOCUMENT_PDF_BYTES,
} from "./pdf"
export {
  BOARD_PREVIEW_MEDIA_TYPES,
  type BoardPreviewInput,
  type BoardPreviewStatus,
  boardPreview,
  boardPreviewStatuses,
  boardPreviews,
  boardsReadLiveData,
  MAX_BOARD_PREVIEW_BYTES,
  type MissingBoardPreview,
  missingBoardPreviews,
  type RefusedBoardPreview,
  storeBoardPreviews,
} from "./previews"
export {
  artifactVersionWarnings,
  type PreparedArtifactVersion,
  type PublishArtifactInput,
  type PublishedArtifact,
  prepareArtifactVersion,
  publishArtifact,
  storeArtifactVersion,
} from "./publish"
export {
  type ArtifactQueryAnswer,
  type ArtifactQueryAnswers,
  answerArtifactQueries,
  parseArtifactQueryAnswers,
} from "./query-answers"
export { readVideoVersion, type VideoVersionRead } from "./validate/video"
export { videoSceneFiles } from "./video"
