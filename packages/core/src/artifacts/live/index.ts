/**
 * An artifact edited live, as a viewer holds it: its open version as a Yjs document that everyone
 * editing it changes at once, read as files or, for a canvas, as its items; and the messages of
 * the `/ws/artifacts` socket that keeps it in step. Browser-safe.
 */

export {
  type BlockMark,
  type BlockNode,
  blocksToMarkdown,
  markdownToBlocks,
} from "./blocks"
export {
  annotateBoard,
  applyBoardEditToText,
  type BoardChange,
  type BoardEdit,
  type BoardElement,
  type BoardElementKind,
  type BoardFramePatch,
  type BoardStyleProperty,
  boardElement,
  boardElements,
  boardFilePath,
  boardFramePatches,
  boardTextHash,
  mergeBoardText,
  setBoardImage,
  setBoardStyle,
  setBoardText,
} from "./board"
export {
  canvasItemMap,
  canvasItemObject,
  documentCanvas,
  documentFiles,
  LIVE_FILES,
  type LiveFile,
  type LiveFiles,
  mergeCanvasItem,
} from "./document"
export {
  AGENT_AWARENESS_FIELD,
  ARTIFACT_LIVE_ROUTE,
  type ArtifactAgentPresence,
  type ArtifactLiveAccess,
  type ArtifactLiveClientMessage,
  type ArtifactLiveLeftReason,
  type ArtifactLiveSaveState,
  type ArtifactLiveServerMessage,
  type ArtifactLiveUser,
  decodeLiveData,
  encodeLiveData,
  liveSync,
  USER_AWARENESS_FIELD,
} from "./protocol"
