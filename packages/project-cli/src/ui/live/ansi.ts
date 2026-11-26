import { createTextAttributes, RGBA, StyledText, type TextChunk } from "@opentui/core"

const NAMED = [
  "#1c1f24",
  "#ff453a",
  "#30d158",
  "#ff9f0a",
  "#0a84ff",
  "#bf5af2",
  "#64d2ff",
  "#d7dae0",
  "#8b919a",
  "#ff6961",
  "#4be07a",
  "#ffb340",
  "#409cff",
  "#da8fff",
  "#8ae0ff",
  "#ffffff",
]

function cubeColor(index: number): string {
  if (index < 16) return NAMED[index] ?? "#ffffff"
  if (index < 232) {
    const steps = [0, 95, 135, 175, 215, 255]
    const value = index - 16
    const channel = (n: number) => (steps[n] ?? 0).toString(16).padStart(2, "0")
    return `#${channel(Math.floor(value / 36))}${channel(Math.floor(value / 6) % 6)}${channel(value % 6)}`
  }
  const level = (8 + (index - 232) * 10).toString(16).padStart(2, "0")
  return `#${level}${level}${level}`
}

interface Style {
  fg?: string
  bold?: boolean
  dim?: boolean
  underline?: boolean
}

/**
 * Turns text styled with SGR escapes (what the printed screens and a child process write) into
 * OpenTUI styled text, so it keeps its colors in the scrollback above a live footer. Every other
 * escape is dropped: OpenTUI would show it as text.
 */
export function ansiToStyledText(text: string, defaultFg: string): StyledText {
  const chunks: TextChunk[] = []
  let style: Style = {}
  const push = (value: string) => {
    if (!value) return
    chunks.push({
      __isChunk: true,
      text: value,
      fg: RGBA.fromHex(style.fg ?? defaultFg),
      attributes: createTextAttributes({
        bold: style.bold ?? false,
        dim: style.dim ?? false,
        underline: style.underline ?? false,
      }),
    })
  }

  const pattern =
    /\x1b\[([0-9;:]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|([^\x1b]+)/g
  for (const match of text.matchAll(pattern)) {
    if (match[2] !== undefined) {
      push(match[2])
    } else if (match[1] !== undefined) {
      style = applySgr(style, match[1])
    }
  }
  return new StyledText(chunks)
}

function applySgr(current: Style, sequence: string): Style {
  const params = sequence === "" ? [0] : sequence.split(/[;:]/).map((part) => Number(part) || 0)
  let style = { ...current }
  for (let index = 0; index < params.length; index++) {
    const code = params[index] ?? 0
    if (code === 0) style = {}
    else if (code === 1) style.bold = true
    else if (code === 2) style.dim = true
    else if (code === 4) style.underline = true
    else if (code === 22) {
      style.bold = false
      style.dim = false
    } else if (code === 24) style.underline = false
    else if (code >= 30 && code <= 37) style.fg = NAMED[code - 30]
    else if (code >= 90 && code <= 97) style.fg = NAMED[code - 90 + 8]
    else if (code === 39) delete style.fg
    else if (code === 38 && params[index + 1] === 5) {
      style.fg = cubeColor(params[index + 2] ?? 0)
      index += 2
    } else if (code === 38 && params[index + 1] === 2) {
      const hex = (n: number | undefined) => (n ?? 0).toString(16).padStart(2, "0")
      style.fg = `#${hex(params[index + 2])}${hex(params[index + 3])}${hex(params[index + 4])}`
      index += 4
    } else if (code === 48 && (params[index + 1] === 5 || params[index + 1] === 2)) {
      index += params[index + 1] === 5 ? 2 : 4
    }
  }
  return style
}
