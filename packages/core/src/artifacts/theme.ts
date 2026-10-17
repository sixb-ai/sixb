/** An artifact may carry this file at its root to override the app's theme. */
export const ARTIFACT_THEME_FILE = "theme.json"

/**
 * An artifact's own theme. `mode` pins light or dark whatever the viewer's app uses; `tokens`
 * override the app's values for the names in {@link ARTIFACT_THEME_TOKENS}.
 */
export interface ArtifactTheme {
  readonly mode?: "light" | "dark"
  readonly tokens?: Readonly<Record<string, string>>
}

const COLOR_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--muted",
  "--muted-foreground",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
] as const
const FONT_TOKENS = ["--font-sans", "--font-serif", "--font-mono"] as const

/** The tokens a theme may set. Every other app token stays the app's. */
export const ARTIFACT_THEME_TOKENS: readonly string[] = [
  ...COLOR_TOKENS,
  ...FONT_TOKENS,
  "--radius",
]

// Values land in CSS custom properties, so each kind of token takes one narrow shape: nothing that
// could close the declaration, open a URL, or call a function other than a color space.
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const FUNCTION_COLOR =
  /^(?:rgba?|hsla?|oklch|oklab|lab|lch)\((?:[\d.%\s,/+-]|deg|turn|rad|none)*\)$/i
const FONT_FAMILY =
  /^\s*(?:"[\w -]+"|'[\w -]+'|[\w-]+)(?:\s*,\s*(?:"[\w -]+"|'[\w -]+'|[\w-]+))*\s*$/
const LENGTH = /^(?:0|\d{1,3}(?:\.\d+)?(?:px|rem|em))$/

/** Reads a `theme.json`. Returns the reason it was refused, in words the author can act on. */
export function parseArtifactTheme(
  text: string
): { readonly theme: ArtifactTheme } | { readonly error: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { error: `${ARTIFACT_THEME_FILE} is not valid JSON.` }
  }
  if (!isObject(value)) return { error: `${ARTIFACT_THEME_FILE} must be a JSON object.` }

  const unknownKey = Object.keys(value).find((key) => key !== "mode" && key !== "tokens")
  if (unknownKey) {
    return {
      error: `${ARTIFACT_THEME_FILE} has '${unknownKey}'; it takes only "mode" and "tokens".`,
    }
  }
  if (value.mode !== undefined && value.mode !== "light" && value.mode !== "dark") {
    return { error: `${ARTIFACT_THEME_FILE} "mode" must be "light" or "dark".` }
  }
  if (value.tokens !== undefined && !isObject(value.tokens)) {
    return { error: `${ARTIFACT_THEME_FILE} "tokens" must be an object of token names to values.` }
  }

  const tokens: Record<string, string> = {}
  for (const [name, tokenValue] of Object.entries(value.tokens ?? {})) {
    if (!ARTIFACT_THEME_TOKENS.includes(name)) {
      return {
        error: `${ARTIFACT_THEME_FILE} sets '${name}'. A theme can set ${ARTIFACT_THEME_TOKENS.join(", ")}.`,
      }
    }
    if (typeof tokenValue !== "string" || !tokenValueFits(name, tokenValue)) {
      return {
        error: `${ARTIFACT_THEME_FILE} gives '${name}' a value it cannot use: ${expected(name)}.`,
      }
    }
    tokens[name] = tokenValue.trim()
  }

  return {
    theme: {
      ...(value.mode === undefined ? {} : { mode: value.mode }),
      ...(Object.keys(tokens).length === 0 ? {} : { tokens }),
    },
  }
}

function tokenValueFits(name: string, value: string): boolean {
  const trimmed = value.trim()
  if (name === "--radius") return LENGTH.test(trimmed)
  if ((FONT_TOKENS as readonly string[]).includes(name)) {
    return trimmed.length <= 200 && FONT_FAMILY.test(trimmed)
  }
  return HEX_COLOR.test(trimmed) || FUNCTION_COLOR.test(trimmed)
}

function expected(name: string): string {
  if (name === "--radius") return "a length such as 8px or 0.5rem"
  if ((FONT_TOKENS as readonly string[]).includes(name)) {
    return 'a font list such as "Inter Tight", system-ui, sans-serif'
  }
  return "a color such as #2f7280 or oklch(0.62 0.1 210)"
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
