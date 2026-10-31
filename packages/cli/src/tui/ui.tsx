/** @jsxImportSource @opentui/react */
import { createTextAttributes, type KeyBinding, type TextareaRenderable } from "@opentui/core"
import { useEffect, useRef, useState } from "react"
import { SPINNER_FRAMES } from "../ui/theme"
import type { TuiColors } from "./theme"

export const BOLD = createTextAttributes({ bold: true })
export const ITALIC = createTextAttributes({ italic: true })

/** Enter sends; shift+enter or ctrl+j starts a new line. */
const COMPOSER_KEYS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
]

/** One piece of the line under the composer, such as `This Mac` or `Ask first`. */
export interface StatusItem {
  readonly text: string
  readonly color: string
  readonly bold?: boolean
}

/**
 * Where a message is written: a panel with Sixb's blue bar, the line it will be sent with under
 * it. `onSubmit` takes the text; the composer clears once it was taken.
 */
export function Composer({
  colors,
  placeholder,
  status,
  focused,
  accent,
  allowEmpty = false,
  onSubmit,
  onChange,
}: {
  readonly colors: TuiColors
  readonly placeholder: string
  readonly status: readonly StatusItem[]
  readonly focused: boolean
  /** The bar's color: blue, or amber while something waits on the person. */
  readonly accent?: string
  /** Enter sends an empty composer too, as a form's default does. */
  readonly allowEmpty?: boolean
  readonly onSubmit: (text: string) => boolean | Promise<boolean>
  /** The text as it is typed. */
  readonly onChange?: (text: string) => void
}) {
  const input = useRef<TextareaRenderable>(null)
  const [lines, setLines] = useState(1)
  return (
    <box
      border={["left"]}
      borderStyle="heavy"
      borderColor={accent ?? (focused ? colors.blue : colors.border)}
      backgroundColor={colors.surface}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      flexDirection="column"
      flexShrink={0}
    >
      <textarea
        ref={input}
        focused={focused}
        placeholder={placeholder}
        textColor={colors.text}
        focusedTextColor={colors.text}
        placeholderColor={colors.faint}
        backgroundColor={colors.surface}
        focusedBackgroundColor={colors.surface}
        keyBindings={COMPOSER_KEYS}
        height={Math.min(lines, 8)}
        onContentChange={() => {
          const text = input.current?.plainText ?? ""
          setLines(Math.max(1, input.current?.lineCount ?? text.split("\n").length))
          onChange?.(text)
        }}
        onSubmit={() => {
          const text = input.current?.plainText.trim() ?? ""
          if (!text && !allowEmpty) return
          void Promise.resolve(onSubmit(text)).then((taken) => {
            if (!taken) return
            input.current?.setText("")
            setLines(1)
            onChange?.("")
          })
        }}
      />
      <box height={1} />
      <text>
        {status.map((item, index) => (
          <span key={item.text}>
            {index > 0 ? <span fg={colors.faint}>{" · "}</span> : null}
            <span fg={item.color} attributes={item.bold ? BOLD : 0}>
              {item.text}
            </span>
          </span>
        ))}
      </text>
    </box>
  )
}

/** Key hints: `tab where  shift+tab permissions  ctrl+p commands`. */
export function KeyHints({
  colors,
  items,
}: {
  readonly colors: TuiColors
  readonly items: readonly (readonly [key: string, label: string])[]
}) {
  return (
    <text>
      {items.map(([key, label], index) => (
        <span key={key}>
          {index > 0 ? "  " : ""}
          <span fg={colors.text}>{key}</span>
          <span fg={colors.muted}>{` ${label}`}</span>
        </span>
      ))}
    </text>
  )
}

export function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setFrame((value) => value + 1), 80)
    return () => clearInterval(timer)
  }, [active])
  return SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "·"
}

/** Re-renders every `ms` while `active`, for a clock. */
export function useNow(ms: number, active = true): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms, active])
  return now
}
