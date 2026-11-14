// Shared syntax-highlighting config + helper. Used by the runtime `Markdown` component (browser)
// and the docs site's build-time markdown renderer so both highlight code identically.

/**
 * Dual light/dark themes. Shiki emits both as CSS variables on each token; the `.dark` rules in
 * `globals.css` (`.prose .code-block pre.shiki span`) swap to the dark values.
 */
export const CODE_THEMES = { light: "github-light", dark: "github-dark" } as const

const LANG_BADGES: Record<string, string> = {
  ts: "TS",
  typescript: "TS",
  mts: "TS",
  cts: "TS",
  tsx: "TSX",
  js: "JS",
  javascript: "JS",
  mjs: "JS",
  cjs: "JS",
  jsx: "JSX",
  json: "JSON",
  jsonc: "JSONC",
  json5: "JSON5",
  jsonl: "JSONL",
  bash: "BASH",
  zsh: "BASH",
  sh: "SH",
  shell: "SH",
  shellscript: "SH",
  shellsession: "SH",
  "shell-session": "SH",
  console: "SH",
  powershell: "PS",
  pwsh: "PS",
  ps1: "PS",
  text: "TXT",
  txt: "TXT",
  plaintext: "TXT",
  plain: "TXT",
  css: "CSS",
  scss: "SCSS",
  sass: "SASS",
  less: "LESS",
  html: "HTML",
  htm: "HTML",
  xml: "XML",
  svg: "SVG",
  md: "MD",
  markdown: "MD",
  mdx: "MDX",
  sql: "SQL",
  postgres: "SQL",
  postgresql: "SQL",
  mysql: "SQL",
  sqlite: "SQL",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  ini: "INI",
  dotenv: "ENV",
  env: "ENV",
  csv: "CSV",
  tsv: "TSV",
  python: "PY",
  py: "PY",
  rust: "RS",
  rs: "RS",
  go: "GO",
  golang: "GO",
  java: "JAVA",
  kotlin: "KT",
  kt: "KT",
  scala: "SCALA",
  c: "C",
  cpp: "C++",
  "c++": "C++",
  cc: "C++",
  cxx: "C++",
  csharp: "C#",
  "c#": "C#",
  cs: "C#",
  fsharp: "F#",
  "f#": "F#",
  fs: "F#",
  objc: "OBJC",
  "objective-c": "OBJC",
  swift: "SWIFT",
  ruby: "RB",
  rb: "RB",
  php: "PHP",
  r: "R",
  lua: "LUA",
  elixir: "EX",
  ex: "EX",
  exs: "EX",
  dart: "DART",
  graphql: "GQL",
  gql: "GQL",
  dockerfile: "DOCKER",
  docker: "DOCKER",
  makefile: "MAKE",
  make: "MAKE",
  terraform: "TF",
  tf: "TF",
  hcl: "HCL",
  prisma: "PRISMA",
  diff: "DIFF",
  patch: "DIFF",
  mermaid: "MERMAID",
  vue: "VUE",
  svelte: "SVELTE",
  astro: "ASTRO",
}

const PLAIN_LANGS = new Set(["", "text", "txt", "plain", "plaintext"])
const MAX_HIGHLIGHT_CACHE = 256

const highlightCache = new Map<string, string>()
const inflightHighlights = new Map<string, Promise<string>>()

function normalizeLang(lang: string): string {
  return lang.trim().toLowerCase()
}

function cacheKey(code: string, lang: string): string {
  return `${normalizeLang(lang) || "text"}\0${code}`
}

function writeCache(key: string, html: string): void {
  if (highlightCache.has(key)) highlightCache.delete(key)
  else if (highlightCache.size >= MAX_HIGHLIGHT_CACHE) {
    const oldest = highlightCache.keys().next().value
    if (oldest !== undefined) highlightCache.delete(oldest)
  }
  highlightCache.set(key, html)
}

/** Whether `lang` names a syntax grammar rather than plain unhighlighted text. */
export function isPlainCodeLang(lang: string): boolean {
  return PLAIN_LANGS.has(normalizeLang(lang))
}

/** Synchronous lookup of a previously highlighted block so remounts and handoffs never flash. */
export function getCachedHighlight(code: string, lang: string): string | null {
  const key = cacheKey(code, lang)
  const hit = highlightCache.get(key)
  if (hit === undefined) return null
  // Refresh LRU recency.
  highlightCache.delete(key)
  highlightCache.set(key, hit)
  return hit
}

/** Short uppercase badge shown in a code block's header bar. */
export function badgeLabel(lang: string): string {
  const normalized = normalizeLang(lang)
  if (!normalized) return ""
  return LANG_BADGES[normalized] ?? normalized.toUpperCase().slice(0, 6)
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
  const cached = getCachedHighlight(code, lang)
  if (cached !== null) return cached

  const key = cacheKey(code, lang)
  const inflight = inflightHighlights.get(key)
  if (inflight) return inflight

  const resolved = normalizeLang(lang) || "text"
  const task = (async () => {
    const codeToHtml = await getCodeToHtml()
    try {
      const html = await codeToHtml(code, { lang: resolved, themes: CODE_THEMES })
      writeCache(key, html)
      return html
    } catch {
      const fallback = await codeToHtml(code, { lang: "text", themes: CODE_THEMES })
      writeCache(key, fallback)
      return fallback
    } finally {
      inflightHighlights.delete(key)
    }
  })()

  inflightHighlights.set(key, task)
  return task
}
