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
  patchText,
} from "./document"
