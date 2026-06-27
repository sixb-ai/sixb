// Shared syntax-highlighting config + helper. Used by the runtime `Markdown` component (browser)
// and the docs site's build-time markdown renderer so both highlight code identically.

/**
 * Dual light/dark themes. Shiki emits both as CSS variables on each token; the `.dark` rules in
 * `globals.css` (`.prose .code-block pre.shiki span`) swap to the dark values.
 */
export const CODE_THEMES = { light: "github-light", dark: "github-dark" } as const

const LANG_BADGES: Record<string, string> = {
  ts: "TS",
  tsx: "TSX",
  js: "JS",
  jsx: "JSX",
  json: "JSON",
  bash: "BASH",
  sh: "SH",
  shell: "SH",
  text: "TXT",
  txt: "TXT",
  css: "CSS",
  html: "HTML",
  md: "MD",
  sql: "SQL",
  yaml: "YAML",
  yml: "YAML",
  python: "PY",
  py: "PY",
}

/** Short uppercase badge shown in a code block's header bar. */
export function badgeLabel(lang: string): string {
  return LANG_BADGES[lang.toLowerCase()] ?? lang.toUpperCase().slice(0, 4)
}

// Shiki (grammars + highlighting engine) is heavy, so load it lazily — code-free conversations and
// docs builds without code blocks never pull it in.
type CodeToHtml = typeof import("shiki")["codeToHtml"]
let codeToHtmlPromise: Promise<CodeToHtml> | null = null

async function getCodeToHtml(): Promise<CodeToHtml> {
  codeToHtmlPromise ??= import("shiki").then((module) => module.codeToHtml)
  return codeToHtmlPromise
}

/**
 * Highlight `code` to a `<pre class="shiki">…</pre>` string using the shared themes. Falls back to
 * a plain (unhighlighted) render if the language grammar is unknown, so it never throws.
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const codeToHtml = await getCodeToHtml()
  const resolved = lang.trim() || "text"
  try {
    return await codeToHtml(code, { lang: resolved, themes: CODE_THEMES })
  } catch {
    return codeToHtml(code, { lang: "text", themes: CODE_THEMES })
  }
}
