import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { client } from "@sixb/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, waitFor, within } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { MemoryRouter } from "react-router-dom"
import { latestWorkLabel } from "../src/agent/activity-label"
import { type AgentApproval, reportedApprovalOutcomes } from "../src/agent/approvals"
import { ArtifactPanelRoot } from "../src/agent/artifact-panel"
import { Transcript } from "../src/agent/components/transcript"
import { conversationMessages, conversationTurn, READ_ONLY_TURN } from "../src/agent/conversation"
import { type AgentChild, childTitle } from "../src/agent/delegation/interpret"
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

  const messages = conversation(parts)
  const transcript = (
    <Transcript
      threadId="thr_1"
      messages={conversationMessages({ messages, presentation: { kind: "idle" } })}
      turn={conversationTurn({
        ...READ_ONLY_TURN,
        presentation: { kind: "idle" },
        activeRunId: null,
      })}
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
      approvalOutcomes={reportedApprovalOutcomes(messages)}
      {...(options.observed ? {} : { delegation: { canStop: () => options.canStop ?? false } })}
    />
  )
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ObservedThreadContext.Provider value={options.observed ?? false}>
          {/* A child's thread opens in the conversation's panel, as in the chat. */}
          <ArtifactPanelRoot scopeKey="thr_1">{transcript}</ArtifactPanelRoot>
        </ObservedThreadContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  )
  return { view, requests, queryClient }
}

/** The reply's line for its sub-agents. */
async function lineOf(view: ReturnType<typeof render>) {
  return waitFor(() => {
    const found = view.container.querySelector<HTMLElement>("[data-delegation-group] > button")
    if (!found) throw new Error("Expected the sub-agents' line.")
    return found
  })
}

/** What waits on the reader from one child, under the line. */
const attentionOf = (view: ReturnType<typeof render>, key: string) => {
  const found = view.container.querySelector<HTMLElement>(`[data-child-key='${key}']`)
  if (!found) throw new Error(`Expected what ${key} waits on.`)
  return found
}

/** The panel the line opened. */
async function threadOf(view: ReturnType<typeof render>) {
  return waitFor(() => {
    const found = view.baseElement.querySelector<HTMLElement>("[data-agent-slot]")
    if (!found?.textContent) throw new Error("Expected the open panel.")
    return found
  })
}

/** Open the line's panel, once. */
async function openPanel(view: ReturnType<typeof render>) {
  const line = await lineOf(view)
  if (line.getAttribute("aria-expanded") !== "true") await act(async () => fireEvent.click(line))
  return threadOf(view)
}

/** A child's row in the panel's list, once it reads `state`. */
async function rowOf(view: ReturnType<typeof render>, key: string, state?: string) {
  await openPanel(view)
  return waitFor(() => {
    const found = view.baseElement.querySelector<HTMLElement>(`[data-child-row='${key}']`)
    if (!found) throw new Error(`Expected the row of ${key}.`)
    if (state) expect(found.dataset.childState).toBe(state)
    return found
  })
}

/** A child's thread in the panel: straight there for a lone child, through its row otherwise. */
async function detailOf(view: ReturnType<typeof render>, key: string) {
  const panel = await openPanel(view)
  const row = panel.querySelector<HTMLElement>(`[data-child-row='${key}']`)
  if (row) await act(async () => fireEvent.click(row))
  return waitFor(() => {
    const found = view.baseElement.querySelector<HTMLElement>(`[data-child-detail='${key}']`)
    if (!found) throw new Error(`Expected the thread of ${key}.`)
    return found
  })
}

/** The line once it reads `text`. */
async function lineSays(view: ReturnType<typeof render>, text: string) {
  return waitFor(() => {
    const line = view.container.querySelector<HTMLElement>("[data-delegation-group] > button")
    expect(line?.textContent).toContain(text)
    return line as HTMLElement
  })
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
  // Removal proofs: drop the ChildCards block from AssistantBody's flushWork, and no line shows.
  // Drop the DELEGATION_ROW_TOOLS filter, and a "3 steps" line repeats what the line says.
  test("is a line under the reply, its spawn and wait not counted again as steps", async () => {
    const { view } = show([spawn("terms"), spawn("history"), wait(["terms", "history"], {})], {
      children: [running("terms"), child("history")],
    })

    await lineSays(view, "Terms is working…")
    expect((await lineOf(view)).textContent).toContain("History finished")
    expect(
      view.queryAllByRole("button").some((button) => /\d+ steps?/.test(button.textContent ?? ""))
    ).toBe(false)

    const text = view.container.textContent ?? ""
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
      // A working row says what it was asked until its stream says what it does; its time ticks.
      working: ["working", "Look into working."],
      approval: ["approval", "Waiting for approval"],
      answer: ["answer", "Waiting for your answer"],
      resume: ["resume", "Decided · continues when the agent resumes"],
      // A finished row says how long it took; the line says it finished.
      done: ["done", "48s"],
      failed: ["failed", "Failed · The sandbox stopped."],
      stopped: ["stopped", "Stopped"],
      ended: ["ended", "Didn't continue · a new message moved on first"],
    }
    for (const [key, [state, label]] of Object.entries(expected)) {
      expect((await rowOf(view, key, state)).textContent).toContain(label)
    }
    expect((await lineOf(view)).textContent).toContain("Answer has a question for you")
    expect(within(attentionOf(view, "answer")).getByText("Calendar or fiscal year?")).toBeDefined()
    expect(attentionOf(view, "answer").textContent).toContain("Your next message answers it.")
  })

  // Removal proofs: drop the live label from the thread's status, and it says only "Working…".
  // Drop the refresh on `agent.run.finished`, and the line keeps saying it works. Money is never
  // said: a priced child reads the same as an unpriced one.
  test("follows a child at work: its live steps, then how it ended, never its cost", async () => {
    const scenario: Scenario = { children: [running("terms")] }
    const { view } = show([spawn("terms")], scenario)
    await lineSays(view, "Terms is working…")
    expect((await detailOf(view, "terms")).textContent).toContain("Working…")

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
    await waitFor(async () => expect((await detailOf(view, "terms")).textContent).toContain(label))
    expect(view.baseElement.textContent).not.toContain("$")

    scenario.children = [child("terms")]
    await act(async () =>
      socket.onmessage?.(
        childEvent("run_terms", { type: "agent.run.finished", status: "succeeded" }, "c2")
      )
    )
    await lineSays(view, "Terms finished")
  })

  // Removal proofs: offer Stop without `canStop`, and the second render has one. Drop the
  // mutation from stop(), and no request reaches the cancel route.
  test("can be stopped by whoever may stop its turn, at once", async () => {
    const { view, requests } = show(
      [spawn("terms")],
      { children: [running("terms")] },
      { canStop: true }
    )
    const terms = await detailOf(view, "terms")
    const stop = await waitFor(() => within(terms).getByRole("button", { name: "Stop Terms" }))

    await act(async () => fireEvent.click(stop))
    expect((await detailOf(view, "terms")).textContent).toContain("Stopping…")
    await waitFor(() => expect(requests).toContain("POST /api/agent-runs/run_terms/cancel"))

    view.unmount()
    const other = show([spawn("terms")], { children: [running("terms")] }, { canStop: false })
    const otherTerms = await detailOf(other.view, "terms")
    expect(within(otherTerms).queryByRole("button", { name: "Stop Terms" })).toBeNull()
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

    await lineSays(view, "Pay needs your approval")
    const pay = attentionOf(view, "pay")
    expect(pay.querySelector("[data-approval-state=pending]")).not.toBeNull()
    expect(view.container.querySelectorAll("[data-approval-state]")).toHaveLength(1)
    // The line names the sub-agent and says it waits: the card goes straight to the call.
    expect(pay.textContent).not.toContain("From Pay")
    expect(within(pay).queryAllByText("Waiting for your approval")).toHaveLength(0)

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

    await lineSays(view, "Terms is working…")
    const lines = [...attentionOf(view, "terms").querySelectorAll("li")].map(
      (line) => line.textContent
    )
    expect(lines).toEqual([
      "Asked · Calendar or fiscal year?",
      "Agent answered · The fiscal year.",
      "Agent said · Skip Globex.",
    ])
  })

  // Removal proof: build the line from a count instead of lineClauses, and the names are gone.
  test("several read as one sentence that names them by how they stand, and open as a list", async () => {
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
    const line = await lineSays(view, "Pay is waiting")
    expect(line.textContent).toContain("Terms is working…")
    expect(line.textContent).toContain("History finished")

    view.unmount()
    const settled = show([spawn("terms"), spawn("history")], {
      children: [child("terms"), child("history")],
    })
    const folded = await lineSays(settled.view, "Terms and History finished")
    expect(folded.getAttribute("aria-expanded")).toBe("false")
    const panel = await openPanel(settled.view)
    expect(panel.querySelectorAll("[data-child-row]")).toHaveLength(2)
  })

  // Removal proof: drop the `[data-agent-slot-frame]` check from the panel's open; focus is lost.
  test("hands focus back to the line after moving within its panel", async () => {
    const { view } = show([spawn("terms"), spawn("history")], {
      children: [child("terms"), child("history")],
    })
    const line = await lineOf(view)
    line.focus()
    await openPanel(view)
    const row = await rowOf(view, "terms")
    row.focus()
    await act(async () => fireEvent.click(row))
    const back = await waitFor(() => view.getByRole("button", { name: "All sub-agents" }))
    back.focus()
    await act(async () => fireEvent.click(back))

    await act(async () => fireEvent.click(view.getByRole("button", { name: "Close" })))
    await waitFor(() => expect(document.activeElement).toBe(line))
  })

  // Removal proof: render the thread inline on a phone too, and no dialog opens.
  test("opens its thread in a sheet on a phone", async () => {
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

    await act(async () => fireEvent.click(await lineSays(view, "Terms finished")))
    const sheet = await waitFor(() => view.getByRole("dialog"))
    expect(within(sheet).getByText("Terms")).toBeDefined()
    expect(within(sheet).getByRole("button", { name: "Close" })).toBeDefined()
    await waitFor(() => expect(within(sheet).getByText("Net 30 for both.")).toBeDefined())
  })

  // Removal proof: read the work only from the live stream, and a reloaded thread has none to show.
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

    const thread = await detailOf(view, "terms")
    await waitFor(() => expect(thread.textContent).toContain("Sent after approval."))
    expect(thread.textContent).toContain("I'll ask to send it.")
    expect(thread.textContent).toContain("Continued after the decision")
    expect(requests).toContain("GET /api/agent-threads/thr_terms/messages")
    expect(sockets).toHaveLength(0)
  })

  // Removal proof: retry a 404 like any failure, and the thread stays without its fallback.
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
    await waitFor(() => expect(requests).toContain("GET /api/agent-threads/thr_1/children"))

    const thread = await detailOf(view, "terms")
    await waitFor(() =>
      expect(thread.textContent).toContain("Its work is in the original conversation.")
    )
    expect(thread.textContent).toContain("Net 30.")
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
    expect((await rowOf(view, "pay", "approval")).textContent).toContain("Waiting for approval")

    // No stream reaches an observer: its steps come once the run ended, and it says so.
    expect((await detailOf(view, "terms")).textContent).toContain(
      "At work. Its steps show here once it finishes."
    )

    expect(requests).toContain("GET /api/observed-agent-threads/thr_1/children")
    expect(view.queryByRole("button", { name: /^Stop/ })).toBeNull()
    expect(sockets).toHaveLength(0)
  })

  // Removal proofs: count every paused child as waiting for the reader, and Sam's line says Pay
  // needs his approval, in amber. Keep the spawn order, and Pay is not first in the list.
  test("says a call waits for you only to whoever decides it, and lists that child first", async () => {
    const parts = [spawn("terms"), spawn("pay")]
    const children = [running("terms"), payPaused()]
    const reader = show(parts, { children }, { approvals: [payApproval()] })

    // The amber dot on its avatar, and the card under the line, call for the reader.
    const readerLine = await lineSays(reader.view, "Pay needs your approval")
    expect(readerLine.querySelector(".bg-amber-500")).not.toBeNull()
    const panel = await openPanel(reader.view)
    expect(panel.querySelector("[data-child-row]")?.getAttribute("data-child-row")).toBe("pay")

    reader.view.unmount()
    const sam = show(parts, { children }, { approvals: [payApproval()], decides: false })
    const line = await lineSays(sam.view, "Pay is waiting for Dana Reyes")
    expect(line.textContent).not.toContain("your approval")
    expect(line.querySelector(".bg-amber-500")).toBeNull()
    expect((await rowOf(sam.view, "pay", "approval")).textContent).toContain(
      "Waiting for Dana Reyes's approval"
    )
  })

  // Removal proofs: close the panel when a sibling finishes, and the reader loses the thread they
  // opened. Count `resume` as done, and a decided child reads as finished.
  test("keeps a thread open as its siblings finish, and says when a child will continue", async () => {
    const scenario: Scenario = { children: [running("terms"), child("history")] }
    const { view } = show([spawn("terms"), spawn("history")], scenario)
    await lineSays(view, "Terms is working…")

    await detailOf(view, "history")
    const socket = await socketOn("run_terms")
    scenario.children = [child("terms"), child("history")]
    await act(async () =>
      socket.onmessage?.(
        childEvent("run_terms", { type: "agent.run.finished", status: "succeeded" }, "c1")
      )
    )
    await lineSays(view, "Terms and History finished")
    expect(view.baseElement.querySelector("[data-child-detail='history']")).not.toBeNull()

    view.unmount()
    const decided = show([spawn("pay"), spawn("history")], {
      children: [payPaused({ awaiting: { type: "resume" } }), child("history")],
    })
    const later = await lineSays(decided.view, "Pay continues later")
    expect(later.textContent).toContain("History finished")
  })

  // Removal proof: put every call of a child under the line, and the resumed turn's call is drawn
  // far above the reply that waits on it.
  test("a call it holds under a later turn shows with that turn, and the line points to it", async () => {
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

    await lineSays(view, "Pay")
    const pay = await waitFor(() => attentionOf(view, "pay"))
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
