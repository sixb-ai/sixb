import { Platform, useColorScheme, type ViewStyle } from "react-native"

export type Scheme = "light" | "dark"

/** The colors of the workspace screens, one set per appearance. */
export interface Palette {
  readonly canvas: string
  /** Cards, list groups and other raised surfaces. */
  readonly card: string
  /** Fills inside a surface: code blocks, idle buttons, image placeholders. */
  readonly well: string
  readonly rule: string
  readonly ink: string
  readonly secondary: string
  readonly muted: string
  /** Large de-emphasized text only; too light for body copy. */
  readonly faint: string
  readonly badge: string
  readonly link: string
  readonly danger: string
  /** The strongest fill, for your own messages and the send button, with the text that sits on it. */
  readonly inverse: string
  readonly onInverse: string
  /** Frosted surfaces that float over content, such as the composer. */
  readonly glass: string
  readonly glassBorder: string
  readonly glassTint: "light" | "dark"
  readonly backdrop: string
  /** A sheet that slides over the screen, and the tiles on it. */
  readonly sheet: string
  readonly sheetTile: string
}

export const palettes: Readonly<Record<Scheme, Palette>> = {
  light: {
    canvas: "#F4F4F2",
    card: "#FFFFFF",
    well: "#F0F0ED",
    rule: "#DCDCD8",
    ink: "#0C0C0D",
    secondary: "#56565B",
    muted: "#6A6A6F",
    faint: "#8A8A8F",
    badge: "#1E3A5F",
    link: "#1F5FD1",
    danger: "#B42318",
    inverse: "#0C0C0D",
    onInverse: "#FFFFFF",
    glass: "rgba(255,255,255,0.82)",
    glassBorder: "rgba(255,255,255,0.9)",
    glassTint: "light",
    backdrop: "rgba(12,12,13,0.32)",
    sheet: "#F4F4F2",
    sheetTile: "#FFFFFF",
  },
  dark: {
    canvas: "#0B0B0C",
    card: "#1C1C1E",
    well: "#2C2C2E",
    rule: "#38383A",
    ink: "#F5F5F7",
    secondary: "#AEAEB2",
    muted: "#98989D",
    faint: "#6E6E73",
    badge: "#2B5486",
    link: "#5E9BFF",
    danger: "#FF6B5E",
    inverse: "#F5F5F7",
    onInverse: "#0B0B0C",
    glass: "rgba(28,28,30,0.78)",
    glassBorder: "rgba(255,255,255,0.08)",
    glassTint: "dark",
    backdrop: "rgba(0,0,0,0.5)",
    sheet: "#1C1C1E",
    sheetTile: "#2C2C2E",
  },
}

/** The welcome and scanner screens: dark in either appearance. */
export const night = {
  background: "#0A0A0B",
  text: "#F5F5F7",
  muted: "#A1A1A6",
  faint: "#8E8E93",
  field: "#1C1C1E",
  border: "rgba(255,255,255,0.14)",
  error: "#FF8A80",
} as const

export const fonts = {
  mono: Platform.select({ ios: "Menlo", default: "monospace" }),
} as const

/** A soft lift for cards. Black in both appearances; on dark surfaces it fades out, as it should. */
export const cardShadow: ViewStyle = {
  shadowColor: "#000000",
  shadowOpacity: 0.06,
  shadowRadius: 15,
  shadowOffset: { width: 0, height: 10 },
  elevation: 2,
}

/** The system appearance, which the app follows as it changes. */
export function useScheme(): Scheme {
  return useColorScheme() === "dark" ? "dark" : "light"
}

export function usePalette(): Palette {
  return palettes[useScheme()]
}

/**
 * Turn a styles factory into a hook that returns the styles for the current appearance. Each
 * appearance's styles are built once, the first time it is used.
 */
export function makeStyles<T>(factory: (palette: Palette) => T): () => T {
  const built = new Map<Scheme, T>()
  return function useStyles() {
    const scheme = useScheme()
    let styles = built.get(scheme)
    if (!styles) {
      styles = factory(palettes[scheme])
      built.set(scheme, styles)
    }
    return styles
  }
}
