/** @jsxImportSource @opentui/react */
import type { KeyEvent, PasteEvent } from "@opentui/core"
import { useKeyboard, usePaste } from "@opentui/react"
import { useRef, useState } from "react"
import { glyph, tone } from "../theme"
import { BOLD, Hints } from "./components"
import { type LiveColors, startFooter } from "./session"

/** Thrown when the person answering a prompt backs out with esc or ctrl+c. */
export class PromptCancelledError extends Error {
  constructor() {
    super("[SixbCLI] Cancelled.")
    this.name = "PromptCancelledError"
  }
}

/**
 * Asks for one line of text, in a footer under the command. The answer stays in the scrollback
 * the way it was asked: `✓ Project directory  acme-ops`.
 */
export async function promptText(options: {
  readonly command: string
  readonly label: string
  /** What Enter accepts when nothing was typed. */
  readonly defaultValue?: string
  readonly hint?: string
  /** A message for an answer that will not do; `null` when it will. */
  readonly validate?: (value: string) => string | null
}): Promise<string> {
  return ask<string>(4, options.command, (colors, resolve, reject) => (
    <TextPrompt options={options} colors={colors} onSubmit={resolve} onCancel={reject} />
  )).then((value) => answered(options.label, value))
}

export interface Choice<T> {
  readonly label: string
  readonly value: T
  readonly detail?: string
}

/** Asks for one of a few choices, picked with the arrow keys. */
export async function promptSelect<T>(options: {
  readonly command: string
  readonly label: string
  readonly choices: readonly Choice<T>[]
  readonly initial?: number
}): Promise<T> {
  const rows = Math.min(options.choices.length, 8) + 4
  const choice = await ask<Choice<T>>(rows, options.command, (colors, resolve, reject) => (
    <SelectPrompt options={options} colors={colors} onSubmit={resolve} onCancel={reject} />
  ))
  answered(options.label, choice.label)
  return choice.value
}

async function ask<T>(
  rows: number,
  command: string,
  build: (colors: LiveColors, resolve: (value: T) => void, reject: () => void) => React.ReactNode
): Promise<T> {
  const footer = await startFooter({ rows: rows + 1 })
  footer.print(`\n  ${tone.blue(glyph.mark)} ${tone.strong(`sixb ${command}`)}\n`)
  try {
    return await new Promise<T>((resolve, reject) => {
      footer.render(build(footer.colors, resolve, () => reject(new PromptCancelledError())))
    })
  } finally {
    await footer.stop()
  }
}

function answered<T extends string>(label: string, value: T): T {
  process.stdout.write(`  ${tone.ok(glyph.ok)} ${tone.muted(label)}  ${value}\n`)
  return value
}

function TextPrompt({
  options,
  colors,
  onSubmit,
  onCancel,
}: {
  readonly options: Parameters<typeof promptText>[0]
  readonly colors: LiveColors
  readonly onSubmit: (value: string) => void
  readonly onCancel: () => void
}) {
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const current = useRef("")
  current.current = value

  const insert = (text: string) => {
    const clean = text.replace(/[\x00-\x1f\x7f]/g, "")
    if (!clean) return
    setValue((previous) => previous + clean)
    setError(null)
  }

  useKeyboard((key: KeyEvent) => {
    if ((key.ctrl && key.name === "c") || key.name === "escape") return onCancel()
    if (key.name === "return") {
      const answer = current.current.trim() || options.defaultValue || ""
      const problem = answer ? (options.validate?.(answer) ?? null) : "An answer is required."
      if (problem) return setError(problem)
      return onSubmit(answer)
    }
    if (key.name === "backspace") return setValue((previous) => previous.slice(0, -1))
    if (key.ctrl && key.name === "u") return setValue("")
    if (!key.ctrl && !key.meta && key.sequence && key.sequence.length === 1) insert(key.sequence)
  })
  usePaste((event: PasteEvent) => insert(new TextDecoder().decode(event.bytes)))

  const empty = value.length === 0
  return (
    <box flexDirection="column" paddingLeft={2}>
      <text>
        <span fg={colors.blue}>{`${glyph.prompt} `}</span>
        <span fg={colors.text} attributes={BOLD}>
          {options.label}
        </span>
        <span fg={colors.muted}>{"  "}</span>
        {empty && options.defaultValue ? (
          <span fg={colors.faint}>{options.defaultValue}</span>
        ) : (
          <span fg={colors.text}>{value}</span>
        )}
        <span fg={colors.blue}>▏</span>
      </text>
      <text fg={error ? colors.red : colors.muted}>{`  ${error ?? options.hint ?? ""}`}</text>
      <box height={1} />
      <Hints
        colors={colors}
        items={[
          ["enter", empty && options.defaultValue ? "accept" : "continue"],
          ["esc", "cancel"],
        ]}
      />
    </box>
  )
}

function SelectPrompt<T>({
  options,
  colors,
  onSubmit,
  onCancel,
}: {
  readonly options: Parameters<typeof promptSelect<T>>[0]
  readonly colors: LiveColors
  readonly onSubmit: (choice: Choice<T>) => void
  readonly onCancel: () => void
}) {
  const [selected, setSelected] = useState(options.initial ?? 0)
  const count = options.choices.length
  const visible = Math.min(count, 8)
  const first = Math.min(Math.max(0, selected - visible + 1), Math.max(0, count - visible))

  useKeyboard((key: KeyEvent) => {
    if ((key.ctrl && key.name === "c") || key.name === "escape") return onCancel()
    if (key.name === "up" || key.name === "k") setSelected((index) => (index - 1 + count) % count)
    else if (key.name === "down" || key.name === "j") setSelected((index) => (index + 1) % count)
    else if (key.name === "return") {
      const choice = options.choices[selected]
      if (choice) onSubmit(choice)
    }
  })

  const labelWidth = Math.max(...options.choices.map((choice) => choice.label.length)) + 2
  return (
    <box flexDirection="column" paddingLeft={2}>
      <text>
        <span fg={colors.blue}>{`${glyph.prompt} `}</span>
        <span fg={colors.text} attributes={BOLD}>
          {options.label}
        </span>
      </text>
      {options.choices.slice(first, first + visible).map((choice, offset) => {
        const active = first + offset === selected
        return (
          <text key={choice.label}>
            <span fg={active ? colors.blue : colors.faint}>
              {active ? `  ${glyph.mark} ` : `  ${glyph.tile} `}
            </span>
            <span fg={active ? colors.text : colors.muted} attributes={active ? BOLD : 0}>
              {choice.label.padEnd(labelWidth)}
            </span>
            <span fg={colors.faint}>{choice.detail ?? ""}</span>
          </text>
        )
      })}
      <box height={1} />
      <Hints
        colors={colors}
        items={[
          ["↑↓", "choose"],
          ["enter", "select"],
          ["esc", "cancel"],
        ]}
      />
    </box>
  )
}
