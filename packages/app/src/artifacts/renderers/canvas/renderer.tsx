import { CANVAS_FILE, type Canvas, parseCanvas } from "@sixb/core/artifacts"
import { useOptionalTheme } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useArtifactEditing, useReportDraft } from "../../edit-session"
import { type History, recordChange, redoChange, startHistory, undoChange } from "../../history"
import { type LiveCanvas, liveCanvasOf } from "../../live/canvas"
import { useLiveArtifactState, useViewerLiveArtifact } from "../../live/hooks"
import { shareSelection } from "../../live/presence"
import type { LiveArtifact } from "../../live/session"
import { useArtifactMessages } from "../../messages"
import { type ArtifactVersion, useFileText, versionFileSource } from "../../queries"
import { useArtifactThemeAttributes } from "../../theme"
import { ViewerLoading, ViewerNotice } from "../notice"
import { canvasFiles } from "./draft"
import type { CanvasEditor } from "./edit-mode"

const CanvasBoard = lazy(() => import("./canvas"))

/**
 * A version's `canvas.json`, parsed once it is read: undefined until then, and null when it
 * cannot be read or does not parse.
 */
export function useCanvas(
  version: ArtifactVersion,
  options: { readonly enabled?: boolean } = {}
): Canvas | null | undefined {
  const file = useFileText(
    options.enabled === false ? null : versionFileSource(version, CANVAS_FILE)
  )
  return useMemo(() => {
    if (file.text === undefined) return file.loading ? undefined : null
    const parsed = parseCanvas(file.text)
    return "canvas" in parsed ? parsed.canvas : null
  }, [file.text, file.loading])
}

/** The mode a canvas's boards draw in: the one its theme.json pins, else the app's. */
export function useCanvasMode(version: ArtifactVersion): "light" | "dark" {
  const theme = useArtifactThemeAttributes(version)
  const app = useOptionalTheme()?.resolvedTheme

  if (theme.className === "dark" || theme.className === "light") return theme.className

  return (
    app ??
    (typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? "dark"
      : "light")
  )
}

/**
 * A canvas artifact: its board, in the app's theme or its own, opened where an address points.
 * Held live by the viewer, it is drawn from its live document once that holds it, everyone's
 * changes as they make them, and edited there; else from the version's `canvas.json`, edited as
 * a draft the header saves.
 */
export function CanvasRenderer({
  version,
  part,
}: {
  readonly version: ArtifactVersion
  readonly part?: string
}) {
  const messages = useArtifactMessages()
  const theme = useArtifactThemeAttributes(version)
  const mode = useCanvasMode(version)
  const live = useViewerLiveArtifact()
  const liveState = useLiveArtifactState(live)
  const liveCanvas = live && liveState.synced && !liveState.left ? liveCanvasOf(live) : null
  const fromDocument = useLiveCanvas(liveCanvas)
  const fromVersion = useCanvas(version, { enabled: !fromDocument })
  const canvas = fromDocument ?? fromVersion
  const editing = useArtifactEditing()
  const liveEdit = useLiveEditor(
    live,
    fromDocument && editing && liveState.access === "edit" ? liveCanvas : null
  )
  const draft = useCanvasDraft(fromDocument ? undefined : canvas)
  const loading = <ViewerLoading label={messages.viewer.loading} />
  if (canvas === undefined) return loading
  if (canvas === null) return <ViewerNotice title={messages.canvas.loadFailed} />
  return (
    <div
      data-sixb-artifact=""
      className={cn("flex min-h-0 flex-1 flex-col", theme.className)}
      style={theme.style}
    >
      <Suspense fallback={loading}>
        <CanvasBoard
          canvas={draft.canvas ?? canvas}
          {...(liveEdit ? { edit: liveEdit } : draft.edit ? { edit: draft.edit } : {})}
          {...(fromDocument && live ? { live } : {})}
          version={version}
          title={version.title}
          mode={mode}
          {...(part ? { focus: part } : {})}
        />
      </Suspense>
    </div>
  )
}

const noSubscription = () => () => {}
const nothing = () => null

/** The canvas a live document holds, as it changes; null while there is none. */
function useLiveCanvas(canvas: LiveCanvas | null): Canvas | null {
  return useSyncExternalStore(
    canvas?.subscribe ?? noSubscription,
    canvas?.getCanvas ?? nothing,
    nothing
  )
}

/**
 * Editing the live document: each change written for everyone at once, this reader's own taken
 * back by undo, and what they select shown to the others. Null while not editing.
 */
function useLiveEditor(live: LiveArtifact | null, canvas: LiveCanvas | null): CanvasEditor | null {
  return useMemo<CanvasEditor | null>(
    () =>
      live && canvas
        ? {
            apply: (change) => canvas.apply(change),
            undo: () => canvas.undo(),
            redo: () => canvas.redo(),
            live: {
              stopCapturing: () => canvas.stopCapturing(),
              select: (ids) => shareSelection(live, ids),
            },
          }
        : null,
    [live, canvas]
  )
}

/**
 * The canvas as the reader arranges it, while the viewer is editing: each change a step for undo,
 * and the draft reported to the header's Save. Leaving editing drops it.
 */
function useCanvasDraft(canvas: Canvas | null | undefined): {
  readonly canvas: Canvas | null
  readonly edit: CanvasEditor | null
} {
  const editing = useArtifactEditing()
  const [history, setHistory] = useState<History<Canvas> | null>(null)
  useEffect(() => {
    setHistory((last) => (editing && canvas ? (last ?? startHistory(canvas)) : null))
  }, [editing, canvas])
  const active = editing && history !== null
  const edit = useMemo<CanvasEditor | null>(
    () =>
      active
        ? {
            apply: (change) =>
              setHistory((last) => (last ? recordChange(last, change(last.present)) : last)),
            undo: () => setHistory((last) => (last ? undoChange(last) : last)),
            redo: () => setHistory((last) => (last ? redoChange(last) : last)),
          }
        : null,
    [active]
  )
  const report = useMemo(() => {
    if (!active || !history || !canvas) return null
    return {
      changed: history.present !== canvas,
      files: () => canvasFiles(canvas, history.present),
      ...(history.past.length > 0 && edit ? { undo: edit.undo } : {}),
      ...(history.future.length > 0 && edit ? { redo: edit.redo } : {}),
    }
  }, [active, history, canvas, edit])
  useReportDraft(report)
  return { canvas: active ? (history?.present ?? null) : null, edit }
}
