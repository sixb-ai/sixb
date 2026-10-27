import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render as mount } from "@testing-library/react"
import { useState } from "react"
import { MemoryRouter } from "react-router-dom"
import { type AgentToolView, defineAgentToolView } from "../src"
import { AssistantBody } from "../src/agent/components/message-parts"
import type { NormalizedPart, NormalizedTool } from "../src/agent/parts"
import { agentToolViews } from "../src/agent/tool-views/define"
import { AgentToolViewsProvider } from "../src/agent/tool-views/registry"
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
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const quote: NormalizedTool = {
  toolName: "quote_shipping",
  state: "output-available",
  input: { orderId: "ORD-7" },
  output: { carrier: "DHL", price: 42 },
}

const quoteView = defineAgentToolView("quote_shipping").render((props) => (
  <p data-testid="quote">
    {props.state === "output-available" ? `Quote for ${String(props.input.orderId)}` : props.state}
  </p>
))

function tool(value: NormalizedTool): NormalizedPart {
  return { kind: "tool", tool: value }
}

function renderBody(parts: readonly NormalizedPart[], views?: readonly AgentToolView[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
  return mount(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentToolViewsProvider views={views}>
          <AssistantBody parts={parts} />
        </AgentToolViewsProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function workTriggers(view: ReturnType<typeof renderBody>): HTMLElement[] {
  return view.getAllByRole("button", { name: /^\d+ steps?/ })
}

async function openWork(view: ReturnType<typeof renderBody>) {
  await act(async () => {
    for (const trigger of workTriggers(view)) fireEvent.click(trigger)
  })
}

/** What the open work groups show inside, without their headlines. */
function workText(view: ReturnType<typeof renderBody>): string {
  return workTriggers(view)
    .map((trigger) => document.getElementById(trigger.getAttribute("aria-controls") ?? ""))
    .map((content) => content?.textContent ?? "")
    .join("\n")
}

describe("defineAgentToolView", () => {
  test("returns a frozen, inert view placed in the work by default", () => {
    const view = defineAgentToolView("quote_shipping").render(() => null)

    expect(view).toEqual({
      kind: "agentToolView",
      toolName: "quote_shipping",
      placement: "work",
      render: view.render,
    })
    expect(Object.isFrozen(view)).toBe(true)
    expect(
      defineAgentToolView("quote_shipping", { placement: "answer" }).render(() => null)
    ).toEqual(expect.objectContaining({ placement: "answer" }))
  })

  test("refuses a name, a placement or a component a tool view cannot have", () => {
    expect(() => defineAgentToolView("quote shipping")).toThrow(
      "[SixbApp] defineAgentToolView needs the name of a tool"
    )
    expect(() => defineAgentToolView("")).toThrow("needs the name of a tool")
    expect(() => defineAgentToolView("quote_shipping", { placement: "body" as "answer" })).toThrow(
      `The view of tool 'quote_shipping' has placement "body". Use "work" or "answer".`
    )
    expect(() =>
      defineAgentToolView("quote_shipping").render("QuoteCard" as unknown as () => null)
    ).toThrow("[SixbApp] The view of tool 'quote_shipping' needs a component")
  })
})

describe("the layout's toolViews export", () => {
  test("is optional, and a list of views with one view per tool", () => {
    expect(agentToolViews(undefined).size).toBe(0)
    expect(agentToolViews([quoteView]).get("quote_shipping")).toBe(quoteView)

    expect(() => agentToolViews(quoteView)).toThrow(
      "[SixbApp] Invalid toolViews in app/layout.tsx: the named toolViews export must be an array"
    )
    expect(() => agentToolViews([quoteView, { toolName: "count_rows" }])).toThrow(
      "toolViews[1] is not a view from defineAgentToolView."
    )
    // Reproduce by dropping the `registry.has` check: the second view silently wins.
    const again = defineAgentToolView("quote_shipping").render(() => null)
    expect(() => agentToolViews([quoteView, again])).toThrow(
      "two views for the tool 'quote_shipping'. Keep one view per tool."
    )
  })

  test("is checked again by the provider, behind the build's check", () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined)
    const again = defineAgentToolView("quote_shipping").render(() => null)

    expect(() => renderBody([], [quoteView, again])).toThrow(
      "[SixbApp] Invalid toolViews in app/layout.tsx: two views for the tool 'quote_shipping'."
    )
    consoleError.mockRestore()
  })
})

describe("a project's tool in the chat", () => {
  afterEach(() => {
    // Some tests silence the error a failing view logs.
    spyOn(console, "error").mockRestore()
  })

  test("without a view, shows as the generic row", async () => {
    const view = renderBody([tool(quote)])
    await openWork(view)

    expect(workText(view)).toContain("quote_shipping")
    expect(view.queryByTestId("quote")).toBeNull()
  })

  test("a view placed in the work takes the generic row's place", async () => {
    const view = renderBody(
      [tool(quote), { kind: "text", text: "Here is the quote." }],
      [quoteView]
    )

    // Closed, the work hides it like any row.
    expect(view.queryByTestId("quote")).toBeNull()
    await openWork(view)

    expect(view.getByTestId("quote").textContent).toBe("Quote for ORD-7")
    expect(workText(view)).not.toContain("quote_shipping")
  })

  test("a view placed in the answer closes the text, before the cards, and the row stays in the work", async () => {
    const answer = defineAgentToolView("quote_shipping", { placement: "answer" }).render(
      (props) => <p data-testid="quote">{props.state}</p>
    )
    const published = tool({
      toolName: "publish_artifact",
      state: "output-available",
      input: { path: "work/review", title: "Q3 review" },
      output: { artifactId: "art_review0001", version: 1, kind: "document", title: "Q3 review" },
    })
    const parts = [
      tool({ ...quote, state: "input-available", output: undefined }),
      { kind: "text", text: "Quoted it." } as const,
      published,
      { kind: "text", text: "And published the review." } as const,
    ]
    const view = renderBody(parts, [answer])
    const html = view.container.innerHTML

    // Live, while the tool still runs, and in call order after every text block.
    expect(view.getByTestId("quote").textContent).toBe("input-available")
    expect(html.indexOf("And published the review.")).toBeLessThan(
      html.indexOf('data-testid="quote"')
    )
    expect(html.indexOf('data-testid="quote"')).toBeLessThan(
      html.indexOf("Published in this response")
    )

    await openWork(view)
    expect(workText(view)).toContain("quote_shipping")
  })

  test("framework tools keep their own rows", async () => {
    const read = tool({
      toolName: "read",
      state: "output-available",
      input: { path: "notes.md" },
      output: { path: "notes.md", content: "Northline notes" },
    })
    const view = renderBody([read])
    await openWork(view)

    // Reproduce by dropping `read` from the built-in registry: the generic row names the tool.
    expect(workText(view)).toContain("notes.md")
    expect(workText(view)).not.toContain("read")
  })

  test("a project view of a framework tool replaces the framework's row", async () => {
    const readView = defineAgentToolView("read").render(() => <p data-testid="read">Our read</p>)
    const view = renderBody(
      [tool({ toolName: "read", state: "input-available", input: { path: "notes.md" } })],
      [readView]
    )
    await openWork(view)

    expect(view.getByTestId("read").textContent).toBe("Our read")
    expect(workText(view)).not.toContain("notes.md")
  })

  test("a view that throws falls back to the tool's built-in row and says why", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined)
    const broken = defineAgentToolView("quote_shipping").render(() => {
      throw new Error("no carrier")
    })
    const view = renderBody([tool(quote), { kind: "text", text: "Still here." }], [broken])
    await openWork(view)

    // Reproduce by rendering the view without its ToolViewBoundary: the whole body unmounts.
    expect(view.container.textContent).toContain("Still here.")
    expect(workText(view)).toContain("quote_shipping")
    expect(
      consoleError.mock.calls.some(
        ([message]) =>
          typeof message === "string" &&
          message.startsWith("[SixbApp] The view of tool 'quote_shipping' failed to render")
      )
    ).toBe(true)
  })

  test("a view runs as a component, so it can hold state", async () => {
    const counter = defineAgentToolView("quote_shipping", { placement: "answer" }).render(() => {
      const [count, setCount] = useState(0)
      return (
        <button type="button" onClick={() => setCount(count + 1)}>
          Clicked {count}
        </button>
      )
    })
    const view = renderBody([tool(quote)], [counter])
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Clicked 0" }))
    })

    expect(view.getByRole("button", { name: "Clicked 1" })).toBeDefined()
  })

  test("a failed call gives its view the error text", () => {
    const answer = defineAgentToolView("quote_shipping", { placement: "answer" }).render(
      (props) => (
        <p data-testid="quote">{props.state === "output-error" ? props.errorText : props.state}</p>
      )
    )
    const view = renderBody(
      [tool({ toolName: "quote_shipping", state: "output-error", errorText: "No carrier." })],
      [answer]
    )

    expect(view.getByTestId("quote").textContent).toBe("No carrier.")
  })
})
