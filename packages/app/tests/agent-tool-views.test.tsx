import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render as mount } from "@testing-library/react"
import { useState } from "react"
import { MemoryRouter } from "react-router-dom"
import { type AgentToolView, defineAgentToolView } from "../src"
import { BashToolView } from "../src/agent/bash/bash-tool-view"
import { AssistantBody } from "../src/agent/components/message-parts"
import { EditToolView, WriteToolView } from "../src/agent/file-edits/file-edit-tool-view"
import type { NormalizedPart, NormalizedTool } from "../src/agent/parts"
import { ReadToolView } from "../src/agent/read/read-tool-view"
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

describe("a command in the chat", () => {
  // Removal proof: show description.detail alone on a failed command's line in BashToolView; the
  // line then says nothing of the timeout, and reads as any other failure.
  test("a timed-out command says how long it had, and keeps the model's notice to the model", () => {
    const notice =
      "[SixbAgent] The command was stopped after 5 minutes, its timeout. Pass a larger timeoutMs, up to 600000, to give it longer."
    const view = mount(
      <BashToolView
        tool={{
          state: "output-available",
          input: { command: "bun run build", timeoutMs: 300_000 },
          output: {
            exitCode: 137,
            stdout: "",
            stderr: `warning: slow\n${notice}`,
            durationMs: 300_000,
            timedOut: true,
          },
        }}
      />
    )
    try {
      const line = view.getByRole("button", { name: /timed out after 5 min/ })
      expect(line.textContent).not.toContain("137")

      fireEvent.click(line)
      expect(view.getByText("warning: slow")).toBeDefined()
      expect(view.container.textContent).not.toContain("[SixbAgent]")
    } finally {
      view.unmount()
    }
  })
})

describe("a file the agent changed", () => {
  // Removal proof: drop "edit" or "write" from BUILT_IN_TOOL_VIEWS; the generic row then names the
  // tool instead of the file.
  test("edit and write keep their own rows in the work", async () => {
    const view = renderBody([
      tool({
        toolName: "edit",
        state: "output-available",
        input: { path: "src/app.ts" },
        output: { path: "src/app.ts", replaced: 1, diff: "@@ -1 +1 @@\n-a\n+b\n" },
      }),
      tool({
        toolName: "write",
        state: "output-available",
        input: { path: "notes/plan.md", content: "x" },
        output: { path: "notes/plan.md", created: true, lines: 1, bytes: 1 },
      }),
    ])
    await openWork(view)

    expect(workText(view)).toContain("Edited app.ts")
    expect(workText(view)).toContain("Created plan.md")
  })

  test("an edit says what it changed, +added −removed, and opens to the diff", () => {
    const view = mount(
      <EditToolView
        tool={{
          toolName: "edit",
          state: "output-available",
          input: { path: "src/app.ts", old_string: "3", new_string: "5" },
          output: {
            path: "src/app.ts",
            replaced: 1,
            diff: "@@ -1,2 +1,2 @@\n-const retries = 3\n+const retries = 5\n \n",
          },
        }}
      />
    )
    try {
      const line = view.getByRole("button", { name: /Edited app\.ts/ })
      expect(line.textContent).toContain("+1")
      expect(line.textContent).toContain("−1")

      fireEvent.click(line)
      expect(view.getByText("const retries = 3")).toBeDefined()
      expect(view.getByText("const retries = 5")).toBeDefined()
      expect(view.getByText("src/app.ts")).toBeDefined()
    } finally {
      view.unmount()
    }
  })

  // Reproduce: count added and removed from the diff alone in describeEdit; the row then
  // shows +1 −1.
  test("a large edit shows all the lines it changed, though its diff was cut", () => {
    const view = mount(
      <EditToolView
        tool={{
          toolName: "edit",
          state: "output-available",
          input: { path: "src/app.ts", old_string: "a", new_string: "b", replace_all: true },
          output: {
            path: "src/app.ts",
            replaced: 40,
            diff: "@@ -1,1 +1,1 @@\n-a\n+b\n… 39 more hunks\n",
            added: 40,
            removed: 40,
          },
        }}
      />
    )
    try {
      const line = view.getByRole("button", { name: /Edited app\.ts/ })
      expect(line.textContent).toContain("+40")
      expect(line.textContent).toContain("−40")
    } finally {
      view.unmount()
    }
  })

  test("a write says whether it created or rewrote the file, and opens to what it wrote", () => {
    const write = (created: boolean) =>
      mount(
        <WriteToolView
          tool={{
            toolName: "write",
            state: "output-available",
            input: { path: "notes/plan.md", content: "# Plan\n\nShip it.\n" },
            output: { path: "notes/plan.md", created, lines: 3, bytes: 17 },
          }}
        />
      )
    const created = write(true)
    try {
      const line = created.getByRole("button", { name: /Created plan\.md/ })
      expect(line.textContent).toContain("3 lines")
      fireEvent.click(line)
      expect(created.getByText("Ship it.")).toBeDefined()
    } finally {
      created.unmount()
    }
    const rewritten = write(false)
    try {
      expect(rewritten.getByRole("button", { name: /Rewrote plan\.md/ })).toBeDefined()
    } finally {
      rewritten.unmount()
    }
  })

  test("a read of a folder lists its entries", () => {
    const view = mount(
      <ReadToolView
        tool={{
          toolName: "read",
          state: "output-available",
          input: { path: "src" },
          output: { path: "src", entries: ["index.ts", "lib/"] },
        }}
      />
    )
    try {
      const line = view.getByRole("button", { name: /Listed src/ })
      expect(line.textContent).toContain("2 entries")
      fireEvent.click(line)
      expect(view.container.textContent).toContain("index.ts\nlib/")
    } finally {
      view.unmount()
    }
  })
})

describe("the Agent's question in its reply", () => {
  // Removal proof: drop the ask exclusion from flushWork in AssistantBody; the question then also
  // shows as a row in the work.
  test("shows as a card after the work, not as a row in it", () => {
    const view = renderBody([
      tool({
        toolName: "ask",
        state: "output-available",
        input: { questions: [{ question: "Which year?", choices: ["2025", "2026"] }] },
        output: { status: "asked" },
      }),
    ])
    // The card alone: no work line before it.
    expect(view.container.textContent).toBe("Asked youWhich year?")
  })
})
