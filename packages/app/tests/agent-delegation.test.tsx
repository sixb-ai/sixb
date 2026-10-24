import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { client } from "@sixb/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, waitFor, within } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { MemoryRouter } from "react-router-dom"
import { latestWorkLabel } from "../src/agent/activity-label"
import type { AgentApproval } from "../src/agent/approvals"
import { Transcript } from "../src/agent/components/transcript"
import { type AgentChild, childTitle } from "../src/agent/delegation/interpret"
import { createLiveRunState } from "../src/agent/live-run"
import { ObservedThreadContext } from "../src/agent/observed-thread"
import type { AgentMessage } from "../src/agent/types"
import { installDom } from "./helpers/dom"

const dom = installDom([
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "Event",
  "CustomEvent",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const originalConfig = client.getConfig()
// Generated query keys carry the client's base URL, so it is set before any key is built.
client.setConfig({ baseUrl: "https://api.sixb.test" })

/** Sockets the cards open; a test plays the server by calling their handlers. */
const sockets: FakeSocket[] = []
const previousWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = FakeSocket.CONNECTING
  readonly sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { readonly data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor() {
    sockets.push(this)
  }

  send(message: string): void {
    this.sent.push(message)
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED
  }

  addEventListener(): void {}

  removeEventListener(): void {}
}

// Radix picks its layout effect when it loads, a no-op without a `document`, and the sheet then
// never mounts. This file or another of the run loads it before the window exists, so it is given
// React's own, and its own back after the file.
const radix = Bun.resolveSync("radix-ui", Bun.resolveSync("@sixb/ui/components", import.meta.dir))
const layoutEffect = Bun.resolveSync(
  "@radix-ui/react-use-layout-effect",
  Bun.resolveSync("@radix-ui/react-portal", Bun.resolveSync("@radix-ui/react-dialog", radix))
)
const loaded: typeof import("react").useLayoutEffect = (await import(layoutEffect)).useLayoutEffect
mock.module(layoutEffect, () => ({ useLayoutEffect }))

beforeAll(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeSocket,
  })
})

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  client.setConfig({ fetch: originalConfig.fetch })
  sockets.length = 0
  dom.happyDOM.setViewport({ width: 1024, height: 768 })
})

afterAll(() => {
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  if (previousWebSocket) Object.defineProperty(globalThis, "WebSocket", previousWebSocket)
  else Reflect.deleteProperty(globalThis, "WebSocket")
})

const at = "2026-10-25T09:00:00.000Z"
const later = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString()
const sonnet = { provider: "gateway", modelId: "anthropic/sonnet" }
const dana = { type: "user", id: "usr_dana" } as const

type ChildRun = AgentChild["runs"][number]

function childRun(id: string, overrides: Partial<ChildRun> = {}): ChildRun {
  return {
    id,
    parentRunId: "run_1",
    status: "succeeded",
    finishReason: "stop",
    attempt: 1,
    streamId: `agents.runs.${id}`,
    createdAt: at,
    startedAt: at,
    completedAt: later(48),
    ...overrides,
  }
}

/** A child of the turn `run_1`, spawned under `key` into its thread, as the API lists it. */
function child(key: string, overrides: Partial<AgentChild> = {}): AgentChild {
  const id = `run_${key}`
  return {
    id,
    threadId: `thr_${key}`,
    projectId: "proj",
    spawnedBy: "run_1",
    key,
    task: `Look into ${key}.`,
    model: sonnet,
    tier: "standard",
    handedFiles: [],
    status: "succeeded",
    finishReason: "stop",
    activeRunId: null,
    createdAt: at,
    completedAt: later(48),
    runs: [childRun(id)],
    ...overrides,
  }
}

const running = (key: string, overrides: Partial<AgentChild> = {}) =>
  child(key, {
    status: "running",
    finishReason: undefined,
    activeRunId: `run_${key}`,
    completedAt: undefined,
    runs: [
      childRun(`run_${key}`, {
        status: "running",
        finishReason: undefined,
        completedAt: undefined,
      }),
    ],
    ...overrides,
  })

const spawn = (key: string) => ({
  type: "tool-call",
  toolCallId: `spawn_${key}`,
  toolName: "spawn_agent",
  state: "output-available",
  input: { key, task: `Look into ${key}.`, model: "standard" },
  output: { runId: `run_${key}`, status: "queued", model: sonnet },
})

/** A `wait_agent` result as the worker stores it: its JSON text in a rich tool result. */
function wait(keys: readonly string[], answer: Record<string, unknown>) {
  return {
    type: "tool-call",
    toolCallId: `wait_${keys.join("_")}`,
    toolName: "wait_agent",
    state: "output-available",
    input: { runIds: keys.map((key) => `run_${key}`) },
    output: { kind: "agentToolResult", content: [{ type: "text", text: JSON.stringify(answer) }] },
  }
}

const message = (key: string, text: string, delivery: "next-step" | "answer") => ({
  type: "tool-call",
  toolCallId: `message_${key}_${delivery}`,
  toolName: "message_agent",
  state: "output-available",
  input: { key, text },
  output: { runId: `run_${key}`, status: "running", delivery },
})

/** Dana asks; the turn `run_1` delegates with these parts. */
function conversation(parts: readonly Record<string, unknown>[]): AgentMessage[] {
  const base = { projectId: "proj", threadId: "thr_1", annotations: [], contentVersion: 1 }
  return [
    {
      ...base,
      id: "msg_1",
      runId: null,
      role: "user",
      authorPrincipal: dana,
      seq: 1,
      createdAt: at,
      parts: [{ type: "text", text: "Compare the supplier terms." }],
    },
    {
      ...base,
      id: "msg_2",
      runId: "run_1",
      role: "assistant",
      seq: 2,
      createdAt: at,
      parts: [{ type: "text", text: "I'll split this up." }, ...parts],
    },
  ] as unknown as AgentMessage[]
}

/** Pay's call, held for Dana under `runId` by the child run `callerRunId`. */
function payApproval(runId = "run_1", callerRunId = "run_pay"): AgentApproval {
  return {
    id: "apr_pay",
    threadId: "thr_1",
    runId,
    callerRunId,
    caller: { runId: callerRunId, key: "pay" },
    requestedBy: dana,
    mode: "manual",
    status: "pending",
    call: {
      kind: "action",
      actionId: "payInvoice",
      subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv-4471" },
      params: { amount: 18_420 },
      actionRunId: "act_pay",
      effect: "external",
    },
    createdAt: at,
    expiresAt: later(7 * 86_400),
    reported: false,
  }
}

const payPaused = (overrides: Partial<AgentChild> = {}) =>
  child("pay", {
    finishReason: "awaiting_approval",
    awaiting: { type: "approval", approvalIds: ["apr_pay"] },
    ...overrides,
  })

/** What the API answers; a test changes it between reads. */
interface Scenario {
  children: AgentChild[]
  /** The reader cannot read the conversation's children, as in a fork without the original. */
  listStatus?: number
  /** Each child thread's messages, by its id. */
  threads?: Record<string, readonly ChildMessage[]>
}

/** A message of a child's thread: what one of its runs did, or the message that started it. */
interface ChildMessage {
  readonly runId: string
  readonly role: "user" | "assistant"
  readonly parts: readonly Record<string, unknown>[]
}

function threadMessages(threadId: string, messages: readonly ChildMessage[]) {
  return messages.map((message, index) => ({
    id: `${threadId}_msg_${index}`,
    projectId: "proj",
    threadId,
    seq: index + 1,
    createdAt: at,
    annotations: [],
    contentVersion: 1,
    ...message,
  }))
}

function api(scenario: Scenario, requests: string[]) {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const path = url.pathname
      requests.push(`${request.method} ${path}`)

      if (path === "/api/models") {
        return Response.json({
          language: [
            {
              ...sonnet,
              isDefault: true,
              name: "Claude Sonnet",
              publisher: { id: "anthropic", name: "Anthropic" },
              capabilities: { input: ["text"], output: ["text"] },
              reasoningLevels: [],
            },
          ],
        })
      }
      if (/^\/api\/(?:observed-)?agent-threads\/thr_1\/children$/.test(path)) {
        if (scenario.listStatus) {
          return Response.json({ error: "Agent thread not found" }, { status: scenario.listStatus })
        }
        return Response.json({ children: scenario.children })
      }
      const messages = /^\/api\/(?:observed-)?agent-threads\/([^/]+)\/messages$/.exec(path)
      const thread = messages?.[1] ? scenario.threads?.[messages[1]] : undefined
      if (messages?.[1] && thread) {
        const listed = threadMessages(messages[1], thread)
        return Response.json({
          messages: listed,
          authors: [],
          hasMore: false,
          total: listed.length,
        })
      }
      const cancel = /^\/api\/agent-runs\/([^/]+)\/cancel$/.exec(path)
      if (cancel) {
        const found = scenario.children.find((each) =>
          each.runs.some((run) => run.id === cancel[1])
        )
        const run = found?.runs.find((each) => each.id === cancel[1])
        return Response.json(
          { run: { ...run, kind: "subagent", projectId: "proj", threadId: found?.threadId } },
          { status: 202 }
        )
      }
      return Response.json({ error: "Not found" }, { status: 404 })
    },
    { preconnect: fetch.preconnect }
  )
}

function show(
  parts: readonly Record<string, unknown>[],
  scenario: Scenario,
  options: {
    readonly approvals?: AgentApproval[]
    /** Whether the reader decides the calls: Dana does, by default. */
    readonly decides?: boolean
    readonly canStop?: boolean
    readonly observed?: boolean
    readonly stops?: string[]
  } = {}
) {
  const requests: string[] = []
  client.setConfig({ fetch: api(scenario, requests) })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const transcript = (
    <Transcript
      threadId="thr_1"
      messages={conversation(parts)}
      live={createLiveRunState(null)}
      {...(options.approvals
        ? {
            approvals: {
              approvals: options.approvals,
              loaded: true,
              canDecide: () => options.decides ?? true,
              requesterName: () => "Dana Reyes",
              canStop: () => true,
              stop: async (approval: AgentApproval) => {
                options.stops?.push(approval.id)
              },
              decide: async () => {
                throw new Error("No decision in these tests.")
              },
            },
          }
        : {})}
      {...(options.observed ? {} : { delegation: { canStop: () => options.canStop ?? false } })}
    />
  )
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ObservedThreadContext.Provider value={options.observed ?? false}>
          {transcript}
        </ObservedThreadContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  )
  return { view, requests, queryClient }
}

const card = (view: ReturnType<typeof render>, key: string) => {
  const found = view.container.querySelector<HTMLElement>(`[data-child-key='${key}']`)
  if (!found) throw new Error(`Expected the card of ${key}.`)
  return found
}

async function cardOf(view: ReturnType<typeof render>, key: string, state?: string) {
  await waitFor(() => {
    const found = card(view, key)
    if (state) expect(found.dataset.childState).toBe(state)
  })
  return card(view, key)
}

/** The socket a card opened on one child run, open and subscribed. */
async function socketOn(runId: string) {
  let found: FakeSocket | undefined
  await waitFor(() => {
    found = sockets.find((socket) =>
      socket.sent.some((sent) => sent.includes(`"runId":"${runId}"`))
    )
    if (found) return
    for (const socket of sockets) socket.onopen?.()
    throw new Error(`Expected a socket on ${runId}.`)
  })
  return found as FakeSocket
}

function childEvent(runId: string, event: Record<string, unknown>, cursor: string) {
  return {
    data: JSON.stringify({
      type: "record",
      record: {
        streamId: `agents.runs.${runId}`,
        cursor,
        publishedAt: at,
        payload: {
          schemaVersion: 1,
          projectId: "proj",
          runId,
          parentRunId: "run_1",
          attempt: 1,
          occurredAt: at,
          ...event,
        },
      },
    }),
  }
}

describe("a sub-agent in the Agent's reply", () => {
  // Removal proofs: drop the ChildCards block from AssistantBody's flushWork, and no card shows.
  // Drop describeDelegationTool from ToolCallRow, and the work reads spawn_agent and its JSON.
  test("is a card under the work that spawned it, and its spawn and wait read as words", async () => {
    const { view } = show([spawn("terms"), spawn("history"), wait(["terms", "history"], {})], {
      children: [running("terms"), child("history")],
    })

    expect(await cardOf(view, "terms", "working")).toBeDefined()
    expect(view.getByRole("region", { name: "Sub-agent: History" })).toBeDefined()

    const worked = view
      .getAllByRole("button")
      .find((button) => button.textContent === "Worked· 3 steps")
    if (!worked) throw new Error("Expected the turn's work.")
    await act(async () => fireEvent.click(worked))

    const text = view.container.textContent ?? ""
    expect(text).toContain("Delegated to Terms")
    expect(text).toContain("Heard back from 2 sub-agents")
    expect(text).not.toContain("spawn_agent")
    expect(text).not.toContain("wait_agent")
    expect(text).not.toContain('"runId"')
  })

  // Removal proof: map `awaiting` to nothing in childState, and the three paused children read as
  // done.
  test("says where each child stands", async () => {
    const keys = [
      "queued",
      "working",
      "approval",
      "answer",
      "resume",
      "done",
      "failed",
      "stopped",
      "ended",
    ]
    const paused = { status: "succeeded" as const, finishReason: "awaiting_approval" as const }
    const { view } = show(keys.map(spawn), {
      children: [
        child("queued", {
          status: "queued",
          finishReason: undefined,
          runs: [childRun("run_queued", { status: "queued", startedAt: undefined })],
        }),
        running("working"),
        child("approval", { ...paused, awaiting: { type: "approval", approvalIds: ["apr_x"] } }),
        child("answer", {
          finishReason: "awaiting_answer",
          awaiting: { type: "answer", question: { id: "q1", text: "Calendar or fiscal year?" } },
        }),
        child("resume", { ...paused, awaiting: { type: "resume" } }),
        child("done"),
        child("failed", {
          status: "failed",
          finishReason: "error",
          error: {
            code: "agent.execution_failed",
            message: "The sandbox stopped.",
            retryable: false,
            at,
          },
        }),
        child("stopped", { status: "cancelled", finishReason: undefined }),
        child("ended", { ...paused, ended: { reason: "superseded" } }),
      ],
    })

    const expected: Record<string, readonly [string, string]> = {
      queued: ["starting", "Starting…"],
      working: ["working", "Working…"],
      approval: ["approval", "Waiting for approval"],
      answer: ["answer", "Waiting for your answer"],
      resume: ["resume", "Decided · continues when the agent resumes"],
      done: ["done", "Doneworked 48s"],
      failed: ["failed", "Failed · The sandbox stopped."],
      stopped: ["stopped", "Stopped"],
      ended: ["ended", "Didn't continue · a new message moved on first"],
    }
    for (const [key, [state, label]] of Object.entries(expected)) {
      const found = await cardOf(view, key, state)
      expect(found.textContent).toContain(label)
    }
    expect(within(card(view, "answer")).getByText("Calendar or fiscal year?")).toBeDefined()
    expect(card(view, "answer").textContent).toContain(
      "Reply in the conversation to let it continue."
    )
  })

  // Removal proofs: drop the list's refresh as a step starts, and the cost never shows. Drop the
  // refresh on `agent.run.finished`, and the card keeps saying it works.
  test("follows a child at work: its cost, its live steps, then how it ended", async () => {
    const scenario: Scenario = { children: [running("terms")] }
    const { view } = show([spawn("terms")], scenario)
    const terms = await cardOf(view, "terms", "working")
    expect(terms.textContent).toContain("Working…")

    const socket = await socketOn("run_terms")
    const priced = running("terms", {
      cost: {
        amounts: [{ currency: "USD", amountNanos: "64000000" }],
        ratedCallCount: 2,
        unpriceableCallCount: 0,
        unvaluedCallCount: 0,
      },
    })
    scenario.children = [priced]
    await act(async () =>
      socket.onmessage?.(
        childEvent(
          "run_terms",
          { type: "agent.ui.chunk", chunkIndex: 0, chunk: { type: "start-step" } },
          "c0"
        )
      )
    )
    await waitFor(() => expect(card(view, "terms").textContent).toContain("$0.06"))

    const reading = {
      type: "tool-input-available",
      toolCallId: "call_1",
      toolName: "bash",
      input: { command: "grep -n payment contracts/northwind.txt" },
    }
    await act(async () =>
      socket.onmessage?.(
        childEvent("run_terms", { type: "agent.ui.chunk", chunkIndex: 1, chunk: reading }, "c1")
      )
    )
    const label = latestWorkLabel([
      { kind: "tool", tool: { toolName: "bash", state: "input-available", input: reading.input } },
    ])
    expect(label).not.toBe("Working…")
    await waitFor(() => expect(card(view, "terms").textContent).toContain(label))

    scenario.children = [child("terms")]
    await act(async () =>
      socket.onmessage?.(
        childEvent("run_terms", { type: "agent.run.finished", status: "succeeded" }, "c2")
      )
    )
    await cardOf(view, "terms", "done")
  })

  // Removal proofs: offer Stop without `canStop`, and the second render has one. Drop the
  // mutation from stop(), and no request reaches the cancel route.
  test("can be stopped by whoever may stop its turn, at once", async () => {
    const { view, requests } = show(
      [spawn("terms")],
      { children: [running("terms")] },
      { canStop: true }
    )
    const stop = await waitFor(() =>
      within(card(view, "terms")).getByRole("button", { name: "Stop Terms" })
    )

    await act(async () => fireEvent.click(stop))
    expect(card(view, "terms").textContent).toContain("Stopping…")
    await waitFor(() => expect(requests).toContain("POST /api/agent-runs/run_terms/cancel"))

    view.unmount()
    const other = show([spawn("terms")], { children: [running("terms")] }, { canStop: false })
    await cardOf(other.view, "terms", "working")
    expect(
      within(card(other.view, "terms")).queryByRole("button", { name: "Stop Terms" })
    ).toBeNull()
  })

  // Removal proofs: drop the caller check from the transcript's unshown calls, and the call has a
  // second card after the reply. Hide Stop waiting from every in-card call, and the paused reply
  // has no way to stop.
  test("holds the card of the call it waits on, and the reply does not repeat it", async () => {
    const approval: AgentApproval = {
      id: "apr_pay",
      threadId: "thr_1",
      runId: "run_1",
      callerRunId: "run_pay",
      caller: { runId: "run_pay", key: "pay" },
      requestedBy: dana,
      mode: "manual",
      status: "pending",
      call: {
        kind: "action",
        actionId: "payInvoice",
        subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv-4471" },
        params: { amount: 18_420 },
        actionRunId: "act_pay",
        effect: "external",
      },
      createdAt: at,
      expiresAt: later(7 * 86_400),
      reported: false,
    }
    const stops: string[] = []
    const { view } = show(
      [spawn("pay")],
      {
        children: [
          child("pay", {
            finishReason: "awaiting_approval",
            awaiting: { type: "approval", approvalIds: ["apr_pay"] },
          }),
        ],
      },
      { approvals: [approval], stops }
    )

    const pay = await cardOf(view, "pay", "approval")
    expect(pay.textContent).toContain("Waiting for your approval")
    expect(pay.querySelector("[data-approval-state=pending]")).not.toBeNull()
    expect(view.container.querySelectorAll("[data-approval-state]")).toHaveLength(1)
    // The card names the sub-agent already, and says once that it waits.
    expect(pay.textContent).not.toContain("Asked by the sub-agent")
    expect(within(pay).getAllByText("Waiting for your approval")).toHaveLength(2)

    // The reply paused on it: stopping is waiting no more.
    await act(async () =>
      fireEvent.click(within(pay).getByRole("button", { name: "Stop waiting" }))
    )
    expect(stops).toEqual(["apr_pay"])
  })

  // Removal proof: drop the `asked` lines from readThreadDelegation, and the question is gone.
  test("shows what the Agent told it, what it asked, and the answer", async () => {
    const { view } = show(
      [
        spawn("terms"),
        wait(["terms"], {
          results: [{ runId: "run_terms", status: "running" }],
          questions: [
            { key: "terms", runId: "run_terms", id: "q1", text: "Calendar or fiscal year?" },
          ],
        }),
        message("terms", "The fiscal year.", "answer"),
        message("terms", "Skip Globex.", "next-step"),
      ],
      { children: [running("terms")] }
    )

    const terms = await cardOf(view, "terms", "working")
    const lines = [...terms.querySelectorAll("li")].map((line) => line.textContent)
    expect(lines).toEqual([
      "Asked · Calendar or fiscal year?",
      "Agent answered · The fiscal year.",
      "Agent said · Skip Globex.",
    ])
  })

  // Removal proof: open the group whatever its children's states, and the settled group lists its
  // cards on load.
  test("several read as one group that counts how they stand, folded once all settled", async () => {
    const { view } = show([spawn("terms"), spawn("pay"), spawn("history")], {
      children: [
        running("terms"),
        child("pay", {
          finishReason: "awaiting_approval",
          awaiting: { type: "approval", approvalIds: ["apr_pay"] },
        }),
        child("history"),
      ],
    })
    const group = await waitFor(() =>
      view.getByRole("region", { name: "Sub-agents of this reply" })
    )
    await cardOf(view, "pay", "approval")
    const header = within(group).getAllByRole("button")[0]
    expect(header?.textContent).toContain("3 sub-agents · 1 waiting · 1 working · 1 done")
    expect(header?.getAttribute("aria-expanded")).toBe("true")

    view.unmount()
    const settled = show([spawn("terms"), spawn("history")], {
      children: [child("terms"), child("history")],
    })
    const folded = await waitFor(() => {
      const button = settled.view.getByRole("button", { name: /2 sub-agents · 2 done/ })
      expect(button.getAttribute("aria-expanded")).toBe("false")
      return button
    })
    expect(card(settled.view, "terms").closest("ul")?.hidden).toBe(true)
    await act(async () => fireEvent.click(folded))
    expect(card(settled.view, "terms").closest("ul")?.hidden).toBe(false)
  })

  // Removal proof: render the work inline on a phone too, and no dialog opens.
  test("opens its work in a sheet on a phone", async () => {
    dom.happyDOM.setViewport({ width: 375, height: 812 })
    const { view } = show([spawn("terms")], {
      children: [child("terms")],
      threads: {
        thr_terms: [
          { runId: "run_terms", role: "user", parts: [{ type: "text", text: "Look into terms." }] },
          {
            runId: "run_terms",
            role: "assistant",
            parts: [{ type: "text", text: "Net 30 for both." }],
          },
        ],
      },
    })
    const terms = await cardOf(view, "terms", "done")

    await act(async () => fireEvent.click(within(terms).getByRole("button", { name: /Show work/ })))
    const sheet = await waitFor(() => view.getByRole("dialog"))
    expect(within(sheet).getByText("Terms")).toBeDefined()
    expect(within(sheet).getByRole("button", { name: "Close" })).toBeDefined()
    await waitFor(() => expect(within(sheet).getByText("Net 30 for both.")).toBeDefined())
  })

  // Removal proof: read the work only from the live stream, and a reloaded card has none to show.
  test("after a reload, reads its work from its thread, its continuation after a line", async () => {
    const paused = childRun("run_terms", { finishReason: "awaiting_approval" })
    const continued = childRun("run_terms_2", { parentRunId: "run_2" })
    const outcome = {
      type: "approval-outcome",
      approvalId: "apr_send",
      status: "approved",
      call: { kind: "workflow", workflowId: "send" },
    }
    const { view, requests } = show([spawn("terms")], {
      children: [child("terms", { runs: [paused, continued] })],
      threads: {
        thr_terms: [
          { runId: "run_terms", role: "user", parts: [{ type: "text", text: "Look into terms." }] },
          {
            runId: "run_terms",
            role: "assistant",
            parts: [{ type: "text", text: "I'll ask to send it." }],
          },
          { runId: "run_terms_2", role: "user", parts: [outcome] },
          {
            runId: "run_terms_2",
            role: "assistant",
            parts: [{ type: "text", text: "Sent after approval." }],
          },
        ],
      },
    })
    const terms = await cardOf(view, "terms", "done")

    await act(async () => fireEvent.click(within(terms).getByRole("button", { name: /Show work/ })))
    await waitFor(() => expect(terms.textContent).toContain("Sent after approval."))
    expect(terms.textContent).toContain("I'll ask to send it.")
    expect(terms.textContent).toContain("Continued after the decision")
    expect(requests).toContain("GET /api/agent-threads/thr_terms/messages")
    expect(sockets).toHaveLength(0)
  })

  // Removal proof: retry a 404 like any failure, and the card stays without its fallback.
  test("in a fork without the original, says where its work is and what it answered", async () => {
    const { view, requests } = show(
      [
        spawn("terms"),
        wait(["terms"], {
          results: [{ runId: "run_terms", status: "succeeded", text: "Net 30." }],
        }),
      ],
      { children: [], listStatus: 404 }
    )
    const terms = await cardOf(view, "terms", "done")
    await waitFor(() => expect(requests).toContain("GET /api/agent-threads/thr_1/children"))

    await act(async () => fireEvent.click(within(terms).getByRole("button", { name: /Show work/ })))
    await waitFor(() =>
      expect(terms.textContent).toContain("Its work is in the original conversation.")
    )
    expect(terms.textContent).toContain("Net 30.")
  })

  // Removal proof: read an observer's children through the turn's own route, and the list 404s.
  test("reads for an observer, by polling, with nothing to act on", async () => {
    const { view, requests } = show(
      [spawn("terms"), spawn("pay")],
      {
        children: [
          running("terms"),
          child("pay", {
            finishReason: "awaiting_approval",
            awaiting: { type: "approval", approvalIds: ["apr_pay"] },
          }),
        ],
      },
      { observed: true }
    )
    const terms = await cardOf(view, "terms", "working")
    expect((await cardOf(view, "pay", "approval")).textContent).toContain("Waiting for approval")

    // No stream reaches an observer: its steps come once the run ended, and it says so.
    await act(async () => fireEvent.click(within(terms).getByRole("button", { name: /Show work/ })))
    expect(terms.textContent).toContain("At work. Its steps show here once it finishes.")

    expect(requests).toContain("GET /api/observed-agent-threads/thr_1/children")
    expect(view.queryByRole("button", { name: /^Stop/ })).toBeNull()
    expect(sockets).toHaveLength(0)
  })

  // Removal proofs: count every paused child as waiting for the reader, and Sam's group says "1
  // waiting for you" in amber. Keep the spawn order, and Pay is not first.
  test("says a call waits for you only to whoever decides it, and lists that child first", async () => {
    const parts = [spawn("terms"), spawn("pay")]
    const children = [running("terms"), payPaused()]
    const reader = show(parts, { children }, { approvals: [payApproval()] })

    const group = await waitFor(() =>
      reader.view.getByRole("region", { name: "Sub-agents of this reply" })
    )
    await cardOf(reader.view, "pay", "approval")
    expect(within(group).getAllByRole("button")[0]?.textContent).toContain("1 waiting for you")
    expect(group.className).toContain("border-amber")
    expect(group.querySelector("li [data-child-key]")?.getAttribute("data-child-key")).toBe("pay")

    reader.view.unmount()
    const sam = show(parts, { children }, { approvals: [payApproval()], decides: false })
    const other = await waitFor(() =>
      sam.view.getByRole("region", { name: "Sub-agents of this reply" })
    )
    await cardOf(sam.view, "pay", "approval")
    const summary = within(other).getAllByRole("button")[0]?.textContent ?? ""
    expect(summary).toContain("1 waiting for Dana Reyes")
    expect(summary).not.toContain("for you")
    expect(other.className).not.toContain("border-amber")
    expect(card(sam.view, "pay").textContent).toContain("Waiting for Dana Reyes's approval")
  })

  // Removal proofs: fold on `settled` alone, and the group shuts on the work the reader opened.
  // Count `resume` as settled, and a decided child folds its group.
  test("stays open while the reader has a child's work open, and while a child will continue", async () => {
    const scenario: Scenario = { children: [running("terms"), child("history")] }
    const { view } = show([spawn("terms"), spawn("history")], scenario)
    await cardOf(view, "terms", "working")

    const history = card(view, "history")
    await act(async () =>
      fireEvent.click(within(history).getByRole("button", { name: /Show work/ }))
    )
    const socket = await socketOn("run_terms")
    scenario.children = [child("terms"), child("history")]
    await act(async () =>
      socket.onmessage?.(
        childEvent("run_terms", { type: "agent.run.finished", status: "succeeded" }, "c1")
      )
    )
    await cardOf(view, "terms", "done")
    const header = view.getByRole("button", { name: /2 sub-agents/ })
    expect(header.getAttribute("aria-expanded")).toBe("true")

    view.unmount()
    const decided = show([spawn("pay"), spawn("history")], {
      children: [payPaused({ awaiting: { type: "resume" } }), child("history")],
    })
    await cardOf(decided.view, "pay", "resume")
    const later = decided.view.getByRole("button", { name: /2 sub-agents/ })
    expect(later.textContent).toContain("1 continues later · 1 done")
    expect(later.getAttribute("aria-expanded")).toBe("true")
  })

  // Removal proof: put every call of a child in its card, and the resumed turn's call is drawn far
  // above the reply that waits on it.
  test("a call it holds under a later turn shows with that turn, and its card points to it", async () => {
    const paused = childRun("run_pay", { finishReason: "awaiting_approval" })
    const continued = childRun("run_pay_2", {
      parentRunId: "run_2",
      finishReason: "awaiting_approval",
    })
    const { view } = show(
      [spawn("pay")],
      { children: [payPaused({ runs: [paused, continued] })] },
      { approvals: [payApproval("run_2", "run_pay_2")] }
    )

    const pay = await cardOf(view, "pay", "approval")
    expect(pay.querySelector("[data-approval-id]")).toBeNull()
    expect(view.container.querySelectorAll("[data-approval-id=apr_pay]")).toHaveLength(1)
    expect(within(pay).getByRole("button", { name: "See its request below" })).toBeDefined()
  })

  test("is named from its key, whose capitals stay", () => {
    expect(childTitle("supplier-terms")).toBe("Supplier terms")
    expect(childTitle("approve-INV-4490")).toBe("Approve INV 4490")
    expect(childTitle("checkVendorBalances")).toBe("Check Vendor Balances")
  })
})
