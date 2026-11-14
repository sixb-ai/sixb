import { applyBoardEditToText, type BoardEdit, LIVE_FILES } from "@sixb/core/artifacts/live"
import * as Y from "yjs"
import type { LiveArtifact } from "./session"

// A designed document as its live document holds it: `document.html` as a `Y.Text`, which the
// reader types into element by element. Each change is made under this document's own origin,
// so undo takes back the reader's own words and never anyone else's.

/** How long changes made one after the other are one step for undo, as typing a word is. */
const UNDO_CAPTURE_MS = 400

const NO_HISTORY = { undo: false, redo: false }

export class LiveDocument {
  private readonly undoManager: Y.UndoManager
  private readonly listeners = new Set<() => void>()
  private history: { readonly undo: boolean; readonly redo: boolean } = NO_HISTORY
  /** The origin of this reader's own changes: the only ones its undo takes back. */
  readonly origin = Symbol("sixb-live-document")

  constructor(private readonly doc: Y.Doc) {
    this.undoManager = new Y.UndoManager(doc.getMap<unknown>(LIVE_FILES), {
      trackedOrigins: new Set([this.origin]),
      captureTimeout: UNDO_CAPTURE_MS,
    })
    this.undoManager.on("stack-item-added", this.onHistory)
    this.undoManager.on("stack-item-popped", this.onHistory)
    this.undoManager.on("stack-cleared", this.onHistory)
  }

  getHistory = (): { readonly undo: boolean; readonly redo: boolean } => this.history

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Makes an edit to a file, worked out from what it holds now, as one step of this reader's
   * undo. False when the document holds no such text; `make` throws when the edit no longer
   * applies.
   */
  editFile(path: string, make: (source: string) => BoardEdit): boolean {
    const text = this.doc.getMap<unknown>(LIVE_FILES).get(path)
    if (!(text instanceof Y.Text)) return false
    applyBoardEditToText(text, make(text.toString()), this.origin)
    return true
  }

  undo(): void {
    this.undoManager.undo()
  }

  redo(): void {
    this.undoManager.redo()
  }

  /** Ends the undo step being made: typing in another element is a step of its own. */
  stopCapturing(): void {
    this.undoManager.stopCapturing()
  }

  destroy(): void {
    this.undoManager.destroy()
    this.listeners.clear()
  }

  private onHistory = (): void => {
    const next = {
      undo: this.undoManager.undoStack.length > 0,
      redo: this.undoManager.redoStack.length > 0,
    }
    if (next.undo === this.history.undo && next.redo === this.history.redo) return
    this.history = next
    for (const listener of this.listeners) listener()
  }
}

const documents = new WeakMap<LiveArtifact, LiveDocument>()

/** The document of a live artifact, one per artifact, so the frame and the header share its undo. */
export function liveDocumentOf(artifact: LiveArtifact): LiveDocument {
  let document = documents.get(artifact)
  if (!document) {
    document = new LiveDocument(artifact.doc)
    documents.set(artifact, document)
  }
  return document
}
