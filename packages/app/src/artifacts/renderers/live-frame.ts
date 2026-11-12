import { type FrameEvent, type FrameZoom, parseFrameEvent } from "@sixb/core/artifacts"
import { boardFramePatches } from "@sixb/core/artifacts/live"
import { useCallback, useEffect, useRef, useState } from "react"
import type { ArtifactFrameHandle } from "../frame"
import { useLiveBoardSource } from "../live/boards"
import type { LiveArtifact } from "../live/session"
import { type ArtifactVersion, useFileText, versionFileSource } from "../queries"
import { showablePatches } from "./canvas/board-source"

// A page edited in place in its frame, as a canvas's board and a designed document are.
//
// The frame serves the page as a stored version holds it, marked for editing; the live document
// holds it as everyone is changing it now. The frame is kept at the version it loaded and told,
// element by element, what changed since (`edit.patch`), so typing goes on under the caret while
// others change other elements. It loads a newer version only when the elements themselves
// changed, or a picture it does not hold yet is shown, and then once the stored version holds it.
//
//   frame ── edit.select ──▶ the element picked                     (the reader's own click)
//         ── edit.text ───▶ the page's Y.Text, merged               (only for the element picked)
//         ◀─ edit.patch ── what the document changed since the frame's version

/**
 * Follows a page's frame and the live document together: the version it shows, kept until it
 * must move, what it showed last, and the patches that bring it to what the document holds.
 */
export function useLiveFrame({
  version,
  file,
  live,
}: {
  readonly version: ArtifactVersion
  /** The page's path in the version. */
  readonly file: string
  readonly live: LiveArtifact | null
}) {
  const source = useLiveBoardSource(live, file)
  const patching = source !== null
  const [pinned, setPinned] = useState(version)
  const shows = patching ? pinned : version
  const stored = useFileText(patching ? versionFileSource(pinned, file) : null).text

  const handle = useRef<ArtifactFrameHandle | null>(null)
  /** Each load the frame said it is ready, for what follows to start over. */
  const [loads, setLoads] = useState(0)
  /** What the frame shows now, once patched past its version's page. */
  const shown = useRef<string | null>(null)
  /** Pictures the reader just uploaded, shown from their bytes until a version holds them. */
  const previews = useRef(new Map<string, string>())
  /** The frame must load a newer version: the elements changed, or a picture is missing. */
  const [stale, setStale] = useState(false)
  /**
   * The elements themselves changed: the frame's addresses name other elements than the
   * document's, so nothing is edited through it until it loads a version that has them.
   */
  const [moved, setMoved] = useState(false)
  const [holding, setHolding] = useState(false)

  const ready = useCallback(() => {
    shown.current = null
    setLoads((count) => count + 1)
  }, [])

  // What the document holds now, as patches to what the frame shows.
  useEffect(() => {
    if (loads === 0 || stored === undefined || source === null) return

    const patches = boardFramePatches(shown.current ?? stored, source)
    if (patches === null) {
      setStale(true)
      setMoved(true)
      return
    }
    setMoved(false)

    const holds = (path: string) => shows.files.some((each) => each.path === path)
    const showable = showablePatches(patches, file, holds, previews.current)
    if (showable.waiting) setStale(true)
    shown.current = source
    if (showable.patches.length === 0) return

    handle.current?.send("edit.patch", { patches: showable.patches }).catch(() => {})
  }, [loads, stored, source, shows, file])

  // A stale frame loads the version the viewer has now once it is past the one it shows, and
  // while the reader is not typing in it, unless what they type in is no longer where it was.
  useEffect(() => {
    if (!stale || (holding && !moved) || version.revision <= pinned.revision) return
    setStale(false)
    setPinned(version)
  }, [stale, holding, moved, version, pinned.revision])

  /** Loads the frame's page again, as what it shows can no longer be patched. */
  const resync = useCallback(() => {
    shown.current = null
    handle.current?.send("reload", {}).catch(() => {})
  }, [])

  return {
    shows,
    source,
    handle,
    loads,
    ready,
    resync,
    stale,
    moved,
    previews: previews.current,
    hold: setHolding,
  }
}

export type LiveFrame = ReturnType<typeof useLiveFrame>

/**
 * Turns the frame's editing on as `on` and `typing` say, each time it loads, and passes on what
 * it reports. Each load gets a port of its own, handed over with its first `edit` request: what
 * editing reports comes through it alone, never through the window, where the page's scripts post
 * too. While the frame's elements are not the document's, it neither picks nor types.
 */
export function useFrameEditing({
  frame,
  on,
  typing,
  onEdit,
  onZoom,
}: {
  readonly frame: LiveFrame
  /** Clicks pick elements instead of following them. */
  readonly on: boolean
  /** A text element picked takes the reader's typing. */
  readonly typing: boolean
  readonly onEdit: (event: FrameEvent) => void
  /** The reader zoomed over the page: the frame passes it on instead of the browser zooming. */
  readonly onZoom?: ((zoom: FrameZoom) => void) | undefined
}): void {
  const port = useRef<{ readonly mine: MessagePort; handed: MessagePort | null } | null>(null)
  const onEditRef = useRef(onEdit)
  onEditRef.current = onEdit
  const onZoomRef = useRef(onZoom)
  onZoomRef.current = onZoom

  useEffect(() => {
    if (frame.loads === 0) return
    const channel = new MessageChannel()
    channel.port1.onmessage = (message: MessageEvent) => {
      const event = parseFrameEvent(message.data)
      if (event?.event === "zoom") onZoomRef.current?.(event.params)
      else if (event?.event.startsWith("edit.")) onEditRef.current(event)
    }
    port.current = { mine: channel.port1, handed: channel.port2 }
    return () => channel.port1.close()
  }, [frame.loads])

  const send = frame.handle
  useEffect(() => {
    if (frame.loads === 0) return
    const handed = port.current?.handed
    if (port.current) port.current.handed = null
    send.current
      ?.send("edit", { on: on && !frame.moved, typing }, handed ? [handed] : [])
      .catch(() => {})
  }, [frame.loads, frame.moved, on, typing, send])
}
