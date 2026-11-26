/** @jsxImportSource @opentui/react */
import { type KeyEvent, RGBA } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useState } from "react"
import type { TuiColors } from "./theme"
import { BOLD } from "./ui"

export interface PaletteItem {
  readonly id: string
  readonly label: string
  /** Quiet text after the label: a model's tier, a conversation's age. */
  readonly detail?: string
  /** A shortcut that does the same, shown on the right. */
  readonly keys?: string
  readonly group?: string
  /** The current choice, marked. */
  readonly current?: boolean
  run(): void
}

/**
 * A list to pick from, filtered as you type: commands, conversations, models. Opens centered over
 * the screen; esc closes it.
 */
export function Palette({
  colors,
  title,
  items,
  placeholder,
  onClose,
}: {
  readonly colors: TuiColors
  readonly title: string
  readonly items: readonly PaletteItem[]
  readonly placeholder: string
  readonly onClose: () => void
}) {
  const { width, height } = useTerminalDimensions()
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(() =>
    Math.max(
      0,
      items.findIndex((item) => item.current)
    )
  )
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = items.filter((item) => {
    const haystack = `${item.label} ${item.detail ?? ""} ${item.group ?? ""}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
  const index = Math.min(selected, Math.max(0, matches.length - 1))
  const boxWidth = Math.min(72, width - 8)
  const rows = Math.max(4, Math.min(matches.length, height - 14, 14))
  const first = Math.min(Math.max(0, index - rows + 1), Math.max(0, matches.length - rows))

  useKeyboard((key: KeyEvent) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) return onClose()
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      return setSelected((value) => Math.max(0, Math.min(value, matches.length - 1) - 1))
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      return setSelected((value) => Math.min(matches.length - 1, value + 1))
    }
    if (key.name === "return") {
      const item = matches[index]
      if (item) {
        onClose()
        item.run()
      }
    }
  })

  // Each row on one line: the label keeps its room first, then its detail gets what is left.
  const visible = matches.slice(first, first + rows)
  const rowsWithHeaders = visible.map((item, offset) => ({
    item,
    active: first + offset === index,
    header:
      item.group && item.group !== (offset === 0 ? undefined : visible[offset - 1]?.group)
        ? item.group
        : undefined,
  }))
  const headerRows = rowsWithHeaders.reduce(
    (sum, row, offset) => sum + (row.header ? (offset === 0 ? 1 : 2) : 0),
    0
  )
  const listRows = matches.length === 0 ? 1 : visible.length + headerRows
  const inner = boxWidth - 6
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
        top={Math.max(2, Math.floor(height / 5))}
        width={boxWidth}
        height={listRows + 6}
        backgroundColor={colors.surface}
        flexDirection="column"
        paddingTop={1}
        paddingBottom={1}
        zIndex={10}
      >
        <box flexDirection="row" justifyContent="space-between" paddingLeft={3} paddingRight={3}>
          <text fg={colors.text} attributes={BOLD}>
            {title}
          </text>
          <text fg={colors.faint}>esc</text>
        </box>
        <box paddingLeft={3} paddingRight={3} paddingTop={1} paddingBottom={1}>
          <input
            focused
            placeholder={placeholder}
            textColor={colors.text}
            focusedTextColor={colors.text}
            placeholderColor={colors.faint}
            backgroundColor={colors.surface}
            focusedBackgroundColor={colors.surface}
            onInput={(value: string) => {
              setQuery(value)
              setSelected(0)
            }}
          />
        </box>
        {matches.length === 0 ? (
          <box paddingLeft={3}>
            <text fg={colors.muted}>Nothing matches.</text>
          </box>
        ) : null}
        {rowsWithHeaders.map(({ item, active, header }, offset) => {
          const keys = item.keys ? item.keys.length + 2 : 0
          const mark = item.current ? 3 : 0
          const detailRoom = item.detail ? Math.min(item.detail.length + 2, 26) : 0
          const label = fit(item.label, inner - keys - mark - detailRoom)
          const detail = item.detail ? fit(item.detail, inner - keys - mark - label.length - 2) : ""
          return (
            <box key={item.id} flexDirection="column">
              {header ? (
                <box paddingLeft={3} paddingTop={offset === 0 ? 0 : 1}>
                  <text fg={colors.blue}>{header}</text>
                </box>
              ) : null}
              <box
                flexDirection="row"
                justifyContent="space-between"
                backgroundColor={active ? colors.raised : colors.surface}
                paddingLeft={3}
                paddingRight={3}
              >
                <text>
                  <span fg={colors.text} attributes={active ? BOLD : 0}>
                    {label}
                  </span>
                  {item.current ? <span fg={colors.blue}>{"  ●"}</span> : null}
                  {detail && item.keys ? <span fg={colors.faint}>{`  ${detail}`}</span> : null}
                </text>
                {item.keys ? (
                  <text fg={colors.faint}>{item.keys}</text>
                ) : detail ? (
                  <text fg={colors.faint}>{detail}</text>
                ) : null}
              </box>
            </box>
          )
        })}
      </box>
    </>
  )
}

/** Text cut to `room` columns, with an ellipsis; nothing when there is no room. */
function fit(text: string, room: number): string {
  if (room < 4) return ""
  return text.length > room ? `${text.slice(0, room - 1)}…` : text
}
