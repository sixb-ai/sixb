import { LIVE_FILES } from "@sixb/core/artifacts/live"
import type { FileRef } from "@sixb/core/blob-storage"
import { useCallback, useMemo, useSyncExternalStore } from "react"
import * as Y from "yjs"
import type { LiveArtifact } from "./session"

// A board's page as the live document holds it, read as it changes: someone typing in it, the
// Agent writing it, or the whole file replaced.

/** A board's page in the document now; null when the document holds none at that path as text. */
export function liveBoardSource(doc: Y.Doc, path: string): string | null {
  const entry = doc.getMap<unknown>(LIVE_FILES).get(path)
  return entry instanceof Y.Text ? entry.toString() : null
}

/** The files the document holds as stored bytes, by path: the pictures a board may show. */
export function liveStoredFiles(doc: Y.Doc): ReadonlyMap<string, FileRef> {
  const files = new Map<string, FileRef>()
  doc.getMap<unknown>(LIVE_FILES).forEach((entry, path) => {
    if (entry instanceof Y.Text || entry instanceof Y.Map) return
    if (isFileRef(entry)) files.set(path, entry)
  })
  return files
}

function isFileRef(value: unknown): value is FileRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { blobId?: unknown }).blobId === "string"
  )
}

/**
 * Follows a board's page in a live artifact's document: the text it holds now, read again as it
 * changes, and when the file at its path is replaced. Null without a document, or a page there.
 */
export function useLiveBoardSource(live: LiveArtifact | null, path: string): string | null {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!live) return () => {}

      const files = live.doc.getMap<unknown>(LIVE_FILES)
      let text: Y.Text | null = null
      const follow = () => {
        text?.unobserve(listener)
        const entry = files.get(path)
        text = entry instanceof Y.Text ? entry : null
        text?.observe(listener)
      }
      const onFiles = (event: Y.YMapEvent<unknown>) => {
        if (!event.keysChanged.has(path)) return
        follow()
        listener()
      }

      follow()
      files.observe(onFiles)
      return () => {
        files.unobserve(onFiles)
        text?.unobserve(listener)
      }
    },
    [live, path]
  )

  return useSyncExternalStore(
    subscribe,
    () => (live ? liveBoardSource(live.doc, path) : null),
    () => null
  )
}

/** Follows the files a live artifact's document holds as stored bytes, as they are added. */
export function useLiveStoredFiles(live: LiveArtifact | null): ReadonlyMap<string, FileRef> {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!live) return () => {}
      const files = live.doc.getMap<unknown>(LIVE_FILES)
      files.observe(listener)
      return () => files.unobserve(listener)
    },
    [live]
  )
  const snapshot = useCallback(() => (live ? storedFilesKey(live.doc) : ""), [live])
  const key = useSyncExternalStore(subscribe, snapshot, () => "")

  // The key stands for the files: the map is read again only when it changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as the key changes.
  return useMemo(() => (live ? liveStoredFiles(live.doc) : new Map()), [live, key])
}

function storedFilesKey(doc: Y.Doc): string {
  return [...liveStoredFiles(doc)].map(([path, ref]) => `${path}:${ref.digest}`).join("\n")
}
