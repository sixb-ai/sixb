import type { FrameEmbed } from "@sixb/core/artifacts"
import { isMobileViewport, useIsMobile } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useCallback, useRef, useState } from "react"
import { ArtifactFrame, type ArtifactFrameHandle } from "../frame"
import { FrameEmbeds } from "../frame-embeds"
import { useArtifactMessages } from "../messages"
import type { ArtifactVersion } from "../queries"
import { useArtifactThemeAttributes } from "../theme"
import { ViewerLoading, ViewerNotice } from "./notice"
import { FrameScreen, usePageEvents } from "./page"

/** How wide a designed document draws without paper: a Letter sheet's width. */
const SHEET_WIDTH = 816

/** Whether a version is a designed document, `document.html` with its own stylesheets. */
export function isDesignedDocument(version: Pick<ArtifactVersion, "outline">): boolean {
  return version.outline.kind === "document" && version.outline.format === "html"
}

/**
 * A designed document: its `document.html` in a sandboxed frame, styled by its own stylesheets.
 * With paper, it shows as the pages it prints on. A phone shows those too small to read, so there
 * it is one sheet whose text wraps to the screen, with a gap where each page breaks. The view
 * follows the window across that width; there is nothing to choose. The artifacts it embeds are
 * drawn over it where it puts them.
 */
export function DesignedDocumentRenderer({
  version,
  part,
}: {
  readonly version: ArtifactVersion
  /** The section to open at, by its slug. */
  readonly part?: string
}) {
  const messages = useArtifactMessages()
  const theme = useArtifactThemeAttributes(version)
  const frame = useRef<ArtifactFrameHandle | null>(null)
  // The hook answers false until its effect runs, so the first render reads the width itself.
  const phone = useIsMobile() || isMobileViewport()
  const pages = version.outline.kind === "document" && !!version.outline.paper && !phone
  const [embeds, setEmbeds] = useState<readonly FrameEmbed[]>([])
  // The embeds a view reported are placed for its layout, not the next one's.
  const [laidOut, setLaidOut] = useState(pages)
  if (laidOut !== pages) {
    setLaidOut(pages)
    setEmbeds([])
  }
  const onEvent = usePageEvents(version, { onEmbeds: setEmbeds })
  const scroll = useCallback((delta: { readonly x: number; readonly y: number }) => {
    frame.current?.send("scroll", delta).catch(() => {})
  }, [])

  return (
    <div
      data-sixb-artifact=""
      className={cn("flex min-h-0 flex-1 flex-col bg-background", theme.className)}
      style={theme.style}
    >
      <ArtifactFrame
        handle={frame}
        version={version}
        title={messages.document.frame(version.title)}
        start={{ pages, ...(part ? { section: part } : {}) }}
        onEvent={onEvent}
        className="flex-1"
        fallback={<ViewerLoading label={messages.viewer.loading} />}
        failure={<ViewerNotice title={messages.document.loadFailed} />}
        overlay={<FrameEmbeds version={version} embeds={embeds} onScroll={scroll} />}
      />
    </div>
  )
}

/**
 * A designed document's first page, live and scaled down to its card: as a sheet of its paper
 * when it has one, else the top of its one sheet.
 */
export function DesignedDocumentScreen({ version }: { readonly version: ArtifactVersion }) {
  const paper = version.outline.kind === "document" ? version.outline.paper : undefined
  // The stage's padding on either side of the sheet, as the kit lays pages out.
  return paper ? (
    <FrameScreen version={version} width={paper.width + 32} start={{ pages: true }} />
  ) : (
    <FrameScreen version={version} width={SHEET_WIDTH + 64} />
  )
}
