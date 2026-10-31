/** @jsxImportSource @opentui/react */
import type { TuiColors } from "./theme"

/**
 * Sixb's name, set in half blocks at one weight: every stroke a single pixel, so stems and bars
 * match and the letters read as type, with the corners cut round and the `x`'s diagonals in pairs
 * of pixels, so they read as lines. Eight pixels tall, the `i`'s dot
 * and the `b`'s ascender above an x-height of five.
 */
const WORDMARK = [
  "          ▄             █      ",
  " ▄▄▄▄▄▄   ▄   ▄▄   ▄▄   █▄▄▄▄  ",
  "▀▄▄▄▄▄    █    ▀█▄█▀    █    ▀▄",
  "▄▄▄▄▄▄▀   █   ▄█▀ ▀█▄   █▄▄▄▄▀ ",
]

const WIDTH = Math.max(...WORDMARK.map((row) => row.length))

/** The wordmark in Sixb's blues, palest to deepest across the name, as the website's hero fills. */
export function Logo({ colors }: { readonly colors: TuiColors }) {
  const blues = colors.wordmark
  const tint = (column: number) =>
    blues[Math.min(blues.length - 1, Math.floor((column / WIDTH) * blues.length))] ?? colors.blue
  // One text, not a row each: a column of rows drew one row past its own box.
  return (
    <text wrapMode="none" flexShrink={0}>
      {WORDMARK.flatMap((row, index) => [
        ...runs(row).map((run) => (
          <span key={`${index}-${run.start}`} fg={tint(run.start)}>
            {run.text}
          </span>
        )),
        index < WORDMARK.length - 1 ? <span key={`${index}-break`}>{"\n"}</span> : null,
      ])}
    </text>
  )
}

/** A row cut where its color steps: one span per stretch of a single blue. */
function runs(row: string): { readonly start: number; readonly text: string }[] {
  const steps = 4
  const out: { start: number; text: string }[] = []
  for (let start = 0; start < row.length; ) {
    const step = Math.floor((start / WIDTH) * steps)
    let end = start
    while (end < row.length && Math.floor((end / WIDTH) * steps) === step) end += 1
    out.push({ start, text: row.slice(start, end) })
    start = end
  }
  return out
}
