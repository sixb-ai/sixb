import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { client } from "@sixb/client"
import { getAuthSessionQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { MemoryRouter } from "react-router-dom"
import { AgentChat } from "../src/agent/agent-chat"
import {
  type AgentApproval,
  heldCallsInOutput,
  isApprovalOutcomeMessage,
  toggledApprovalMode,
} from "../src/agent/approvals"
import { type BashTool, BashToolView } from "../src/agent/bash/bash-tool-view"
import { createLiveRunState } from "../src/agent/live-run"
import type { AgentMessage } from "../src/agent/types"
import { Transcript } from "../src/index"
import { installDom } from "./helpers/dom"

installDom([
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

/** Sockets the chat opens; a test plays the server by calling their handlers. */
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

// Radix picks its layout effect when it loads, a no-op without a `document`, and its popovers then
// never mount. This file or another of the run loads it before the window exists, so it is given
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
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
  client.setConfig({ fetch: originalConfig.fetch })
  sockets.length = 0
})

afterAll(() => {
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  if (previousWebSocket) Object.defineProperty(globalThis, "WebSocket", previousWebSocket)
  else Reflect.deleteProperty(globalThis, "WebSocket")
})

const dana = { type: "user", id: "usr_dana" } as const
const sam = { type: "user", id: "usr_sam" } as const
const at = "2026-10-24T09:00:00.000Z"

const users = {
  dana: { id: dana.id, email: "dana@acme.test", displayName: "Dana Reyes", groupIds: [] },
  sam: { id: sam.id, email: "sam@acme.test", displayName: "Sam Ortiz", groupIds: [] },
}

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: "thr_1",
    projectId: "proj",
    ownerPrincipal: dana,
    owner: { ...dana, displayName: "Dana Reyes" },
    participants: [],
    title: "Pay Northwind",
    status: "active",
    messageCount: 2,
    activeRunId: null,
    createdAt: at,
    updatedAt: at,
    approvalMode: "manual",
    approvalModeSource: "fallback",
    ...overrides,
  }
}

const payCall = {
  kind: "action",
  actionId: "payInvoice",
  subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv-4471" },
  params: { amount: 18_420, paidOn: "2026-10-24", method: "ach" },
  actionRunId: "act_pay",
  effect: "external",
} as const

/** What the CLI printed when the gateway held the call: the 202 answer, exit 4. */
function heldBash(approvalId = "apr_1") {
  return {
    type: "tool-call",
    toolCallId: "call_1",
    toolName: "bash",
    state: "output-available",
    input: { command: "sixb actions request payInvoice --run-id act_pay" },
    output: {
      stdout: `${JSON.stringify({
        status: "awaiting_approval",
        approval: {
          id: approvalId,
          kind: "action",
          actionId: payCall.actionId,
          subject: payCall.subject,
        },
        message: "The user approves or denies this in the conversation.",
      })}\n`,
      stderr: "",
      exitCode: 4,
      durationMs: 400,
      stdoutTruncated: false,
      stderrTruncated: false,
    },
  }
}

const message = { projectId: "proj", threadId: "thr_1", annotations: [], contentVersion: 1 }

function conversation(requester: typeof dana | typeof sam = dana) {
  return [
    {
      ...message,
      id: "msg_1",
      runId: null,
      role: "user",
      authorPrincipal: requester,
      seq: 1,
      createdAt: at,
      parts: [{ type: "text", text: "Pay INV-4471 by ACH today." }],
    },
    {
      ...message,
      id: "msg_2",
      runId: "run_1",
      role: "assistant",
      seq: 2,
      createdAt: at,
      parts: [
        { type: "text", text: "I'll send an ACH payment of $18,420 for INV-4471." },
        heldBash(),
      ],
    },
  ]
}

function approval(overrides: Partial<AgentApproval> = {}): AgentApproval {
  return {
    id: "apr_1",
    threadId: "thr_1",
    runId: "run_1",
    callerRunId: "run_1",
    requestedBy: dana,
    mode: "manual",
    status: "pending",
    call: payCall,
    createdAt: at,
    expiresAt: "2026-10-31T09:00:00.000Z",
    reported: false,
    ...overrides,
  }
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    projectId: "proj",
    threadId: "thr_1",
    triggerMessageId: "msg_1",
    status: "succeeded",
    finishReason: "awaiting_approval",
    attempt: 0,
    streamId: "stream_1",
    requestedBy: dana,
    createdAt: at,
    ...overrides,
  }
}

const ran = approval({
  status: "approved",
  decidedAt: at,
  decidedBy: dana,
  outcome: { kind: "action-run", runId: "act_pay", status: "succeeded" },
})

/** What the API answers; a test changes it between reads. */
interface Scenario {
  thread: Record<string, unknown>
  messages: readonly Record<string, unknown>[]
  runs: readonly Record<string, unknown>[]
  approvals: AgentApproval[]
  /** Calls waiting for the reader, across their threads. */
  waiting: AgentApproval[]
  /** The reader's other threads. */
  threads?: readonly Record<string, unknown>[]
  decided: AgentApproval
  /** The turn the decision resumes, when it is the last. */
  resumed?: Record<string, unknown>
  /** Why the turn could not resume, when it could not. */
  refused?: { status: "refused"; code: string; message: string; retrying: boolean }
}

function api(scenario: Scenario, requests: string[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const method = request.method
    const body = method === "GET" ? "" : await request.text()
    requests.push(`${method} ${url.pathname}${url.search}${body ? ` ${body}` : ""}`)
    const path = url.pathname

    if (path === "/api/agent") {
      return Response.json({ name: "Sixb", model: { provider: "test", modelId: "fast" } })
    }
    if (path === "/api/models") return Response.json({ language: [] })
    if (path === "/api/agent/preferences") {
      if (method === "PUT")
        return Response.json({ ...JSON.parse(body), approvalModeSource: "default" })
      return Response.json({ approvalMode: "manual", approvalModeSource: "fallback" })
    }
    if (path === "/api/agent-approvals") {
      return Response.json({
        approvals: scenario.waiting,
        hasMore: false,
        total: scenario.waiting.length,
      })
    }
    if (path === "/api/agent-threads") {
      const own = url.searchParams.get("sharedWithMe") === "true" ? [] : (scenario.threads ?? [])
      return Response.json({ threads: own, hasMore: false, total: own.length })
    }
    if (path === "/api/agent-threads/thr_1") return Response.json(scenario.thread)
    if (path === "/api/agent-threads/thr_1/approval-mode") {
      const { approvalMode } = JSON.parse(body) as { approvalMode: string }
      scenario.thread = { ...scenario.thread, approvalMode, approvalModeSource: "thread" }
      return Response.json(scenario.thread)
    }
    if (path === "/api/agent-threads/thr_1/messages" && method === "GET") {
      return Response.json({
        messages: scenario.messages,
        authors: [
          { ...dana, displayName: "Dana Reyes" },
          { ...sam, displayName: "Sam Ortiz" },
        ],
        hasMore: false,
        total: scenario.messages.length,
      })
    }
    if (path === "/api/agent-threads/thr_1/messages") {
      return Response.json(
        { run: run({ id: "run_2", status: "queued", finishReason: undefined }) },
        { status: 202 }
      )
    }
    if (path === "/api/agent-threads/thr_1/runs") {
      return Response.json({ runs: scenario.runs, hasMore: false, total: scenario.runs.length })
    }
    if (path === "/api/agent-threads/thr_1/approvals") {
      return Response.json({
        approvals: scenario.approvals,
        hasMore: false,
        total: scenario.approvals.length,
      })
    }
    if (path === "/api/agent-threads/thr_1/approvals/apr_1/decision") {
      scenario.approvals = [scenario.decided]
      return Response.json({
        approval: scenario.decided,
        ...(scenario.resumed ? { run: scenario.resumed } : {}),
        ...(scenario.refused ? { resume: scenario.refused } : {}),
      })
    }
    if (path === "/api/agent-threads/thr_1/cancel") {
      // The server sets the turn's waiting calls aside; their events say so.
      scenario.approvals = scenario.approvals.map((entry) =>
        entry.status === "pending" ? { ...entry, status: "cancelled", decidedAt: at } : entry
      )
      return Response.json({ run: run() })
    }
    if (path === "/api/object-types") return Response.json([])

    return Response.json({ error: "Not found" }, { status: 404 })
  }
}

function renderChat(as: "dana" | "sam", scenario: Partial<Scenario> = {}) {
  const state: Scenario = {
    thread: thread(),
    messages: conversation(),
    runs: [run()],
    approvals: [approval()],
    waiting: [],
    decided: ran,
    ...scenario,
  }
  const requests: string[] = []
  client.setConfig({
    fetch: Object.assign(api(state, requests), { preconnect: fetch.preconnect }),
  })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(getAuthSessionQueryKey(), {
    authenticated: true,
    user: users[as],
    session: { id: "ses_1", expiresAt: "2026-12-01T00:00:00.000Z" },
  })

  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentChat threadId="thr_1" onNavigateHome={() => {}} onNavigateThread={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  )
  return { view, state, requests }
}

/** Plays the server on the chat's sockets: they open, and the activity feed subscribes. */
async function subscribeActivity() {
  await act(async () => {
    for (const socket of sockets) socket.onopen?.()
  })
  const activity = sockets.find((socket) =>
    socket.sent.some((sent) => sent.includes('"subscribe.activity"'))
  )
  if (!activity) throw new Error("The chat opened no activity feed.")

  await act(async () => {
    activity.onmessage?.({ data: JSON.stringify({ type: "subscribed.activity" }) })
  })
  return activity
}

/**
 * React DOM was imported before Happy DOM, so it sees typing through its fallback: a keyup in the
 * field that has focus.
 */
function type(field: HTMLElement, value: string) {
  fireEvent.focusIn(field)
  fireEvent.input(field, { target: { value } })
  fireEvent.keyUp(field, { key: value.at(-1) })
}

const card = (view: ReturnType<typeof render>) =>
  view.findByRole("region", { name: /^Approval request/ })

describe("the approval mode chip", () => {
  // Removal proof: drop `setApprovalMode` from the composer props; the chip is gone, and so is the PUT.
  test("switches the reader's mode in the thread, and the next turn runs in it", async () => {
    const { view, requests } = renderChat("dana", { approvals: [], runs: [], messages: [] })

    const chip = await view.findByRole("button", { name: "Approval mode: Manual. Change it" })
    fireEvent.click(chip)
    fireEvent.click(await view.findByRole("radio", { name: /^Auto/ }))

    await waitFor(() =>
      expect(requests).toContain(
        'PUT /api/agent-threads/thr_1/approval-mode {"approvalMode":"auto"}'
      )
    )
    expect(view.getByRole("button", { name: "Approval mode: Auto. Change it" })).toBeDefined()

    const input = view.getByRole("textbox", { name: "Message" })
    type(input, "Pay it")
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() =>
      expect(
        requests.some(
          (entry) =>
            entry.startsWith("POST /api/agent-threads/thr_1/messages") &&
            entry.includes('"approvalMode":"auto"')
        )
      ).toBe(true)
    )
  })

  // Removal proof: drop the Shift+Tab branch from the composer's handleKeyDown; nothing is sent.
  // Drop `value.length === 0` from it; typing then no longer lets Shift+Tab move focus back.
  test("Shift+Tab in an empty message switches between Manual and Accept edits, and says so", async () => {
    const { view, requests } = renderChat("dana", { approvals: [], runs: [], messages: [] })
    await view.findByRole("button", { name: "Approval mode: Manual. Change it" })
    const input = view.getByRole("textbox", { name: "Message" })
    const modeSaves = () => requests.filter((entry) => entry.includes("/approval-mode"))

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true })
    await waitFor(() =>
      expect(modeSaves()).toEqual([
        'PUT /api/agent-threads/thr_1/approval-mode {"approvalMode":"accept-edits"}',
      ])
    )
    expect(view.getByText("Approval mode: Accept edits")).toBeDefined()

    // Never on to Auto: back to Manual.
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true })
    await waitFor(() => expect(modeSaves()).toHaveLength(2))
    expect(modeSaves()[1]).toBe(
      'PUT /api/agent-threads/thr_1/approval-mode {"approvalMode":"manual"}'
    )

    // With a message typed, Shift+Tab moves focus back as everywhere else, and Tab moves it on.
    type(input, "Pay it")
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true })
    fireEvent.keyDown(input, { key: "Tab" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(modeSaves()).toHaveLength(2)
  })

  test("offers to make the mode the reader's default", async () => {
    const { view, requests } = renderChat("dana", { approvals: [], runs: [], messages: [] })
    fireEvent.click(await view.findByRole("button", { name: /^Approval mode: Manual/ }))
    fireEvent.click(await view.findByRole("radio", { name: /^Accept edits/ }))
    await view.findByRole("button", { name: /^Approval mode: Accept edits/ })

    fireEvent.click(view.getByRole("button", { name: /^Approval mode: Accept edits/ }))
    fireEvent.click(await view.findByRole("button", { name: "Use as my default" }))

    await waitFor(() =>
      expect(requests).toContain('PUT /api/agent/preferences {"approvalMode":"accept-edits"}')
    )
  })
})

describe("an approval card", () => {
  // Removal proof: drop the ApprovalCards block from AssistantBody's flushWork; no card shows.
  test("shows the held call with its values, its effect, and the requester's choices", async () => {
    const { view } = renderChat("dana")

    const found = within(await card(view))
    expect(found.getByText("Waiting for your approval")).toBeDefined()
    expect(found.getByRole("heading", { name: "Pay invoice" })).toBeDefined()
    expect(found.getByText("Paid on")).toBeDefined()
    expect(found.getByText("ach")).toBeDefined()
    expect(found.getByText("Reaches an external system, then updates your data")).toBeDefined()
    expect(found.getByRole("button", { name: "Approve" })).toBeDefined()
    expect(found.getByRole("button", { name: "Deny" })).toBeDefined()
    expect(found.getByRole("button", { name: "Always allow · switches to Auto" })).toBeDefined()
    // The turn is paused, not finished: the composer says how to move on.
    expect(view.getByRole("textbox", { name: "Message" }).getAttribute("placeholder")).toBe(
      "Approve above, or reply instead"
    )
  })

  // Removal proof: drop `setPendingSend` from `decide`; the resumed turn is not followed.
  test("approving runs the call, says how it ended, and follows the turn it resumes", async () => {
    const resumed = run({ id: "run_2", status: "queued", finishReason: undefined })
    const { view, requests } = renderChat("dana", { resumed })

    fireEvent.click(within(await card(view)).getByRole("button", { name: "Approve" }))

    await waitFor(() =>
      expect(requests).toContain(
        'POST /api/agent-threads/thr_1/approvals/apr_1/decision {"decision":"approve"}'
      )
    )
    expect(await view.findByText("Approved · Ran")).toBeDefined()
    expect(view.getByRole("link", { name: "View run" }).getAttribute("href")).toBe(
      "/observability/runs/actions/act_pay"
    )
    // The resumed turn is followed under the card, which keeps its place.
    expect(await view.findByRole("status", { name: "Agent is working" })).toBeDefined()
  })

  // Removal proof: drop the `alsoApproved` count from the card; the sibling call goes unmentioned.
  test("always allow says what it switches to and what else it approves, then confirms", async () => {
    const sibling = approval({ id: "apr_2", call: { ...payCall, actionRunId: "act_pay_2" } })
    const { view, requests } = renderChat("dana", { approvals: [approval(), sibling] })

    // The sibling's command named no card: it gets its own, under the turn.
    const [first] = await view.findAllByRole("region", { name: /^Approval request/ })
    if (!first) throw new Error("No card.")
    const found = within(first)
    const always = found.getByRole("button", { name: "Always allow · switches to Auto" })
    expect(found.getByText("Also approves 1 other request waiting in this reply.")).toBeDefined()

    fireEvent.click(always)

    await waitFor(() =>
      expect(requests).toContain(
        'POST /api/agent-threads/thr_1/approvals/apr_1/decision {"decision":"approve","always":true}'
      )
    )
    expect(await view.findByText("You're now in Auto in this conversation.")).toBeDefined()
  })

  // Removal proof: drop the `resume` branch of the card's `then`; the card says nothing of it.
  test("a decision whose turn could not resume says so on the card", async () => {
    const { view } = renderChat("dana", {
      refused: {
        status: "refused",
        code: "sandbox_execution_unavailable",
        message: "[Sixb] The sandbox needs recovering.",
        retrying: false,
      },
    })

    fireEvent.click(within(await card(view)).getByRole("button", { name: "Approve" }))

    expect(await view.findByText("Approved · Ran")).toBeDefined()
    expect(
      view.getByText("The agent couldn't continue. Send a message to pick up from here.")
    ).toBeDefined()
  })

  // Removal proof: drop `onApprovalActivity` from the activity stream; the card keeps its buttons.
  test("a decision made elsewhere reaches the card live", async () => {
    const { view, state } = renderChat("dana")
    const activity = await subscribeActivity()
    expect(within(await card(view)).getByRole("button", { name: "Approve" })).toBeDefined()

    state.approvals = [approval({ status: "denied", decidedAt: at, decidedBy: dana })]
    await act(async () => {
      activity.onmessage?.({
        data: JSON.stringify({
          type: "activity",
          event: {
            schemaVersion: 1,
            type: "agent.approval.activity",
            projectId: "proj",
            approvalId: "apr_1",
            threadId: "thr_1",
            runId: "run_1",
            status: "denied",
            hasOutcome: false,
            occurredAt: at,
          },
        }),
      })
    })

    expect(await view.findByText("Denied · Didn't run")).toBeDefined()
    expect(view.queryByRole("button", { name: "Approve" })).toBeNull()
  })

  // Removal proof: drop the Stop waiting button from the card; the paused turn can only be denied
  // call by call.
  test("Stop waiting stops the paused turn, and its cards say so", async () => {
    const { view, requests } = renderChat("dana")

    fireEvent.click(within(await card(view)).getByRole("button", { name: "Stop waiting" }))

    await waitFor(() =>
      expect(requests).toContain('POST /api/agent-threads/thr_1/cancel {"runId":"run_1"}')
    )
    expect(await view.findByText("Stopped")).toBeDefined()
    expect(view.queryByRole("button", { name: "Approve" })).toBeNull()
  })

  test("the thread's owner may stop someone else's paused turn, and no one else may", async () => {
    const shared = thread({
      participants: [
        { principal: { ...sam, displayName: "Sam Ortiz" }, addedAt: at, addedBy: dana },
      ],
    })
    const samsCall = approval({ requestedBy: sam })

    const owner = renderChat("dana", { thread: shared, approvals: [samsCall] })
    expect(
      within(await card(owner.view)).getByRole("button", { name: "Stop waiting" })
    ).toBeDefined()
    cleanup()

    const other = renderChat("sam", { thread: shared, approvals: [approval()] })
    expect(
      within(await card(other.view)).queryByRole("button", { name: "Stop waiting" })
    ).toBeNull()
  })

  // Removal proof: make `canDecide` return true; Sam gets Dana's buttons.
  test("others in a shared thread read it, and who decides", async () => {
    const { view } = renderChat("sam", {
      thread: thread({
        participants: [
          { principal: { ...sam, displayName: "Sam Ortiz" }, addedAt: at, addedBy: dana },
        ],
      }),
    })

    const found = within(await card(view))
    expect(found.getByText("Waiting for Dana Reyes")).toBeDefined()
    expect(
      found.getByText("Only Dana Reyes can approve this: it runs with their access.")
    ).toBeDefined()
    expect(found.queryByRole("button", { name: "Approve" })).toBeNull()
    expect(found.queryByRole("button", { name: "Deny" })).toBeNull()
    // Sending sets Dana's request aside: Sam is told before he does.
    expect(
      view.getByText("Sending now sets aside Dana Reyes's request waiting for approval.")
    ).toBeDefined()
  })

  test.each([
    ["pending", approval(), "Waiting for your approval"],
    ["running", approval({ status: "approved", decidedAt: at }), "Approved · Running…"],
    ["ran", ran, "Approved · Ran"],
    [
      "failed",
      approval({
        status: "approved",
        decidedAt: at,
        outcome: {
          kind: "action-run",
          runId: "act_pay",
          status: "failed",
          error: {
            code: "action.rejected",
            message: "This invoice is already paid.",
            retryable: false,
            at,
            details: { actionId: "payInvoice", runId: "act_pay", phase: "validation" },
          },
        },
      }),
      "Approved, but it failed",
    ],
    ["denied", approval({ status: "denied", decidedAt: at }), "Denied · Didn't run"],
    ["superseded", approval({ status: "superseded", decidedAt: at }), "Set aside"],
    ["cancelled", approval({ status: "cancelled", decidedAt: at }), "Stopped"],
    ["expired", approval({ status: "expired", decidedAt: at }), "Expired"],
    [
      "lost",
      approval({
        status: "approved",
        decidedAt: at,
        outcome: {
          kind: "error",
          error: {
            code: "agent.approval_authority_lost",
            message: "[Sixb] The sign-in ended.",
            retryable: false,
            at,
          },
        },
      }),
      "Approved, but it didn't run",
    ],
  ] as const)("reads as %s after a reload", (state, record, label) => {
    const view = renderTranscript([record])

    const found = view.getByRole("region", { name: /^Approval request/ })
    expect(found.getAttribute("data-approval-state")).toBe(state)
    expect(within(found).getByText(label)).toBeDefined()
    expect(within(found).queryByRole("button", { name: "Approve" }) !== null).toBe(
      state === "pending"
    )
  })

  // Removal proof: drop ApprovalCard's early return for a call with no record; the copy shows a card
  // nobody can answer.
  test("a held call the thread holds no record of, as in a copy, shows no card", () => {
    const view = renderTranscript([])

    expect(view.queryByRole("region", { name: /^Approval request/ })).toBeNull()
  })

  // Removal proof: return the bare ToolLine for a held command; its output can't be opened.
  test("a held command keeps its output view, headed by what it waits for", () => {
    const view = render(<BashToolView tool={heldBash() as BashTool} />)

    fireEvent.click(view.getByRole("button", { name: /Waiting for approval/ }))
    fireEvent.click(view.getByRole("button", { name: "View raw" }))
    expect(view.getByText(/"status":"awaiting_approval"/)).toBeDefined()
  })

  test("a transcript read without its approvals, as an observer's, only says what was asked", () => {
    const view = renderTranscript(undefined)

    const found = view.getByRole("region", { name: /^Approval request/ })
    expect(found.getAttribute("data-approval-state")).toBe("asked")
    expect(within(found).getByText("Asked for approval")).toBeDefined()
    expect(within(found).queryByRole("button")).toBeNull()
  })

  // Removal proof: give the cards an empty `outcomes` map in Transcript; the observer reads "Asked".
  test("an observer reads how a call ended from the message that resumed its turn", () => {
    const view = renderTranscript(undefined, [
      {
        ...message,
        id: "msg_3",
        runId: null,
        role: "user",
        authorPrincipal: dana,
        seq: 3,
        createdAt: at,
        parts: [
          {
            type: "approval-outcome",
            approvalId: "apr_1",
            status: "approved",
            call: { kind: "action", actionId: "payInvoice", subject: payCall.subject },
            outcome: { kind: "action-run", runId: "act_pay", status: "succeeded" },
          },
        ],
      },
    ])

    const found = view.getByRole("region", { name: /^Approval request/ })
    expect(found.getAttribute("data-approval-state")).toBe("ran")
    expect(within(found).getByRole("link", { name: "View run" })).toBeDefined()
    expect(within(found).queryByRole("button", { name: "Approve" })).toBeNull()
  })

  // Removal proof: drop the caller line from ApprovalCard, or `caller` from
  // reportedApprovalOutcomes; neither the requester nor an observer reads which sub-agent asked.
  test("a sub-agent's call says which one asked, from its record or the message that resumed", () => {
    const fromChild = { runId: "run_child", key: "pay-suppliers" }
    const recorded = renderTranscript([
      approval({ callerRunId: fromChild.runId, caller: fromChild }),
    ])

    expect(
      within(recorded.getByRole("region", { name: /^Approval request/ })).getByText(
        "Asked by the sub-agent pay-suppliers"
      )
    ).toBeDefined()
    cleanup()

    const observed = renderTranscript(undefined, [
      {
        ...message,
        id: "msg_3",
        runId: null,
        role: "user",
        authorPrincipal: dana,
        seq: 3,
        createdAt: at,
        parts: [
          {
            type: "approval-outcome",
            approvalId: "apr_1",
            status: "denied",
            call: { kind: "action", actionId: "payInvoice", subject: payCall.subject },
            caller: fromChild,
          },
        ],
      },
    ])

    expect(
      within(observed.getByRole("region", { name: /^Approval request/ })).getByText(
        "Asked by the sub-agent pay-suppliers"
      )
    ).toBeDefined()
  })

  // Removal proof: keep only pending approvals in Transcript's `unshown`; the card leaves once
  // decided.
  test("a call whose command did not name it keeps its card under its turn, once decided too", () => {
    const [question, answer] = conversation()
    const view = renderTranscript(
      [ran],
      [],
      [question, { ...answer, parts: [{ type: "text", text: "I'll send an ACH payment." }] }]
    )

    const found = view.getByRole("region", { name: /^Approval request/ })
    expect(found.getAttribute("data-approval-state")).toBe("ran")
  })
})

describe("the thread list", () => {
  // Removal proof: drop `waitingRows` from the switcher; the waiting thread sits among the others.
  test("puts the conversations waiting for the reader first", async () => {
    const older = "2026-10-20T09:00:00.000Z"
    const { view } = renderChat("dana", {
      waiting: [approval({ id: "apr_2", threadId: "thr_2" })],
      threads: [
        thread({ id: "thr_3", title: "Q3 software spend", updatedAt: at }),
        thread({ id: "thr_2", title: "Approve Halvorsen", updatedAt: older }),
      ],
    })

    fireEvent.click(await view.findByRole("button", { name: /1 conversation waiting/ }))
    const dialog = within(await view.findByRole("dialog"))
    const section = dialog.getByRole("region", { name: "Waiting for you" })
    expect(within(section).getByRole("button", { name: /^Approve Halvorsen/ })).toBeDefined()
    expect(within(section).queryByRole("button", { name: /^Q3 software spend/ })).toBeNull()
  })

  // Removal proof: drop `waitingThreadIds` from ConversationPanel's switcher; no badge shows.
  test("counts the other conversations waiting for the reader, and marks them", async () => {
    const waiting = [
      approval({ id: "apr_2", threadId: "thr_2" }),
      approval({ id: "apr_3", threadId: "thr_3" }),
      approval({ id: "apr_4", threadId: "thr_3" }),
      // The open one shows its own card.
      approval(),
    ]
    const { view } = renderChat("dana", { waiting })

    const history = await view.findByRole("button", {
      name: /2 conversations waiting for your approval/,
    })
    expect(history.querySelector("[data-waiting-approval-count]")?.textContent).toBe("2")

    fireEvent.click(history)
    const dialog = within(await view.findByRole("dialog"))
    expect(
      dialog.getByRole("button", { name: /Pay Northwind, current, Waiting for you/ })
    ).toBeDefined()
  })

  // Removal proof: drop `onApprovalActivity` from the activity stream; no badge.
  test("a call held in another conversation counts as it arrives", async () => {
    const { view, state } = renderChat("dana", { approvals: [], runs: [], messages: [] })
    const activity = await subscribeActivity()
    await view.findByRole("button", { name: /^Thread history/ })
    expect(view.container.querySelector("[data-waiting-approval-count]")).toBeNull()

    state.waiting = [approval({ id: "apr_2", threadId: "thr_2" })]
    await act(async () => {
      activity.onmessage?.({
        data: JSON.stringify({
          type: "activity",
          event: {
            schemaVersion: 1,
            type: "agent.approval.activity",
            projectId: "proj",
            approvalId: "apr_2",
            threadId: "thr_2",
            runId: "run_9",
            status: "pending",
            hasOutcome: false,
            occurredAt: at,
          },
        }),
      })
    })

    await waitFor(() =>
      expect(view.container.querySelector("[data-waiting-approval-count]")?.textContent).toBe("1")
    )
  })
})

describe("held calls in a command's output", () => {
  test("are read from the CLI's 202 answer, whatever the exit code", () => {
    expect(heldCallsInOutput(heldBash("apr_9").output)).toEqual([
      {
        id: "apr_9",
        kind: "action",
        actionId: "payInvoice",
        subject: { objectTypeId: "Invoice", primaryId: "inv-4471" },
      },
    ])
    expect(heldCallsInOutput({ ...heldBash().output, exitCode: 0 })).toHaveLength(1)
    expect(
      heldCallsInOutput({ stdout: '{"status":"succeeded","id":"act_1"}', exitCode: 0 })
    ).toEqual([])
    expect(heldCallsInOutput({ stdout: "awaiting_approval", exitCode: 4 })).toEqual([])
  })

  test("Shift+Tab never reaches Auto", () => {
    expect(toggledApprovalMode("manual")).toBe("accept-edits")
    expect(toggledApprovalMode("accept-edits")).toBe("manual")
    expect(toggledApprovalMode("auto")).toBe("manual")
  })

  test("the message that resumes a turn is not shown", () => {
    const outcome = {
      ...conversation()[0],
      parts: [
        {
          type: "approval-outcome",
          approvalId: "apr_1",
          status: "approved",
          call: { kind: "action", actionId: "payInvoice", subject: payCall.subject },
        },
      ],
    } as unknown as AgentMessage
    expect(isApprovalOutcomeMessage(outcome)).toBe(true)
    expect(isApprovalOutcomeMessage(conversation()[0] as unknown as AgentMessage)).toBe(false)
  })
})

/** The transcript alone, with the thread's approvals, or none at all as an observer reads it. */
function renderTranscript(
  approvals: AgentApproval[] | undefined,
  extra: readonly Record<string, unknown>[] = [],
  base: readonly Record<string, unknown>[] = conversation()
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setConfig({
    fetch: Object.assign(async () => Response.json({ error: "Not found" }, { status: 404 }), {
      preconnect: fetch.preconnect,
    }),
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Transcript
          threadId="thr_1"
          messages={[...base, ...extra] as unknown as AgentMessage[]}
          live={createLiveRunState(null)}
          {...(approvals === undefined
            ? {}
            : {
                approvals: {
                  approvals,
                  loaded: true,
                  canDecide: () => true,
                  requesterName: () => "Dana Reyes",
                  decide: async (decided) => ({ approval: decided }),
                },
              })}
        />
      </MemoryRouter>
    </QueryClientProvider>
  )
}
