/**
 * Marking plumbing for this repo's hosts and workers, not for app authors.
 *
 * `checkPipelineMarkings` is the SQL preflight the API server and CLI run before serving. The
 * projection worker shares the host's version classifier with `shareDatasetVersionMarkings`, then
 * classifies each pinned version and refuses one with `assertProjectionVersionMarkings`.
 */
export type {
  DatasetVersionMarkings,
  VersionClassification,
  VersionColumnMarkings,
} from "./dataset-version-markings"
export { getDatasetVersionMarkings, shareDatasetVersionMarkings } from "./dataset-version-markings"
export { checkPipelineMarkings } from "./pipeline-markings"
export { assertProjectionVersionMarkings } from "./projection-markings"
