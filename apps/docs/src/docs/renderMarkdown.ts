import { codeToHtml } from "shiki"
import type { DocConfig } from "./config"
import type { DocHeading } from "./types"

const codeBlockPattern = /<pre><code(?: class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g
const localMarkdownLinkPattern = /href="([^"]+\.md)"/g
const headingPattern = /<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g
const firstParagraphPattern = /<p>([\s\S]*?)<\/p>/

export interface RenderedDoc {
  readonly html: string
  readonly summary: string
  readonly headings: readonly DocHeading[]
}

export function renderMarkdown(markdown: string): string {
  return Bun.markdown.html(markdown, {
    tables: true,
    strikethrough: true,
    tasklists: true,
    autolinks: true,
    headings: { ids: true },
    tagFilter: true,
  })
}

export async function renderHighlightedMarkdown(
  markdown: string,
  options: {
    readonly doc: DocConfig
    readonly docs: readonly DocConfig[]
  }
): Promise<RenderedDoc> {
  const linked = rewriteLocalMarkdownLinks(renderMarkdown(markdown), options)
  return {
    html: await highlightCodeBlocks(linked),
    summary: extractSummary(linked),
    headings: extractHeadings(linked),
  }
}

async function highlightCodeBlocks(html: string): Promise<string> {
  const parts: string[] = []
  let lastIndex = 0

  for (const match of html.matchAll(codeBlockPattern)) {
    const index = match.index ?? 0
    parts.push(html.slice(lastIndex, index))
    const lang = match[1] ?? "text"
    const code = await codeToHtml(decodeHtmlEntities(match[2] ?? ""), {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
    })
    parts.push(
      `<figure class="code-block"><figcaption class="code-bar"><span class="code-lang">${lang}</span><button class="code-copy" type="button" data-copy aria-label="Copy code">Copy</button></figcaption>${code}</figure>`
    )
    lastIndex = index + match[0].length
  }

  parts.push(html.slice(lastIndex))
  return parts.join("")
}

function extractHeadings(html: string): DocHeading[] {
  const headings: DocHeading[] = []
  for (const match of html.matchAll(headingPattern)) {
    headings.push({
      level: Number(match[1]) as 2 | 3,
      id: match[2] ?? "",
      text: stripTags(match[3] ?? ""),
    })
  }
  return headings
}

function extractSummary(html: string): string {
  const match = html.match(firstParagraphPattern)
  return match ? stripTags(match[1] ?? "") : ""
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, "")).trim()
}

function rewriteLocalMarkdownLinks(
  html: string,
  options: {
    readonly doc: DocConfig
    readonly docs: readonly DocConfig[]
  }
): string {
  return html.replace(localMarkdownLinkPattern, (match, rawHref: string) => {
    const routePath = resolveRenderedRoutePath(rawHref, options)
    return routePath ? `href="${routePath}"` : match
  })
}

function resolveRenderedRoutePath(
  rawHref: string,
  options: {
    readonly doc: DocConfig
    readonly docs: readonly DocConfig[]
  }
): string | null {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(rawHref) || rawHref.startsWith("#")) {
    return null
  }

  let url: URL
  try {
    url = new URL(rawHref, `https://sixb.local${options.doc.markdownPath}`)
  } catch {
    return null
  }

  const pathname = url.pathname
  const target = options.docs.find((doc) => doc.markdownPath === pathname)
  if (!target) {
    return null
  }

  return `${target.routePath}${url.hash}`
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-fA-F]+)|([a-zA-Z]+));/g, (match, dec, hex, name) => {
    if (dec) {
      return String.fromCodePoint(Number.parseInt(dec, 10))
    }

    if (hex) {
      return String.fromCodePoint(Number.parseInt(hex, 16))
    }

    if (name === "amp") return "&"
    if (name === "lt") return "<"
    if (name === "gt") return ">"
    if (name === "quot") return '"'
    if (name === "apos") return "'"
    return match
  })
}
