import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AgentExecutionTrace } from "../src/AgentExecutionTrace"
import { AssistantBody } from "../src/components/MessageParts"
import { type NormalizedPart, normalizeDurableParts } from "../src/parts"
import type { AgentMessagePart } from "../src/types"

describe("assistant work dropdowns", () => {
  test("renders a durable workflow trace through the shared agent presentation", () => {
    const parts: AgentMessagePart[] = [
      { type: "step-start" },
      { type: "reasoning", text: "Checking policy." },
      {
        type: "tool-call",
        toolCallId: "policy-call",
        toolName: "lookup_policy",
        state: "output-available",
        input: { severity: "high" },
        output: { responseWindowMinutes: 90 },
      },
      {
        type: "tool-call",
        toolCallId: "failed-call",
        toolName: "lookup_history",
        state: "output-error",
        input: { caseNumber: "SC-1042" },
        errorText: "History unavailable",
      },
      { type: "text", text: "Dispatch within 90 minutes." },
    ]

    const html = renderToStaticMarkup(createElement(AgentExecutionTrace, { parts }))

    expect(html).toContain("Worked")
    expect(html).toContain("2 steps")
    expect(html).toContain("Dispatch within 90 minutes.")
    expect(normalizeDurableParts(parts)).toContainEqual({
      kind: "tool",
      tool: {
        toolName: "lookup_policy",
        state: "output-available",
        input: { severity: "high" },
        output: { responseWindowMinutes: 90 },
      },
    })
    expect(normalizeDurableParts(parts)).toContainEqual({
      kind: "tool",
      tool: {
        toolName: "lookup_history",
        state: "output-error",
        input: { caseNumber: "SC-1042" },
        errorText: "History unavailable",
      },
    })
  })

  test("renders workflow traces as explicit debugger steps", () => {
    const parts: AgentMessagePart[] = [
      { type: "step-start" },
      { type: "reasoning", text: "Checking policy." },
      { type: "text", text: "I will look up the response policy." },
      {
        type: "tool-call",
        toolCallId: "policy-call",
        toolName: "lookup_policy",
        state: "output-available",
        input: { severity: "high" },
        output: { responseWindowMinutes: 90 },
      },
      {
        type: "tool-call",
        toolCallId: "history-call",
        toolName: "lookup_history",
        state: "output-error",
        input: { caseNumber: "SC-1042" },
        errorText: "History unavailable",
      },
      { type: "step-start" },
      { type: "text", text: "Dispatch within 90 minutes." },
    ]

    const html = renderToStaticMarkup(
      createElement(AgentExecutionTrace, { parts, variant: "debug" })
    )

    expect(html).toContain("Step 1")
    expect(html).toContain("Step 2")
    expect(html).toContain("2 tool calls")
    expect(html).toContain("lookup_policy")
    expect(html).toContain("Succeeded")
    expect(html).not.toContain("responseWindowMinutes")
    expect(html).toContain("lookup_history")
    expect(html).toContain("Failed")
    expect(html).toContain("History unavailable")
    expect(html).toContain("Final answer")
    expect(html).toContain("Dispatch within 90 minutes.")
  })

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
