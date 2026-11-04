import { describe, expect, test } from "bun:test"
import type { AgentRunStreamEvent } from "@sixb/client"
import { renderToStaticMarkup } from "react-dom/server"
import { latestWorkLabel } from "../src/agent/activity-label"
import { AssistantBody } from "../src/agent/components/message-parts"
import { WebSearchToolView } from "../src/agent/components/web-search-tool-view"
import { fr } from "../src/agent/i18n/fr"
import { createLiveRunState, liveRunReducer } from "../src/agent/live-run"
import { type NormalizedPart, normalizeDurableParts } from "../src/agent/parts"
import {
  coerceWebSearchOutput,
  collectWebSources,
  formatPublicationDate,
} from "../src/agent/utils/web-search"

const result = {
  url: "https://www.example.com/article",
  title: "An article",
  text: "A short excerpt.",
}

function search(output: unknown, toolName = "web_search"): NormalizedPart {
  return {
    kind: "tool",
    tool: { toolName, state: "output-available", input: { query: "articles" }, output },
  }
}

// The shape Sixb's own `web_search` stores; `result` above is the Exa tool's, kept by older threads.
const hit = {
  url: "https://news.example.org/story",
  title: "A story",
  snippet: "What the story says.",
  publishedAt: "2026-11-02",
}

function fetched(output: unknown, input: unknown = { url: "https://docs.example.com/guide" }) {
  return {
    kind: "tool",
    tool: { toolName: "web_fetch", state: "output-available", input, output },
  } satisfies NormalizedPart
}

describe("web search sources", () => {
  test("reads Sixb's hits and the Exa results older threads stored alike", () => {
    expect(coerceWebSearchOutput({ query: "story", results: [hit] })).toEqual([
      {
        id: hit.url,
        url: hit.url,
        domain: "news.example.org",
        faviconUrl: "https://news.example.org/favicon.ico",
        title: hit.title,
        excerpt: hit.snippet,
        author: undefined,
        publishedDate: "2026-11-02",
      },
    ])

    const stored = coerceWebSearchOutput({
      results: [{ ...result, author: "Someone", publishedDate: "2026-09-14" }],
    })
    expect(stored?.[0]).toMatchObject({
      excerpt: result.text,
      author: "Someone",
      publishedDate: "2026-09-14",
    })

    expect(coerceWebSearchOutput({ query: "story", results: [{ ...hit, snippet: 42 }] })).toBeNull()
  })

  test("counts a page the agent read as a source, unless it only pointed elsewhere", () => {
    const page = {
      source: { url: "https://docs.example.com/guide", title: "The guide" },
      status: 200,
      contentType: "text/html",
      bytes: 4_096,
      preview: "# The guide",
    }
    const sources = collectWebSources([
      search({ query: "guide", results: [hit] }),
      fetched(page),
      fetched({ ...page, source: { url: hit.url, title: "Read again" } }),
      fetched({
        ...page,
        source: { url: "https://moved.example.com/", title: "" },
        status: 301,
        redirect: { url: "https://elsewhere.example.net/", status: 301 },
      }),
      fetched({ ...page, source: { url: "https://gone.example.com/", title: "" }, status: 404 }),
      fetched({ title: "Stored page", url: "https://old.example.com/", content: "Old text." }),
    ])

    expect(sources.map((source) => [source.domain, source.title, source.excerpt])).toEqual([
      ["news.example.org", "A story", "What the story says."],
      ["docs.example.com", "The guide", ""],
      ["old.example.com", "Stored page", "Old text."],
    ])
  })

  test("normalizes metadata and bounds excerpts without requiring optional fields", () => {
    expect(coerceWebSearchOutput({ results: [result] })).toEqual([
      {
        id: result.url,
        url: result.url,
        domain: "example.com",
        faviconUrl: "https://www.example.com/favicon.ico",
        title: result.title,
        excerpt: result.text,
        author: undefined,
        publishedDate: undefined,
      },
    ])
    const source = coerceWebSearchOutput({
      results: [
        {
          ...result,
          title: "  A\n title  ",
          text: "word ".repeat(1000),
          author: "  Someone ",
          publishedDate: "2026-09-14T23:00:00Z",
        },
      ],
    })?.[0]
    expect(source?.title).toBe("A title")
    expect(source?.excerpt.length).toBeLessThanOrEqual(360)
    expect(source?.excerpt.endsWith("…")).toBe(true)
    expect(source?.author).toBe("Someone")
    expect(source?.publishedDate).toBe("2026-09-14T23:00:00Z")
    expect(formatPublicationDate("2026-09-14T23:00:00Z", "en")).toBe("Sep 14, 2026")
    expect(formatPublicationDate("2026-09-14T23:00:00Z", "fr-FR")).toBe("14 sept. 2026")
    expect(
      coerceWebSearchOutput({ results: [{ ...result, publishedDate: "unknown" }] })?.[0]
        ?.publishedDate
    ).toBeUndefined()
  })

  test("keeps unknown shapes in the inspector and distinguishes empty from unsafe results", () => {
    for (const output of [
      null,
      {},
      { results: null },
      { results: [{ url: result.url }] },
      { results: [null] },
      { results: [{ ...result, text: 42 }] },
    ]) {
      expect(coerceWebSearchOutput(output)).toBeNull()
    }
    expect(coerceWebSearchOutput({ results: [] })).toEqual([])
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,test",
      "/relative",
      "https://user:pass@example.com",
      "file:///tmp/test",
    ]) {
      expect(coerceWebSearchOutput({ results: [{ ...result, url }] })).toBeNull()
    }
    expect(
      coerceWebSearchOutput({ results: [result, { ...result, url: "javascript:bad" }] })
    ).toHaveLength(1)
  })

  test("deduplicates pages across searches without collapsing domains or query parameters", () => {
    const sources = collectWebSources([
      search({
        results: [result, { ...result, url: "https://WWW.example.com:443/article#section" }],
      }),
      search({
        results: [
          { ...result, url: `${result.url}?lang=fr` },
          { ...result, url: "https://www.example.com/other" },
        ],
      }),
      search({ results: [{ ...result, url: "https://unrelated.example" }] }, "custom_tool"),
    ])
    expect(sources.map((source) => source.url)).toEqual([
      result.url,
      `${result.url}?lang=fr`,
      "https://www.example.com/other",
    ])
    const anchored = coerceWebSearchOutput({
      results: [{ ...result, url: `${result.url}#section` }],
    })?.[0]
    expect(anchored?.id).toBe(result.url)
    expect(anchored?.url).toBe(`${result.url}#section`)
  })

  // Regression check: restore src/components/MessageParts.tsx from HEAD, run this test, then
  // restore the implementation. It fails because the closed work group used to hide all sources.
  test("shows sources outside closed work details and before the answer", () => {
    const html = renderToStaticMarkup(
      <AssistantBody
        parts={[search({ results: [result] }), { kind: "text", text: "The answer." }]}
      />
    )
    expect(html).toContain('aria-label="Web search sources"')
    expect(html).toContain("example.com")
    expect(html).not.toContain("A short excerpt.")
    expect(html.indexOf("example.com")).toBeLessThan(html.indexOf("The answer."))
    expect(html).not.toContain("Open source")
  })

  test("limits the initial row and distinguishes pages from the same domain", () => {
    const results = Array.from({ length: 5 }, (_, i) => ({
      ...result,
      title: `Page ${i}`,
      url: `https://example.com/${i}`,
    }))
    const html = renderToStaticMarkup(<AssistantBody parts={[search({ results })]} />)
    expect(html).toContain("Show 2 more sources")
    expect(html).toContain("example.com · Page 0")
    expect(html).not.toContain("Page 3")
  })

  // Regression proof: drop `fileName(parsed)` in webSource; both chips then read
  // "localhost · localhost".
  test("names a page without a title by its file name, else its host", () => {
    const pdf = (url: string) => ({
      source: { url, title: "" },
      status: 200,
      contentType: "application/pdf",
      bytes: 4_096,
      path: "/w/out.pdf",
    })
    const parts = [
      fetched(pdf("http://localhost:3000/files/Q3%20report.pdf")),
      fetched(pdf("http://localhost:3000/")),
    ]

    expect(collectWebSources(parts).map((source) => source.title)).toEqual([
      "Q3 report.pdf",
      "localhost",
    ])
    expect(renderToStaticMarkup(<AssistantBody parts={parts} />)).toContain(
      "localhost · Q3 report.pdf"
    )
  })

  test("keeps sources from earlier successful searches when another search fails", () => {
    const html = renderToStaticMarkup(
      <AssistantBody
        parts={[
          search({ results: [result] }),
          {
            kind: "tool",
            tool: { toolName: "web_search", state: "output-error", errorText: "Timeout" },
          },
        ]}
      />
    )
    expect(html).toContain("example.com")
    expect(html).toContain("Web search failed. See work details.")
  })

  test("renders empty results without a phantom row and preserves unknown outputs", () => {
    const empty = renderToStaticMarkup(<AssistantBody parts={[search({ results: [] })]} />)
    expect(empty).toContain("No sources found.")
    expect(empty).not.toContain('aria-label="Web search sources"')
    const unknown = renderToStaticMarkup(
      <AssistantBody parts={[search({ results: "custom format" })]} />
    )
    expect(unknown).not.toContain("No sources found.")
    expect(unknown).not.toContain('aria-label="Web search sources"')
    const mixed = renderToStaticMarkup(
      <AssistantBody parts={[search({ results: [] }), search({ custom: "unknown" })]} />
    )
    expect(mixed).not.toContain("No sources found.")
  })

  test("uses readable progress and query text without treating query markup as HTML", () => {
    const part: NormalizedPart = {
      kind: "tool",
      tool: {
        toolName: "web_search",
        state: "input-available",
        input: { query: "<script>test</script>" },
      },
    }
    expect(latestWorkLabel([part])).toBe("Searching the web")
    expect(latestWorkLabel([part], fr)).toBe("Recherche sur le web")
    const html = renderToStaticMarkup(<WebSearchToolView tool={part.tool} />)
    expect(html).toContain("Searching the web")
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
  })

  test("collects identical sources in the stream and persisted message", () => {
    const output = { results: [result] }
    const event: AgentRunStreamEvent = {
      type: "agent.ui.chunk",
      schemaVersion: 1,
      projectId: "project",
      runId: "run",
      threadId: "thread",
      attempt: 1,
      occurredAt: "2026-09-14T00:00:00.000Z",
      chunkIndex: 0,
      chunk: { type: "tool-output-available", toolCallId: "call", toolName: "web_search", output },
    }
    const live = liveRunReducer(createLiveRunState("run"), { type: "event", event })
    const durable = normalizeDurableParts([
      {
        type: "tool-call",
        toolCallId: "call",
        toolName: "web_search",
        state: "output-available",
        input: { query: "articles" },
        output,
      },
    ])
    expect(collectWebSources(live.parts)).toEqual(collectWebSources(durable))
    expect(collectWebSources(live.parts)).toHaveLength(1)
  })
})

describe("web page progress", () => {
  const reading = (input: unknown): NormalizedPart => ({
    kind: "tool",
    tool: { toolName: "web_fetch", state: "input-available", input },
  })

  test("reads a page, or asks it a question, by its domain", () => {
    const url = "https://www.example.com/pricing"

    expect(latestWorkLabel([reading({ url })])).toBe("Reading example.com")
    expect(latestWorkLabel([reading({ url, question: "What does it cost?" })])).toBe(
      "Asking example.com"
    )
    expect(latestWorkLabel([reading({ url, question: "  " })])).toBe("Reading example.com")
    expect(latestWorkLabel([reading({ url, question: "Prix ?" })], fr)).toBe(
      "Question à example.com"
    )
  })
})
