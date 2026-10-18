import { CANVAS_FILE, type Canvas, parseCanvas } from "@sixb/core/artifacts"
import { useOptionalTheme } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { lazy, Suspense, useMemo } from "react"
import { useArtifactMessages } from "../../messages"
import { type ArtifactVersion, useFileText, versionFileSource } from "../../queries"
import { useArtifactThemeAttributes } from "../../theme"
import { ViewerLoading, ViewerNotice } from "../notice"

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
          canvas={canvas}
          version={version}
          title={version.title}
          mode={mode}
          {...(part ? { focus: part } : {})}
        />
      </Suspense>
    </div>
  )
}
