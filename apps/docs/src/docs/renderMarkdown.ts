import { badgeLabel, highlightCode } from "@sixb/ui/lib/shiki"
import type { DocConfig } from "./config"
import type { DocHeading } from "./types"

const codeBlockPattern = /<pre><code(?: class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g
const localMarkdownLinkPattern = /href="([^"]+\.md)"/g
const headingPattern = /<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g
const firstParagraphPattern = /<p>([\s\S]*?)<\/p>/

// A single-file "File: `path`" paragraph immediately before a code block is
// hoisted into that block's header bar (after the language badge).
const fileLabelPattern =
  /<p>Files?:\s*<code>([^<]+)<\/code><\/p>\s*(<figure class="code-block"><figcaption class="code-bar"><span class="code-bar-left"><span class="code-badge">[^<]*<\/span>)/g

const copyIconMarkup =
  '<svg class="code-copy-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'

const checkIconMarkup =
  '<svg class="code-copy-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'

function hoistFileLabels(html: string): string {
  return html.replace(
    fileLabelPattern,
    (_match, file: string, barStart: string) => `${barStart}<span class="code-file">${file}</span>`
  )
}

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
    html: hoistFileLabels(await highlightCodeBlocks(linked)),
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
    const code = await highlightCode(decodeHtmlEntities(match[2] ?? ""), lang)
    parts.push(
      `<figure class="code-block"><figcaption class="code-bar"><span class="code-bar-left"><span class="code-badge">${badgeLabel(lang)}</span></span><button class="code-copy" type="button" data-copy aria-label="Copy code">${copyIconMarkup}${checkIconMarkup}</button></figcaption>${code}</figure>`
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
