import type { FrameEmbed } from "@sixb/core/artifacts"
import { type TouchEvent, useMemo, useRef, type WheelEvent } from "react"
import type { ArtifactVersion } from "./queries"
import { ArtifactEmbed } from "./references/references"

/**
 * What a frame embeds from other artifacts, drawn where it put each box: laid out at the box's
 * size over `zoom` times the frame's scale, then scaled with it. Only what the version records as
 * an embed is drawn, so a deck or a page shows nothing it did not publish with.
 *
 * Over a page, a wheel or a finger that moves nothing inside an embed scrolls the page under it,
 * through `onScroll`, as it would scroll the page anywhere else.
 */
export function FrameEmbeds({
  version,
  embeds,
  zoom = 1,
  onScroll,
}: {
  readonly version: ArtifactVersion
  readonly embeds: readonly FrameEmbed[]
  readonly zoom?: number
  readonly onScroll?: (delta: { readonly x: number; readonly y: number }) => void
}) {
  const recorded = useMemo(
    () =>
      new Set(
        version.references
          .filter((reference) => reference.as === "embed")
          .map((reference) => reference.address)
      ),
    [version]
  )
  const touch = useRef<{ x: number; y: number } | null>(null)
  const scrolling = onScroll
    ? {
        onWheel: (event: WheelEvent<HTMLDivElement>) => {
          // Lines, as a mouse with notches may send, are about 16 pixels each.
          const unit = event.deltaMode === 1 ? 16 : 1
          const delta = { x: event.deltaX * unit, y: event.deltaY * unit }
          if (!scrollsInside(event.target, event.currentTarget, delta)) onScroll(delta)
        },
        onTouchStart: (event: TouchEvent<HTMLDivElement>) => {
          const point = event.touches[0]
          touch.current = point ? { x: point.clientX, y: point.clientY } : null
        },
        onTouchMove: (event: TouchEvent<HTMLDivElement>) => {
          const point = event.touches[0]
          const last = touch.current
          if (!point || !last) return
          touch.current = { x: point.clientX, y: point.clientY }
          const delta = { x: last.x - point.clientX, y: last.y - point.clientY }
          if (!scrollsInside(event.target, event.currentTarget, delta)) onScroll(delta)
        },
      }
    : {}
  return embeds
    .filter((embed) => recorded.has(embed.address))
    .map((embed) => {
      const scale = embed.scale * zoom
      return (
        <div
          // The element it is, so what it draws stays mounted as others scroll in and out.
          key={embed.id}
          data-sixb-frame-embed={embed.address}
          className="pointer-events-auto absolute"
          style={{
            left: embed.rect.x,
            top: embed.rect.y,
            width: embed.rect.width,
            height: embed.rect.height,
          }}
          {...scrolling}
        >
          <div
            style={{
              width: embed.rect.width / scale,
              height: embed.rect.height / scale,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
            }}
          >
            <ArtifactEmbed address={embed.address} caption="" fill />
          </div>
        </div>
      )
    })
}

/** Whether something between where the event began and the embed can still scroll that way. */
function scrollsInside(
  target: EventTarget,
  embed: HTMLElement,
  delta: { readonly x: number; readonly y: number }
): boolean {
  for (
    let element = target instanceof HTMLElement ? target : null;
    element && element !== embed;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element)
    const vertical =
      /(auto|scroll)/.test(style.overflowY) &&
      ((delta.y > 0 && element.scrollTop + element.clientHeight < element.scrollHeight - 1) ||
        (delta.y < 0 && element.scrollTop > 0))
    const horizontal =
      /(auto|scroll)/.test(style.overflowX) &&
      ((delta.x > 0 && element.scrollLeft + element.clientWidth < element.scrollWidth - 1) ||
        (delta.x < 0 && element.scrollLeft > 0))
    if (vertical || horizontal) return true
  }
  return false
}
