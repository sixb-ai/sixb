import type { FrameEditTarget, FrameEmbed, FrameEvent } from "@sixb/core/artifacts"
import { mergeBoardText } from "@sixb/core/artifacts/live"
import { isMobileViewport, useIsMobile } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { useArtifactEditing } from "../edit-session"
import { ArtifactFrame, type ArtifactFrameHandle } from "../frame"
import { FrameEmbeds } from "../frame-embeds"
import { useLiveBoardSource } from "../live/boards"
import { liveDocumentOf } from "../live/document"
import { useLiveArtifactState, useViewerLiveArtifact } from "../live/hooks"
import type { LiveArtifact } from "../live/session"
import { useArtifactMessages } from "../messages"
import { type ArtifactVersion, useFileText, versionFileSource } from "../queries"
import { useArtifactThemeAttributes } from "../theme"
import { useFrameEditing, useLiveFrame } from "./live-frame"
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
 *
 * Held live and edited, it is one sheet whose words the reader types into in place, element by
 * element, for everyone at once: as pages, every page after the first shows a copy, and only the
 * original takes typing. Once they are done, it stays that sheet until the stored version holds
 * their words, then shows its pages again.
 */
export function DesignedDocumentRenderer({
  version,
  part,
}: {
  readonly version: ArtifactVersion
  /** The section to open at, by its slug. */
  readonly part?: string
}) {
  const live = useViewerLiveArtifact()
  const state = useLiveArtifactState(live)
  const editing = useArtifactEditing()
  const held = live && state.synced && !state.left ? live : null
  const typing = editing && state.access === "edit" ? held : null
  const settling = useSettling(version, held, typing !== null)

  return (
    <DocumentStage version={version}>
      {typing ? (
        <DocumentEditor version={version} live={typing} typing />
      ) : settling ? (
        <DocumentEditor version={version} live={settling} typing={false} />
      ) : (
        <DocumentReader version={version} {...(part ? { part } : {})} />
      )}
    </DocumentStage>
  )
}

/** The artifact's theme around whichever frame shows the document. */
function DocumentStage({
  version,
  children,
}: {
  readonly version: ArtifactVersion
  readonly children: ReactNode
}) {
  const theme = useArtifactThemeAttributes(version)
  return (
    <div
      data-sixb-artifact=""
      className={cn("flex min-h-0 flex-1 flex-col bg-background", theme.className)}
      style={theme.style}
    >
      {children}
    </div>
  )
}

/**
 * The live artifact while the stored version does not yet hold what the reader typed, from the
 * moment they stop editing; null otherwise. Their words are written back a moment after they
 * stop, and the version that holds them arrives after that.
 */
function useSettling(
  version: ArtifactVersion,
  live: LiveArtifact | null,
  typing: boolean
): LiveArtifact | null {
  const [settling, setSettling] = useState(false)
  // Set as the render that ends typing is made, so the pages never show in between.
  const [typed, setTyped] = useState(typing)
  if (typed !== typing) {
    setTyped(typing)
    setSettling(!typing)
  }

  const following = settling ? live : null
  const source = useLiveBoardSource(following, version.entry)
  const stored = useFileText(following ? versionFileSource(version, version.entry) : null).text
  const caughtUp = source === null || (stored !== undefined && stored === source)
  useEffect(() => {
    if (settling && caughtUp) setSettling(false)
  }, [settling, caughtUp])

  return following && !caughtUp ? following : null
}

/** The document as a reader opens it: its pages, or one sheet on a phone. */
function DocumentReader({
  version,
  part,
}: {
  readonly version: ArtifactVersion
  readonly part?: string
}) {
  const messages = useArtifactMessages()
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
  )
}

/**
 * The document as one sheet that follows its live document, element by element, as
 * ../live-frame.ts describes. Typing, a click on a text element puts the caret in it, and what
 * the reader types is written into `document.html` for everyone, under their own undo.
 */
function DocumentEditor({
  version,
  live,
  typing,
}: {
  readonly version: ArtifactVersion
  readonly live: LiveArtifact
  readonly typing: boolean
}) {
  const messages = useArtifactMessages()
  const file = version.entry
  const editor = liveDocumentOf(live)
  const frame = useLiveFrame({ version, file, live })
  const [embeds, setEmbeds] = useState<readonly FrameEmbed[]>([])
  const pageEvents = usePageEvents(frame.shows, { onEmbeds: setEmbeds })
  const [selected, setSelected] = useState<FrameEditTarget | null>(null)
  // The element picked, as the event handler reads it: what the frame says the reader typed is
  // taken only for it, and nothing while the frame's elements are not the document's.
  const picked = useRef<FrameEditTarget | null>(null)
  picked.current = typing ? selected : null
  const moved = useRef(frame.moved)
  moved.current = frame.moved

  // While the reader types in it, the frame keeps the version it loaded.
  const { hold } = frame
  useEffect(() => {
    hold(typing && selected?.kind === "text")
  }, [hold, typing, selected])

  // Once the frame's elements no longer match the document's, nothing stays picked: its address
  // may name another element now.
  useEffect(() => {
    if (!typing || frame.moved) {
      picked.current = null
      setSelected(null)
    }
  }, [typing, frame.moved])

  const onEdit = (event: FrameEvent) => {
    if (moved.current || !typing) return
    if (event.event === "edit.select") {
      // Typing in another element is a step of its own for undo.
      editor.stopCapturing()
      picked.current = event.params.target
      setSelected(event.params.target)
      return
    }
    if (event.event !== "edit.text") return

    // Only the words of the element the reader picked, a text, are taken.
    const chosen = picked.current
    const { address, base, text } = event.params
    if (chosen?.kind !== "text" || chosen.address !== address) return
    try {
      editor.editFile(file, (source) => mergeBoardText(source, address, base, text))
    } catch {
      // The element is no longer text there: the document changed under the reader.
      picked.current = null
      setSelected(null)
      frame.resync()
    }
  }
  useFrameEditing({ frame, on: typing, typing, onEdit })

  const onEvent = useCallback(
    (event: FrameEvent) => {
      if (event.event === "ready") {
        picked.current = null
        setSelected(null)
        frame.ready()
      }
      pageEvents(event)
    },
    [frame, pageEvents]
  )
  const scroll = useCallback(
    (delta: { readonly x: number; readonly y: number }) => {
      frame.handle.current?.send("scroll", delta).catch(() => {})
    },
    [frame.handle]
  )

  return (
    <ArtifactFrame
      handle={frame.handle}
      version={frame.shows}
      title={messages.document.frame(version.title)}
      editable
      onEvent={onEvent}
      className="flex-1"
      fallback={<ViewerLoading label={messages.viewer.loading} />}
      failure={<ViewerNotice title={messages.document.loadFailed} />}
      overlay={<FrameEmbeds version={frame.shows} embeds={embeds} onScroll={scroll} />}
    />
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
