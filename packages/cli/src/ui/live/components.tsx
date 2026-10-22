/** @jsxImportSource @opentui/react */
import { createTextAttributes } from "@opentui/core"
import { useEffect, useState } from "react"
import { glyph, SPINNER_FRAMES } from "../theme"
import type { LiveColors } from "./session"

export const BOLD = createTextAttributes({ bold: true })

export function useSpinner(active = true): string {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setFrame((value) => value + 1), 80)
    return () => clearInterval(timer)
  }, [active])
  return SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? glyph.mark
}

/** Re-renders every `ms`, for clocks such as an uptime. */
export function useTick(ms: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

/** The mosaic as progress: tiles fill palest blue first. */
export function Tiles({
  colors,
  filled,
  total,
}: {
  readonly colors: LiveColors
  readonly filled: number
  readonly total: number
}) {
  return (
    <>
      {Array.from({ length: total }, (_, index) => {
        const step = Math.min(
          colors.water.length - 1,
          Math.floor((index / Math.max(1, total - 1)) * (colors.water.length - 1))
        )
        return index < filled ? (
          <span key={index} fg={colors.water[step]}>
            {glyph.mark}
          </span>
        ) : (
          <span key={index} fg={colors.faint}>
            {glyph.tile}
          </span>
        )
      })}
    </>
  )
}

/** Key hints: `o open app  ·  r restart  ·  q quit`. */
export function Hints({
  colors,
  items,
}: {
  readonly colors: LiveColors
  readonly items: readonly (readonly [string, string])[]
}) {
  return (
    <text>
      {items.map(([key, label], index) => (
        <span key={key}>
          {index > 0 ? <span fg={colors.faint}>{`  ${glyph.dot}  `}</span> : null}
          <span fg={colors.text} attributes={BOLD}>
            {key}
          </span>
          <span fg={colors.muted}>{` ${label}`}</span>
        </span>
      ))}
    </text>
  )
}
