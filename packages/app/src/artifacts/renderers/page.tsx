import type { FrameEmbed, FrameEvent } from "@sixb/core/artifacts"
import { cn } from "@sixb/ui/lib/utils"
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArtifactFrame, type ArtifactFrameHandle } from "../frame"
import { FrameEmbeds } from "../frame-embeds"
import { useArtifactMessages } from "../messages"
import { type ArtifactVersion, useArtifactTheme } from "../queries"
import { useOpenArtifactAddress } from "../references/references"
import { artifactThemeAttributes, useArtifactThemeAttributes } from "../theme"
import { ViewerLoading, ViewerNotice } from "./notice"

/**
 * A page: its `index.html` live in a sandboxed frame that fills the viewer, in the app's theme or
 * its own, scrolling as the page does, with the artifacts it embeds drawn over it where the page
 * puts them as it scrolls. The page runs its own scripts, so a link to another artifact opens, and
 * an embed shows, only when the version recorded it at publish, whatever the frame says.
 */
export function PageRenderer({ version }: { readonly version: ArtifactVersion }) {
  const messages = useArtifactMessages()
  const theme = useArtifactThemeAttributes(version)
  const frame = useRef<ArtifactFrameHandle | null>(null)
  const [embeds, setEmbeds] = useState<readonly FrameEmbed[]>([])
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
        title={messages.page.frame(version.title)}
        onEvent={onEvent}
        className="flex-1"
        fallback={<ViewerLoading label={messages.viewer.loading} />}
        failure={<ViewerNotice title={messages.page.loadFailed} />}
        overlay={<FrameEmbeds version={version} embeds={embeds} onScroll={scroll} />}
      />
    </div>
  )
}

/**
 * What a page's frame says, for wherever it is shown: a link it recorded at publish opens, and its
 * embeds and height go to whoever draws them.
 */
export function usePageEvents(
  version: ArtifactVersion,
  on: {
    readonly onEmbeds?: (embeds: readonly FrameEmbed[]) => void
    readonly onSize?: (height: number) => void
  }
): (event: FrameEvent) => void {
  const openAddress = useOpenArtifactAddress()
  const linked = useMemo(
    () => new Set(version.references.map((reference) => reference.address)),
    [version]
  )
  const { onEmbeds, onSize } = on
  return useCallback(
    (event: FrameEvent) => {
      switch (event.event) {
        case "open":
          if (linked.has(event.params.address)) openAddress(event.params.address)
          return
        case "embeds":
          onEmbeds?.(event.params.embeds)
          return
        case "size":
          onSize?.(event.params.height)
          return
      }
    },
    [linked, openAddress, onEmbeds, onSize]
  )
}

/**
 * A page's face for a card, from what publishing read of it: its title over the outline of a page,
 * so a card says what it is before, or without, the live page behind it.
 */
export function PageFace({ version }: { readonly version: ArtifactVersion }) {
  const title = (version.outline.kind === "page" && version.outline.title) || version.title
  return (
    <span className="@container absolute inset-0 flex flex-col bg-background px-[7%] pt-[7%]">
      <span className="line-clamp-2 text-[6.4cqw] leading-[1.15] font-semibold tracking-[-0.02em] text-foreground">
        {title}
      </span>
      <span className="mt-[3cqw] h-[1.8cqw] w-2/5 rounded-full bg-foreground/10" />
      <span className="mt-[5cqw] grid grid-cols-3 gap-[2.4cqw]">
        {[0, 1, 2].map((tile) => (
          <span
            key={tile}
            className="flex h-[14cqw] flex-col justify-end gap-[1.2cqw] rounded-[1.6cqw] border border-border/80 bg-card p-[2.2cqw]"
          >
            <span className="h-[1.6cqw] w-1/2 rounded-full bg-foreground/10" />
            <span className="h-[3.2cqw] w-3/4 rounded-full bg-foreground/15" />
          </span>
        ))}
      </span>
    </span>
  )
}

/** The width a page's card draws it at before scaling it down: a laptop's. */
const PAGE_WIDTH = 1280

/**
 * A page's top, live in a frame laid out at a laptop's width and scaled down to the card, in the
 * page's own theme. It fades in over the page's face, which stays if it never loads.
 */
export function PageScreen({ version }: { readonly version: ArtifactVersion }) {
  const theme = artifactThemeAttributes(useArtifactTheme(version))
  const box = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(0)
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => setScale(element.clientWidth / PAGE_WIDTH)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return (
    <div
      ref={box}
      className={cn("absolute inset-0 overflow-hidden bg-background", theme.className)}
      style={theme.style}
    >
      <PageFace version={version} />
      {scale > 0 ? (
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ width: PAGE_WIDTH, height: `${100 / scale}%`, transform: `scale(${scale})` }}
        >
          <ArtifactFrame
            version={version}
            title={version.title}
            decorative
            className="absolute inset-0"
          />
        </div>
      ) : null}
    </div>
  )
}
