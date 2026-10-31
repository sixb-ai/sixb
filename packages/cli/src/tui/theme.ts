import { palette } from "../ui/theme"

/**
 * The full-screen app's colors. It paints no background of its own: the terminal's shows through,
 * and panels are the terminal's background with a little of its foreground mixed in, so they sit
 * right on any theme. Blue is for what is live or chosen, amber for what waits on you.
 */
export interface TuiColors {
  /** Always the terminal's own. */
  readonly background: string
  /** Panels: the composer, a user's message, a dialog. */
  readonly surface: string
  /** A panel's selected row. */
  readonly raised: string
  readonly border: string
  readonly text: string
  readonly muted: string
  readonly faint: string
  readonly blue: string
  readonly water: readonly string[]
  /** The wordmark's blues, palest first, deep enough to read on this background. */
  readonly wordmark: readonly string[]
  /** Inline code in the agent's answers. */
  readonly code: string
  readonly green: string
  readonly amber: string
  readonly red: string
}

/** What the terminal says its own colors are, when it answers. */
export interface TerminalColors {
  readonly background: string
  readonly foreground: string
}

const night: TuiColors = {
  background: "transparent",
  surface: "#1a1c20",
  raised: "#24272d",
  border: "#2b2e35",
  text: "#eceef2",
  muted: "#8b919a",
  faint: "#5a6069",
  blue: palette.blue,
  water: palette.water,
  wordmark: palette.water.slice(1),
  code: "#8fbefc",
  green: palette.green,
  amber: palette.amber,
  red: palette.red,
}

const day: TuiColors = {
  background: "transparent",
  surface: "#f2f4f7",
  raised: "#e6e9ef",
  border: "#dfe3e9",
  text: "#17181c",
  muted: "#626873",
  faint: "#9aa0a9",
  blue: "#007aff",
  water: ["#a6cbfb", "#6fb0fc", "#3d95fd", "#007aff"],
  wordmark: ["#2f8bf5", "#0a74e8", "#0062cc"],
  code: "#0062cc",
  green: "#1f9d48",
  amber: "#c77700",
  red: "#e5332a",
}

/**
 * The colors for this terminal: from its own background and foreground when it reports them, else
 * Sixb's night or day colors for the mode it reports.
 */
export function tuiColors(
  mode: "light" | "dark" | null,
  terminal: TerminalColors | null = null
): TuiColors {
  if (!terminal) return mode === "light" ? day : night
  const { background, foreground } = terminal
  const dark = luminance(background) < 0.5
  const base = dark ? night : day
  return {
    ...base,
    surface: mix(background, foreground, dark ? 0.07 : 0.05),
    raised: mix(background, foreground, dark ? 0.13 : 0.1),
    border: mix(background, foreground, dark ? 0.18 : 0.14),
    text: foreground,
    muted: mix(background, foreground, 0.6),
    faint: mix(background, foreground, 0.38),
  }
}

/** `amount` of `to` mixed into `from`, both `#rrggbb`. */
export function mix(from: string, to: string, amount: number): string {
  const a = channels(from)
  const b = channels(to)
  return `#${a
    .map((value, index) => Math.round(value + ((b[index] ?? value) - value) * amount))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`
}

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = channels(hex)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

function channels(hex: string): number[] {
  const value = hex.replace("#", "").slice(0, 6).padEnd(6, "0")
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) || 0)
}
