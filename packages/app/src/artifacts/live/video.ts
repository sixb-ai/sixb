import {
  applyBoardEditToText,
  LIVE_FILES,
  readVideoComposition,
  readVideoFileTimeline,
  VIDEO_ENTRY,
  type VideoComposition,
  type VideoEditResult,
  type VideoFileTimeline,
  type VideoSources,
} from "@sixb/core/artifacts/live"
import type { FileRef } from "@sixb/core/blob-storage"
import * as Y from "yjs"
import type { LiveArtifact } from "./session"

// A video as its live document holds it: `index.html` and each scene a `Y.Text`, each recording
// the reference to its stored bytes.
//
// Reading: the files are read again as the document changes, at most once a frame, into the video
// the editor lays out: its composition, as publishing reads it, and each file's clips. A file
// nobody changed keeps the same timeline object, so a track draws again only when its file does.
//
// Writing: an edit is worked out by `@sixb/core`'s video module from the files as they are, and
// written into the document as the characters it changes, in one transaction under this video's
// own origin: only those are this reader's to undo. A recording added joins the video for good,
// outside the undo, as a canvas's pictures do.

/** The origin of a file an import adds: kept whatever the reader undoes. */
const KEPT_FILES = Symbol("sixb-live-video-kept-files")

/** How long changes made one after the other are one step for undo; each edit ends its own. */
const UNDO_CAPTURE_MS = 400

const NO_HISTORY = { undo: false, redo: false }

/** The video a live document holds now, as the editor lays it out. */
export interface LiveVideoState {
  /** Every file: an HTML file's text, null for a recording or a picture. */
  readonly sources: VideoSources
  /** As publishing reads it; null when the files no longer read as a video, as `error` says. */
  readonly composition: VideoComposition | null
  readonly error?: string
  /** `index.html`'s own clips and each scene's, by path. */
  readonly timelines: ReadonlyMap<string, VideoFileTimeline>
}

const EMPTY: LiveVideoState = { sources: new Map(), composition: null, timelines: new Map() }

/** Runs `run` before the next frame is drawn; a timer standing for one where there are none. */
function requestFrame(run: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const frame = requestAnimationFrame(run)
    return () => cancelAnimationFrame(frame)
  }
  const timer = setTimeout(run, 16)
  return () => clearTimeout(timer)
}

export class LiveVideo {
  private state: LiveVideoState = EMPTY
  private stale = true
  private readonly listeners = new Set<() => void>()
  private readonly undoManager: Y.UndoManager
  private history: { readonly undo: boolean; readonly redo: boolean } = NO_HISTORY
  private cancelFrame: (() => void) | null = null
  /** The origin of this reader's own changes: the only ones its undo takes back. */
  readonly origin = Symbol("sixb-live-video")

  constructor(private readonly doc: Y.Doc) {
    const files = doc.getMap<unknown>(LIVE_FILES)
    files.observeDeep(this.onChange)
    this.undoManager = new Y.UndoManager(files, {
      trackedOrigins: new Set([this.origin]),
      captureTimeout: UNDO_CAPTURE_MS,
    })
    this.undoManager.on("stack-item-added", this.onHistory)
    this.undoManager.on("stack-item-popped", this.onHistory)
    this.undoManager.on("stack-cleared", this.onHistory)
  }

  /** The video now. What changed since it was last read is read in first. */
  getState = (): LiveVideoState => {
    if (this.stale) this.read()
    return this.state
  }

  getHistory = (): { readonly undo: boolean; readonly redo: boolean } => this.history

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Makes an edit worked out from the video now, as one step of this reader's undo. Returns why
   * it was refused, or null once it is made.
   */
  apply(make: (sources: VideoSources) => VideoEditResult): string | null {
    const result = make(this.getState().sources)
    if ("error" in result) return result.error
    if (result.edit.length === 0) return null

    const files = this.doc.getMap<unknown>(LIVE_FILES)
    this.undoManager.stopCapturing()
    this.doc.transact(() => {
      for (const file of result.edit) {
        if ("remove" in file) {
          files.delete(file.path)
        } else if ("create" in file) {
          files.set(file.path, new Y.Text(file.create))
        } else {
          const text = files.get(file.path)
          if (text instanceof Y.Text) applyBoardEditToText(text, file.changes)
        }
      }
    }, this.origin)
    this.undoManager.stopCapturing()
    return null
  }

  /** The path of a file of the video holding the bytes `digest` names, when one does. */
  fileWithDigest(digest: string): string | undefined {
    for (const [path, value] of this.doc.getMap<unknown>(LIVE_FILES)) {
      if (value instanceof Y.AbstractType || typeof value !== "object" || value === null) continue
      if ((value as { readonly digest?: unknown }).digest === digest) return path
    }
    return undefined
  }

  /** Adds a file the reader uploaded, for good: undoing the clip that plays it leaves it. */
  addFile(path: string, ref: FileRef): void {
    this.doc.transact(() => {
      this.doc.getMap<unknown>(LIVE_FILES).set(path, { ...ref })
    }, KEPT_FILES)
  }

  undo(): void {
    this.undoManager.undo()
  }

  redo(): void {
    this.undoManager.redo()
  }

  stopCapturing(): void {
    this.undoManager.stopCapturing()
  }

  destroy(): void {
    this.cancelFrame?.()
    this.doc.getMap<unknown>(LIVE_FILES).unobserveDeep(this.onChange)
    this.undoManager.destroy()
    this.listeners.clear()
  }

  private onChange = (_events: unknown, transaction: Y.Transaction): void => {
    this.stale = true
    // This reader's own edits show at once; everyone else's, once a frame.
    if (transaction.origin === this.origin || transaction.local) {
      this.cancelFrame?.()
      this.cancelFrame = null
      this.notify()
      return
    }
    this.cancelFrame ??= requestFrame(() => {
      this.cancelFrame = null
      this.notify()
    })
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  /** Reads the files again, keeping the timeline of each file whose text did not change. */
  private read(): void {
    this.stale = false
    const before = this.state
    const sources = new Map<string, string | null>()
    this.doc.getMap<unknown>(LIVE_FILES).forEach((entry, path) => {
      sources.set(path, entry instanceof Y.Text ? entry.toString() : null)
    })

    const timelines = new Map<string, VideoFileTimeline>()
    for (const [path, text] of sources) {
      if (text === null || !/\.html?$/i.test(path)) continue
      const kept = before.timelines.get(path)
      if (kept && before.sources.get(path) === text) {
        timelines.set(path, kept)
        continue
      }
      const timeline = readVideoFileTimeline(path, text)
      if (timeline) timelines.set(path, timeline)
    }

    const index = sources.get(VIDEO_ENTRY)
    const read =
      typeof index === "string"
        ? readVideoComposition(index, (path) => {
            const text = sources.get(path)
            return typeof text === "string" ? text : undefined
          })
        : { error: `A video needs '${VIDEO_ENTRY}'.` }

    this.state =
      "error" in read
        ? { sources, composition: before.composition, error: read.error, timelines }
        : { sources, composition: read.composition, timelines }
  }

  private onHistory = (): void => {
    const next = {
      undo: this.undoManager.undoStack.length > 0,
      redo: this.undoManager.redoStack.length > 0,
    }
    if (next.undo === this.history.undo && next.redo === this.history.redo) return
    this.history = next
    this.notify()
  }
}

const videos = new WeakMap<LiveArtifact, LiveVideo>()

/** The video of a live artifact, one per artifact, so the editor and the header share its undo. */
export function liveVideoOf(artifact: LiveArtifact): LiveVideo {
  let video = videos.get(artifact)
  if (!video) {
    video = new LiveVideo(artifact.doc)
    videos.set(artifact, video)
  }
  return video
}
