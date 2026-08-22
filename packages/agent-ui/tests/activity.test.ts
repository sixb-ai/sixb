import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AssistantBody } from "../src/components/MessageParts"
import type { NormalizedPart } from "../src/parts"

describe("assistant work dropdowns", () => {
  test("caps an expanded work group and scrolls its details independently", () => {
    const html = renderAssistant(
      [reasoning("Checking the available records."), tool("search", "input-available")],
      true
    )

    expect(html).toContain("Working…")
    expect(html).toContain("max-h-[min(24rem,50vh)]")
    expect(html).toContain("overflow-y-auto")
    expect(html).toContain("overscroll-contain")
  })

  test("uses a content-width trigger instead of highlighting the full row", () => {
    const html = renderAssistant([reasoning("Checking records."), tool("search")], true)

    expect(html).toContain('class="group flex w-fit max-w-full')
  })

  test("visible assistant text separates consecutive work groups", () => {
    const html = renderAssistant([
      reasoning("First investigation"),
      tool("first-tool"),
      { kind: "text", text: "First update." },
      reasoning("Second investigation"),
      tool("second-tool"),
      { kind: "text", text: "Final result." },
    ])

    expect(html.match(/Worked/g)).toHaveLength(2)
    expect(html).toContain("First update.")
    expect(html).toContain("Final result.")
  })

  test("whitespace-only text does not split one work group into several dropdowns", () => {
    const html = renderAssistant([
      reasoning("First investigation"),
      tool("first-tool"),
      { kind: "text", text: " \n" },
      { kind: "step-start" },
      reasoning("Second investigation"),
      tool("second-tool"),
    ])

    expect(html.match(/Worked/g)).toHaveLength(1)
  })

  test("streams a text-only answer without inventing a work dropdown", () => {
    const html = renderAssistant([{ kind: "text", text: "Direct answer." }], true)

    expect(html).not.toContain("Working…")
    expect(html).not.toContain("Reasoning…")
    expect(html).toContain("Direct answer.")
  })
})

function renderAssistant(parts: readonly NormalizedPart[], live = false): string {
  return renderToStaticMarkup(createElement(AssistantBody, { parts, live }))
}

function reasoning(text: string): Extract<NormalizedPart, { kind: "reasoning" }> {
  return { kind: "reasoning", text, streaming: false }
}

function tool(
  toolName: string,
  state: Extract<NormalizedPart, { kind: "tool" }>["tool"]["state"] = "output-available"
): Extract<NormalizedPart, { kind: "tool" }> {
  return {
    kind: "tool",
    tool: {
      toolName,
      state,
      input: { query: "example" },
      ...(state === "output-available" ? { output: { ok: true } } : {}),
    },
  }
}
