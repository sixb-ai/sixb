import { CANVAS_FILE, type Canvas, parseCanvas } from "@sixb/core/artifacts"
import { useOptionalTheme } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import { useArtifactEditing, useReportDraft } from "../../edit-session"
import { type History, recordChange, redoChange, startHistory, undoChange } from "../../history"
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
export function useCanvas(version: ArtifactVersion): Canvas | null | undefined {
  const file = useFileText(versionFileSource(version, CANVAS_FILE))
  return useMemo(() => {
    if (file.text === undefined) return file.loading ? undefined : null
    const parsed = parseCanvas(file.text)
    return "canvas" in parsed ? parsed.canvas : null
  }, [file.text, file.loading])
}

/** A canvas artifact: its board, in the app's theme or its own, opened where an address points. */
export function CanvasRenderer({
  version,
  part,
}: {
  readonly version: ArtifactVersion
  readonly part?: string
}) {
  const messages = useArtifactMessages()
  const theme = useArtifactThemeAttributes(version)
  const app = useOptionalTheme()?.resolvedTheme
  const canvas = useCanvas(version)
  const draft = useCanvasDraft(canvas)
  // The board draws in the mode its theme.json pins, else the app's.
  const mode =
    theme.className === "dark" || theme.className === "light"
      ? theme.className
      : (app ??
        (typeof document !== "undefined" && document.documentElement.classList.contains("dark")
          ? "dark"
          : "light"))
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
          {...(draft.edit ? { edit: draft.edit } : {})}
          version={version}
          title={version.title}
          mode={mode}
          {...(part ? { focus: part } : {})}
        />
      </Suspense>
    </div>
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
