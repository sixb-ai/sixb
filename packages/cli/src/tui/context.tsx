/** @jsxImportSource @opentui/react */
import { type KeyEvent, RGBA } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { glyph } from "../ui/theme"
import { type ContextUse, contextBreakdown } from "./format"
import type { TuiColors } from "./theme"
import { BOLD } from "./ui"

/** What the room kept for the model's answer reads as, in the bar and its row. */
const RESERVED_TILE = "╌"

/**
 * `/context`: what the conversation uses of its model's window, part by part. Opens centered over
 * the screen like the palettes; esc or enter closes it.
 */
export function ContextPanel({
  colors,
  context,
  modelName,
  onClose,
}: {
  readonly colors: TuiColors
  readonly context: ContextUse | null
  readonly modelName?: string
  readonly onClose: () => void
}) {
  const { width, height } = useTerminalDimensions()
  useKeyboard((key: KeyEvent) => {
    if (key.name === "escape" || key.name === "return" || (key.ctrl && key.name === "c")) {
      onClose()
    }
  })

  const boxWidth = Math.min(64, width - 4)
  const inner = boxWidth - 6
  // A row: its label, its tokens and share in 12 columns, then its share's tiles.
  const labelColumns = Math.min(24, Math.max(12, inner - 12 - 12))
  const rowTiles = Math.max(0, inner - labelColumns - 12)
  const breakdown = context ? contextBreakdown(context, { bar: inner, row: rowTiles }) : undefined
  const toneColor =
    breakdown?.tone === "over"
      ? colors.red
      : breakdown?.tone === "near"
        ? colors.amber
        : colors.blue

  const lines = breakdown ? breakdown.rows.length + breakdown.notes.length + 7 : 2
  return (
    <>
      <box
        position="absolute"
        left={0}
        top={0}
        width={width}
        height={height}
        backgroundColor={RGBA.fromValues(0, 0, 0, 0.45)}
        zIndex={9}
      />
      <box
        position="absolute"
        left={Math.floor((width - boxWidth) / 2)}
        top={Math.max(1, Math.floor((height - lines - 4) / 3))}
        width={boxWidth}
        backgroundColor={colors.surface}
        flexDirection="column"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={3}
        paddingRight={3}
        zIndex={10}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={colors.text} attributes={BOLD}>
            Context
          </text>
          <text fg={colors.faint}>esc</text>
        </box>
        {breakdown ? (
          <>
            <box flexDirection="row" justifyContent="space-between" paddingTop={1}>
              <text wrapMode="none" flexShrink={1}>
                <span fg={colors.text}>{breakdown.headline}</span>
                {modelName ? <span fg={colors.faint}>{` · ${modelName}`}</span> : null}
              </text>
              <text fg={breakdown.tone === "quiet" ? colors.muted : toneColor} flexShrink={0}>
                {breakdown.share}
              </text>
            </box>
            <text wrapMode="none">
              <span fg={toneColor}>{glyph.mark.repeat(breakdown.bar.used)}</span>
              <span fg={colors.faint}>{glyph.tile.repeat(breakdown.bar.free)}</span>
              <span fg={colors.faint}>{RESERVED_TILE.repeat(breakdown.bar.reserved)}</span>
            </text>
            {breakdown.warning ? (
              <text wrapMode="none" fg={toneColor}>
                {fit(breakdown.warning, inner)}
              </text>
            ) : null}
            <box flexDirection="column" paddingTop={1}>
              {breakdown.rows.map((row) => (
                <box key={row.label} flexDirection="row">
                  <text
                    wrapMode="none"
                    width={labelColumns}
                    fg={row.kind === "part" ? colors.text : colors.muted}
                  >
                    {fit(row.label, labelColumns - 1)}
                  </text>
                  <text wrapMode="none" width={12} fg={colors.muted}>
                    {`${row.tokens.padStart(5)}  ${(row.share ?? "").padStart(4)} `}
                  </text>
                  <text wrapMode="none" fg={colors.faint}>
                    {row.kind === "free"
                      ? glyph.tile
                      : row.kind === "reserved"
                        ? RESERVED_TILE
                        : ""}
                    <span fg={colors.muted}>
                      {glyph.mark.repeat(Math.min(row.tiles, rowTiles))}
                    </span>
                  </text>
                </box>
              ))}
            </box>
            {breakdown.notes.length > 0 ? (
              <box flexDirection="column" paddingTop={1}>
                {breakdown.notes.map((note) => (
                  <text key={note} wrapMode="none" fg={colors.muted}>
                    {fit(note, inner)}
                  </text>
                ))}
              </box>
            ) : null}
          </>
        ) : (
          <text fg={colors.muted} paddingTop={1}>
            Nothing yet: the context is measured after the first answer.
          </text>
        )}
      </box>
    </>
  )
}

/** Text cut to `room` columns, with an ellipsis. */
function fit(text: string, room: number): string {
  if (text.length <= room) return text
  return room <= 1 ? "" : `${text.slice(0, room - 1)}…`
}
