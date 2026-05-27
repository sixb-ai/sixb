import { codeToHtml } from "shiki"
import type { DocConfig } from "./config"

const codeBlockPattern = /<pre><code(?: class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g
const localMarkdownLinkPattern = /href="([^"]+\.md)"/g

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
): Promise<string> {
  const html = rewriteLocalMarkdownLinks(renderMarkdown(markdown), options)
  const parts: string[] = []
  let lastIndex = 0

  for (const match of html.matchAll(codeBlockPattern)) {
    const index = match.index ?? 0
    parts.push(html.slice(lastIndex, index))
    parts.push(
      await codeToHtml(decodeHtmlEntities(match[2] ?? ""), {
        lang: match[1] ?? "text",
        themes: {
          light: "github-light",
          dark: "github-dark",
        },
      })
    )
    lastIndex = index + match[0].length
  }

  parts.push(html.slice(lastIndex))
  return parts.join("")
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
