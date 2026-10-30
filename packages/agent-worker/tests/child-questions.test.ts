import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test"
import { AGENT_RUNTIME_PROFILE } from "@sixb/cli-core"
import {
  type AgentApprovalCall,
  agent,
  type CommandResult,
  can,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  type RunCommandOptions,
  type Sandbox,
  SixbHost,
} from "@sixb/core"
import {
  createSubagentRunId,
  createSubagentThreadId,
  holdAgentApprovalCall,
} from "@sixb/core/internal/agents"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import type { LanguageModelRequest, LanguageModelStream } from "@sixb/core/models"
import type { AgentRunRecord, AgentStorage, SubagentRunRecord } from "@sixb/core/storage"
import { SubagentInbox } from "../../agent/src/subagent-inbox"
import { testStream, WorkerTestModel } from "../../agent/tests/worker-model-fixture"
import { AgentWorker } from "../src"

// A child asks its parent with ask_parent: the parent's wait_agent returns the question at once,
// and message_agent answers it while the child waits. When the parent's turn ends first, the child
// pauses on its question, and the next turn's message_agent continues it with the answer.

const projectId = "agent-child-questions"
const alice = { type: "user", id: "usr_alice" } as const

const HELD_COMMAND = "sixb actions request mark-paid --subject invoice:INV-2041"

const Invoice = defineObjectType({
  id: "invoice",
  name: "Invoice",
  properties: [prop("id", "string", { primary: true, required: true }), prop("status", "string")],
})

const markPaid = defineAction("mark-paid")
  .on(Invoice)
  .params({})
  .edits(({ objects, subject }) => {
    objects(Invoice).byId(subject.primaryId).update({ status: "paid" })
  })

const heldCall: AgentApprovalCall = {
  kind: "action",
  actionId: "mark-paid",
  subject: { kind: "object", objectTypeId: "invoice", primaryId: "INV-2041" },
  params: {},
  actionRunId: "act_mark_paid",
  effect: "ontology",
}

const agentUsers = defineGroup("agent-users")
const agentRunner = defineRole("agent.runner", {
  grantedTo: [agentUsers],
  grants: [can.run(agent), can.view(Invoice), can.apply(markPaid)],
})

const WEST = { key: "west", task: "Compare the western region's revenue." }
const QUESTION = "Calendar year or the April–March fiscal year?"
const ANSWER = "The April–March fiscal year."
const RESULT = "Western revenue grew 12% over the April–March fiscal year."

const spawnWest = {
  key: WEST.key,
  task: WEST.task,
  model: { provider: "child-provider", modelId: "child-model" },
}

/** Settles once a child asked its parent, its question then in the turn's mailbox. */
let asked = Promise.withResolvers<void>()

beforeEach(() => {
  asked = Promise.withResolvers<void>()
  const ask = SubagentInbox.prototype.ask
  // `ask` puts the question in the mailbox before its first await: it is there on return.
  spyOn(SubagentInbox.prototype, "ask").mockImplementation(function (this: SubagentInbox, ...args) {
    const reply = ask.apply(this, args)
    asked.resolve()
    return reply
  })
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

/**
 * A sandbox that is ready, runs every command without output, holds the call `HELD_COMMAND`
 * makes, and calls `onListOut` when a child lists its `out/`, as it does once it ends.
 */
class TestSandbox implements Sandbox {
  readonly provider = "test"
  readonly status = "running"
  readonly workingDirectory: string

  /** As a firewall adds credentials: the URL itself. */
  credentialedUrl(url: string): string {
    return url
  }

  constructor(
    readonly id: string,
    private readonly host: SixbHost,
    private readonly onListOut?: () => Promise<void>
  ) {
    this.workingDirectory = `/tmp/sixb-child-questions/${id}`
  }

  async writeFiles(): Promise<void> {}

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    const script = args.at(-1) ?? ""
    if (options.env?.SIXB_LIST_DIR?.endsWith("/out")) await this.onListOut?.()
    if (command !== "bash") return ok("")

    if (script === HELD_COMMAND) {
      await holdTheCall(this.host, String(options.env?.SIXB_RUN_ID))
      // Exit code 4: the call waits.
      return { exitCode: 4, stdout: "", stderr: "", durationMs: 1 }
    }
    if (script.includes("SIXB_BASH_ENV_READY")) return ok("node\t22.0.0\tsixb CLI 1\n")
    if (script === "sixb status") {
      return ok(
        JSON.stringify({
          ok: true,
          profile: AGENT_RUNTIME_PROFILE,
          cli: { version: "1" },
          javascript: { name: "node", version: "22.0.0" },
          project: { id: projectId },
        })
      )
    }
    return ok("")
  }

  async stop(): Promise<void> {}

  async destroy(): Promise<void> {}
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "", durationMs: 1 }
}

async function holdTheCall(host: SixbHost, runId: string): Promise<void> {
  const agents = requireAgents(host)
  const run = await agents.runs.getById({ projectId, id: runId })
  if (!run) throw new Error(`Expected run '${runId}'.`)
  const hold = await holdAgentApprovalCall(agents, {
    projectId,
    run,
    requestedBy: alice,
    call: heldCall,
  })
  if (hold.kind !== "held") throw new Error(`Expected the call to be held, got '${hold.kind}'.`)
}

function finish(finishReason: "stop" | "tool-calls") {
  return {
    type: "finish",
    finishReason,
    rawFinishReason: finishReason,
    usage: { inputTokens: 10, outputTokens: 5 },
  } as const
}

function toolCalls(...calls: readonly (readonly [string, string, unknown])[]) {
  return testStream([
    { type: "stream-start", warnings: [] },
    ...calls.map(([toolCallId, toolName, input]) => ({
      type: "tool-call" as const,
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    })),
    finish("tool-calls"),
  ])
}

function answer(text: string) {
  return testStream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: text },
    { type: "text-end", id: "answer" },
    finish("stop"),
  ])
}

type Script = (
  request: LanguageModelRequest,
  call: number
) => LanguageModelStream | Promise<LanguageModelStream>

/** The parent's model and West's, each scripted by the calls it receives, across turns. */
function setup(scripts: {
  readonly parent: Script
  readonly west: Script
  readonly onListOut?: () => Promise<void>
}) {
  const broker = new InMemoryBroker()
  const parentRequests: LanguageModelRequest[] = []
  const westRequests: LanguageModelRequest[] = []
  const parentModel = new WorkerTestModel({
    providerId: "parent-provider",
    modelId: "parent-model",
    stream: async (request) => {
      parentRequests.push(request)
      return scripts.parent(request, parentRequests.length)
    },
  })
  const childModel = new WorkerTestModel({
    providerId: "child-provider",
    modelId: "child-model",
    stream: async (request) => {
      if (!modelText(request).includes(WEST.task)) throw new Error("Expected West's task.")

      westRequests.push(request)
      return scripts.west(request, westRequests.length)
    },
  })
  let sandboxes = 0
  const host: SixbHost = new SixbHost({
    id: projectId,
    ontology: [Invoice],
    actions: [markPaid],
    groups: [agentUsers],
    roles: [agentRunner],
    broker,
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    sandboxes: {
      supportsRequestCredentials: true,
      create: async () => new TestSandbox(`sandbox-${++sandboxes}`, host, scripts.onListOut),
    },
    models: { language: [parentModel, childModel] },
  })
  const worker = new AgentWorker(host, {
    apiBaseUrl: "http://localhost:3002/api/",
  })
  return { host, broker, agents: requireAgents(host), worker, parentRequests, westRequests }
}

function requireAgents(host: SixbHost): AgentStorage {
  const agents = host.storage.agents
  if (!agents) throw new Error("Expected Agent storage.")
  return agents
}

async function signedIn(host: SixbHost) {
  const auth = host.storage.auth
  if (!auth) throw new Error("Expected auth storage.")
  if (!(await auth.users.getById({ projectId, id: alice.id }))) {
    await auth.users.create({ projectId, id: alice.id, email: "alice@example.com" })
    await auth.groupMemberships.upsert({
      projectId,
      userId: alice.id,
      groupId: agentUsers.id,
      source: "manual",
    })
  }
  const sessionId = `session-${crypto.randomUUID()}`
  await auth.sessions.create({
    projectId,
    id: sessionId,
    userId: alice.id,
    strategyId: "test",
    tokenHash: sessionId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60_000),
  })

  return bindRequestExecution(host, {
    request: new Request("http://localhost/test"),
    authorization: {
      type: "principal",
      credential: { type: "session", id: sessionId },
      context: {
        principal: alice,
        sessionId,
        groupIds: [agentUsers.id],
        roleIds: [agentRunner.id],
        grants: { ...emptyGrantIndex(), "run:agent": true },
      },
    },
  })
}

/** One turn of the event loop that fake timers do not hold. */
function realLoopTurn(): Promise<void> {
  const { port1, port2 } = new MessageChannel()
  return new Promise((resolve) => {
    port1.onmessage = () => {
      port1.close()
      port2.close()
      resolve()
    }
    port2.postMessage(null)
  })
}

/** Drive fake time, `wait_agent`'s polling included, until `check` holds. */
async function underFakeTime<T>(
  check: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  label: string
): Promise<T> {
  for (let step = 0; step < 2_000; step += 1) {
    await realLoopTurn()
    const value = await check()
    if (value !== null && value !== undefined && value !== false) return value
    jest.advanceTimersByTime(50)
  }
  throw new Error(`[test] ${label} did not settle under fake time.`)
}

async function settle<T>(promise: Promise<T>, label: string): Promise<T> {
  let outcome: { readonly value: T } | { readonly error: unknown } | undefined
  promise.then(
    (value) => {
      outcome = { value }
    },
    (error: unknown) => {
      outcome = { error }
    }
  )
  const settled = await underFakeTime(() => outcome, label)
  if ("error" in settled) throw settled.error
  return settled.value
}

async function terminal(agents: AgentStorage, runId: string): Promise<AgentRunRecord> {
  return underFakeTime(async () => {
    const run = await agents.runs.getById({ projectId, id: runId })
    return run && run.status !== "queued" && run.status !== "running" ? run : null
  }, `run ${runId} terminal`)
}

async function child(agents: AgentStorage, runId: string): Promise<SubagentRunRecord> {
  const run = await agents.runs.getById({ projectId, id: runId })
  if (run?.kind !== "subagent") throw new Error(`Expected child run '${runId}'.`)
  return run
}

function modelText(request: LanguageModelRequest | undefined): string {
  return JSON.stringify(request?.messages ?? [])
}

/** What a tool answered the model, by its call id, from the model's next request. */
function toolOutput(request: LanguageModelRequest | undefined, toolCallId: string): unknown {
  for (const message of request?.messages ?? []) {
    if (message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolCallId !== toolCallId) continue
      const output = part.output
      if (output.type === "json" || output.type === "error-json") return output.value
      try {
        return JSON.parse(output.value)
      } catch {
        return output.value
      }
    }
  }
  return undefined
}

function westRunId(request: LanguageModelRequest | undefined): string {
  const spawned = toolOutput(request, "spawn") as { readonly runId?: string } | undefined
  if (!spawned?.runId) throw new Error("Expected West's run id.")
  return spawned.runId
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** A mail id a run gave the mail of one of its tool calls: run, model call, tool call. */
function mailId(runId: string, toolCallId: string) {
  return expect.stringMatching(new RegExp(`^${escapeRegExp(runId)}:.+:${toolCallId}$`))
}

/** What a child run did, as its thread keeps it: every message of the run but its trigger. */
async function transcriptOf(harness: ReturnType<typeof setup>, runId: string) {
  const run = await child(harness.agents, runId)
  const { messages } = await harness.agents.messages.list({ projectId, threadId: run.threadId })
  return messages.filter(
    (message) => message.runId === run.id && message.id !== run.triggerMessageId
  )
}

/** Request a turn as Alice, in `threadId` when given, and run it until it ends. */
async function requestTurn(
  harness: ReturnType<typeof setup>,
  text: string,
  threadId?: string,
  approvalMode?: "manual"
) {
  const alicesSixb = await signedIn(harness.host)
  const { run } = await settle(
    alicesSixb.agent.runs.request({
      text,
      ...(threadId === undefined ? {} : { threadId }),
      ...(approvalMode === undefined ? {} : { approvalMode }),
    }),
    "request"
  )
  return { run, alicesSixb, finished: await terminal(harness.agents, run.id) }
}

/** Resolves once West asked, before the parent reads it. */
function westAsked(): Promise<void> {
  return asked.promise
}

/** A parent that spawns West, waits for its question and answers the user with it. */
function asksTheUser(request: LanguageModelRequest, call: number) {
  if (call === 1) return toolCalls(["spawn", "spawn_agent", spawnWest])
  if (call === 2) return toolCalls(["wait", "wait_agent", { runIds: [westRunId(request)] }])
  return answer(`West asks: ${QUESTION}`)
}

describe("a child's question", () => {
  // Removal proof: drop `this.#questions.listen()` from SubagentCoordinator.admit; nothing wakes
  // wait_agent, which waits for the deadline margin and the turn never gets to answer.
  test("returns the parent's wait at once, and its answer reaches the child in the same run", async () => {
    const harness = setup({
      parent: (request, call) => {
        if (call === 1) return toolCalls(["spawn", "spawn_agent", spawnWest])
        if (call === 2) return toolCalls(["wait", "wait_agent", { runIds: [westRunId(request)] }])
        if (call === 3) {
          return toolCalls(["answer", "message_agent", { key: WEST.key, text: ANSWER }])
        }
        if (call === 4) {
          const westId = westRunId(harness.parentRequests[1])
          return toolCalls(["wait-again", "wait_agent", { runIds: [westId] }])
        }
        return answer(RESULT)
      },
      west: (_request, call) =>
        call === 1 ? toolCalls(["ask", "ask_parent", { question: QUESTION }]) : answer(RESULT),
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, finished } = await requestTurn(harness, "How did the west do this year?")
      const west = await child(harness.agents, createSubagentRunId(run.id, WEST.key))
      const question = { id: mailId(west.id, "ask"), text: QUESTION }

      expect(finished).toMatchObject({ status: "succeeded", finishReason: "stop" })
      expect(toolOutput(harness.parentRequests[2], "wait")).toEqual({
        results: [{ runId: west.id, status: "running", question }],
        questions: [{ key: WEST.key, runId: west.id, ...question }],
      })
      expect(toolOutput(harness.parentRequests[3], "answer")).toEqual({
        runId: west.id,
        status: "running",
        delivery: "answer",
      })
      // The child's call returned the answer, and its result uses it.
      expect(toolOutput(harness.westRequests[1], "ask")).toEqual({ answer: ANSWER })
      expect(harness.westRequests).toHaveLength(2)
      expect(toolOutput(harness.parentRequests[4], "wait-again")).toEqual({
        results: [{ runId: west.id, status: "succeeded", text: RESULT }],
      })
      expect(west).toMatchObject({ status: "succeeded", result: { text: RESULT } })
      // Answered in its turn: its thread has one run, never a continuation.
      expect((await harness.agents.runs.list({ projectId, threadId: west.threadId })).total).toBe(1)
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: drop the `#asking` check from SubagentInbox.ask; both questions go out, the
  // parent answers the one it lists, and the other waits until the test gives up.
  test("is one at a time: a second one asked with it is refused", async () => {
    const harness = setup({
      parent: (request, call) => {
        if (call === 1) return toolCalls(["spawn", "spawn_agent", spawnWest])
        if (call === 2) return toolCalls(["wait", "wait_agent", { runIds: [westRunId(request)] }])
        if (call === 3) {
          return toolCalls(["answer", "message_agent", { key: WEST.key, text: ANSWER }])
        }
        if (call === 4) {
          const westId = westRunId(harness.parentRequests[1])
          return toolCalls(["wait-again", "wait_agent", { runIds: [westId] }])
        }
        return answer(RESULT)
      },
      west: (_request, call) =>
        call === 1
          ? toolCalls(
              ["ask", "ask_parent", { question: QUESTION }],
              ["ask-too", "ask_parent", { question: "Which currency?" }]
            )
          : answer(RESULT),
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { finished } = await requestTurn(harness, "How did the west do this year?")
      const replies = [
        toolOutput(harness.westRequests[1], "ask"),
        toolOutput(harness.westRequests[1], "ask-too"),
      ]

      expect(finished).toMatchObject({ status: "succeeded" })
      expect(replies).toContainEqual({ answer: ANSWER })
      expect(replies).toContainEqual(
        "[SixbAgent] Ask one question at a time: your parent has not answered the last one yet."
      )
      const waited = toolOutput(harness.parentRequests[2], "wait") as {
        readonly questions: readonly unknown[]
      }
      expect(waited.questions).toHaveLength(1)
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })
})

describe("a question its parent's turn ends on", () => {
  // Removal proofs: skip `deferOpenQuestions` in the worker, and West is cancelled with the turn
  // instead of pausing; drop the deferred check from runSubagent's `pauseAfterStep`, and West
  // answers instead of pausing; drop the `isAwaitingAnswer` continuation from message_agent, and the next turn's
  // answer is refused as a child of an earlier turn; drop the answer from `continuationMessage`, and
  // the continuation never reads it; drop the reply check from SubagentInbox's `unread`, and the
  // continuation reads the paused child's deferred notice again as a message; drop the waiting
  // note from `turnQuestions`, and the next turn is not told West waits.
  test("pauses the child on it, and the next turn's answer continues it with its work", async () => {
    const harness = setup({
      parent: (request, call) => {
        // The first turn cannot answer: it asks the user and ends.
        if (call === 1) return toolCalls(["spawn", "spawn_agent", spawnWest])
        if (call === 2) return toolCalls(["wait", "wait_agent", { runIds: [westRunId(request)] }])
        if (call === 3) return answer(`West asks: ${QUESTION}`)

        // The next one relays the user's answer.
        const westId = westRunId(harness.parentRequests[1])
        if (call === 4) return toolCalls(["paused", "wait_agent", { runIds: [westId] }])
        if (call === 5) {
          return toolCalls(["answer", "message_agent", { key: WEST.key, text: ANSWER }])
        }
        if (call === 6) return toolCalls(["wait-again", "wait_agent", { runIds: [westId] }])
        return answer(RESULT)
      },
      west: (_request, call) => {
        if (call === 1) return toolCalls(["look", "bash", { command: "ls revenue" }])
        if (call === 2) return toolCalls(["ask", "ask_parent", { question: QUESTION }])
        return answer(RESULT)
      },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const first = await requestTurn(harness, "How did the west do this year?")
      const paused = await child(harness.agents, createSubagentRunId(first.run.id, WEST.key))
      const question = { id: mailId(paused.id, "ask"), text: QUESTION }

      expect(first.finished).toMatchObject({ status: "succeeded", finishReason: "stop" })
      expect(paused).toMatchObject({
        status: "succeeded",
        finishReason: "awaiting_answer",
        result: { text: "" },
      })
      // Its transcript keeps its work and the question it paused on.
      const calls = (await transcriptOf(harness, paused.id)).flatMap((message) =>
        message.parts.filter((part) => part.type === "tool-call")
      )
      expect(calls).toMatchObject([
        { toolCallId: "look", toolName: "bash" },
        {
          toolCallId: "ask",
          toolName: "ask_parent",
          input: { question: QUESTION },
          output: { status: "deferred", question: question.id },
        },
      ])

      const next = await requestTurn(harness, ANSWER, first.run.threadId)
      const continued = await child(harness.agents, createSubagentRunId(next.run.id, WEST.key))

      expect(next.finished).toMatchObject({ status: "succeeded", finishReason: "stop" })
      // The next turn reads that West waits on its question, and its answer continues it.
      expect(modelText(harness.parentRequests[3])).toContain("<sixb_waiting_children>")
      expect(modelText(harness.parentRequests[3])).toContain(`- west asks: ${QUESTION}`)
      expect(toolOutput(harness.parentRequests[4], "paused")).toEqual({
        results: [{ runId: paused.id, status: "awaiting_answer", question }],
      })
      expect(toolOutput(harness.parentRequests[5], "answer")).toEqual({
        runId: continued.id,
        status: "queued",
        delivery: "answer",
        continues: paused.id,
      })
      expect(continued).toMatchObject({
        parentRunId: next.run.id,
        spawnKey: WEST.key,
        threadId: paused.threadId,
        status: "succeeded",
        result: { text: RESULT },
      })
      expect(toolOutput(harness.parentRequests[6], "wait-again")).toEqual({
        results: [{ runId: paused.id, status: "succeeded", text: RESULT }],
      })

      // It starts from the paused child's last request and reads the answer first.
      const [last, resumed] = harness.westRequests.slice(1)
      const lastMessages = last?.messages ?? []
      expect(resumed?.messages.slice(0, lastMessages.length + 2)).toEqual([
        ...lastMessages,
        expect.objectContaining({ role: "assistant" }),
        expect.objectContaining({ role: "tool" }),
      ])
      const asked = (
        toolOutput(harness.parentRequests[4], "paused") as {
          readonly results: readonly { readonly question: { readonly id: string } }[]
        }
      ).results[0]?.question.id
      expect(JSON.stringify(resumed?.messages.at(-1))).toMatch(
        new RegExp(
          `<sixb_parent_answer id=\\\\"${escapeRegExp(next.run.id)}:[^"]+:answer\\\\" question=\\\\"${escapeRegExp(asked ?? "")}\\\\">${ANSWER}</sixb_parent_answer>`
        )
      )
      // What its parent's turn told the paused child is a reply, never a message to read again.
      expect(modelText(resumed)).not.toContain("<sixb_parent_message id=")
      expect(harness.westRequests).toHaveLength(3)
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: await the reply without `waitForAbort` in SubagentInbox.ask; West never sees
  // the cancel and stays running.
  test("stops the child with it when the turn is cancelled, its question in its transcript", async () => {
    const harness = setup({
      parent: async (request, call) => {
        if (call === 1) return toolCalls(["spawn", "spawn_agent", spawnWest])
        if (call === 2) return toolCalls(["wait", "wait_agent", { runIds: [westRunId(request)] }])

        // The user stops the turn while West waits on its question.
        const { parentRunId } = await child(harness.agents, westRunId(harness.parentRequests[1]))
        await (await signedIn(harness.host)).agent.runs.cancel(parentRunId)
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve()
          request.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        return answer("Stopped.")
      },
      west: () => toolCalls(["ask", "ask_parent", { question: QUESTION }]),
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, finished } = await requestTurn(harness, "How did the west do this year?")
      const west = await terminal(harness.agents, createSubagentRunId(run.id, WEST.key))

      expect(finished).toMatchObject({ status: "cancelled" })
      expect(west).toMatchObject({ status: "cancelled" })
      expect(JSON.stringify(await transcriptOf(harness, west.id))).toContain(QUESTION)
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })
})

describe("a turn that ends while a child waits on its question", () => {
  // Removal proof: drop the `defer` call from runAgentTurn's finalize; the turn, paused on its own
  // call, waits for West, which waits for it, until the test gives up.
  test("pauses the child before it pauses on its own held call", async () => {
    const harness = setup({
      parent: (request, call) => {
        if (call === 1) return toolCalls(["spawn", "spawn_agent", spawnWest])
        if (call === 2) return toolCalls(["wait", "wait_agent", { runIds: [westRunId(request)] }])
        return toolCalls(["held", "bash", { command: HELD_COMMAND }])
      },
      west: () => toolCalls(["ask", "ask_parent", { question: QUESTION }]),
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, finished } = await requestTurn(harness, "Pay INV-2041.", undefined, "manual")
      const west = await child(harness.agents, createSubagentRunId(run.id, WEST.key))

      expect(finished).toMatchObject({ status: "succeeded", finishReason: "awaiting_approval" })
      expect(west).toMatchObject({ status: "succeeded", finishReason: "awaiting_answer" })
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proofs: return from `deferOpenQuestions` once the notices are sent, without waiting
  // for the children; the turn ends first and the repair pass, which runs while West stores its
  // files, cancels it. Drop the wake from its wait, and the turn ends at its next re-check, seconds
  // after West paused.
  test("ends only once the child paused, so the repair pass leaves it alone", async () => {
    const harness = setup({
      parent: asksTheUser,
      west: () => toolCalls(["ask", "ask_parent", { question: QUESTION }]),
      // West's end takes longer than the repair interval (30 s).
      onListOut: () => new Promise((resolve) => setTimeout(resolve, 31_000)),
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, finished } = await requestTurn(harness, "How did the west do this year?")
      const west = await terminal(harness.agents, createSubagentRunId(run.id, WEST.key))

      expect(finished).toMatchObject({ status: "succeeded" })
      expect(west).toMatchObject({ status: "succeeded", finishReason: "awaiting_answer" })
      // West's pause woke the turn's wait: it ended at once, not at its next re-check.
      const endedAfterWest = Number(finished.completedAt) - Number(west.completedAt)
      expect(endedAfterWest).toBeLessThan(1_000)
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: drop `beforeComplete` from runAgentTurn's loop; the Agent ends on its first
  // answer, and the user never reads West's question.
  test("shows the Agent a question it never waited for, before its answer ends the turn", async () => {
    const harness = setup({
      parent: async (_request, call) => {
        if (call === 1) return toolCalls(["spawn", "spawn_agent", spawnWest])
        if (call === 2) {
          await westAsked()
          return answer("West is comparing the regions.")
        }
        return answer(`West asks: ${QUESTION}`)
      },
      west: () => toolCalls(["ask", "ask_parent", { question: QUESTION }]),
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, finished } = await requestTurn(harness, "How did the west do this year?")
      const west = await child(harness.agents, createSubagentRunId(run.id, WEST.key))

      expect(finished).toMatchObject({ status: "succeeded" })
      expect(harness.parentRequests).toHaveLength(3)
      expect(modelText(harness.parentRequests[2])).toContain("<sixb_child_questions>")
      expect(modelText(harness.parentRequests[2])).toContain(`- west asks: ${QUESTION}`)
      expect(west).toMatchObject({ finishReason: "awaiting_answer" })
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: drop the `#reported` check from message_agent's answer; the steering message
  // becomes the answer to a question the Agent never read.
  test("is answered only by a message sent once the Agent read it", async () => {
    const STEER = "Leave out the Seattle office."
    const harness = setup({
      parent: async (_request, call) => {
        if (call === 1) return toolCalls(["spawn", "spawn_agent", spawnWest])
        if (call === 2) {
          await westAsked()
          return toolCalls(["steer", "message_agent", { key: WEST.key, text: STEER }])
        }
        const westId = westRunId(harness.parentRequests[1])
        if (call === 3) return toolCalls(["wait", "wait_agent", { runIds: [westId] }])
        if (call === 4) {
          return toolCalls(["answer", "message_agent", { key: WEST.key, text: ANSWER }])
        }
        if (call === 5) return toolCalls(["wait-again", "wait_agent", { runIds: [westId] }])
        return answer(RESULT)
      },
      west: (_request, call) =>
        call === 1 ? toolCalls(["ask", "ask_parent", { question: QUESTION }]) : answer(RESULT),
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      await requestTurn(harness, "How did the west do this year?")

      expect(toolOutput(harness.parentRequests[2], "steer")).toMatchObject({
        delivery: "next-step",
      })
      expect(toolOutput(harness.parentRequests[4], "answer")).toMatchObject({ delivery: "answer" })
      expect(toolOutput(harness.westRequests[1], "ask")).toEqual({ answer: ANSWER })
      expect(modelText(harness.westRequests[1])).toContain(STEER)
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: publish the answer before claiming the question in message_agent; both
  // messages are told they answered it.
  test("is answered once when two answers are sent at once", async () => {
    const harness = setup({
      parent: (request, call) => {
        if (call === 1) return toolCalls(["spawn", "spawn_agent", spawnWest])
        if (call === 2) return toolCalls(["wait", "wait_agent", { runIds: [westRunId(request)] }])
        if (call === 3) {
          return toolCalls(
            ["answer", "message_agent", { key: WEST.key, text: ANSWER }],
            ["answer-too", "message_agent", { key: WEST.key, text: "The calendar year." }]
          )
        }
        const westId = westRunId(harness.parentRequests[1])
        if (call === 4) return toolCalls(["wait-again", "wait_agent", { runIds: [westId] }])
        return answer(RESULT)
      },
      west: (_request, call) =>
        call === 1 ? toolCalls(["ask", "ask_parent", { question: QUESTION }]) : answer(RESULT),
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      await requestTurn(harness, "How did the west do this year?")
      const deliveries = ["answer", "answer-too"].map(
        (id) =>
          (toolOutput(harness.parentRequests[3], id) as { readonly delivery: string }).delivery
      )

      expect(deliveries.sort()).toEqual(["answer", "next-step"])
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: drop `unansweredQuestion` from settleSubagent; West's transcript still says
  // an answer comes, and its continuation reads that promise.
  test("with a held call in the same step, the decision continues the child without an answer", async () => {
    const harness = setup({
      parent: (request, call) => {
        if (call <= 3) return asksTheUser(request, call)
        const westId = westRunId(harness.parentRequests[1])
        if (call === 4) return toolCalls(["wait-again", "wait_agent", { runIds: [westId] }])
        return answer(RESULT)
      },
      west: (_request, call) =>
        call === 1
          ? toolCalls(
              ["ask", "ask_parent", { question: QUESTION }],
              ["held", "bash", { command: HELD_COMMAND }]
            )
          : answer(RESULT),
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const first = await requestTurn(harness, "Pay INV-2041.", undefined, "manual")
      const west = await child(harness.agents, createSubagentRunId(first.run.id, WEST.key))
      const calls = (await transcriptOf(harness, west.id)).flatMap((message) =>
        message.parts.filter((part) => part.type === "tool-call")
      )

      expect(first.finished).toMatchObject({ finishReason: "awaiting_approval" })
      expect(west).toMatchObject({ finishReason: "awaiting_approval" })
      expect(calls).toContainEqual(
        expect.objectContaining({
          toolCallId: "ask",
          output: expect.objectContaining({ status: "unanswered" }),
        })
      )

      const [held] = (await first.alicesSixb.agent.approvals.list({ threadId: first.run.threadId }))
        .approvals
      if (!held) throw new Error("Expected West's held call.")
      const decided = await settle(
        first.alicesSixb.agent.approvals.decide(held.id, { decision: "approve" }),
        "decide"
      )
      if (!decided.run) throw new Error("Expected the turn to resume.")
      await terminal(harness.agents, decided.run.id)

      expect(modelText(harness.westRequests[1])).toContain("without an answer. Ask again")
      expect(modelText(harness.westRequests[1])).not.toContain("You continue with its answer")
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })
})

describe("a child paused on its question, in a later turn", () => {
  // Removal proof: return the latest run of the key's thread from `pausedOnQuestion`, without
  // passing a failed continuation; the third turn's answer is refused.
  test("is not hidden by a continuation that failed", async () => {
    const harness = setup({
      parent: (request, call) => {
        if (call <= 3) return asksTheUser(request, call)
        // Each later turn answers West and waits for it.
        if (call === 4 || call === 7) {
          return toolCalls(["answer", "message_agent", { key: WEST.key, text: ANSWER }])
        }
        const westId = westRunId(harness.parentRequests[1])
        if (call === 5 || call === 8) {
          return toolCalls(["wait-again", "wait_agent", { runIds: [westId] }])
        }
        return answer(RESULT)
      },
      west: (_request, call) => {
        if (call === 1) return toolCalls(["ask", "ask_parent", { question: QUESTION }])
        if (call === 2) throw new Error("[test] The provider is down.")
        return answer(RESULT)
      },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const first = await requestTurn(harness, "How did the west do this year?")
      const paused = createSubagentRunId(first.run.id, WEST.key)
      const second = await requestTurn(harness, ANSWER, first.run.threadId)
      const failed = await child(harness.agents, createSubagentRunId(second.run.id, WEST.key))
      const third = await requestTurn(harness, "Try again.", first.run.threadId)

      expect(failed).toMatchObject({
        status: "failed",
        threadId: createSubagentThreadId(first.run.id, WEST.key),
      })
      expect(toolOutput(harness.parentRequests[7], "answer")).toMatchObject({
        delivery: "answer",
        continues: paused,
      })
      expect(
        await child(harness.agents, createSubagentRunId(third.run.id, WEST.key))
      ).toMatchObject({ status: "succeeded", result: { text: RESULT } })
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: find it among the latest 20 turns only, as before `listThreadSubagents`; the
  // answer 21 turns later is refused, and that turn is not told West waits.
  test("is found however many turns ago it paused", async () => {
    const LATER_TURNS = 21
    const harness = setup({
      parent: (request, call) => {
        if (call <= 3) return asksTheUser(request, call)
        if (call <= 3 + LATER_TURNS) return answer("Noted.")
        if (call === 4 + LATER_TURNS) {
          return toolCalls(["answer", "message_agent", { key: WEST.key, text: ANSWER }])
        }
        const westId = westRunId(harness.parentRequests[1])
        if (call === 5 + LATER_TURNS) {
          return toolCalls(["wait-again", "wait_agent", { runIds: [westId] }])
        }
        return answer(RESULT)
      },
      west: (_request, call) =>
        call === 1 ? toolCalls(["ask", "ask_parent", { question: QUESTION }]) : answer(RESULT),
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const first = await requestTurn(harness, "How did the west do this year?")
      for (let turn = 0; turn < LATER_TURNS; turn += 1) {
        await requestTurn(harness, "Something else.", first.run.threadId)
      }
      await requestTurn(harness, ANSWER, first.run.threadId)

      expect(modelText(harness.parentRequests[3 + LATER_TURNS])).toContain(
        `- west asks: ${QUESTION}`
      )
      expect(toolOutput(harness.parentRequests[4 + LATER_TURNS], "answer")).toMatchObject({
        delivery: "answer",
        continues: createSubagentRunId(first.run.id, WEST.key),
      })
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: drop the check for this turn's continuation in `answerPaused`; the second
  // answer fails as a key used with other inputs.
  test("takes one answer: a second sent with it is refused, and says why", async () => {
    const harness = setup({
      parent: (request, call) => {
        if (call <= 3) return asksTheUser(request, call)
        if (call === 4) {
          return toolCalls(
            ["answer", "message_agent", { key: WEST.key, text: ANSWER }],
            ["answer-too", "message_agent", { key: WEST.key, text: "The calendar year." }]
          )
        }
        const westId = westRunId(harness.parentRequests[1])
        if (call === 5) return toolCalls(["wait-again", "wait_agent", { runIds: [westId] }])
        return answer(RESULT)
      },
      west: (_request, call) =>
        call === 1 ? toolCalls(["ask", "ask_parent", { question: QUESTION }]) : answer(RESULT),
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const first = await requestTurn(harness, "How did the west do this year?")
      await requestTurn(harness, ANSWER, first.run.threadId)
      const replies = ["answer", "answer-too"].map((id) =>
        toolOutput(harness.parentRequests[4], id)
      )

      expect(replies).toContainEqual(expect.objectContaining({ delivery: "answer" }))
      expect(replies).toContainEqual(
        "[SixbAgent] 'west' already continues with the answer you sent it this turn. Message it again once it is at work, or wait for it with wait_agent."
      )
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })
})
