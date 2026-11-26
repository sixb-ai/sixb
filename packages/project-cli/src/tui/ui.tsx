/** @jsxImportSource @opentui/react */
import { createTextAttributes, type KeyBinding, type TextareaRenderable } from "@opentui/core"
import { createContext, useContext, useEffect, useRef, useState } from "react"
import { SPINNER_FRAMES } from "../ui/theme"
import type { TuiColors } from "./theme"

export const BOLD = createTextAttributes({ bold: true })
export const ITALIC = createTextAttributes({ italic: true })

/** The rows the composer grows to as its text wraps or breaks; past them it scrolls. */
const COMPOSER_MAX_ROWS = 8

/** Enter sends; shift+enter or ctrl+j starts a new line. */
const COMPOSER_KEYS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
]

/**
 * The focused composer's clear: ctrl+c empties a draft before it quits, and says whether there
 * was one. The app's keys run before the composer's, so the app asks it.
 */
export const ComposerDraft = createContext<{ current: (() => boolean) | null }>({ current: null })

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
  const [rows, setRows] = useState(1)
  // Rows as the text wraps at the composer's width, not lines: a long line grows it too. Not
  // virtualLineCount, which counts no more rows than the textarea already shows.
  const fit = () => setRows(Math.max(1, input.current?.lineInfo.lineStartCols.length ?? 1))
  const clear = () => {
    input.current?.setText("")
    setRows(1)
    onChange?.("")
  }

  const draft = useContext(ComposerDraft)
  useEffect(() => {
    if (!focused) return
    const clearDraft = () => {
      if (!input.current?.plainText) return false
      clear()
      return true
    }
    draft.current = clearDraft
    return () => {
      if (draft.current === clearDraft) draft.current = null
    }
  })

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
      onSizeChange={fit}
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
        height={Math.min(rows, COMPOSER_MAX_ROWS)}
        onContentChange={() => {
          fit()
          onChange?.(input.current?.plainText ?? "")
        }}
        onSubmit={() => {
          const text = input.current?.plainText.trim() ?? ""
          if (!text && !allowEmpty) return
          void Promise.resolve(onSubmit(text)).then((taken) => {
            if (taken) clear()
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
    <text wrapMode="none" flexShrink={0}>
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
