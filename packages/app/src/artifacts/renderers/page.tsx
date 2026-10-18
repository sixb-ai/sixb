import type { FrameEvent } from "@sixb/core/artifacts"
import { cn } from "@sixb/ui/lib/utils"
import { useCallback, useMemo } from "react"
import { ArtifactFrame } from "../frame"
import { useArtifactMessages } from "../messages"
import type { ArtifactVersion } from "../queries"
import { useOpenArtifactAddress } from "../references/references"
import { useArtifactThemeAttributes } from "../theme"
import { ViewerLoading, ViewerNotice } from "./notice"

/**
 * A page: its `index.html` live in a sandboxed frame that fills the viewer, in the app's theme or
 * its own, scrolling as the page does. The page runs its own scripts, so a link to another
 * artifact opens only when the version recorded it at publish, whatever the frame says.
 */
export function PageRenderer({ version }: { readonly version: ArtifactVersion }) {
  const messages = useArtifactMessages()
  const theme = useArtifactThemeAttributes(version)
  const openAddress = useOpenArtifactAddress()
  const linked = useMemo(
    () => new Set(version.references.map((reference) => reference.address)),
    [version]
  )
  const onEvent = useCallback(
    (event: FrameEvent) => {
      if (event.event === "open" && linked.has(event.params.address)) {
        openAddress(event.params.address)
      }
    },
    [linked, openAddress]
  )
  return (
    <div
      data-sixb-artifact=""
      className={cn("flex min-h-0 flex-1 flex-col bg-background", theme.className)}
      style={theme.style}
    >
      <ArtifactFrame
        version={version}
        title={messages.page.frame(version.title)}
        onEvent={onEvent}
        className="flex-1"
        fallback={<ViewerLoading label={messages.viewer.loading} />}
        failure={<ViewerNotice title={messages.page.loadFailed} />}
      />
    </div>
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
