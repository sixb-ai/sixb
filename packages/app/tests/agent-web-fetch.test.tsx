import { describe, expect, test } from "bun:test"
import { act, fireEvent, render } from "@testing-library/react"
import { WebFetchToolView } from "../src/agent/components/web-fetch-tool-view"
import type { NormalizedTool } from "../src/agent/parts"
import { builtInToolView } from "../src/agent/tool-views/built-in"
import { coerceWebFetchOutput } from "../src/agent/utils/web-fetch"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "EventTarget",
  "MouseEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const page = {
  source: { url: "https://www.example.com/pricing", title: "Pricing" },
  status: 200,
  contentType: "text/html; charset=utf-8",
  bytes: 122_880,
  path: "/workspace/.sixb/tool-outputs/call-1a2b3c4d5e6f.md",
  preview: "# Plans\n\nThe team plan costs **$20** a month.\n\n![chart](https://example.com/c.png)",
}

function fetchTool(output: unknown, input: Record<string, unknown> = {}): NormalizedTool {
  return {
    toolName: "web_fetch",
    state: "output-available",
    input: { url: page.source.url, ...input },
    output,
  }
}

async function opened(tool: NormalizedTool) {
  const view = render(<WebFetchToolView tool={tool} />)
  const trigger = view.getByRole("button")
  const closed = trigger.textContent

  await act(async () => {
    fireEvent.click(trigger)
  })

  const content = document.getElementById(trigger.getAttribute("aria-controls") ?? "")
  return { view, closed, content: content?.textContent ?? "", element: content }
}

describe("a web page the agent read", () => {
  test("shows the answer to its question, and what the server sent only once opened", async () => {
    const tool = fetchTool(
      { ...page, question: "What does the team plan cost?", answer: "It costs **$20** a month." },
      { question: "What does the team plan cost?" }
    )
    const { closed, content, element } = await opened(tool)

    expect(closed).toBe("Pricingexample.com")
    expect(content).toContain("What does the team plan cost?")
    expect(element?.querySelector("strong")?.textContent).toBe("$20")
    expect(content).not.toContain("The team plan costs")
    expect(content).toContain("200 · text/html · 120 KB")
    expect(content).not.toContain("tool-outputs")
  })

  // Guard proof: drop `components={PAGE_COMPONENTS}` in web-fetch-tool-view.tsx; the page's chart
  // renders as an image that loads from its site.
  // Guard proof: drop `components={PAGE_COMPONENTS}` from the answer's Markdown; the image the
  // page made the model quote then loads.
  test("shows the answer without loading the images it quotes from the page", async () => {
    const tool = fetchTool({
      ...page,
      question: "Any chart?",
      answer: "Yes: ![chart](https://tracker.example.com/pixel.png)",
    })

    const { element } = await opened(tool)

    expect(element?.textContent).toContain("Yes:")
    expect(element?.querySelector("img")).toBeNull()
  })

  test("shows the start of the page without loading its images", async () => {
    const { content, element } = await opened(fetchTool({ ...page, truncated: true }))

    expect(element?.querySelector("h1")?.textContent).toBe("Plans")
    expect(content).toContain("The team plan costs $20 a month.")
    expect(element?.querySelector("img")).toBeNull()
    expect(content).toContain("120 KB · truncated")
  })

  // Regression proof: drop the `answerTruncated` note in web-fetch-tool-view.tsx; the cut answer
  // then reads as complete.
  test("says, once opened, that an answer cut at its length limit may be incomplete", async () => {
    const question = { question: "Which plans?" }
    const cut = await opened(
      fetchTool({ ...page, ...question, answer: "Free, Team and", answerTruncated: true })
    )

    expect(cut.closed).not.toContain("incomplete")
    expect(cut.content).toContain(
      "Free, Team andThe answer stopped at its length limit and may be incomplete."
    )
    cut.view.unmount()

    const whole = await opened(fetchTool({ ...page, ...question, answer: "Free and Team." }))
    expect(whole.content).not.toContain("incomplete")
  })

  // Regression proof: drop `fileName(parsed)` in webSource; the row then reads
  // "localhostlocalhost".
  test("names a PDF without a title by its file name", async () => {
    const url = "http://localhost:3000/files/Q3%20report.pdf"
    const { closed } = await opened(
      fetchTool(
        {
          source: { url, title: "" },
          status: 200,
          contentType: "application/pdf",
          bytes: 4_096,
          path: "/w/out.pdf",
        },
        { url }
      )
    )

    expect(closed).toBe("Q3 report.pdflocalhost")
  })

  test("says when the question went unanswered and shows the page instead", async () => {
    const { content } = await opened(
      fetchTool({ ...page, question: "Is there a free plan?", answerError: "Refused." })
    )

    expect(content).toContain("Is there a free plan?")
    expect(content).toContain("No answer came back. Here is how the page begins.")
    expect(content).toContain("The team plan costs $20 a month.")
    expect(content).not.toContain("Refused.")
  })

  test("names the site a redirect pointed to instead of the page's text", async () => {
    const { closed, element } = await opened(
      fetchTool({
        source: { url: page.source.url, title: "" },
        status: 301,
        contentType: "text/html",
        bytes: 0,
        redirect: { url: "https://shop.example.net/pricing", status: 301 },
      })
    )

    expect(closed).toBe("pricingRedirected to shop.example.net")
    expect(element?.textContent).not.toContain("No page text was returned.")
    expect(element?.querySelector("a")?.getAttribute("href")).toBe(
      "https://shop.example.net/pricing"
    )
  })

  test("still renders the page the Exa tool stored in older threads", async () => {
    const stored = { title: "Old page", url: "https://old.example.com/a", content: "Old text." }
    expect(builtInToolView(fetchTool(stored))).not.toBeNull()

    const { closed, content } = await opened(fetchTool(stored))
    expect(closed).toBe("Old pageold.example.com")
    expect(content).toContain("Old text.")
  })

  test("leaves an output it does not recognize to the inspector", () => {
    for (const output of [{ source: { title: "No address" } }, { source: { url: "file:///x" } }]) {
      expect(coerceWebFetchOutput(output)).toBeNull()
      expect(builtInToolView(fetchTool(output))).toBeNull()
    }
  })
})
