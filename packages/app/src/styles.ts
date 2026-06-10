import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { resolveTailwindCliEntry } from "./tailwind"

export type CustomAppStylesheet =
  /** No `app/globals.css` — the app ships no framework-managed stylesheet. */
  | { readonly kind: "none" }
  /** Plain handwritten CSS — bundled as-is, exactly as before. */
  | { readonly kind: "static"; readonly path: string }
  /** Tailwind source — compiled to `outputPath` before bundling. */
  | { readonly kind: "tailwind"; readonly sourcePath: string; readonly outputPath: string }

export interface ResolveCustomAppStylesheetInput {
  readonly appDir: string
  readonly generatedDir: string
  readonly rootDir: string
}

/**
 * Decides how `app/globals.css` participates in the build.
 *
 * `globals.css` is treated as Tailwind *source* when it uses Tailwind at-rules
 * (`@source`, `@theme`, ...) or imports a package stylesheet such as
 * `@sixb/ui/globals.css` — those need the Tailwind pipeline before they are
 * shippable. Plain CSS keeps the existing pass-through behavior, so apps that
 * never opted into Tailwind are unaffected.
 */
export async function resolveCustomAppStylesheet(
  input: ResolveCustomAppStylesheetInput
): Promise<CustomAppStylesheet> {
  const sourcePath = join(input.appDir, "globals.css")

  let css: string
  try {
    css = await readFile(sourcePath, "utf-8")
  } catch {
    return { kind: "none" }
  }

  if (!usesTailwind(css)) {
    return { kind: "static", path: sourcePath }
  }

  if (!resolveTailwindCliEntry(input.rootDir)) {
    throw new Error(
      "[SixbCustomApp] app/globals.css uses Tailwind features but '@tailwindcss/cli' is not installed. Install it with: bun add tailwindcss @tailwindcss/cli"
    )
  }

  return {
    kind: "tailwind",
    sourcePath,
    outputPath: join(input.generatedDir, "app.css"),
  }
}

const TAILWIND_AT_RULES =
  /@(?:tailwind|source|theme|plugin|config|utility|custom-variant|variant|apply)\b/

export function usesTailwind(css: string): boolean {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "")

  if (TAILWIND_AT_RULES.test(stripped)) {
    return true
  }

  // A bare-specifier @import (e.g. `@import "tailwindcss"` or
  // `@import "@sixb/ui/globals.css"`) pulls in package CSS that the browser
  // bundler would inline without processing its Tailwind directives.
  for (const match of stripped.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)) {
    const specifier = match[1]
    if (
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("#") &&
      !/^(?:https?:|data:)/.test(specifier)
    ) {
      return true
    }
  }

  return false
}
