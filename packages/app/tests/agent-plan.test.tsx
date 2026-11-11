import { describe, expect, test } from "bun:test"
import { LocaleProvider } from "@sixb/ui/lib/i18n"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render as mount } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { latestWorkLabel } from "../src/agent/activity-label"
import { AssistantBody } from "../src/agent/components/message-parts"
import type {
  AgentConversationMessage,
  AgentConversationPart,
  AgentConversationTurn,
} from "../src/agent/conversation"
import { en } from "../src/agent/i18n/en"
import { fr } from "../src/agent/i18n/fr"
import type { NormalizedPart, NormalizedTool } from "../src/agent/parts"
import { isPlanCall, livePlan, planItems, planOf } from "../src/agent/plan/interpret"
import { AgentPlan } from "../src/agent/plan/plan-strip"
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

// An account review, as a model would plan it in the user's words.
const review = {
  todos: [
    { content: "Gather Northwind's open invoices", status: "completed" },
    { content: "Check the March invoices", status: "completed" },
    { content: "Compare usage with the contract", status: "in_progress" },
    { content: "Note what to raise with the customer", status: "pending" },
    { content: "Draft the account review", status: "pending" },
  ],
}

const done = {
  todos: review.todos.map((todo) => ({ ...todo, status: "completed" })),
}

/** What the todo tool keeps of a list: its counts. */
function counts(input: { readonly todos: readonly { content: string; status: string }[] }) {
  return {
    total: input.todos.length,
    completed: input.todos.filter((item) => item.status === "completed").length,
    inProgress: input.todos.filter((item) => item.status === "in_progress").map((i) => i.content),
  }
}

function todo(input: unknown, state: "input-streaming" | "output-available" = "output-available") {
  return state === "output-available"
    ? ({
        type: "tool",
        toolName: "todo",
        state,
        input: input as Record<string, unknown>,
        output: counts(input as Parameters<typeof counts>[0]),
      } as AgentConversationPart)
    : ({ type: "tool", toolName: "todo", state, input } as AgentConversationPart)
}

const askCall = {
  type: "tool",
  toolName: "ask",
  state: "output-available",
  input: { questions: [{ question: "Which contract year?", choices: ["2025", "2026"] }] },
  output: {},
} as AgentConversationPart

const searching = {
  type: "tool",
  toolName: "web_search",
  state: "input-available",
  input: { query: "Northwind usage" },
} as AgentConversationPart

function user(text: string): AgentConversationMessage {
  return message("user", [{ type: "text", text, streaming: false }])
}

function reply(...parts: AgentConversationPart[]): AgentConversationMessage {
  return message("assistant", parts)
}

let keys = 0
function message(
  role: "user" | "assistant",
  parts: readonly AgentConversationPart[]
): AgentConversationMessage {
  keys += 1
  return {
    key: `m${keys}`,
    id: `m${keys}`,
    role,
    status: "complete",
    runId: role === "assistant" ? `run${keys}` : null,
    parts,
    context: [],
    diagnostics: [],
  }
}

const actions = {
  canStop: true,
  canRetry: false,
  canContinue: false,
  stopping: false,
  retrying: false,
  continuing: false,
}

const responding: AgentConversationTurn = {
  ...actions,
  kind: "responding",
  runId: "run",
  waitingLonger: false,
  waitingFor: null,
  compacting: false,
  contextFull: false,
  reconnecting: false,
  answeringFor: null,
}

const idle: AgentConversationTurn = { ...actions, kind: "idle" }

describe("the plan a todo call sends", () => {
  test("reads its items defensively: trimmed, without empty ones, unknown statuses to do", () => {
    expect(
      planItems({
        todos: [
          { content: "  Check the March invoices  ", status: "in_progress" },
          { content: "   ", status: "pending" },
          { content: 42, status: "pending" },
          "Draft the review",
          { content: "Draft the review", status: "blocked" },
        ],
      })
    ).toEqual([
      { content: "Check the March invoices", status: "in_progress" },
      { content: "Draft the review", status: "pending" },
    ])
    expect(planItems({ todos: "Check the invoices" })).toEqual([])
    expect(planItems(null)).toEqual([])
  })

  test("counts what is done and says the first item in progress", () => {
    expect(planOf(review)).toMatchObject({
      completed: 2,
      current: "Compare usage with the contract",
      unfinished: true,
    })
    expect(planOf(done)).toMatchObject({ completed: 5, current: null, unfinished: false })
    // An empty list clears the plan.
    expect(planOf({ todos: [] })).toBeNull()
  })
})

describe("the plan of the work in progress", () => {
  test("is the running reply's newest list, not one the model is still writing", () => {
    // Guard proof: drop the state check in `newestPlan` (src/agent/plan/interpret.ts); the list
    // still streaming, with its half-written item, wins.
    const messages = [
      user("Prepare Northwind's account review"),
      reply(todo(review), todo({ todos: [{ content: "Check the Ma" }] }, "input-streaming")),
    ]
    expect(livePlan(messages, responding)?.current).toBe("Compare usage with the contract")
    expect(livePlan(messages, idle)).toBeNull()
  })

  test("never crosses a message from the user, an answer to its question too", () => {
    // Guard proof: in `livePlan`, go on past a user message whose previous reply asked a question,
    // as the loop did before; the set-aside question then brings the old plan into the new request.
    const asking = reply(todo(review), askCall)
    expect(livePlan([user("Prepare the review"), asking, user("2026")], responding)).toBeNull()
    // The user set the question aside and asked for something else.
    expect(
      livePlan(
        [user("Prepare the review"), asking, user("Forget it, translate this email instead")],
        responding
      )
    ).toBeNull()

    const answered = reply(todo(review))
    expect(livePlan([user("Prepare the review"), answered, user("Thanks!")], responding)).toBeNull()
  })

  test("goes on across the replies a turn resumes, while work is left", () => {
    // Guard proof: in `livePlan`, keep every reply's plan to the end (`index === newest` always
    // true); the finished plan then stays on the strip for the whole resumed run.
    const resumed = reply(searching)
    expect(
      livePlan([user("Prepare the review"), reply(todo(review)), resumed], responding)?.current
    ).toBe("Compare usage with the contract")

    expect(
      livePlan([user("Prepare the review"), reply(todo(done)), resumed], responding)
    ).toBeNull()
    // The reply at work keeps its own plan to the end, done too.
    expect(livePlan([user("Prepare the review"), reply(todo(done))], responding)?.completed).toBe(5)
  })

  // Guard proof: drop the runId check from `awaitsApproval`; a call an earlier turn still holds then
  // keeps that turn's plan after the turn that answered the user ended.
  test("stays while the turn waits for a decision on a call it held, and only then", () => {
    const planned = reply(todo(review))
    const messages = [user("Prepare the review"), planned]
    const pending = { status: "pending", runId: planned.runId ?? "" } as const

    expect(livePlan(messages, idle, [pending])?.current).toBe("Compare usage with the contract")
    // Decided or set aside, the turn resumed or ended: what it does next says.
    expect(livePlan(messages, idle, [{ ...pending, status: "cancelled" }])).toBeNull()
    expect(livePlan(messages, { kind: "failed" }, [pending])).toBeNull()
    // A call held by an older turn is not this one's.
    expect(livePlan([...messages, reply(searching)], idle, [pending])).toBeNull()
  })

  test("leaves a cleared plan behind", () => {
    expect(
      livePlan([user("Prepare the review"), reply(todo(review), todo({ todos: [] }))], responding)
    ).toBeNull()
  })

  // Guard proof: drop `!isPlanCall(call)` from `newestPlan`; the project's call then clears the
  // plan the reply sent before it.
  test("skips a project's own tool named todo, and its calls keep their generic row", () => {
    expect(isPlanCall({ state: "output-available", input: review, output: counts(review) })).toBe(
      true
    )
    expect(isPlanCall({ state: "input-streaming", input: undefined })).toBe(true)
    expect(
      isPlanCall({ state: "output-available", input: { title: "Buy milk" }, output: {} })
    ).toBe(false)
    expect(isPlanCall({ state: "output-available", input: review, output: { id: "t1" } })).toBe(
      false
    )

    const project = {
      type: "tool",
      toolName: "todo",
      state: "output-available",
      input: { title: "Buy milk" },
      output: { id: "t1" },
    } as AgentConversationPart
    expect(
      livePlan([user("Prepare the review"), reply(todo(review), project)], responding)?.current
    ).toBe("Compare usage with the contract")
  })
})

describe("the plan over the composer", () => {
  test("says the item in progress and how far, and opens to every item", async () => {
    const view = mount(
      <AgentPlan messages={[user("Prepare the review"), reply(todo(review))]} turn={responding} />
    )
    try {
      const line = view.getByRole("button")
      expect(line.textContent).toBe("Compare usage with the contract2 of 5 done")
      expect(line.getAttribute("aria-expanded")).toBe("false")
      expect(view.queryByRole("list")).toBeNull()

      await act(async () => fireEvent.click(line))
      expect(line.getAttribute("aria-expanded")).toBe("true")
      const items = view.getAllByRole("listitem").map((item) => item.textContent)
      expect(items).toEqual([
        "Done: Gather Northwind's open invoices",
        "Done: Check the March invoices",
        "In progress: Compare usage with the contract",
        "To do: Note what to raise with the customer",
        "To do: Draft the account review",
      ])
    } finally {
      view.unmount()
    }
  })

  test("is gone once the turn ends, and reads in the conversation's language", () => {
    const messages = [user("Prépare la revue"), reply(todo(review))]
    const ended = mount(<AgentPlan messages={messages} turn={idle} />)
    try {
      expect(ended.container.textContent).toBe("")
    } finally {
      ended.unmount()
    }

    const french = mount(
      <LocaleProvider locale="fr">
        <AgentPlan messages={messages} turn={responding} />
      </LocaleProvider>
    )
    try {
      expect(french.getByRole("button").textContent).toContain("2 sur 5 terminées")
    } finally {
      french.unmount()
    }
  })
})

describe("the plan in the work", () => {
  function tool(
    input: unknown,
    state: NormalizedTool["state"] = "output-available"
  ): NormalizedPart {
    return {
      kind: "tool",
      tool: {
        toolName: "todo",
        state,
        input,
        ...(state === "output-available"
          ? { output: counts(input as Parameters<typeof counts>[0]) }
          : {}),
      },
    }
  }
  const search: NormalizedPart = {
    kind: "tool",
    tool: { toolName: "web_search", state: "input-available", input: { query: "Northwind" } },
  }

  function renderBody(parts: readonly NormalizedPart[], live = false) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    return mount(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AssistantBody parts={parts} live={live} />
        </MemoryRouter>
      </QueryClientProvider>
    )
  }

  test("is a quiet row of how far it was, opening to its items, never its JSON", async () => {
    const view = renderBody([tool(review), { kind: "text", text: "Here is the review." }])
    try {
      await act(async () => fireEvent.click(view.getByRole("button", { name: "1 step" })))
      const row = view.getByRole("button", { name: /Updated the plan/ })
      expect(row.textContent).toBe("Updated the plan2 of 5 done")

      await act(async () => fireEvent.click(row))
      expect(view.getAllByRole("listitem")).toHaveLength(5)
      expect(view.container.textContent).not.toContain("todos")
      expect(view.container.textContent).not.toContain("in_progress")
    } finally {
      view.unmount()
    }

    const cleared = renderBody([tool({ todos: [] }), { kind: "text", text: "Done." }])
    try {
      await act(async () => fireEvent.click(cleared.getByRole("button", { name: "1 step" })))
      expect(cleared.container.textContent).toContain("Cleared the plan")
    } finally {
      cleared.unmount()
    }
  })

  // Guard proof: in BUILT_IN_TOOL_VIEWS, render PlanToolView whatever the call holds; the
  // project's call then reads "Cleared the plan".
  test("a project's own tool named todo, in an earlier thread, keeps the generic row", async () => {
    const project: NormalizedPart = {
      kind: "tool",
      tool: {
        toolName: "todo",
        state: "output-available",
        input: { title: "Buy milk" },
        output: { id: "t1" },
      },
    }
    const view = renderBody([project, { kind: "text", text: "Added." }])
    try {
      await act(async () => fireEvent.click(view.getByRole("button", { name: "1 step" })))
      expect(view.container.textContent).toContain("todo")
      expect(view.container.textContent).not.toContain("Cleared the plan")
    } finally {
      view.unmount()
    }
  })

  // Guard proof: have AssistantBody's live line say `planOf(...).current` of the reply's newest
  // todo call, as it did; the line then reads "Compare usage with the contract" and the strip
  // over the composer says it a second time.
  test("leaves the item in progress to the strip: the live line says the newest step", () => {
    const view = renderBody([tool(review), search], true)
    try {
      expect(view.container.textContent).toContain("Searching the web")
      expect(view.container.textContent).not.toContain("Compare usage with the contract")
    } finally {
      view.unmount()
    }
  })

  // Guard proof: drop the todo branch from `toolProgressLabel` (src/agent/activity-label.ts); the
  // live line then reads "Using todo". Return `plan.updated` for a call that returned instead; it
  // reads "Updated the plan", which the line would turn into "Still updated the plan…".
  test("says the plan's step in the present, in the conversation's language", () => {
    const label = (part: NormalizedPart, messages = en) => latestWorkLabel([part], messages)

    expect(label(tool({ todos: [{ content: "Check" }] }, "input-streaming"))).toBe(
      "Updating the plan"
    )
    expect(label(tool(review))).toBe("Following the plan")
    expect(label(tool(review), fr)).toBe("Poursuite du plan")
    expect(label(tool(review, "output-error"))).toBe("Couldn't update the plan")

    const project: NormalizedPart = {
      kind: "tool",
      tool: { toolName: "todo", state: "output-available", input: { title: "Buy milk" } },
    }
    expect(label(project)).toBe("Using todo")
  })
})
