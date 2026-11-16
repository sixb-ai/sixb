import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanup, render, waitFor } from "@testing-library/react"
import { Window } from "happy-dom"
import { renderToStaticMarkup } from "react-dom/server"
import { defaultUrlTransform, Markdown } from "../src/components/ui/markdown"
import * as shiki from "../src/lib/shiki"
import { badgeLabel, getCachedHighlight, highlightCode, isPlainCodeLang } from "../src/lib/shiki"

const GLOBALS_CSS = readFileSync(join(import.meta.dir, "../src/styles/globals.css"), "utf8")

describe("Markdown", () => {
  test("renders headings h1-h6, inline styles, lists, quotes, rules, and footnotes", () => {
    const source = [
      "# Heading 1",
      "## Heading 2",
      "### Heading 3",
      "#### Heading 4",
      "##### Heading 5",
      "###### Heading 6",
      "",
      "Paragraph with **bold**, *italic*, ~~strikethrough~~, and `inlineCode()`[^1].",
      "",
      "- Unordered one",
      "  - Nested unordered",
      "1. Ordered one",
      "",
      "- [x] Completed task",
      "- [ ] Open task",
      "",
      "> Quoted line",
      "> > Nested quote",
      "",
      "---",
      "",
      "[^1]: Footnote detail.",
    ].join("\n")

    const html = renderToStaticMarkup(<Markdown>{source}</Markdown>)

    expect(html).toContain("<h1>Heading 1</h1>")
    expect(html).toContain("<h2>Heading 2</h2>")
    expect(html).toContain("<h3>Heading 3</h3>")
    expect(html).toContain("<h4>Heading 4</h4>")
    expect(html).toContain("<h5>Heading 5</h5>")
    expect(html).toContain("<h6>Heading 6</h6>")
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain("<em>italic</em>")
    expect(html).toContain("<del>strikethrough</del>")
    expect(html).toContain("<code>inlineCode()</code>")
    expect(html).toContain("<ul>")
    expect(html).toContain("<ol>")
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked/)
    expect(html).toContain("<blockquote>")
    expect(html).toContain("<hr/>")
    expect(html).toContain("data-footnotes")
  })

  test("renders bare and indented code blocks as block figures rather than inline code", () => {
    // Reproduce by unwrapping `pre` without `InsidePreContext` in markdown.tsx; bare fenced blocks
    // have no `language-*` class and collapse into an inline `<code>` span.
    const bare = ["```", "first line", "  indented second line", "```"].join("\n")
    const bareHtml = renderToStaticMarkup(<Markdown>{bare}</Markdown>)

    expect(bareHtml).toContain('<figure class="code-block code-block-bare">')
    expect(bareHtml).not.toContain('<figcaption class="code-bar">')
    expect(bareHtml).toContain(
      '<pre class="shiki"><code>first line\n  indented second line</code></pre>'
    )

    const indented = "Paragraph:\n\n    SELECT 1;\n    SELECT 2;\n"
    const indentedHtml = renderToStaticMarkup(<Markdown>{indented}</Markdown>)
    expect(indentedHtml).toContain('<figure class="code-block code-block-bare">')
    expect(indentedHtml).toContain("SELECT 1;\nSELECT 2;")
  })

  test("keeps hyphenated and symbol language identifiers and handles empty code fences", () => {
    // Reproduce by matching `/language-(\w+)/` or `String(children)` in markdown.tsx: `c++` becomes
    // `C` and an empty fence renders the literal word "undefined".
    const cpp = ["```c++", "int main() { return 0; }", "```"].join("\n")
    const cppHtml = renderToStaticMarkup(<Markdown>{cpp}</Markdown>)
    expect(cppHtml).toContain('<span class="code-badge">C++</span>')

    const objc = ["```objective-c", "@interface Box : NSObject", "```"].join("\n")
    const objcHtml = renderToStaticMarkup(<Markdown>{objc}</Markdown>)
    expect(objcHtml).toContain('<span class="code-badge">OBJC</span>')

    const empty = ["```ts", "```"].join("\n")
    const emptyHtml = renderToStaticMarkup(<Markdown>{empty}</Markdown>)
    expect(emptyHtml).toContain('<span class="code-badge">TS</span>')
    expect(emptyHtml).not.toContain("undefined")
  })

  test("opens external links in a new tab while keeping fragment links in place", () => {
    // Reproduce by adding `target="_blank"` unconditionally on `COMPONENTS.a`; `#overview` and
    // footnote references open a new tab instead of scrolling in place.
    const links = "[Docs](https://sixb.ai) and [Section](#overview)"
    const html = renderToStaticMarkup(<Markdown>{links}</Markdown>)

    expect(html).toContain(
      '<a href="https://sixb.ai" target="_blank" rel="noreferrer noopener">Docs</a>'
    )
    expect(html).toContain('<a href="#overview">Section</a>')
    expect(html).not.toMatch(/href="#overview"[^>]*target="_blank"/)
  })

  test("gives each rendered document its own footnote ids", () => {
    // Reproduce by dropping `remarkRehypeOptions` from Markdown in markdown.tsx; both replies render
    // `user-content-fn-1`, and the second reply's `[1]` scrolls to the first reply's note.
    const reply = (note: string) => `Sourced[^1].\n\n[^1]: ${note}`
    const html = renderToStaticMarkup(
      <>
        <Markdown>{reply("First reply's source.")}</Markdown>
        <Markdown>{reply("Second reply's source.")}</Markdown>
      </>
    )

    const replies = html.split('<div data-slot="markdown"').slice(1)
    const footnotes = replies.map((reply) => {
      const note = /<li id="([^"]+)">/.exec(reply)?.[1]
      const ref = /<a href="#([^"]+)" id="([^"]+)" data-footnote-ref/.exec(reply)
      const backref = /<a href="#([^"]+)" data-footnote-backref/.exec(reply)?.[1]
      return { note, href: ref?.[1], ref: ref?.[2], backref }
    })

    expect(footnotes).toHaveLength(2)
    for (const footnote of footnotes) {
      expect(footnote.note).toEndWith("fn-1")
      expect(footnote.href).toBe(footnote.note)
      expect(footnote.backref).toBe(footnote.ref)
    }
    expect(footnotes[0]?.note).not.toBe(footnotes[1]?.note)
    expect(footnotes[0]?.ref).not.toBe(footnotes[1]?.ref)
  })

  test("wraps tables in a scroll container and keeps only short cells on a single line", () => {
    const table = [
      "| ID | Description | Amount |",
      "| :--- | :--- | ---: |",
      "| inv_01 | Quarterly platform enterprise subscription renewal | $12,400 |",
    ].join("\n")

    const html = renderToStaticMarkup(<Markdown>{table}</Markdown>)

    expect(html).toContain('<div class="prose-table">')
    expect(html).toMatch(/<td[^>]*class="whitespace-nowrap"[^>]*>inv_01<\/td>/)
    expect(html).toMatch(/<td[^>]*class="whitespace-nowrap"[^>]*>\$12,400<\/td>/)
    expect(html).not.toMatch(/<td[^>]*class="whitespace-nowrap"[^>]*>Quarterly/)
  })

  test("strips unsafe URL schemes and never injects raw HTML markup", () => {
    expect(defaultUrlTransform("javascript:alert(1)")).toBe("")
    expect(defaultUrlTransform("data:text/html,<script>alert(1)</script>")).toBe("")
    expect(defaultUrlTransform("https://sixb.ai/docs")).toBe("https://sixb.ai/docs")

    const untrusted = [
      '[Click](javascript:alert("xss"))',
      "",
      "<script>window.__pwned = true</script>",
      '<img src="x" onerror="alert(1)" />',
    ].join("\n")
    const html = renderToStaticMarkup(<Markdown>{untrusted}</Markdown>)

    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("<script")
    expect(html).not.toContain("<img")
  })
})

describe("shiki helpers and prose styles", () => {
  test("maps full language names to accurate badges instead of truncating to 4 letters", () => {
    // Reproduce by removing full-name entries from `LANG_BADGES` in shiki.ts; `javascript` renders
    // "JAVA" and `typescript` renders "TYPE".
    expect(badgeLabel("javascript")).toBe("JS")
    expect(badgeLabel("typescript")).toBe("TS")
    expect(badgeLabel("markdown")).toBe("MD")
    expect(badgeLabel("c++")).toBe("C++")
    expect(badgeLabel("c#")).toBe("C#")
    expect(badgeLabel("dockerfile")).toBe("DOCKER")
    expect(badgeLabel("graphql")).toBe("GQL")
    expect(badgeLabel("")).toBe("")
    expect(isPlainCodeLang("")).toBe(true)
    expect(isPlainCodeLang("txt")).toBe(true)
    expect(isPlainCodeLang("typescript")).toBe(false)
  })

  test("caches highlighted HTML synchronously for subsequent renders and handoffs", async () => {
    // Reproduce by dropping `highlightCache` in shiki.ts; `getCachedHighlight` stays null and every
    // remount flashes unhighlighted `<pre>` before re-running Shiki.
    const snippet = "export const stable = true"
    expect(getCachedHighlight(snippet, "ts")).toBeNull()

    const highlighted = await highlightCode(snippet, "ts")
    expect(highlighted).toContain("shiki")
    expect(getCachedHighlight(snippet, "ts")).toBe(highlighted)
    expect(getCachedHighlight(snippet, "TS")).toBe(highlighted)

    const source = ["```ts", snippet, "```"].join("\n")
    const rendered = renderToStaticMarkup(<Markdown>{source}</Markdown>)
    expect(rendered).toContain(highlighted)
  })

  test("styles h5, h6, task lists, aligned table cells, footnotes, and wrapping in .prose", () => {
    expect(GLOBALS_CSS).toContain(".prose h5")
    expect(GLOBALS_CSS).toContain(".prose h6")
    expect(GLOBALS_CSS).toContain("overflow-wrap: break-word")
    expect(GLOBALS_CSS).toContain(".prose li.task-list-item")
    expect(GLOBALS_CSS).toContain('.prose :is(th, td)[align="center"]')
    expect(GLOBALS_CSS).toContain('.prose :is(th, td)[align="right"]')
    expect(GLOBALS_CSS).toContain(".prose section[data-footnotes]")
  })
})

describe("streamed code blocks", () => {
  const browser = new Window({ url: "https://ui.sixb.test" })
  const dom: Record<string, unknown> = {
    window: browser,
    self: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()

  beforeAll(() => {
    for (const [key, value] of Object.entries(dom)) {
      previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    }
  })

  afterEach(() => {
    cleanup()
    mock.restore()
  })

  afterAll(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    browser.close()
  })

  test("highlights the final code when it arrives while an earlier pass is still running", async () => {
    // Reproduce by stopping a pass when `code` changes instead of on unmount in CodeBlock (an
    // effect-scoped `active` flag): version 3 arrives during pass 2, no pass ever highlights it,
    // and the finished block keeps version 1's HTML.
    const passes: { code: string; finish: () => void }[] = []
    spyOn(shiki, "highlightCode").mockImplementation(
      (code) =>
        new Promise((resolve) => {
          const version = passes.length + 1
          passes.push({ code, finish: () => resolve(`<pre data-version="${version}"></pre>`) })
        })
    )
    const code = (version: number) =>
      Array.from({ length: version }, (_, line) => `const line${line} = ${line}`).join("\n")
    const reply = (version: number) => (
      <Markdown>{["```ts", code(version), "```"].join("\n")}</Markdown>
    )

    const view = render(reply(1))
    const highlighted = () =>
      view.container.querySelector("[data-version]")?.getAttribute("data-version")
    await waitFor(() => expect(passes).toHaveLength(1))
    passes[0]?.finish()
    await waitFor(() => expect(highlighted()).toBe("1"))

    view.rerender(reply(2))
    await waitFor(() => expect(passes).toHaveLength(2))
    view.rerender(reply(3))
    passes[1]?.finish()

    await waitFor(() => expect(passes).toHaveLength(3))
    expect(passes[2]?.code).toBe(code(3))
    passes[2]?.finish()
    await waitFor(() => expect(highlighted()).toBe("3"))
  })
})
