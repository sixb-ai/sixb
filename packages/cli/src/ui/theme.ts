/**
 * The CLI's look, shared by the printed screens and the live ones.
 *
 * Sixb's colors: ink and paper, one blue for a live signal, and the "water" blues the mosaic fills
 * with, palest first. Body text keeps the terminal's own foreground, so every screen reads on a
 * dark or a light terminal; color marks status, never content.
 */
export const palette = {
  blue: "#0a84ff",
  water: ["#a6cbfb", "#6fb0fc", "#3d95fd", "#0a84ff"],
  green: "#30d158",
  amber: "#ff9f0a",
  red: "#ff453a",
  muted: "#8b919a",
  faint: "#666b74",
} as const

export const glyph = {
  /** The brand mark: the logo's slab, as one cell. A tile when it counts progress. */
  mark: "▰",
  tile: "▱",
  ok: "✓",
  fail: "✕",
  warn: "▲",
  live: "●",
  idle: "○",
  dot: "·",
  arrow: "→",
  restart: "↻",
  rule: "│",
} as const

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

type ColorLevel = 0 | 1 | 2 | 3

/**
 * How much color the terminal takes: none, the 16 named colors, the 256-color cube, or 24-bit.
 * `NO_COLOR` and `FORCE_COLOR` win; a pipe or a dumb terminal gets none.
 */
export function colorLevel(stream: { readonly isTTY?: boolean } = process.stdout): ColorLevel {
  if ("NO_COLOR" in process.env && process.env.NO_COLOR !== "") return 0
  const forced = process.env.FORCE_COLOR
  if (forced !== undefined && forced !== "") {
    if (forced === "0" || forced === "false") return 0
    return forced === "1" || forced === "true" ? (Math.max(1, detectedLevel()) as ColorLevel) : 3
  }
  if (!stream.isTTY || process.env.TERM === "dumb") return 0
  return detectedLevel()
}

function detectedLevel(): ColorLevel {
  const colorterm = process.env.COLORTERM?.toLowerCase()
  if (colorterm === "truecolor" || colorterm === "24bit") return 3
  // Terminal.app reports neither, and draws 24-bit colors as noise.
  if (process.env.TERM_PROGRAM === "Apple_Terminal") return 2
  if (process.env.TERM_PROGRAM && process.env.TERM_PROGRAM !== "tmux") return 3
  if (process.env.TERM?.includes("256")) return 2
  return 1
}

const NAMED: Record<string, number> = {
  [palette.blue]: 34,
  [palette.green]: 32,
  [palette.amber]: 33,
  [palette.red]: 31,
  [palette.muted]: 90,
  [palette.faint]: 90,
  ...Object.fromEntries(palette.water.map((hex) => [hex, 34])),
}

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function cube(hex: string): number {
  const [r, g, b] = rgb(hex).map((channel) => Math.round((channel / 255) * 5))
  return 16 + 36 * (r ?? 0) + 6 * (g ?? 0) + (b ?? 0)
}

function foreground(hex: string, level: ColorLevel): string {
  if (level === 3) return `38;2;${rgb(hex).join(";")}`
  if (level === 2) return `38;5;${cube(hex)}`
  return String(NAMED[hex] ?? 39)
}

export interface Paint {
  readonly color?: string
  readonly bold?: boolean
  readonly dim?: boolean
  readonly underline?: boolean
}

/** Styles text for this terminal; the text comes back unchanged where color is off. */
export function paint(text: string, style: Paint, level: ColorLevel = colorLevel()): string {
  if (level === 0 || text === "") return text
  const codes: string[] = []
  if (style.bold) codes.push("1")
  if (style.dim) codes.push("2")
  if (style.underline) codes.push("4")
  if (style.color) codes.push(foreground(style.color, level))
  return codes.length === 0 ? text : `\x1b[${codes.join(";")}m${text}\x1b[0m`
}

export const tone = {
  strong: (text: string) => paint(text, { bold: true }),
  muted: (text: string) => paint(text, { color: palette.muted }),
  faint: (text: string) => paint(text, { color: palette.faint }),
  blue: (text: string) => paint(text, { color: palette.blue }),
  ok: (text: string) => paint(text, { color: palette.green }),
  warn: (text: string) => paint(text, { color: palette.amber }),
  fail: (text: string) => paint(text, { color: palette.red }),
  url: (text: string) => paint(text, { color: palette.blue, underline: true }),
} as const

/** The mark in its blue, or a row of tiles filled palest first: the mosaic, as a progress bar. */
export function tiles(filled: number, total: number): string {
  let row = ""
  for (let index = 0; index < total; index++) {
    if (index < filled) {
      const step = Math.min(
        palette.water.length - 1,
        Math.floor((index / Math.max(1, total - 1)) * (palette.water.length - 1))
      )
      row += paint(glyph.mark, { color: palette.water[step] })
    } else {
      row += paint(glyph.tile, { color: palette.faint })
    }
  }
  return row
}
