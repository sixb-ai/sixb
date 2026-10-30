import { describe, expect, test } from "bun:test"
import type { AgentApprovalOutcomePart, AgentMessagePart, FileRef, LanguageModel } from "@sixb/core"
import {
  agent,
  can,
  defineGroup,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createSubagentRunId, createSubagentThreadId } from "@sixb/core/internal/agents"
import { agentRunStreamId } from "@sixb/core/internal/agents/streams"
import { createSessionCredential } from "@sixb/core/internal/auth"
import type { SubagentRunSpec } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// A child the Agent spawned works in a thread of its own, visible exactly when its conversation is,
// and reads as one child across the runs of its thread.

// Route tests register the binding but never invoke the provider.
const model = {
  providerId: "test",
  modelId: "test-model",
  definition: { kind: "language", providerId: "test", modelId: "test-model", capabilities: {} },
  stream: async () => {
    throw new Error("Must not invoke the route test model")
  },
} satisfies LanguageModel

const runners = defineGroup("runners")
const threadObservers = defineGroup("thread-observers")
const roles = [
  defineRole("runner", { grantedTo: [runners], grants: [can.run(agent)] }),
  defineRole("thread-observer", {
    grantedTo: [threadObservers],
    grants: [can.observe(agent.threads)],
  }),
]

const projectId = "agent-children"
const marie = { type: "user", id: "marie" } as const
const paul = { type: "user", id: "paul" } as const
const pia = { type: "user", id: "pia" } as const
const fiona = { type: "user", id: "fiona" } as const

const THREAD = "thr_src"
const R1 = "run_spawning"
const R2 = "run_resumed"

const at = (minute: number) => new Date(Date.UTC(2026, 9, 24, 9, minute))
const lease = (token: string) => ({ token, queueLeaseExpiresAt: new Date(Date.now() + 600_000) })

function createFixture() {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const broker = new InMemoryBroker()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    models: { language: [model] },
    storage,
    broker,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage,
    queues: new InMemoryQueues(),
    groups: [runners, threadObservers],
    roles,
    auth: { id: "test", kind: "dev" },
  })
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )

  /** A browser session for a new user in these groups: its cookie, and a mutation's CSRF pair. */
  async function browser(userId: string, groupIds: readonly string[] = [runners.id]) {
    await storage.auth.users.create({ projectId, id: userId, email: `${userId}@example.test` })
    for (const groupId of groupIds) {
      await storage.auth.groupMemberships.upsert({ projectId, userId, groupId, source: "manual" })
    }

    const credential = createSessionCredential(`ses_${userId}`)
    await storage.auth.sessions.create({
      projectId,
      id: credential.sessionId,
      userId,
      strategyId: "test",
      tokenHash: credential.tokenHash,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    return {
      cookie: `sixb_session_app=${credential.cookieValue}; sixb_csrf_app=csrf-token`,
      origin: "http://app.localhost",
      "x-sixb-csrf": "csrf-token",
    }
  }

  function request(
    path: string,
    headers: Record<string, string>,
    init: { readonly method?: string; readonly body?: unknown } = {}
  ) {
    return app.fetch(
      new Request(`http://api.localhost${path}`, {
        method: init.method ?? "GET",
        headers: { ...headers, "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
    )
  }

  async function file(name: string, text: string): Promise<FileRef> {
    return blobStorage.put({
      body: new TextEncoder().encode(text),
      fileName: name,
      mediaType: "text/plain",
    })
  }

  /** A turn of Marie's thread that Paul asked for. */
  async function turn(id: string, triggerMessageId: string, createdAt: Date) {
    const requestExecutionId = `request_${id}`
    await storage.executions.create({
      id: requestExecutionId,
      projectId,
      requesterGroupIds: [],
      requestedBy: paul,
      executor: { type: "request", requestId: `req_${id}` },
      source: { type: "http", requestId: `req_${id}` },
      correlationId: `corr_${id}`,
      authorizationRef: {
        type: "principal",
        principal: paul,
        credential: { type: "session", id: "ses_paul" },
      },
    })
    const executionId = await createTestAgentExecution(storage, {
      projectId,
      runId: id,
      sourceExecutionId: requestExecutionId,
    })
    await storage.agents.runs.create({
      projectId,
      id,
      executionId,
      threadId: THREAD,
      triggerMessageId,
      spec: { model: { provider: "test", modelId: "test-model" } },
      createdAt,
    })
    await storage.agents.runs.start({
      projectId,
      id,
      execution: lease(`tok_${id}`),
      startedAt: createdAt,
    })
    return executionId
  }

  /**
   * A child of `parent` under `key`: spawned into a thread of its own, or, `continues`, the next
   * run of that thread, started by `trigger`.
   */
  async function child(
    parent: { readonly id: string; readonly executionId: string },
    key: string,
    createdAt: Date,
    spec: Partial<SubagentRunSpec> = {},
    continuation?: { readonly threadId: string; readonly trigger: readonly AgentMessagePart[] }
  ) {
    const id = createSubagentRunId(parent.id, key)
    const executionId = await createTestAgentExecution(storage, {
      projectId,
      runId: id,
      sourceExecutionId: parent.executionId,
    })
    const task = `Look into ${key}.`
    const run = await storage.agents.runs.createSubagent({
      projectId,
      id,
      executionId,
      parentRunId: parent.id,
      parentExecutionToken: `tok_${parent.id}`,
      spawnKey: key,
      spec: {
        model: { provider: "test", modelId: "test-model" },
        task,
        toolNames: [],
        ...spec,
      },
      thread: continuation
        ? { id: continuation.threadId, create: false }
        : { id: createSubagentThreadId(parent.id, key), create: true },
      trigger: {
        id: `task_${id}`,
        parts: continuation ? continuation.trigger : [{ type: "text", text: task }],
      },
      maxActiveChildren: 4,
      createdAt,
    })
    return { id, executionId, threadId: run.threadId }
  }

  /** What a child run did, as its thread keeps it once the run ends. */
  async function work(
    run: { readonly id: string; readonly threadId: string },
    parts: AgentMessagePart[]
  ) {
    const id = `work_${run.id}`
    await storage.agents.messages.append({
      projectId,
      id,
      threadId: run.threadId,
      runId: run.id,
      role: "assistant",
      parts,
    })
    return id
  }

  async function spend(executionId: string, id: string, inputTokens: number) {
    await storage.aiUsage.recordModelCall({
      id: `usage_${id}`,
      projectId,
      executionId,
      attempt: 1,
      callId: `call_${id}`,
      requesterGroupIds: [],
      providerId: "test",
      requestedModelId: "test-model",
      responseId: `response_${id}`,
      usage: { inputTokens, outputTokens: 1 },
      occurredAt: at(30),
    })
  }

  /**
   * Marie's thread, where Paul takes part. Paul's turn spawned two children: `terms` paused on a
   * held call, `history` answered with a file and showed a chart. The turn paused on `terms`'s call.
   */
  async function seedPausedTurn() {
    await storage.agents.threads.create({ projectId, id: THREAD, ownerPrincipal: marie })
    await storage.agents.threads.addParticipants({
      projectId,
      threadId: THREAD,
      principals: [paul, pia],
      addedBy: marie,
      maxParticipants: 50,
    })
    await storage.agents.messages.append({
      projectId,
      id: "msg_ask",
      threadId: THREAD,
      runId: null,
      role: "user",
      authorPrincipal: paul,
      parts: [{ type: "text", text: "Compare the supplier terms." }],
    })
    const r1 = { id: R1, executionId: await turn(R1, "msg_ask", at(0)) }

    const contract = await file("contract.txt", "net 30")
    const terms = await child(r1, "terms", at(1), {
      tier: "heavy",
      files: [{ path: "contract.txt", fileRef: contract }],
    })
    const history = await child(r1, "history", at(2))

    await storage.agents.runs.start({ projectId, id: terms.id, execution: lease("tok_terms") })
    await storage.agents.approvals.request({
      id: "apr_terms",
      projectId,
      runId: R1,
      callerRunId: terms.id,
      executionToken: "tok_terms",
      requestedBy: paul,
      mode: "manual",
      call: {
        kind: "workflow",
        workflowId: "send",
        input: {},
        workflowRunId: "wf_send",
      },
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    const draft = await file("draft.md", "draft so far")
    await work(terms, [{ type: "text", text: "I asked to send the terms." }])
    await storage.agents.runs.finish({
      projectId,
      id: terms.id,
      executionToken: "tok_terms",
      status: "succeeded",
      finishReason: "awaiting_approval",
      result: { text: "", files: [{ path: "draft.md", fileRef: draft }] },
    })

    await storage.agents.runs.start({ projectId, id: history.id, execution: lease("tok_history") })
    const summary = await file("summary.md", "paid on time")
    const chart = await file("chart.txt", "a chart it read")
    const historyWork = await work(history, [
      { type: "file", fileRef: chart },
      { type: "text", text: "Paid on time." },
    ])
    await storage.agents.runs.finish({
      projectId,
      id: history.id,
      executionToken: "tok_history",
      status: "succeeded",
      finishReason: "stop",
      result: { text: "Paid on time.", files: [{ path: "summary.md", fileRef: summary }] },
    })

    await storage.agents.runs.finish({
      projectId,
      id: R1,
      executionToken: `tok_${R1}`,
      status: "succeeded",
      finishReason: "awaiting_approval",
    })
    await spend(terms.executionId, "terms", 100)
    await spend(history.executionId, "history", 7)
    return { r1, terms, history, historyWork, contract, draft }
  }

  /** Paul approves `terms`'s call. */
  async function decide() {
    await storage.agents.approvals.decide({
      projectId,
      id: "apr_terms",
      decision: "approved",
      decidedBy: paul,
    })
  }

  /**
   * The message that reports how `terms`'s call ended: the resume that continues it, or a new
   * message that set it aside.
   */
  async function report(
    seeded: Awaited<ReturnType<typeof seedPausedTurn>>,
    by: "resume" | "new message"
  ): Promise<AgentApprovalOutcomePart> {
    const resuming = by === "resume"
    if (!resuming) {
      await storage.agents.approvals.settle({ projectId, threadId: THREAD, status: "superseded" })
    }
    const outcome: AgentApprovalOutcomePart = {
      type: "approval-outcome",
      approvalId: "apr_terms",
      status: resuming ? "approved" : "superseded",
      call: { kind: "workflow", workflowId: "send" },
      caller: { runId: seeded.terms.id, key: "terms", ...(resuming ? { continues: true } : {}) },
    }
    const messageId = resuming ? "msg_resume" : "msg_new"
    await storage.agents.messages.append({
      projectId,
      id: messageId,
      threadId: THREAD,
      runId: null,
      role: "user",
      authorPrincipal: paul,
      parts: [outcome],
    })
    await storage.agents.approvals.markReported({
      projectId,
      threadId: THREAD,
      ids: ["apr_terms"],
      messageId,
      resuming,
    })
    return outcome
  }

  /**
   * Paul approves: the turn resumes, and `terms` continues in its thread under the resumed turn,
   * at work. The resumed turn also spawned `extra`, still queued.
   */
  async function resume(seeded: Awaited<ReturnType<typeof seedPausedTurn>>) {
    await decide()
    const outcome = await report(seeded, "resume")

    const r2 = { id: R2, executionId: await turn(R2, "msg_resume", at(10)) }
    const { caller: _caller, ...own } = outcome
    const continued = await child(
      r2,
      "terms",
      at(11),
      { tier: "heavy", files: [{ path: "contract.txt", fileRef: seeded.contract }] },
      { threadId: seeded.terms.threadId, trigger: [own] }
    )
    await storage.agents.runs.start({ projectId, id: continued.id, execution: lease("tok_cont") })
    await spend(continued.executionId, "continued", 20)
    const extra = await child(r2, "extra", at(12))
    return { r2, continued, extra }
  }

  /**
   * Paul's turn spawned `fiscal`, which asked which year to use; the turn ended before he said, so
   * `fiscal` paused on its question. His next turn either answers it or spawns `fiscal` again.
   */
  async function seedQuestion() {
    await storage.agents.threads.create({ projectId, id: THREAD, ownerPrincipal: marie })
    await storage.agents.threads.addParticipants({
      projectId,
      threadId: THREAD,
      principals: [paul],
      addedBy: marie,
      maxParticipants: 50,
    })
    const r1 = { id: R1, executionId: await turn(R1, "msg_ask", at(0)) }
    const fiscal = await child(r1, "fiscal", at(1))
    await storage.agents.runs.start({ projectId, id: fiscal.id, execution: lease("tok_fiscal") })
    await work(fiscal, [
      {
        type: "tool-call",
        toolCallId: "call_ask",
        toolName: "ask_parent",
        input: { question: "Calendar year or April–March? " },
        state: "output-available",
        output: { status: "deferred", question: "q_fiscal" },
      },
    ])
    await storage.agents.runs.finish({
      projectId,
      id: fiscal.id,
      executionToken: "tok_fiscal",
      status: "succeeded",
      finishReason: "awaiting_answer",
      result: { text: "" },
    })
    await storage.agents.runs.finish({
      projectId,
      id: R1,
      executionToken: `tok_${R1}`,
      status: "succeeded",
      finishReason: "stop",
    })
    const r2 = { id: R2, executionId: await turn(R2, "msg_next", at(10)) }

    const answer = {
      type: "mail",
      id: "mail_answer",
      from: "parent",
      kind: "answer",
      inReplyTo: "q_fiscal",
      text: "April–March.",
    } as const
    return {
      fiscal,
      /** The next turn's message answers it: `fiscal` continues with the answer and finishes. */
      answer: async () => {
        const continued = await child(
          r2,
          "fiscal",
          at(11),
          {},
          {
            threadId: fiscal.threadId,
            trigger: [answer],
          }
        )
        await storage.agents.runs.start({ projectId, id: continued.id, execution: lease("tok_c") })
        await work(continued, [{ type: "text", text: "Done, April–March." }])
        await storage.agents.runs.finish({
          projectId,
          id: continued.id,
          executionToken: "tok_c",
          status: "succeeded",
          finishReason: "stop",
          result: { text: "Done, April–March." },
        })
        return continued
      },
      /** The next turn spawns `fiscal` again instead, which an answer would reach. */
      replace: () => child(r2, "fiscal", at(11)),
    }
  }

  /** Fiona's copy of Marie's thread: she owns it and never read the original. */
  async function forkForFiona() {
    await storage.agents.threads.fork({
      projectId,
      sourceThreadId: THREAD,
      id: "thr_fiona",
      ownerPrincipal: fiona,
    })
  }

  return {
    storage,
    broker,
    browser,
    request,
    seedPausedTurn,
    seedQuestion,
    decide,
    report,
    resume,
    forkForFiona,
  }
}

/** Every reader of the fixture: the owner, the turn's requester, another participant, and more. */
async function readers(fixture: ReturnType<typeof createFixture>) {
  return {
    marie: await fixture.browser("marie"),
    paul: await fixture.browser("paul"),
    pia: await fixture.browser("pia"),
    olga: await fixture.browser("olga", [runners.id, threadObservers.id]),
    xavier: await fixture.browser("xavier"),
    fiona: await fixture.browser("fiona"),
  }
}

type Fixture = ReturnType<typeof createFixture>
type Seeded = Awaited<ReturnType<Fixture["seedPausedTurn"]>>
type Headers = Record<string, string>

const CHILDREN = `/api/agent-threads/${THREAD}/children`

const childFile = (child: { readonly id: string; readonly threadId: string }, path: string) =>
  `/api/agent-threads/${child.threadId}/child-files/content?run=${child.id}&path=${encodeURIComponent(path)}`

/** The conversation's children, by key. */
async function listed(fixture: Fixture, headers: Headers, query = "") {
  const response = await fixture.request(`${CHILDREN}${query}`, headers)
  expect(response.status).toBe(200)
  const { children } = (await response.json()) as { children: Record<string, unknown>[] }
  return children
}

async function childOf(fixture: Fixture, headers: Headers, key: string) {
  const child = (await listed(fixture, headers)).find((each) => each.key === key)
  if (!child) throw new Error(`Expected the child '${key}'.`)
  return child
}

describe("a sub-agent's thread over HTTP, for each reader", () => {
  // Guard proof: read a child's thread as its own row in createAgentThreadAccessRule, without its
  // conversation; Paul and Pia, who take part in the conversation only, then get 404 on the
  // child's routes.
  test("is read exactly when its conversation is, on every route", async () => {
    const fixture = createFixture()
    const people = await readers(fixture)
    const seeded = await fixture.seedPausedTurn()
    await fixture.forkForFiona()
    const { terms } = seeded

    const routes = [
      CHILDREN,
      `/api/agent-threads/${terms.threadId}`,
      `/api/agent-threads/${terms.threadId}/messages`,
      `/api/agent-threads/${terms.threadId}/runs`,
      `/api/agent-runs/${terms.id}`,
      childFile(terms, "/handedFiles/0/fileRef"),
    ]
    const expected = { marie: 200, paul: 200, pia: 200, olga: 404, xavier: 404, fiona: 404 }

    for (const [name, status] of Object.entries(expected)) {
      for (const path of routes) {
        const response = await fixture.request(path, people[name as keyof typeof people])
        expect(`${name} ${path} ${response.status}`).toBe(`${name} ${path} ${status}`)
      }
    }

    // A participant who leaves no longer reads them.
    await fixture.storage.agents.threads.removeParticipant({
      projectId,
      threadId: THREAD,
      principal: pia,
    })
    for (const path of routes) {
      expect((await fixture.request(path, people.pia)).status).toBe(404)
    }
  })

  // Guard proof: drop `getControllableRun(run.parentRunId, "cancel")` from runs.cancel; Pia, who
  // only takes part, then stops Paul's sub-agent.
  test("is stopped by whoever asked for its turn, or the conversation's owner", async () => {
    const fixture = createFixture()
    const people = await readers(fixture)
    const seeded = await fixture.seedPausedTurn()
    const { continued } = await fixture.resume(seeded)
    const cancel = (headers: Headers) =>
      fixture.request(`/api/agent-runs/${continued.id}/cancel`, headers, { method: "POST" })

    const expected = { pia: 403, olga: 404, xavier: 404, fiona: 404, paul: 202, marie: 202 }
    await fixture.forkForFiona()
    for (const [name, status] of Object.entries(expected)) {
      const response = await cancel(people[name as keyof typeof people])
      expect(`${name} ${response.status}`).toBe(`${name} ${status}`)
    }

    // A running one is still running: its worker obeys the stop it was sent.
    const control = await fixture.broker.read({
      projectId,
      streamId: `agents.runs.${continued.id}.control`,
    })
    expect(new Set(control.records.map((record) => record.name))).toEqual(
      new Set(["agent.run.cancel"])
    )
    const stopped = await cancel(people.paul)
    expect(await stopped.json()).toMatchObject({
      run: { id: continued.id, kind: "subagent", parentRunId: R2, status: "running" },
    })
  })
})

describe("a conversation's sub-agents", () => {
  test("lists each, its thread with every run it took", async () => {
    const fixture = createFixture()
    const { marie } = await readers(fixture)
    const seeded = await fixture.seedPausedTurn()

    const children = await listed(fixture, marie)
    expect(children.map((child) => child.key)).toEqual(["terms", "history"])
    expect(children[1]).toEqual({
      id: seeded.history.id,
      threadId: seeded.history.threadId,
      projectId,
      spawnedBy: R1,
      key: "history",
      task: "Look into history.",
      model: { provider: "test", modelId: "test-model" },
      handedFiles: [],
      status: "succeeded",
      finishReason: "stop",
      activeRunId: null,
      createdAt: at(2).toISOString(),
      completedAt: expect.any(String),
      usage: expect.objectContaining({ inputTokens: 7 }),
      cost: expect.objectContaining({ unvaluedCallCount: 1 }),
      runs: [
        {
          id: seeded.history.id,
          parentRunId: R1,
          status: "succeeded",
          finishReason: "stop",
          attempt: 1,
          streamId: agentRunStreamId(seeded.history.id),
          createdAt: at(2).toISOString(),
          startedAt: expect.any(String),
          completedAt: expect.any(String),
          result: {
            text: "Paid on time.",
            files: [
              { path: "summary.md", fileRef: expect.objectContaining({ fileName: "summary.md" }) },
            ],
          },
          usage: expect.objectContaining({ inputTokens: 7 }),
          cost: expect.objectContaining({ unvaluedCallCount: 1 }),
        },
      ],
    })

    // What it did is its thread's: its task, then its work.
    const messages = await fixture.request(
      `/api/agent-threads/${seeded.history.threadId}/messages`,
      marie
    )
    expect(await messages.json()).toMatchObject({
      messages: [
        { role: "user", runId: seeded.history.id, parts: [{ text: "Look into history." }] },
        { role: "assistant", parts: [{ type: "file" }, { text: "Paid on time." }] },
      ],
    })

    // A turn of another conversation has none here.
    expect(await listed(fixture, marie, "?runId=run_other")).toEqual([])
  })

  // Guard proof: make pausedState's pending approvals `undefined`; the paused child no longer says
  // what it waits for.
  test("a paused sub-agent says which of its calls wait", async () => {
    const fixture = createFixture()
    const { paul } = await readers(fixture)
    await fixture.seedPausedTurn()

    expect(await childOf(fixture, paul, "terms")).toMatchObject({
      status: "succeeded",
      finishReason: "awaiting_approval",
      tier: "heavy",
      awaiting: { type: "approval", approvalIds: ["apr_terms"] },
    })
  })

  // Guard proofs: read only the latest run in listThreadRuns, and `terms` has one run; add only
  // the latest run's usage, and it costs 20 tokens; list by the run's turn rather than the
  // thread's, and the resumed turn lists `terms` too.
  test("a sub-agent that continued after its approvals reads as one, across its thread's runs", async () => {
    const fixture = createFixture()
    const { paul } = await readers(fixture)
    const seeded = await fixture.seedPausedTurn()
    const { continued, extra } = await fixture.resume(seeded)

    const terms = await childOf(fixture, paul, "terms")
    expect(terms).toMatchObject({
      id: seeded.terms.id,
      threadId: seeded.terms.threadId,
      status: "running",
      activeRunId: continued.id,
      // Both runs' calls: 100 before its pause, 20 since.
      usage: { inputTokens: 120 },
      runs: [
        { id: seeded.terms.id, parentRunId: R1, finishReason: "awaiting_approval" },
        {
          id: continued.id,
          parentRunId: R2,
          status: "running",
          streamId: agentRunStreamId(continued.id),
        },
      ],
    })
    expect(terms).not.toHaveProperty("awaiting")

    // The resumed turn spawned only `extra`; `terms` is still the first turn's.
    expect(await listed(fixture, paul, `?runId=${R2}`)).toMatchObject([
      { id: extra.id, key: "extra", status: "queued" },
    ])

    // Its thread holds both runs and the outcome between them.
    const runs = await fixture.request(`/api/agent-threads/${seeded.terms.threadId}/runs`, paul)
    expect(await runs.json()).toMatchObject({
      runs: expect.arrayContaining([
        expect.objectContaining({ id: seeded.terms.id, kind: "subagent", parentRunId: R1 }),
        expect.objectContaining({ id: continued.id, kind: "subagent", parentRunId: R2 }),
      ]),
      total: 2,
    })
    const messages = await fixture.request(
      `/api/agent-threads/${seeded.terms.threadId}/messages`,
      paul
    )
    expect(await messages.json()).toMatchObject({
      messages: [
        { role: "user", runId: seeded.terms.id },
        { role: "assistant", runId: seeded.terms.id },
        { role: "user", runId: continued.id, parts: [{ type: "approval-outcome" }] },
      ],
    })
  })

  test("serves the files a sub-agent was handed and returned, and those it was shown", async () => {
    const fixture = createFixture()
    const { marie, xavier, fiona } = await readers(fixture)
    const seeded = await fixture.seedPausedTurn()
    await fixture.forkForFiona()

    const handed = await fixture.request(childFile(seeded.terms, "/handedFiles/0/fileRef"), marie)
    expect(handed.status).toBe(200)
    expect(await handed.text()).toBe("net 30")

    const returned = await fixture.request(childFile(seeded.history, "/files/0/fileRef"), marie)
    expect(await returned.text()).toBe("paid on time")

    // What a tool showed it is a file of its thread's messages.
    const shown = await fixture.request(
      `/api/agent-threads/${seeded.history.threadId}/messages/${seeded.historyWork}/files/content?path=${encodeURIComponent("/parts/0/fileRef")}`,
      marie
    )
    expect(await shown.text()).toBe("a chart it read")

    const head = await fixture.request(childFile(seeded.history, "/files/0/fileRef"), marie, {
      method: "HEAD",
    })
    expect(head.status).toBe(200)

    for (const reader of [xavier, fiona]) {
      const refused = await fixture.request(
        childFile(seeded.terms, "/handedFiles/0/fileRef"),
        reader
      )
      expect(refused.status).toBe(404)
    }

    // A run of the thread, and only a sub-agent's files: never another field of its view.
    const otherRun = await fixture.request(
      childFile({ id: seeded.history.id, threadId: seeded.terms.threadId }, "/files/0/fileRef"),
      marie
    )
    expect(otherRun.status).toBe(404)
    const outside = await fixture.request(childFile(seeded.terms, "/model"), marie)
    expect(outside.status).toBe(400)
  })
})

describe("where a paused sub-agent stands", () => {
  const read = async (fixture: Fixture, headers: Headers, key: string) => {
    const { awaiting, ended, status } = await childOf(fixture, headers, key)
    return { status, ...(awaiting ? { awaiting } : {}), ...(ended ? { ended } : {}) }
  }

  // Guard proof: drop the lookup of the resume's `continues` in pausedState; a child its resume
  // reported then reads as ended.
  test("waiting for decisions, then continuing once its turn resumes", async () => {
    const fixture = createFixture()
    const { paul } = await readers(fixture)
    const seeded = await fixture.seedPausedTurn()

    expect(await read(fixture, paul, "terms")).toEqual({
      status: "succeeded",
      awaiting: { type: "approval", approvalIds: ["apr_terms"] },
    })

    await fixture.decide()
    expect(await read(fixture, paul, "terms")).toEqual({
      status: "succeeded",
      awaiting: { type: "resume" },
    })

    // Reported by the resume, before the resumed turn admits its continuation.
    await fixture.report(seeded, "resume")
    expect(await read(fixture, paul, "terms")).toEqual({
      status: "succeeded",
      awaiting: { type: "resume" },
    })
  })

  // Guard proofs: make pausedState answer `resume` whenever no call is pending, or drop its
  // stopped-turn check, and these read as continuing; drop `expired` from endReason, and an
  // expired call reads as stopped.
  test("ended without continuing: set aside, stopped or expired", async () => {
    const cases: Record<
      string,
      (fixture: Fixture, seeded: Seeded, paul: Headers) => Promise<void>
    > = {
      superseded: async (fixture, seeded) => {
        await fixture.report(seeded, "new message")
      },
      // Paul stops his paused turn, even once its call is decided.
      stopped: async (fixture, _seeded, paul) => {
        await fixture.decide()
        const response = await fixture.request(`/api/agent-threads/${THREAD}/cancel`, paul, {
          method: "POST",
          body: { runId: R1 },
        })
        expect(response.status).toBe(202)
      },
      expired: async (fixture) => {
        await fixture.storage.agents.approvals.expireDue({
          projectId,
          now: new Date(Date.now() + 30 * 86_400_000),
        })
      },
    }

    for (const [reason, end] of Object.entries(cases)) {
      const fixture = createFixture()
      const { paul } = await readers(fixture)
      const seeded = await fixture.seedPausedTurn()
      await end(fixture, seeded, paul)

      expect({ reason, ...(await read(fixture, paul, "terms")) }).toEqual({
        reason,
        status: "succeeded",
        ended: { reason },
      })
    }
  })
})

describe("a sub-agent paused on its question", () => {
  // Guard proofs: make questionState return nothing, and the paused child no longer shows its
  // question; drop its "latest under the key" check, and the replaced one still waits; drop the
  // mail part from the message schema, and reading the answered child's thread fails.
  test("waits for a later turn's answer, continues with it, or is replaced", async () => {
    const answered = createFixture()
    const { paul } = await readers(answered)
    const seeded = await answered.seedQuestion()

    expect(await childOf(answered, paul, "fiscal")).toMatchObject({
      status: "succeeded",
      finishReason: "awaiting_answer",
      awaiting: {
        type: "answer",
        question: { id: "q_fiscal", text: "Calendar year or April–March?" },
      },
    })

    const continued = await seeded.answer()
    const child = await childOf(answered, paul, "fiscal")
    expect(child).toMatchObject({
      status: "succeeded",
      finishReason: "stop",
      runs: [
        { id: seeded.fiscal.id, finishReason: "awaiting_answer" },
        { id: continued.id, parentRunId: R2 },
      ],
    })
    expect(child).not.toHaveProperty("awaiting")
    const messages = await answered.request(
      `/api/agent-threads/${seeded.fiscal.threadId}/messages`,
      paul
    )
    expect(messages.status).toBe(200)
    expect(await messages.json()).toMatchObject({
      messages: [
        { role: "user" },
        { role: "assistant" },
        {
          role: "user",
          runId: continued.id,
          parts: [{ type: "mail", kind: "answer", inReplyTo: "q_fiscal", text: "April–March." }],
        },
        { role: "assistant", runId: continued.id },
      ],
    })

    const replaced = createFixture()
    const people = await readers(replaced)
    const again = await replaced.seedQuestion()
    await again.replace()
    const [first] = await listed(replaced, people.paul)
    expect(first).toMatchObject({
      threadId: again.fiscal.threadId,
      status: "succeeded",
      finishReason: "awaiting_answer",
      ended: { reason: "replaced" },
    })
  })
})

describe("stopping a sub-agent", () => {
  // Guard proof: make cancelAgentChildRun publish the stop signal for a queued run instead of
  // finishing it; `extra` then stays queued.
  test("a queued one is cancelled at once, and one that ended cannot be stopped", async () => {
    const fixture = createFixture()
    const { paul } = await readers(fixture)
    const seeded = await fixture.seedPausedTurn()
    const { extra } = await fixture.resume(seeded)
    const cancel = (runId: string) =>
      fixture.request(`/api/agent-runs/${runId}/cancel`, paul, { method: "POST" })

    const cancelled = await cancel(extra.id)
    expect(cancelled.status).toBe(202)
    expect(await cancelled.json()).toMatchObject({ run: { id: extra.id, status: "cancelled" } })
    const stream = await fixture.broker.read({ projectId, streamId: agentRunStreamId(extra.id) })
    expect(stream.records.map((record) => record.name)).toEqual(["agent.run.finished"])

    const again = await cancel(extra.id)
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ code: "run_not_active" })

    expect((await cancel(seeded.history.id)).status).toBe(409)
  })
})

describe("an observer reads a conversation's sub-agents", () => {
  // Guard proof: list the children of any thread named in observed.listChildren, a child's
  // included; the child's thread then lists the conversation's children instead of 404.
  test("by polling the observed routes, read-only", async () => {
    const fixture = createFixture()
    const { olga, marie } = await readers(fixture)
    const seeded = await fixture.seedPausedTurn()
    const observed = `/api/observed-agent-threads/${THREAD}/children`

    const list = await fixture.request(observed, olga)
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({
      children: [{ key: "terms" }, { key: "history" }],
    })

    const messages = await fixture.request(
      `/api/observed-agent-threads/${seeded.history.threadId}/messages`,
      olga
    )
    expect(await messages.json()).toMatchObject({
      messages: [{ role: "user" }, { parts: [{ type: "file" }, { text: "Paid on time." }] }],
    })

    const path = encodeURIComponent("/files/0/fileRef")
    const file = await fixture.request(
      `/api/observed-agent-threads/${seeded.history.threadId}/child-files/content?run=${seeded.history.id}&path=${path}`,
      olga
    )
    expect(await file.text()).toBe("paid on time")

    // A child's thread is no conversation: it lists no children.
    const ofChild = await fixture.request(
      `/api/observed-agent-threads/${seeded.history.threadId}/children`,
      olga
    )
    expect(ofChild.status).toBe(404)

    // Reading another user's thread takes the grant, even for its owner.
    const owner = await fixture.request(observed, marie)
    expect(owner.status).toBe(403)
  })
})
