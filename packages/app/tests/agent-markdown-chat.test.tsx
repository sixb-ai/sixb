import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ArtifactReferencesProvider,
  ReferencingMarkdown,
} from "../src/artifacts/references/references"

const AGENT_CSS = readFileSync(join(import.meta.dir, "../src/agent/agent.css"), "utf8")

function renderChatMarkdown(markdown: string): string {
  const cache = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <ArtifactReferencesProvider open={() => {}}>
        <ReferencingMarkdown className="prose-chat">{markdown}</ReferencingMarkdown>
      </ArtifactReferencesProvider>
    </QueryClientProvider>
  )
}

describe("chat markdown rendering", () => {
  test("turns GitHub alert quotes into callouts and keeps plain quotes as blockquotes", () => {
    // Reproduce by removing `rehypeCallouts` or `ReplyCallout` from ReferencingMarkdown; marked
    // quotes render literally inside a blockquote in chat replies.
    const html = renderChatMarkdown(
      [
        "> [!WARNING]",
        "> Deleting this column removes stored values.",
        "",
        "> [!NOTE]",
        "> Backups run hourly.",
        "",
        "> A standard quote stays a blockquote.",
      ].join("\n")
    )

    expect(html).toContain('<aside class="sixb-callout" data-callout="warning">')
    expect(html).toContain('<p class="sixb-callout-label">Warning</p>')
    expect(html).toContain("Deleting this column removes stored values.")
    expect(html).toContain('<aside class="sixb-callout" data-callout="note">')
    expect(html).toContain('<p class="sixb-callout-label">Note</p>')
    expect(html).toContain("<blockquote>")
    expect(html).not.toContain("[!WARNING]")
    expect(html).not.toContain("[!NOTE]")
  })

  test("keeps footnote and hash links in-page while opening external links in a new tab", () => {
    const html = renderChatMarkdown(
      [
        "See [Sixb](https://sixb.ai), [Summary](#summary), and note[^1].",
        "",
        "[^1]: Cached per message.",
      ].join("\n")
    )

    expect(html).toContain(
      '<a href="https://sixb.ai" target="_blank" rel="noreferrer noopener">Sixb</a>'
    )
    expect(html).toContain('<a href="#summary">Summary</a>')
    expect(html).not.toMatch(/href="#summary"[^>]*target="_blank"/)
    expect(html).not.toMatch(/href="#user-content-fn-1"[^>]*target="_blank"/)
  })

  test("defines conversational .prose.prose-chat typography rules in agent.css", () => {
    // Reproduce by removing `.prose.prose-chat` from agent.css; chat replies fall back to docs-page
    // 36px h1 headings and 48px h2 margins.
    expect(AGENT_CSS).toContain(".prose.prose-chat")
    expect(AGENT_CSS).toContain(".prose.prose-chat h1")
    expect(AGENT_CSS).toContain(".prose.prose-chat h2")
    expect(AGENT_CSS).toContain(".prose.prose-chat table")
  })
})
