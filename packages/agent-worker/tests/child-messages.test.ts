import { afterEach, describe, expect, jest, test } from "bun:test"
import { AGENT_RUNTIME_PROFILE } from "@sixb/cli-core"
import {
  type AgentApprovalCall,
  type AgentMessage,
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
  agentThreadInboxStreamId,
  createSubagentRunId,
  holdAgentApprovalCall,
} from "@sixb/core/internal/agents"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import type { LanguageModelRequest, LanguageModelStream } from "@sixb/core/models"
import type { AgentRunRecord, AgentStorage, SubagentRunRecord } from "@sixb/core/storage"
import { createTestSixb } from "@sixb/core/testing"
import { testStream, WorkerTestModel } from "../../agent/tests/worker-model-fixture"
import { AgentWorker } from "../src"

// The parent steers a child at work with message_agent: the child reads the message before its
// next step, or in one more step when it arrives as the child answers, and both keep it.

const projectId = "agent-child-messages"
const alice = { type: "user", id: "usr_alice" } as const
const HELD_COMMAND = "sixb actions request mark-paid --subject invoice:INV-2041"
const STEER = "Skip Globex; focus on payment terms."

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

const agentUsers = defineGroup("agent-users")
const agentRunner = defineRole("agent.runner", {
  grantedTo: [agentUsers],
  grants: [can.run(agent), can.view(Invoice), can.apply(markPaid)],
})

const heldCall: AgentApprovalCall = {
  kind: "action",
  actionId: "mark-paid",
  subject: { kind: "object", objectTypeId: "invoice", primaryId: "INV-2041" },
  params: {},
  actionRunId: "act_mark_paid",
  effect: "ontology",
}

const COMPARE = { key: "compare-suppliers", task: "Compare the suppliers' offers." }
const COLLECT = { key: "collect", task: "List the open invoices." }

function spawn(child: typeof COMPARE) {
  return {
    key: child.key,
    task: child.task,
    model: { provider: "child-provider", modelId: "child-model" },
  }
}

/** What the held command waits for once it filed its call, when a test needs that moment. */
let afterHold: (() => Promise<void>) | undefined

afterEach(() => {
  afterHold = undefined
  jest.useRealTimers()
})

/** A sandbox that is ready, has no files, and holds the one call that waits for approval. */
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
    private readonly host: SixbHost
  ) {
    this.workingDirectory = `/tmp/sixb-child-messages/${id}`
  }

  async writeFiles(): Promise<void> {}

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    const script = args.at(-1) ?? ""
    if (command !== "bash") return ok("")

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
    if (script === HELD_COMMAND) {
      await holdTheCall(this.host, String(options.env?.SIXB_RUN_ID))
      await afterHold?.()
      // Exit code 4: the call waits.
      return { exitCode: 4, stdout: "", stderr: "", durationMs: 1 }
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

/** A promise the test resolves once, from wherever the moment it names happens. */
function moment() {
  let reached!: () => void
  const promise = new Promise<void>((resolve) => {
    reached = resolve
  })
  return { promise, reached }
}

/** The parent's model and the children's, each scripted by the calls it receives. */
function setup(scripts: {
  readonly parent: Script
  readonly children: Readonly<Record<string, Script>>
}) {
  const broker = new InMemoryBroker()
  const parentRequests: LanguageModelRequest[] = []
  const childRequests = new Map<string, LanguageModelRequest[]>()
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
      const text = modelText(request)
      const task = [COMPARE, COLLECT].find((child) => text.includes(child.task))?.key
      // A continuation reads how its calls ended.
      const key = task && text.includes("<sixb_approval id=") ? `${task}'` : task
      const script = key === undefined ? undefined : scripts.children[key]
      if (!key || !script) throw new Error(`Expected a scripted child, got '${key}'.`)

      const requests = childRequests.get(key) ?? []
      requests.push(request)
      childRequests.set(key, requests)
      return script(request, requests.length)
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
      create: async () => new TestSandbox(`sandbox-${++sandboxes}`, host),
    },
    models: { language: [parentModel, childModel] },
  })
  const worker = new AgentWorker(host, {
    apiBaseUrl: "http://localhost:3002/api/",
    defaultMaxSteps: 6,
  })
  return {
    host,
    broker,
    agents: requireAgents(host),
    worker,
    parentRequests,
    childRequests: (key: string) => childRequests.get(key) ?? [],
  }
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

/** What wait_agent answered in a turn, as the thread keeps it. */
async function storedWait(agents: AgentStorage, threadId: string, toolCallId: string) {
  const { messages } = await agents.messages.list({ projectId, threadId })
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-call" || part.toolCallId !== toolCallId) continue
      if (part.state !== "output-available") throw new Error(`Expected '${toolCallId}' to answer.`)
      const output = part.output as { readonly content?: readonly { readonly text?: string }[] }
      return JSON.parse(output.content?.[0]?.text ?? "null")
    }
  }
  throw new Error(`Expected the tool call '${toolCallId}'.`)
}

function spawnedRunId(request: LanguageModelRequest): string {
  const spawned = toolOutput(request, "spawn") as { readonly runId?: string } | undefined
  if (!spawned?.runId) throw new Error("Expected the spawned child's run id.")
  return spawned.runId
}

/** Request a turn as Alice, in a new thread or after the last one, and run it until it ends. */
async function requestTurn(harness: ReturnType<typeof setup>, threadId?: string) {
  const alicesSixb = await signedIn(harness.host)
  const { run } = await settle(
    alicesSixb.agent.runs.request({
      text: threadId ? "And the payment terms?" : "Compare our suppliers and pay INV-2041.",
      approvalMode: "manual",
      ...(threadId === undefined ? {} : { threadId }),
    }),
    "request"
  )
  return { run, finished: await terminal(harness.agents, run.id), alicesSixb }
}

/** What a child run did, as its thread keeps it: every message of the run but its trigger. */
async function transcriptOf(
  harness: ReturnType<typeof setup>,
  runId: string
): Promise<readonly AgentMessage[]> {
  const run = await child(harness.agents, runId)
  const { messages } = await harness.agents.messages.list({ projectId, threadId: run.threadId })
  return messages
    .filter((message) => message.runId === run.id && message.id !== run.triggerMessageId)
    .map(({ role, parts }) => ({ role, parts }))
}

function mailParts(transcript: readonly AgentMessage[] | null) {
  return (transcript ?? []).flatMap((message) =>
    message.parts.filter((part) => part.type === "mail")
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** A mail id this turn gave the message of one of its tool calls. */
function mailId(parentRunId: string, toolCallId = "steer") {
  return expect.stringMatching(new RegExp(`^${escapeRegExp(parentRunId)}:.+:${toolCallId}$`))
}

/** Whether a request holds the parent's message, as the child's model reads it. */
function readsMessage(
  request: LanguageModelRequest | undefined,
  parentRunId: string,
  text = STEER,
  toolCallId = "steer"
): boolean {
  // The messages as JSON, where each quote is escaped.
  const block = `<sixb_parent_message id=\\\\"${escapeRegExp(parentRunId)}:[^"\\\\]+:${toolCallId}\\\\">${escapeRegExp(text)}</sixb_parent_message>`
  return new RegExp(block).test(modelText(request))
}

/**
 * The parent spawns Compare, tells it to skip Globex once its first model call is under way, and
 * waits for it. Compare's first call ends with `firstStep`, once the message was sent.
 */
function steeredMidWork(input: {
  readonly firstStep: () => LanguageModelStream
  readonly secondStep?: Script
  readonly afterSent?: (harness: ReturnType<typeof setup>, childRunId: string) => Promise<void>
}) {
  const childAtWork = moment()
  const sent = moment()
  const harness = setup({
    parent: async (request, call) => {
      if (call === 1) return toolCalls(["spawn", "spawn_agent", spawn(COMPARE)])
      if (call === 2) {
        await childAtWork.promise
        return toolCalls(["steer", "message_agent", { key: COMPARE.key, text: STEER }])
      }
      if (call === 3) {
        const childRunId = spawnedRunId(harness.parentRequests[1] ?? request)
        await input.afterSent?.(harness, childRunId)
        sent.reached()
        return toolCalls(["wait", "wait_agent", { runIds: [childRunId] }])
      }
      return answer("Payment terms compared.")
    },
    children: {
      [COMPARE.key]: async (request, call) => {
        if (call > 1) {
          return (
            input.secondStep?.(request, call) ?? answer("Compared payment terms, without Globex.")
          )
        }

        childAtWork.reached()
        await sent.promise
        return input.firstStep()
      },
    },
  })
  return harness
}

describe("a message to a child at work", () => {
  // Removal proof: drop the inbox read from runSubagent's prepareStep; the child's second request
  // holds no message, and it reads it only after it answered, in a third step.
  test("is read before its next step", async () => {
    const harness = steeredMidWork({
      firstStep: () => toolCalls(["look", "bash", { command: "ls offers" }]),
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run } = await requestTurn(harness)
      const compare = await child(harness.agents, createSubagentRunId(run.id, COMPARE.key))

      expect(toolOutput(harness.parentRequests[2], "steer")).toEqual({
        runId: compare.id,
        status: "running",
        delivery: "next-step",
      })
      expect(modelText(harness.childRequests(COMPARE.key)[0])).not.toContain(
        "<sixb_parent_message id="
      )
      expect(readsMessage(harness.childRequests(COMPARE.key)[1], run.id)).toBe(true)
      expect(harness.childRequests(COMPARE.key)).toHaveLength(2)
      expect(toolOutput(harness.parentRequests[3], "wait")).toMatchObject({
        results: [{ status: "succeeded", text: "Compared payment terms, without Globex." }],
      })
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proofs: drop `beforeComplete` from runSubagent; the child ends on its first answer,
  // which wait_agent returns with the message as unread. Drop `afterAnswer` from the inbox's take;
  // the child is not told to answer again in full.
  test("adds a step when it arrives as the child answers, which writes its result again", async () => {
    const harness = steeredMidWork({ firstStep: () => answer("Globex is cheapest.") })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run } = await requestTurn(harness)
      const second = harness.childRequests(COMPARE.key)[1]

      expect(harness.childRequests(COMPARE.key)).toHaveLength(2)
      expect(readsMessage(second, run.id)).toBe(true)
      // Its first answer is in its history, before the message, and it is told to write it again.
      expect(modelText(second)).toContain("Globex is cheapest.")
      expect(modelText(second)).toContain("Write your complete result again")
      expect(toolOutput(harness.parentRequests[3], "wait")).toMatchObject({
        results: [
          {
            text: "Compared payment terms, without Globex.",
            earlierAnswer: "Globex is cheapest.",
          },
        ],
      })
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: drop `answerBeforeLateMessage` from wait_agent; the parent gets the addendum
  // alone, and the comparison it amends is gone.
  test("never loses the answer it amends: an addendum comes with the answer before it", async () => {
    const full = "Acme: 30 days, 2% early. Globex: 60 days. Recommend Acme."
    const harness = steeredMidWork({
      firstStep: () => answer(full),
      secondStep: () => answer("Noted: the budget changes nothing."),
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      await requestTurn(harness)

      expect(toolOutput(harness.parentRequests[3], "wait")).toMatchObject({
        results: [{ text: "Noted: the budget changes nothing.", earlierAnswer: full }],
      })
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: drop the answerNote branch of `answerBeforeLateMessage`; the parent reads the
  // answer before its message as if it accounted for it.
  test("says so when the child did not answer again after it", async () => {
    const harness = steeredMidWork({
      firstStep: () => answer("Globex is cheapest."),
      secondStep: () => answer(" "),
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      await requestTurn(harness)

      expect(toolOutput(harness.parentRequests[3], "wait")).toMatchObject({
        results: [
          {
            text: "Globex is cheapest.",
            answerNote:
              "It wrote this answer before your last message came, and did not answer again after reading it.",
          },
        ],
      })
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: build the child's work from its steps alone, without its deliveries; its
  // agent-message part is gone.
  test("is kept by both: the parent's call in its thread, the child's reading in the child's", async () => {
    const harness = steeredMidWork({
      firstStep: () => toolCalls(["look", "bash", { command: "ls offers" }]),
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run } = await requestTurn(harness)
      const compare = await child(harness.agents, createSubagentRunId(run.id, COMPARE.key))
      const { messages } = await harness.agents.messages.list({
        projectId,
        threadId: run.threadId,
      })
      const steer = messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool-call" && part.toolCallId === "steer")

      expect(steer).toMatchObject({
        toolName: "message_agent",
        input: { key: COMPARE.key, text: STEER },
        state: "output-available",
        output: { runId: compare.id, status: "running", delivery: "next-step" },
      })
      expect(await transcriptOf(harness, compare.id)).toEqual([
        {
          role: "assistant",
          parts: expect.arrayContaining([expect.objectContaining({ toolCallId: "look" })]),
        },
        {
          role: "user",
          parts: [
            {
              type: "mail",
              id: mailId(run.id),
              from: "parent",
              kind: "message",
              text: STEER,
            },
          ],
        },
        {
          role: "assistant",
          parts: expect.arrayContaining([
            expect.objectContaining({ text: "Compared payment terms, without Globex." }),
          ]),
        },
      ])
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: drop the read-id check from SubagentInbox.take; the child reads the message
  // twice, in one block each.
  test("is read once, however often the broker delivers it", async () => {
    const harness = steeredMidWork({
      firstStep: () => toolCalls(["look", "bash", { command: "ls offers" }]),
      // What a redelivery past the broker's dedupe window does: the same record, written again.
      afterSent: async ({ agents, broker }, childRunId) => {
        const streamId = agentThreadInboxStreamId((await child(agents, childRunId)).threadId)
        const { records } = await broker.read({ projectId, streamId })
        await broker.append({
          projectId,
          streamId,
          records: records.map((record) => ({ name: record.name, payload: record.payload })),
        })
      },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run } = await requestTurn(harness)
      const compare = await child(harness.agents, createSubagentRunId(run.id, COMPARE.key))

      expect(
        modelText(harness.childRequests(COMPARE.key)[1]).split("<sixb_parent_message id=").length -
          1
      ).toBe(1)
      expect(mailParts(await transcriptOf(harness, compare.id))).toHaveLength(1)
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: accept only the kinds this version knows in readAgentMail's envelope check; the
  // newer kind is skipped for good, as the cursor passes it.
  test("reads a newer sender's kind as a message, rather than skipping it", async () => {
    const harness = steeredMidWork({
      firstStep: () => toolCalls(["look", "bash", { command: "ls offers" }]),
      afterSent: async ({ broker }, childRunId) => {
        const parentRunId = (await child(harness.agents, childRunId)).parentRunId
        await broker.append({
          projectId,
          streamId: agentThreadInboxStreamId((await child(harness.agents, childRunId)).threadId),
          records: [
            {
              name: "agent.mail",
              payload: {
                id: `${parentRunId}:future`,
                fromRunId: parentRunId,
                toThreadId: (await child(harness.agents, childRunId)).threadId,
                kind: "handoff",
                text: "Use the fiscal year.",
                sentAt: new Date().toISOString(),
              },
            },
          ],
        })
      },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run } = await requestTurn(harness)
      const compare = createSubagentRunId(run.id, COMPARE.key)

      expect(mailParts(await transcriptOf(harness, compare))).toEqual([
        expect.objectContaining({ id: mailId(run.id), kind: "message", text: STEER }),
        expect.objectContaining({
          id: `${run.id}:future`,
          kind: "message",
          text: "Use the fiscal year.",
        }),
      ])
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: build the mail id from the provider's tool call id alone; the second message,
  // whose call reuses that id in a later step, is dropped as a duplicate.
  test("is one message per call, even when a provider reuses a tool call id", async () => {
    const childAtWork = moment()
    const sent = moment()
    const harness = setup({
      parent: async (request, call) => {
        if (call === 1) return toolCalls(["spawn", "spawn_agent", spawn(COMPARE)])
        if (call === 2) {
          await childAtWork.promise
          return toolCalls(["steer", "message_agent", { key: COMPARE.key, text: STEER }])
        }
        if (call === 3) {
          return toolCalls(["steer", "message_agent", { key: COMPARE.key, text: "Also Initech." }])
        }
        if (call === 4) {
          sent.reached()
          const compare = spawnedRunId(harness.parentRequests[1] ?? request)
          return toolCalls(["wait", "wait_agent", { runIds: [compare] }])
        }
        return answer("Payment terms compared.")
      },
      children: {
        [COMPARE.key]: async (_request, call) => {
          if (call > 1) return answer("Compared payment terms, without Globex, with Initech.")
          childAtWork.reached()
          await sent.promise
          return toolCalls(["look", "bash", { command: "ls offers" }])
        },
      },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run } = await requestTurn(harness)
      const second = harness.childRequests(COMPARE.key)[1]

      expect(readsMessage(second, run.id)).toBe(true)
      expect(readsMessage(second, run.id, "Also Initech.")).toBe(true)
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })
})

describe("message_agent", () => {
  // Removal proof: drop the not-a-child check from SubagentCoordinator.message; the unknown key
  // fails with a TypeError instead. Drop the ended check; the message to Compare is sent.
  test("refuses a key that is no child of the turn, and a child that ended, with what to do", async () => {
    const harness = setup({
      parent: (request, call) => {
        if (call === 1) return toolCalls(["spawn", "spawn_agent", spawn(COMPARE)])
        if (call === 2) {
          return toolCalls(["wait", "wait_agent", { runIds: [spawnedRunId(request)] }])
        }
        if (call === 3) {
          return toolCalls(
            ["late", "message_agent", { key: COMPARE.key, text: STEER }],
            ["unknown", "message_agent", { key: "compare-supplier", text: STEER }]
          )
        }
        return answer("Payment terms compared.")
      },
      children: { [COMPARE.key]: () => answer("Globex is cheapest.") },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      await requestTurn(harness)

      expect(toolOutput(harness.parentRequests[3], "late")).toBe(
        "[SixbAgent] 'compare-suppliers' already ended (succeeded), so it cannot read a message. Spawn a new child with another key to go on."
      )
      expect(toolOutput(harness.parentRequests[3], "unknown")).toBe(
        "[SixbAgent] 'compare-supplier' is not a child agent of this turn. Use the key you passed to spawn_agent."
      )
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proofs: drop the paused check from SubagentCoordinator.message; the refusal says
  // Compare ended. Drop `unreadBy` from wait_agent; its result lists no unread message.
  test("refuses a child paused for an approval, and wait_agent lists what it left unread", async () => {
    const compareAtWork = moment()
    const sent = moment()
    const collectReleased = moment()
    // Collect stays at work, so the turn goes on once Compare paused.
    const harness = setup({
      parent: async (request, call) => {
        if (call === 1) {
          return toolCalls(
            ["spawn", "spawn_agent", spawn(COMPARE)],
            ["spawn-collect", "spawn_agent", spawn(COLLECT)]
          )
        }
        if (call === 2) {
          await compareAtWork.promise
          return toolCalls(["steer", "message_agent", { key: COMPARE.key, text: STEER }])
        }
        if (call === 3) {
          sent.reached()
          const compare = spawnedRunId(harness.parentRequests[1] ?? request)
          return toolCalls(["wait", "wait_agent", { runIds: [compare] }])
        }
        if (call === 4) {
          return toolCalls(["paused", "message_agent", { key: COMPARE.key, text: STEER }])
        }
        if (call === 5) {
          collectReleased.reached()
          const collect = toolOutput(harness.parentRequests[1], "spawn-collect") as {
            readonly runId: string
          }
          return toolCalls(["wait-collect", "wait_agent", { runIds: [collect.runId] }])
        }
        return answer("INV-2041 waits for your approval; three invoices are open.")
      },
      children: {
        // Its step holds a call, so it pauses before it reads the message sent during it.
        [COMPARE.key]: async () => {
          compareAtWork.reached()
          await sent.promise
          return toolCalls(["held", "bash", { command: HELD_COMMAND }])
        },
        [COLLECT.key]: async () => {
          await collectReleased.promise
          return answer("Three invoices are open.")
        },
      },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, finished } = await requestTurn(harness)

      expect(finished).toMatchObject({ status: "succeeded", finishReason: "awaiting_approval" })
      expect(harness.childRequests(COMPARE.key)).toHaveLength(1)
      expect(toolOutput(harness.parentRequests[3], "wait")).toMatchObject({
        results: [
          {
            status: "awaiting_approval",
            unread: [{ id: mailId(run.id), text: STEER }],
          },
        ],
      })
      expect(toolOutput(harness.parentRequests[4], "paused")).toBe(
        "[SixbAgent] 'compare-suppliers' is paused for the user's approval and reads no message until it continues, in the turn after the user decides. Message it then, or tell the user what to change."
      )
    } finally {
      collectReleased.reached()
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: drop the `holdsRun` check from SubagentCoordinator.message; the message is
  // accepted while the child is about to pause on the call it filed.
  test("refuses a child whose call was just filed, before it pauses", async () => {
    const filed = moment()
    const refused = moment()
    afterHold = async () => {
      filed.reached()
      await refused.promise
    }
    const harness = setup({
      parent: async (request, call) => {
        if (call === 1) return toolCalls(["spawn", "spawn_agent", spawn(COMPARE)])
        if (call === 2) {
          await filed.promise
          return toolCalls(["steer", "message_agent", { key: COMPARE.key, text: STEER }])
        }
        if (call === 3) {
          refused.reached()
          const compare = spawnedRunId(harness.parentRequests[1] ?? request)
          return toolCalls(["wait", "wait_agent", { runIds: [compare] }])
        }
        return answer("INV-2041 waits for your approval.")
      },
      children: { [COMPARE.key]: () => toolCalls(["held", "bash", { command: HELD_COMMAND }]) },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run } = await requestTurn(harness)

      expect(await child(harness.agents, createSubagentRunId(run.id, COMPARE.key))).toMatchObject({
        status: "succeeded",
        finishReason: "awaiting_approval",
      })
      expect(toolOutput(harness.parentRequests[2], "steer")).toBe(
        "[SixbAgent] 'compare-suppliers' is paused for the user's approval and reads no message until it continues, in the turn after the user decides. Message it then, or tell the user what to change."
      )
    } finally {
      refused.reached()
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: drop the earlier-turn lookup from SubagentCoordinator.message; the refusal
  // says to use the key passed to spawn_agent, which the Agent did.
  test("tells the Agent to spawn again a child of an earlier turn", async () => {
    const harness = setup({
      parent: (request, call) => {
        if (call === 1) return toolCalls(["spawn", "spawn_agent", spawn(COMPARE)])
        if (call === 2) {
          return toolCalls(["wait", "wait_agent", { runIds: [spawnedRunId(request)] }])
        }
        if (call === 3) return answer("Globex is cheapest.")
        if (call === 4) {
          return toolCalls(["steer", "message_agent", { key: COMPARE.key, text: STEER }])
        }
        return answer("Payment terms next.")
      },
      children: { [COMPARE.key]: () => answer("Globex is cheapest.") },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const first = await requestTurn(harness)
      await requestTurn(harness, first.run.threadId)

      expect(toolOutput(harness.parentRequests[4], "steer")).toBe(
        "[SixbAgent] 'compare-suppliers' is a child agent of an earlier turn, which ended with it. Spawn it again in this turn, with the same key if you like, and message it then."
      )
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })
})

describe("a message a child paused before reading", () => {
  // Removal proof: read a run's mail in SubagentInbox.take only from the run's own start, past
  // what was sent before it was admitted; the child that continues after the approval never reads
  // the message its parent was told it would.
  test("reaches the child that continues it once the user decides", async () => {
    const childAtWork = moment()
    const sent = moment()
    const harness = setup({
      parent: async (request, call) => {
        if (call === 1) return toolCalls(["spawn", "spawn_agent", spawn(COMPARE)])
        if (call === 2) {
          await childAtWork.promise
          return toolCalls(["steer", "message_agent", { key: COMPARE.key, text: STEER }])
        }
        if (call === 3) {
          sent.reached()
          const compare = spawnedRunId(harness.parentRequests[1] ?? request)
          return toolCalls(["wait", "wait_agent", { runIds: [compare] }])
        }
        if (call === 4) {
          const compare = spawnedRunId(harness.parentRequests[1] ?? request)
          return toolCalls(["wait-again", "wait_agent", { runIds: [compare] }])
        }
        return answer("Payment terms compared; INV-2041 is paid.")
      },
      children: {
        // Its step files a call, so it pauses before it reads the message sent during it.
        [COMPARE.key]: async () => {
          childAtWork.reached()
          await sent.promise
          return toolCalls(["held", "bash", { command: HELD_COMMAND }])
        },
        [`${COMPARE.key}'`]: () => answer("Compared payment terms, without Globex."),
      },
    })
    await createTestSixb(harness.host).objects.upsert("invoice", { id: "INV-2041", status: "open" })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, finished, alicesSixb } = await requestTurn(harness)
      expect(finished).toMatchObject({ status: "succeeded", finishReason: "awaiting_approval" })
      // Its turn paused once it did: the wait is its last step.
      expect(await storedWait(harness.agents, run.threadId, "wait")).toMatchObject({
        results: [{ status: "awaiting_approval", unread: [{ id: mailId(run.id), text: STEER }] }],
      })

      const [held] = (await alicesSixb.agent.approvals.list({ threadId: run.threadId })).approvals
      const decided = await settle(
        alicesSixb.agent.approvals.decide(held?.id ?? "", { decision: "approve" }),
        "decide"
      )
      if (!decided.run) throw new Error("Expected the turn to resume.")
      await terminal(harness.agents, decided.run.id)
      const continuation = createSubagentRunId(decided.run.id, COMPARE.key)

      expect(readsMessage(harness.childRequests(`${COMPARE.key}'`)[0], run.id)).toBe(true)
      expect(mailParts(await transcriptOf(harness, continuation))).toEqual([
        expect.objectContaining({ id: mailId(run.id), text: STEER }),
      ])
      expect(toolOutput(harness.parentRequests[4], "wait-again")).toMatchObject({
        results: [{ status: "succeeded", text: "Compared payment terms, without Globex." }],
      })
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })
})
