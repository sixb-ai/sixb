import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { FRAME_DECK_CSS, FRAME_DEFAULT_THEMES } from "../src/artifacts/frames/kit"
import { ARTIFACT_THEME_TOKENS } from "../src/artifacts/theme"

const GLOBALS_CSS = join(import.meta.dir, "../../ui/src/styles/globals.css")

/** The custom properties of the top-level rule whose selector list includes `selector`. */
function declarations(css: string, selector: string): Record<string, string> {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)
  for (const [, prelude = "", body = ""] of rules) {
    // The prelude runs from the last brace, so it can start with statements such as `@import`.
    const selectors = (prelude.split(";").at(-1) ?? "").split(",").map((part) => part.trim())
    if (!selectors.includes(selector)) continue
    const found: Record<string, string> = {}
    for (const declaration of body.split(";")) {
      const colon = declaration.indexOf(":")
      const name = declaration.slice(0, colon).trim()
      if (colon !== -1 && name.startsWith("--")) found[name] = declaration.slice(colon + 1).trim()
    }
    return found
  }
  throw new Error(`No '${selector}' rule in ${GLOBALS_CSS}.`)
}

describe("a frame's default themes", () => {
  test("are the app's, light and dark, for every token the app sends into a frame", () => {
    // Reproduce by changing one of these tokens in packages/ui/src/styles/globals.css, or by
    // leaving a token out of either theme, as the light one once left out the chart colors.
    const css = readFileSync(GLOBALS_CSS, "utf8")
    const light = declarations(css, ":root")
    // `.dark` sits under `:root`, so a token it leaves alone keeps the light value.
    const dark = { ...light, ...declarations(css, ".dark") }
    for (const [mode, theme, app] of [
      ["light", FRAME_DEFAULT_THEMES.light, light],
      ["dark", FRAME_DEFAULT_THEMES.dark, dark],
    ] as const) {
      const tokens: Readonly<Record<string, string>> = theme.tokens
      expect(Object.keys(tokens).sort(), mode).toEqual([...ARTIFACT_THEME_TOKENS].sort())
      for (const token of ARTIFACT_THEME_TOKENS) {
        expect(tokens[token], `${mode} ${token}`).toBe(app[token])
      }
    }
  })

  test("start the kit in the light one", () => {
    // Reproduce by writing the kit's :root defaults out by hand again, as they once differed.
    const root = /:root \{([^}]*)\}/.exec(FRAME_DECK_CSS)?.[1] ?? ""
    for (const [token, value] of Object.entries(FRAME_DEFAULT_THEMES.light.tokens)) {
      expect(root, token).toContain(`${token}: ${value};`)
    }
  })
})
