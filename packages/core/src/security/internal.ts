/**
 * Marking plumbing for this repo's hosts and workers, not for app authors.
 *
 * `checkPipelineMarkings` is the SQL preflight the API server and CLI run before serving. The
 * projection worker shares the host's version classifier with `shareDatasetVersionMarkings`, then
 * classifies each pinned version and refuses one with `assertProjectionVersionMarkings`. The API
 * server reads the versions projections applied ahead of its first request with
 * `warmAppliedMarkings`, and the CLI reports what they add with `getAppliedMarkings`.
 */
export { getAppliedMarkings, warmAppliedMarkings } from "./applied-markings-host"
export type {
  DatasetVersionMarkings,
  VersionClassification,
  VersionColumnMarkings,
} from "./dataset-version-markings"
export { getDatasetVersionMarkings, shareDatasetVersionMarkings } from "./dataset-version-markings"
export { checkPipelineMarkings } from "./pipeline-markings"
export { assertProjectionVersionMarkings } from "./projection-markings"
