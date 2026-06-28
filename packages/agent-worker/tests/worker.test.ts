import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import {
  AgentRequestError,
  type AgentRunStreamEvent,
  type AgentStorage,
  AgentStorageError,
  type AgentsRuntime,
  type AppendAgentMessageInput,
  agentRunStreamId,
  type Broker,
  type CreateSandboxOptions,
  createAgentRunId,
  createAgentRunLeaseId,
  defineAgent,
  defineGroup,
  type EventsRuntime,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type Queues,
  type RunCommandOptions,
  type Sandbox,
  type SandboxFactory,
  Sixb,
  type Storage,
} from "@sixb/core"
import { jsonSchema, type ToolSet, tool } from "ai"
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test"
import {
  AgentWorker,
  type AgentWorkerContext,
  type AgentWorkerOptions,
  type AgentWorkerStorage,
  createBrokerStreamSink,
  NOOP_STREAM_SINK,
} from "../src"
import { AgentFinalizationError, AgentLeaseLostError } from "../src/errors"
import { finishRunOrThrow } from "../src/finalize"
import { reconcileAgentExecutionIdentity } from "../src/identity"
import { runAgentTurn } from "../src/run-agent-turn"
import { createAgentRunEnvironment } from "../src/run-environment"
import { waitFor } from "./helpers"

const PROJECT_ID = "agent-worker-tests"
const TEST_AGENT_API_BASE_URL = "http://localhost:3002/api/"
const REQUESTER = { type: "user", id: "usr_requester" } as const
const AGENT_RUNTIME_GROUP = defineGroup("agent-runtime", { label: "Agent runtime" })

const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
}

function stream(chunks: LanguageModelV3StreamPart[]) {
  return { stream: convertArrayToReadableStream(chunks) }
}

function finish(unified: "stop" | "tool-calls"): LanguageModelV3StreamPart {
  return { type: "finish", finishReason: { unified, raw: unified }, usage: USAGE }
}

/**
 * A model that, on its first call, calls the `echo` tool, then on its second call answers with
 * reasoning + text. A stateful `doStream` (not the array form) guarantees per-call ordering.
 */
function toolThenAnswerModel(): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    modelId: "mock-model",
    doStream: async () => {
      call += 1
      if (call === 1) {
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "echo",
            input: JSON.stringify({ value: "hi" }),
          },
          finish("tool-calls"),
        ])
      }
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "reasoning-start", id: "r" },
        { type: "reasoning-delta", id: "r", delta: "echo it back" },
        { type: "reasoning-end", id: "r" },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "Echoed hi" },
        { type: "text-end", id: "t" },
        finish("stop"),
      ])
    },
  })
}

function bashThenAnswerModel(): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    modelId: "mock-model",
    doStream: async () => {
      call += 1
      if (call === 1) {
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "bash-call-1",
            toolName: "bash",
            input: JSON.stringify({
              command: "echo 'Hello, world!' | grep Hello",
              cwd: "/workspace",
              timeoutMs: 1234,
            }),
          },
          finish("tool-calls"),
        ])
      }
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "Bash ran successfully" },
        { type: "text-end", id: "t" },
        finish("stop"),
      ])
    },
  })
}

function apiBashThenAnswerModel(): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    modelId: "mock-model",
    doStream: async () => {
      call += 1
      if (call === 1) {
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "bash-api-call-1",
            toolName: "bash",
            input: JSON.stringify({
              command: "print-sixb-env",
            }),
          },
          finish("tool-calls"),
        ])
      }
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "API context is available" },
        { type: "text-end", id: "t" },
        finish("stop"),
      ])
    },
  })
}

function controlledBlockingAnswerModel(): {
  readonly model: MockLanguageModelV3
  startedCount(): number
  waitForStarted(count: number): Promise<void>
  releaseAll(): void
} {
  let started = 0
  const releases: Array<() => void> = []
  const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = []

  const notifyStarted = () => {
    for (const waiter of waiters) {
      if (started >= waiter.count) {
        waiter.resolve()
      }
    }
  }

  return {
    model: new MockLanguageModelV3({
      modelId: "mock-model",
      doStream: async (options) => ({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            started += 1
            const callId = started
            let released = false
            const abort = () => controller.error(new DOMException("Aborted", "AbortError"))
            const release = () => {
              if (released) return
              released = true
              controller.enqueue({ type: "text-start", id: `t-${callId}` })
              controller.enqueue({ type: "text-delta", id: `t-${callId}`, delta: "done" })
              controller.enqueue({ type: "text-end", id: `t-${callId}` })
              controller.enqueue(finish("stop"))
              controller.close()
            }

            controller.enqueue({ type: "stream-start", warnings: [] })
            releases.push(release)
            notifyStarted()
            if (options.abortSignal?.aborted) {
              abort()
            } else {
              options.abortSignal?.addEventListener("abort", abort, { once: true })
            }
          },
        }),
      }),
    }),
    startedCount() {
      return started
    },
    waitForStarted(count) {
      if (started >= count) {
        return Promise.resolve()
      }
      return new Promise((resolve) => {
        waiters.push({ count, resolve })
      })
    },
    releaseAll() {
      for (const release of releases.splice(0)) {
        release()
      }
    },
  }
}

const echoTool: ToolSet = {
  echo: tool({
    description: "Echo a value back.",
    inputSchema: jsonSchema<{ value: string }>({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    }),
    async execute(input) {
      return { echoed: input.value }
    },
  }),
}

// Sixb's generics overflow TS2589 when instantiated with an empty ontology in a test; we only need a
// structural `AgentWorkerSixb`, so we construct through a narrowed constructor cast (as the
// action-worker tests do).
interface TestSixb {
  readonly id: string
  readonly broker: Broker
  readonly events: EventsRuntime
  readonly storage: Storage
  readonly queues: Queues
  readonly agents: AgentsRuntime
  readonly sandboxes?: SandboxFactory
}

const SixbCtor = Sixb as unknown as new (options: Record<string, unknown>) => TestSixb

function workerOptions(
  options: Omit<AgentWorkerOptions, "apiBaseUrl"> & { readonly apiBaseUrl?: string } = {}
): AgentWorkerOptions {
  return { ...options, apiBaseUrl: options.apiBaseUrl ?? TEST_AGENT_API_BASE_URL }
}

interface RecordedCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly options: RunCommandOptions
}

class RecordingSandbox implements Sandbox {
  readonly id: string
  readonly provider = "recording"
  readonly workingDirectory: string
  status: "running" | "stopped" | "failed" = "running"
  readonly commands: RecordedCommand[] = []
  destroyed = false

  constructor(id: string) {
    this.id = id
    this.workingDirectory = `/tmp/sixb-recording-sandbox/${id}`
  }

  async runCommand(command: string, args: readonly string[] = [], options: RunCommandOptions = {}) {
    this.commands.push({ command, args, options })
    const script = args.at(-1)
    if (command === "bash" && script === "print-sixb-env") {
      const env = options.env ?? {}
      return {
        exitCode: 0,
        stdout: [
          `base=${env.SIXB_API_BASE_URL ?? ""}`,
          `project=${env.SIXB_PROJECT_ID ?? ""}`,
          `agent=${env.SIXB_AGENT_ID ?? ""}`,
          `thread=${env.SIXB_THREAD_ID ?? ""}`,
          `run=${env.SIXB_RUN_ID ?? ""}`,
          `skills=${env.SIXB_SKILLS_DIR ?? ""}`,
          `context=${env.SIXB_RUN_CONTEXT ?? ""}`,
          `token=${env.SIXB_ACCESS_TOKEN ?? ""}`,
        ].join("\n"),
        stderr: "",
        durationMs: 1,
      }
    }
    return {
      exitCode: 0,
      stdout: `ran ${command} ${args.join(" ")}`.trim(),
      stderr: "",
      durationMs: 1,
    }
  }

  async stop(): Promise<void> {
    this.status = "stopped"
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    await this.stop()
  }
}

class RecordingSandboxFactory implements SandboxFactory {
  readonly sandboxes: RecordingSandbox[] = []
  readonly createOptions: CreateSandboxOptions[] = []

  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    this.createOptions.push(options)
    const sandbox = new RecordingSandbox(`sandbox-${this.sandboxes.length + 1}`)
    this.sandboxes.push(sandbox)
    return sandbox
  }
}

function buildSixb(
  model: LanguageModelV3,
  broker: Broker = new InMemoryBroker(),
  sandboxes: SandboxFactory = new RecordingSandboxFactory()
): TestSixb {
  const agent = defineAgent("assistant", {
    name: "Assistant",
    model,
    instructions: "You are a helpful test assistant.",
    groups: [AGENT_RUNTIME_GROUP],
    loop: { stopWhen: { maxSteps: 4 } },
  })
  return new SixbCtor({
    id: PROJECT_ID,
    ontology: [],
    agents: [agent],
    groups: [AGENT_RUNTIME_GROUP],
    broker,
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    sandboxes,
  })
}

class FailingRunStreamBroker extends InMemoryBroker {
  override append(
    params: Parameters<InMemoryBroker["append"]>[0]
  ): ReturnType<InMemoryBroker["append"]> {
    if (params.streamId.startsWith("agents.runs.")) {
      return Promise.reject(new Error("broker append down"))
    }
    return super.append(params)
  }
}

function agentStorageOf(sixb: TestSixb): AgentStorage {
  const storage = sixb.storage.agents
  if (!storage) {
    throw new Error("expected agent storage")
  }
  return storage
}

function authStorageOf(sixb: TestSixb) {
  const storage = sixb.storage.auth
  if (!storage) {
    throw new Error("expected auth storage")
  }
  return storage
}

function workerStorageOf(storage: Storage): AgentWorkerStorage {
  if (!storage.agents) {
    throw new Error("expected agent storage")
  }
  if (!storage.auth) {
    throw new Error("expected auth storage")
  }
  return storage as AgentWorkerStorage
}

function buildAgentWorkerContext(
  sixb: TestSixb,
  input: { readonly apiBaseUrl?: string; readonly baseTools?: ToolSet } = {}
): AgentWorkerContext {
  if (!sixb.sandboxes) {
    throw new Error("expected sandbox factory")
  }
  return {
    id: sixb.id,
    storage: workerStorageOf(sixb.storage),
    sandboxes: sixb.sandboxes,
    baseTools: input.baseTools ?? {},
    apiBaseUrl: input.apiBaseUrl ?? TEST_AGENT_API_BASE_URL,
    streamSink: NOOP_STREAM_SINK,
    leaseMs: 60_000,
    heartbeatMs: 20_000,
    defaultMaxSteps: 4,
    turnTimeoutMs: 60_000,
  }
}

async function reserveRequestedRun(
  sixb: TestSixb,
  input: { readonly threadId: string; readonly runId: string; readonly triggerMessageId: string }
) {
  return agentStorageOf(sixb).runs.reserve({
    id: input.runId,
    projectId: PROJECT_ID,
    threadId: input.threadId,
    agentId: "assistant",
    triggerMessageId: input.triggerMessageId,
    requestedByPrincipal: REQUESTER,
    lease: { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() + 60_000) },
  })
}

async function runBashTool(
  context: { readonly tools: ToolSet },
  command: string
): Promise<{ readonly stdout: string }> {
  const bash = context.tools.bash as unknown as {
    execute(
      input: { readonly command: string },
      options: { readonly abortSignal?: AbortSignal }
    ): Promise<{ readonly stdout: string }>
  }
  return bash.execute({ command }, { abortSignal: new AbortController().signal })
}

function stdoutValue(stdout: string, key: string): string {
  const prefix = `${key}=`
  return (
    stdout
      .split("\n")
      .find((line) => line.startsWith(prefix))
      ?.slice(prefix.length) ?? ""
  )
}

function restrictedOrigin(option: CreateSandboxOptions | undefined): string {
  if (option?.network?.mode !== "restricted") {
    throw new Error("Expected restricted sandbox network.")
  }
  const origin = option.network.allow[0]?.origin
  if (!origin) {
    throw new Error("Expected restricted sandbox origin.")
  }
  return origin
}

async function listMessages(storage: AgentStorage, threadId: string) {
  const result = await storage.messages.list({ projectId: PROJECT_ID, threadId, order: "asc" })
  return result.messages
}

async function listRunStreamRecords(broker: Broker, runId: string) {
  return broker.read({
    projectId: PROJECT_ID,
    streamId: agentRunStreamId(runId),
  })
}

/**
 * Wrap root storage so agent `runs.finish` fails with a non-terminal (infra) error its first
 * `failTimes` calls, including when the worker finalizes through `storage.transaction(...)`.
 */
function withFlakyAgentFinishStorage(storage: Storage, failTimes: number): Storage {
  const agents = storage.agents
  if (!agents) {
    throw new Error("expected agent storage")
  }
  let fails = 0
  const wrapAgents = (agents: AgentStorage): AgentStorage => ({
    threads: agents.threads,
    messages: agents.messages,
    runs: {
      reserve: (input) => agents.runs.reserve(input),
      renewLease: (input) => agents.runs.renewLease(input),
      reclaim: (input) => agents.runs.reclaim(input),
      getById: (params) => agents.runs.getById(params),
      list: (input) => agents.runs.list(input),
      finish: (input) => {
        if (fails < failTimes) {
          fails += 1
          return Promise.reject(new Error("storage blip"))
        }
        return agents.runs.finish(input)
      },
    },
  })
  return {
    ...storage,
    agents: wrapAgents(agents),
    transaction: (run, options) =>
      storage.transaction((tx) => {
        const agents = tx.agents
        return run({
          ...tx,
          ...(agents ? { agents: wrapAgents(agents) } : {}),
        })
      }, options),
  }
}

function withAlwaysFailingTransactionalFinish(storage: Storage): Storage {
  const agents = storage.agents
  if (!agents) {
    throw new Error("expected agent storage")
  }
  const wrapAgents = (agents: AgentStorage): AgentStorage => ({
    threads: agents.threads,
    messages: agents.messages,
    runs: {
      reserve: (input) => agents.runs.reserve(input),
      renewLease: (input) => agents.runs.renewLease(input),
      reclaim: (input) => agents.runs.reclaim(input),
      getById: (params) => agents.runs.getById(params),
      list: (input) => agents.runs.list(input),
      finish: () => Promise.reject(new Error("storage down after message generation")),
    },
  })
  return {
    ...storage,
    agents: wrapAgents(agents),
    transaction: (run, options) =>
      storage.transaction((tx) => {
        const agents = tx.agents
        return run({
          ...tx,
          ...(agents ? { agents: wrapAgents(agents) } : {}),
        })
      }, options),
  }
}

function withObservedAgentMessageAppendStorage(
  storage: Storage,
  onBeforeAppend: (input: AppendAgentMessageInput) => void | Promise<void>
): Storage {
  const agents = storage.agents
  if (!agents) {
    throw new Error("expected agent storage")
  }
  const wrapAgents = (agents: AgentStorage): AgentStorage => ({
    threads: agents.threads,
    runs: agents.runs,
    messages: {
      getById: (params) => agents.messages.getById(params),
      list: (input) => agents.messages.list(input),
      append: async (input) => {
        await onBeforeAppend(input)
        return agents.messages.append(input)
      },
    },
  })
  return {
    ...storage,
    agents: wrapAgents(agents),
    transaction: (run, options) =>
      storage.transaction((tx) => {
        const agents = tx.agents
        return run({
          ...tx,
          ...(agents ? { agents: wrapAgents(agents) } : {}),
        })
      }, options),
  }
}

/** A model whose stream opens then hangs until aborted — used to force a turn timeout. */
function hangingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    modelId: "mock-model",
    doStream: async (options) => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          const abort = () => controller.error(new DOMException("Aborted", "AbortError"))
          if (options.abortSignal?.aborted) {
            abort()
          } else {
            options.abortSignal?.addEventListener("abort", abort, { once: true })
          }
        },
      }),
    }),
  })
}

describe("AgentWorker", () => {
  test("requires an API base URL", () => {
    const sixb = buildSixb(toolThenAnswerModel())

    expect(() => new AgentWorker(sixb, { apiBaseUrl: "" })).toThrow(
      "Agent workers require options.apiBaseUrl."
    )
  })

  test("creates isolated gateway URLs and sandbox env per concurrent run environment", async () => {
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(toolThenAnswerModel(), new InMemoryBroker(), sandboxes)
    const agent = sixb.agents.getById("assistant")
    if (!agent) {
      throw new Error("Expected test agent.")
    }
    const [firstRequest, secondRequest] = await Promise.all([
      sixb.agents.request({ agentId: "assistant", text: "first" }),
      sixb.agents.request({ agentId: "assistant", text: "second" }),
    ])
    const [firstRun, secondRun] = await Promise.all([
      reserveRequestedRun(sixb, firstRequest),
      reserveRequestedRun(sixb, secondRequest),
    ])

    const context = buildAgentWorkerContext(sixb, {
      apiBaseUrl: "http://sixb-api.local/api/",
    })
    await reconcileAgentExecutionIdentity(context.storage, PROJECT_ID, agent)
    const [firstEnvironment, secondEnvironment] = await Promise.all([
      createAgentRunEnvironment({ context, agent, run: firstRun }),
      createAgentRunEnvironment({ context, agent, run: secondRun }),
    ])
    let firstDisposed = false
    let secondDisposed = false

    try {
      expect(sandboxes.createOptions).toHaveLength(2)
      const origins = sandboxes.createOptions.map(restrictedOrigin)
      expect(new Set(origins)).toEqual(new Set(["http://sixb-api.local"]))

      const [firstBash, secondBash] = await Promise.all([
        runBashTool(firstEnvironment.turnContext, "print-sixb-env"),
        runBashTool(secondEnvironment.turnContext, "print-sixb-env"),
      ])
      const firstBaseUrl = stdoutValue(firstBash.stdout, "base")
      const secondBaseUrl = stdoutValue(secondBash.stdout, "base")

      expect(firstBaseUrl).not.toBe(secondBaseUrl)
      expect(firstBaseUrl).toStartWith("http://sixb-api.local/__sixb/agent-api/")
      expect(secondBaseUrl).toStartWith("http://sixb-api.local/__sixb/agent-api/")
      expect(new URL(firstBaseUrl).origin).toBe(origins[0])
      expect(new URL(secondBaseUrl).origin).toBe(origins[1])
      expect(firstBaseUrl).toContain(`/${encodeURIComponent(firstRun.id)}/`)
      expect(secondBaseUrl).toContain(`/${encodeURIComponent(secondRun.id)}/`)
      expect(firstBaseUrl).not.toContain("sixb_sat_")
      expect(secondBaseUrl).not.toContain("sixb_sat_")
      expect(firstBash.stdout).toContain(`run=${firstRun.id}`)
      expect(secondBash.stdout).toContain(`run=${secondRun.id}`)
      expect(firstBash.stdout).toContain(`thread=${firstRun.threadId}`)
      expect(secondBash.stdout).toContain(`thread=${secondRun.threadId}`)
      expect(stdoutValue(firstBash.stdout, "skills")).not.toBe(
        stdoutValue(secondBash.stdout, "skills")
      )
      expect(stdoutValue(firstBash.stdout, "context")).not.toBe(
        stdoutValue(secondBash.stdout, "context")
      )
      const systemAddendum = firstEnvironment.turnContext.systemAddendum ?? ""
      expect(systemAddendum).toContain("Use $SIXB_SKILLS_DIR to reference skill file paths")
      expect(systemAddendum).toContain("Path: $SIXB_SKILLS_DIR/sixb-query")
      expect(systemAddendum).not.toContain("/tmp/sixb-recording-sandbox")

      await firstEnvironment.dispose()
      firstDisposed = true
      expect(sandboxes.sandboxes[0]?.destroyed).toBe(true)
      expect(sandboxes.sandboxes[1]?.destroyed).toBe(false)
    } finally {
      if (!firstDisposed) {
        await firstEnvironment.dispose()
      }
      if (!secondDisposed) {
        await secondEnvironment.dispose()
        secondDisposed = true
      }
    }
    expect(sandboxes.sandboxes.every((sandbox) => sandbox.destroyed)).toBe(true)
  })

  test("trigger persists the user message and enqueues an intent without creating a run", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    const result = await sixb.agents.request({
      agentId: "assistant",
      text: "hello",
      principal: REQUESTER,
    })

    expect(result.createdThread).toBe(true)
    expect(result.jobId).toBeDefined()
    expect(result.runId.startsWith("agt_run_")).toBe(true)

    const messages = await listMessages(storage, result.threadId)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: "user", runId: null })
    expect(messages[0]?.authorPrincipal).toEqual(REQUESTER)
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "hello" }])

    // Reserve-at-claim: no run record exists yet, and the thread is still idle.
    const runs = await storage.runs.list({ projectId: PROJECT_ID, threadId: result.threadId })
    expect(runs.runs).toHaveLength(0)
    const thread = await storage.threads.getById({ projectId: PROJECT_ID, id: result.threadId })
    expect(thread?.activeRunId).toBeNull()
  })

  test("runs a full multi-step turn: reserves, persists the assistant message, finalizes with usage", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    const auth = authStorageOf(sixb)

    const worker = new AgentWorker(
      sixb,
      workerOptions({
        tools: echoTool,
      })
    )
    await worker.start()
    try {
      const { threadId, runId } = await sixb.agents.request({
        agentId: "assistant",
        text: "echo hi",
      })

      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "running" ? found : null
        },
        { label: "run terminal" }
      )

      expect(run.status).toBe("succeeded")
      expect(run.id).toBe(runId)
      expect(run.attempt).toBe(1)
      expect(run.finishReason).toBe("stop")
      expect(run.modelId).toBe("mock-model")
      expect(run.usage?.outputTokens).toBeGreaterThan(0)
      expect(run.usage?.inputTokens).toBeGreaterThan(0)
      expect(run.executionPrincipal).toEqual({
        type: "serviceAccount",
        id: "svc_agent_assistant",
      })

      // Thread released after finalization (single-flight pointer cleared).
      const thread = await storage.threads.getById({ projectId: PROJECT_ID, id: threadId })
      expect(thread?.activeRunId).toBeNull()

      const messages = await listMessages(storage, threadId)
      const assistant = messages.find((message) => message.role === "assistant")
      expect(assistant).toBeDefined()
      expect(assistant?.runId).toBe(run.id)
      expect(assistant?.authorPrincipal).toEqual({
        type: "serviceAccount",
        id: "svc_agent_assistant",
      })

      const parts = assistant?.parts ?? []
      expect(parts.some((part) => part.type === "reasoning")).toBe(true)
      expect(parts.some((part) => part.type === "step-start")).toBe(true)
      expect(
        parts.some(
          (part) =>
            part.type === "tool-call" &&
            part.toolName === "echo" &&
            part.state === "output-available"
        )
      ).toBe(true)
      expect(parts.some((part) => part.type === "text" && part.text.includes("Echoed hi"))).toBe(
        true
      )

      await expect(
        auth.serviceAccounts.getById({ projectId: PROJECT_ID, id: "svc_agent_assistant" })
      ).resolves.toMatchObject({
        id: "svc_agent_assistant",
        name: "Assistant",
        status: "active",
      })
      const memberships = await auth.serviceAccountGroupMemberships.listForServiceAccount({
        projectId: PROJECT_ID,
        serviceAccountId: "svc_agent_assistant",
      })
      expect(memberships.map((membership) => [membership.groupId, membership.source])).toEqual([
        ["agent-runtime", "agent"],
      ])

      const streamRecords = await listRunStreamRecords(sixb.broker, runId)
      const streamNames = streamRecords.map((record) => record.name)
      expect(streamNames[0]).toBe("agent.run.started")
      expect(streamNames.at(-2)).toBe("agent.message.finalized")
      expect(streamNames.at(-1)).toBe("agent.run.finished")
      expect(streamNames.filter((name) => name === "agent.ui.chunk").length).toBeGreaterThan(0)

      const finalizedIndex = streamNames.indexOf("agent.message.finalized")
      const firstChunkIndex = streamNames.indexOf("agent.ui.chunk")
      expect(firstChunkIndex).toBeGreaterThan(0)
      expect(firstChunkIndex).toBeLessThan(finalizedIndex)

      const chunks = streamRecords
        .filter((record) => record.name === "agent.ui.chunk")
        .map(
          (record) =>
            record.payload as unknown as Extract<
              AgentRunStreamEvent,
              { readonly type: "agent.ui.chunk" }
            >
        )
      expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index))
      expect(chunks.every((chunk) => chunk.attempt === 1)).toBe(true)

      const finishedPayload = streamRecords.find(
        (record) => record.name === "agent.run.finished"
      )?.payload
      expect(finishedPayload).toMatchObject({
        type: "agent.run.finished",
        status: "succeeded",
        runId,
        attempt: 1,
      })
    } finally {
      await worker.stop()
    }
  })

  test("runs the built-in bash tool in a per-run sandbox", async () => {
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(bashThenAnswerModel(), new InMemoryBroker(), sandboxes)
    const storage = agentStorageOf(sixb)

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const { threadId } = await sixb.agents.request({
        agentId: "assistant",
        text: "run bash",
      })

      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "running" ? found : null
        },
        { label: "bash run terminal" }
      )

      expect(run.status).toBe("succeeded")
      const createOptions = sandboxes.createOptions[0]
      expect(createOptions?.network).toMatchObject({
        mode: "restricted",
        allow: [{ name: "sixb-api" }],
      })
      if (createOptions?.network?.mode !== "restricted") {
        throw new Error("Expected restricted sandbox network.")
      }
      expect(createOptions.network.allow[0]?.origin).toBe("http://localhost:3002")

      const sandbox = sandboxes.sandboxes[0]
      expect(sandbox).toBeDefined()
      await waitFor(() => (sandbox?.destroyed ? true : null), {
        label: "sandbox destroyed",
      })
      expect(sandbox?.commands).toHaveLength(1)
      const command = sandbox?.commands[0]
      expect(command?.command).toBe("bash")
      expect(command?.args).toEqual(["-lc", "echo 'Hello, world!' | grep Hello"])
      expect(command?.options.cwd).toBe("/workspace")
      expect(command?.options.env?.SIXB_API_BASE_URL).toStartWith(
        `http://localhost:3002/__sixb/agent-api/${encodeURIComponent(run.id)}/`
      )
      expect(command?.options.env?.SIXB_SKILLS_DIR).toContain("/.sixb/agent/skills")
      expect(command?.options.timeout).toBe(1234)
      expect(command?.options.signal).toBeInstanceOf(AbortSignal)

      const messages = await listMessages(storage, threadId)
      const assistant = messages.find((message) => message.role === "assistant")
      const parts = assistant?.parts ?? []
      expect(
        parts.find((part) => part.type === "tool-call" && part.toolName === "bash")
      ).toMatchObject({
        type: "tool-call",
        toolName: "bash",
        state: "output-available",
        input: {
          command: "echo 'Hello, world!' | grep Hello",
          cwd: "/workspace",
          timeoutMs: 1234,
        },
        output: {
          exitCode: 0,
          stdout: "ran bash -lc echo 'Hello, world!' | grep Hello",
          stderr: "",
          durationMs: 1,
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      })
      expect(parts.some((part) => part.type === "text" && part.text.includes("Bash ran"))).toBe(
        true
      )
    } finally {
      await worker.stop()
    }
  })

  test("passes Sixb API gateway env and skills into the per-run sandbox", async () => {
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(apiBashThenAnswerModel(), new InMemoryBroker(), sandboxes)
    const storage = agentStorageOf(sixb)
    const auth = authStorageOf(sixb)

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const { threadId, runId } = await sixb.agents.request({
        agentId: "assistant",
        text: "inspect sixb api context",
      })

      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "running" ? found : null
        },
        { label: "api bash run terminal" }
      )

      expect(run.status).toBe("succeeded")
      const createOptions = sandboxes.createOptions[0]
      expect(createOptions?.network).toMatchObject({
        mode: "restricted",
        allow: [{ name: "sixb-api" }],
      })
      if (createOptions?.network?.mode !== "restricted") {
        throw new Error("Expected restricted sandbox network.")
      }
      expect(createOptions.network.allow[0]?.origin).toBe("http://localhost:3002")

      const command = sandboxes.sandboxes[0]?.commands[0]
      expect(command?.command).toBe("bash")
      expect(command?.args).toEqual(["-lc", "print-sixb-env"])
      const env = command?.options.env
      expect(env?.SIXB_API_BASE_URL).toStartWith(
        `http://localhost:3002/__sixb/agent-api/${encodeURIComponent(runId)}/`
      )
      expect(env?.SIXB_PROJECT_ID).toBe(PROJECT_ID)
      expect(env?.SIXB_AGENT_ID).toBe("assistant")
      expect(env?.SIXB_THREAD_ID).toBe(threadId)
      expect(env?.SIXB_RUN_ID).toBe(runId)
      expect(env?.SIXB_CONTEXT_DIR).toContain("/.sixb/agent")
      expect(env?.SIXB_SKILLS_DIR).toContain("/.sixb/agent/skills")
      expect(env?.SIXB_RUN_CONTEXT).toContain("/.sixb/agent/context/run.json")
      expect(env?.SIXB_API_GUIDE).toBeUndefined()
      expect(env?.SIXB_ACCESS_TOKEN).toBeUndefined()

      if (!env?.SIXB_SKILLS_DIR || !env.SIXB_RUN_CONTEXT) {
        throw new Error("Expected sandbox API env.")
      }

      const querySkill = await readFile(
        join(env.SIXB_SKILLS_DIR, "sixb-query", "SKILL.md"),
        "utf-8"
      )
      expect(querySkill).toContain("name: sixb-query")
      expect(querySkill).toContain("/api/object-types")
      expect(querySkill).toContain("references/query-api.md")
      expect(querySkill).toContain("Do not invent alternative")
      expect(querySkill).not.toContain("SIXB_ACCESS_TOKEN")

      const queryApiReference = await readFile(
        join(env.SIXB_SKILLS_DIR, "sixb-query", "references", "query-api.md"),
        "utf-8"
      )
      expect(queryApiReference).toContain("/api/objects/query")
      expect(queryApiReference).toContain("/api/objects/query/facets")
      expect(queryApiReference).toContain("Do not send top-level")
      expect(queryApiReference).toContain("This is the only list-by-type route")
      expect(queryApiReference).toContain("Do not use `/api/objects/{objectTypeId}`")
      expect(queryApiReference).toContain("Common Mistakes")
      expect(queryApiReference).toContain('/api/objects/customer"')
      expect(queryApiReference).toContain('"kind":"limit"')

      const queryShapesReference = await readFile(
        join(env.SIXB_SKILLS_DIR, "sixb-query", "references", "query-shapes.md"),
        "utf-8"
      )
      expect(queryShapesReference).toContain('"kind": "page"')
      expect(queryShapesReference).toContain('"pageSize": 20')
      expect(queryShapesReference).toContain(
        '"pageToken": "next-page-token-from-previous-response"'
      )

      const queryExamplesReference = await readFile(
        join(env.SIXB_SKILLS_DIR, "sixb-query", "references", "examples.md"),
        "utf-8"
      )
      expect(queryExamplesReference).toContain("keep pagination and limits inside")
      expect(queryExamplesReference).toContain('"kind": "limit"')

      const telemetrySkill = await readFile(
        join(env.SIXB_SKILLS_DIR, "sixb-telemetry", "SKILL.md"),
        "utf-8"
      )
      expect(telemetrySkill).toContain("name: sixb-telemetry")
      expect(telemetrySkill).toContain("references/telemetry-api.md")

      const telemetryApiReference = await readFile(
        join(env.SIXB_SKILLS_DIR, "sixb-telemetry", "references", "telemetry-api.md"),
        "utf-8"
      )
      expect(telemetryApiReference).toContain("/api/telemetry/history")
      expect(telemetryApiReference).toContain("/telemetry/rpm/latest")

      const actionsSkill = await readFile(
        join(env.SIXB_SKILLS_DIR, "sixb-actions", "SKILL.md"),
        "utf-8"
      )
      expect(actionsSkill).toContain("name: sixb-actions")
      expect(actionsSkill).toContain("references/actions-api.md")

      const actionsApiReference = await readFile(
        join(env.SIXB_SKILLS_DIR, "sixb-actions", "references", "actions-api.md"),
        "utf-8"
      )
      expect(actionsApiReference).toContain("/api/actions")
      expect(actionsApiReference).toContain("ask for approval")
      expect(actionsApiReference).toContain("Do not request the action until the user approves")
      expect(actionsApiReference).toContain("/api/action-runs/action_run_id")
      expect(actionsApiReference).toContain("without a `kind`")
      expect(actionsApiReference).toContain('"objectTypeId": "customer", "primaryId": "cust-001"')

      const runContext = JSON.parse(await readFile(env.SIXB_RUN_CONTEXT, "utf-8")) as unknown
      expect(runContext).toMatchObject({
        projectId: PROJECT_ID,
        agentId: "assistant",
        threadId,
        runId,
        apiBaseUrl: env.SIXB_API_BASE_URL,
      })

      const messages = await listMessages(storage, threadId)
      const assistant = messages.find((message) => message.role === "assistant")
      const toolPart = assistant?.parts.find(
        (part) => part.type === "tool-call" && part.toolName === "bash"
      )
      if (!toolPart || toolPart.type !== "tool-call" || toolPart.state !== "output-available") {
        throw new Error("Expected completed bash tool call.")
      }
      const output = toolPart.output
      const stdout =
        output && typeof output === "object" && "stdout" in output ? String(output.stdout) : ""
      expect(output).toMatchObject({
        stdoutTruncated: false,
        stderrTruncated: false,
      })
      expect(stdout).toContain(`base=${env.SIXB_API_BASE_URL}`)
      expect(stdout).toContain(`skills=${env.SIXB_SKILLS_DIR}`)
      expect(stdout).toContain(`context=${env.SIXB_RUN_CONTEXT}`)
      expect(stdout).toContain("token=")
      expect(stdout).not.toContain("sixb_sat_")
      expect(
        assistant?.parts.some(
          (part) => part.type === "text" && part.text.includes("API context is available")
        )
      ).toBe(true)

      const tokens = await auth.accessTokens.list({
        projectId: PROJECT_ID,
        kind: "serviceAccount",
        subjectType: "serviceAccount",
        subjectId: "svc_agent_assistant",
        includeRevoked: true,
      })
      expect(tokens.accessTokens).toEqual([])
    } finally {
      await worker.stop()
    }
  })

  test("runs jobs for different threads concurrently with isolated run environments", async () => {
    const controlled = controlledBlockingAnswerModel()
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(controlled.model, new InMemoryBroker(), sandboxes)
    const storage = agentStorageOf(sixb)
    const auth = authStorageOf(sixb)

    const firstRequest = await sixb.agents.request({ agentId: "assistant", text: "first" })

    const worker = new AgentWorker(
      sixb,
      workerOptions({ concurrency: 2, idlePollMs: 10, tools: echoTool })
    )
    await worker.start()
    try {
      await waitFor(() => (controlled.startedCount() >= 1 ? true : null), {
        label: "first model stream started",
      })
      const firstInitiallyRunning = await storage.runs.getById({
        projectId: PROJECT_ID,
        id: firstRequest.runId,
      })
      expect(firstInitiallyRunning?.status).toBe("running")

      const secondRequest = await sixb.agents.request({ agentId: "assistant", text: "second" })

      await waitFor(() => (controlled.startedCount() >= 2 ? true : null), {
        label: "two concurrent model streams started",
      })

      const [firstRunning, secondRunning] = await Promise.all([
        storage.runs.getById({ projectId: PROJECT_ID, id: firstRequest.runId }),
        storage.runs.getById({ projectId: PROJECT_ID, id: secondRequest.runId }),
      ])
      expect(firstRunning?.status).toBe("running")
      expect(secondRunning?.status).toBe("running")

      expect(sandboxes.createOptions).toHaveLength(2)
      const origins = sandboxes.createOptions.map(restrictedOrigin)
      expect(new Set(origins)).toEqual(new Set(["http://localhost:3002"]))

      controlled.releaseAll()

      const [firstRun, secondRun] = await Promise.all([
        waitFor(
          async () => {
            const run = await storage.runs.getById({
              projectId: PROJECT_ID,
              id: firstRequest.runId,
            })
            return run && run.status !== "running" ? run : null
          },
          { label: "first concurrent run terminal" }
        ),
        waitFor(
          async () => {
            const run = await storage.runs.getById({
              projectId: PROJECT_ID,
              id: secondRequest.runId,
            })
            return run && run.status !== "running" ? run : null
          },
          { label: "second concurrent run terminal" }
        ),
      ])

      expect(firstRun.status).toBe("succeeded")
      expect(secondRun.status).toBe("succeeded")
      expect(
        (await listMessages(storage, firstRequest.threadId)).some(
          (message) => message.role === "assistant"
        )
      ).toBe(true)
      expect(
        (await listMessages(storage, secondRequest.threadId)).some(
          (message) => message.role === "assistant"
        )
      ).toBe(true)

      const streamRecords = await Promise.all([
        listRunStreamRecords(sixb.broker, firstRequest.runId),
        listRunStreamRecords(sixb.broker, secondRequest.runId),
      ])
      expect(
        streamRecords.every((records) =>
          records.some((record) => record.name === "agent.run.finished")
        )
      ).toBe(true)
      await expect(
        auth.serviceAccounts.getById({ projectId: PROJECT_ID, id: "svc_agent_assistant" })
      ).resolves.toBeDefined()
    } finally {
      controlled.releaseAll()
      await worker.stop()
    }
  })

  test("publishes UI chunks before appending the finalized assistant message", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    let chunksBeforeAssistantAppend = 0
    let finalizedBeforeAssistantAppend = false

    const observedStorage = withObservedAgentMessageAppendStorage(sixb.storage, async (input) => {
      if (input.role !== "assistant" || input.runId === null) {
        return
      }
      const records = await listRunStreamRecords(sixb.broker, input.runId)
      chunksBeforeAssistantAppend = records.filter(
        (record) => record.name === "agent.ui.chunk"
      ).length
      finalizedBeforeAssistantAppend = records.some(
        (record) => record.name === "agent.message.finalized"
      )
    })
    const workerSixb = {
      id: sixb.id,
      broker: sixb.broker,
      events: sixb.events,
      storage: observedStorage,
      queues: sixb.queues,
      agents: sixb.agents,
      sandboxes: sixb.sandboxes,
    }

    const worker = new AgentWorker(workerSixb, workerOptions({ tools: echoTool }))
    await worker.start()
    try {
      const { threadId } = await sixb.agents.request({ agentId: "assistant", text: "echo hi" })
      await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "running" ? found : null
        },
        { label: "run terminal" }
      )

      expect(chunksBeforeAssistantAppend).toBeGreaterThan(0)
      expect(finalizedBeforeAssistantAppend).toBe(false)
    } finally {
      await worker.stop()
    }
  })

  test("continues the turn when broker run stream publishing fails", async () => {
    const sixb = buildSixb(toolThenAnswerModel(), new FailingRunStreamBroker())
    const storage = agentStorageOf(sixb)
    const originalConsoleError = console.error
    console.error = () => {}

    const worker = new AgentWorker(sixb, workerOptions({ tools: echoTool }))
    try {
      await worker.start()
      const { threadId } = await sixb.agents.request({ agentId: "assistant", text: "echo hi" })
      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "running" ? found : null
        },
        { label: "run terminal despite stream publish failures" }
      )

      expect(run.status).toBe("succeeded")
      const assistants = (await listMessages(storage, threadId)).filter(
        (message) => message.role === "assistant"
      )
      expect(assistants).toHaveLength(1)
    } finally {
      await worker.stop()
      console.error = originalConsoleError
    }
  })

  test("continues the turn when a custom stream sink fails", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    const originalConsoleError = console.error
    console.error = () => {}

    const worker = new AgentWorker(
      sixb,
      workerOptions({
        tools: echoTool,
        streamSink: {
          async publishStarted() {
            throw new Error("sink down")
          },
          async publishUiChunk() {
            throw new Error("sink down")
          },
          async publishMessageFinalized() {
            throw new Error("sink down")
          },
          async publishRunFinished() {
            throw new Error("sink down")
          },
        },
      })
    )
    try {
      await worker.start()
      const { threadId } = await sixb.agents.request({ agentId: "assistant", text: "echo hi" })
      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "running" ? found : null
        },
        { label: "run terminal despite custom stream sink failures" }
      )

      expect(run.status).toBe("succeeded")
      const assistants = (await listMessages(storage, threadId)).filter(
        (message) => message.role === "assistant"
      )
      expect(assistants).toHaveLength(1)
    } finally {
      await worker.stop()
      console.error = originalConsoleError
    }
  })

  test("drops non-JSON UI chunks without corrupting durable run state", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    const request = await sixb.agents.request({ agentId: "assistant", text: "echo hi" })
    const run = await storage.runs.reserve({
      id: request.runId,
      projectId: PROJECT_ID,
      threadId: request.threadId,
      agentId: "assistant",
      triggerMessageId: request.triggerMessageId,
      requestedByPrincipal: REQUESTER,
      lease: { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() + 60_000) },
    })

    const circular: Record<string, unknown> = {}
    circular.self = circular
    const originalConsoleError = console.error
    console.error = () => {}
    try {
      await createBrokerStreamSink({
        broker: sixb.broker,
        projectId: PROJECT_ID,
      }).publishUiChunk({
        run,
        chunkIndex: 0,
        chunk: circular,
      })
    } finally {
      console.error = originalConsoleError
    }

    expect(await listRunStreamRecords(sixb.broker, request.runId)).toHaveLength(0)
    expect(await storage.runs.getById({ projectId: PROJECT_ID, id: request.runId })).toMatchObject({
      status: "running",
      attempt: 1,
    })
  })

  test("rejects a second message while a run is active (single-flight, trigger layer)", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    // Open a thread and simulate an in-flight run by reserving directly.
    const first = await sixb.agents.request({ agentId: "assistant", text: "first" })
    await storage.runs.reserve({
      id: first.runId,
      projectId: PROJECT_ID,
      threadId: first.threadId,
      agentId: "assistant",
      triggerMessageId: first.triggerMessageId,
      requestedByPrincipal: REQUESTER,
      lease: { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() + 60_000) },
    })

    const promise = sixb.agents.request({
      agentId: "assistant",
      text: "second",
      threadId: first.threadId,
    })
    await expect(promise).rejects.toBeInstanceOf(AgentRequestError)
    await expect(promise).rejects.toMatchObject({ code: "active_run_exists" })
  })

  test("reclaims a crashed run on redelivery and completes it (attempt++)", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    // Trigger normally, then simulate a worker that crashed mid-run: an active run whose lease has
    // already expired, with the same trigger message the redelivered job carries.
    const { threadId, runId, triggerMessageId } = await sixb.agents.request({
      agentId: "assistant",
      text: "echo hi",
    })
    const crashedRunId = runId
    await storage.runs.reserve({
      id: crashedRunId,
      projectId: PROJECT_ID,
      threadId,
      agentId: "assistant",
      triggerMessageId,
      requestedByPrincipal: REQUESTER,
      lease: { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() - 1_000) },
    })

    const worker = new AgentWorker(sixb, workerOptions({ tools: echoTool }))
    await worker.start()
    try {
      const reclaimed = await waitFor(
        async () => {
          const run = await storage.runs.getById({ projectId: PROJECT_ID, id: crashedRunId })
          return run && run.status !== "running" ? run : null
        },
        { label: "crashed run reclaimed + finished" }
      )
      expect(reclaimed.status).toBe("succeeded")
      expect(reclaimed.attempt).toBe(2)

      const streamRecords = await listRunStreamRecords(sixb.broker, crashedRunId)
      expect(
        streamRecords.find((record) => record.name === "agent.run.started")?.payload
      ).toMatchObject({
        type: "agent.run.started",
        runId: crashedRunId,
        attempt: 2,
      })
      expect(
        streamRecords.find((record) => record.name === "agent.run.finished")?.payload
      ).toMatchObject({
        type: "agent.run.finished",
        status: "succeeded",
        runId: crashedRunId,
        attempt: 2,
      })
    } finally {
      await worker.stop()
    }
  })

  test("a worker whose lease was reclaimed writes nothing (fencing)", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    const { threadId, runId, triggerMessageId } = await sixb.agents.request({
      agentId: "assistant",
      text: "echo hi",
    })

    // This worker reserved the run, but its lease already expired and another worker reclaimed it.
    const staleRun = await storage.runs.reserve({
      id: runId,
      projectId: PROJECT_ID,
      threadId,
      agentId: "assistant",
      triggerMessageId,
      requestedByPrincipal: REQUESTER,
      lease: { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() - 1_000) },
    })
    await storage.runs.reclaim({
      projectId: PROJECT_ID,
      id: runId,
      lease: { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() + 60_000) },
    })

    const promise = runAgentTurn({
      context: {
        id: PROJECT_ID,
        storage: workerStorageOf(sixb.storage),
        tools: echoTool,
        streamSink: NOOP_STREAM_SINK,
        leaseMs: 60_000,
        heartbeatMs: 20_000,
        defaultMaxSteps: 4,
        turnTimeoutMs: 60_000,
      },
      agent: sixb.agents.getById("assistant")!,
      run: staleRun,
      signal: new AbortController().signal,
    })
    await expect(promise).rejects.toBeInstanceOf(AgentLeaseLostError)

    // No assistant message was written; the run is still owned by the reclaiming worker.
    const messages = await listMessages(storage, threadId)
    expect(messages.every((message) => message.role !== "assistant")).toBe(true)
    const run = await storage.runs.getById({ projectId: PROJECT_ID, id: runId })
    expect(run?.status).toBe("running")
  })

  test("adds concise Sixb context to every model system prompt", async () => {
    let capturedSystem: string | undefined
    const model = new MockLanguageModelV3({
      modelId: "mock-model",
      doStream: async (options) => {
        capturedSystem = options.prompt.find((message) => message.role === "system")?.content
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Done" },
          { type: "text-end", id: "t" },
          finish("stop"),
        ])
      },
    })
    const sixb = buildSixb(model)
    const request = await sixb.agents.request({ agentId: "assistant", text: "hello" })
    const run = await reserveRequestedRun(sixb, request)

    await runAgentTurn({
      context: {
        id: PROJECT_ID,
        storage: workerStorageOf(sixb.storage),
        tools: {},
        systemAddendum: "Extra sandbox context.",
        streamSink: NOOP_STREAM_SINK,
        leaseMs: 60_000,
        heartbeatMs: 20_000,
        defaultMaxSteps: 4,
        turnTimeoutMs: 60_000,
      },
      agent: sixb.agents.getById("assistant")!,
      run,
      signal: new AbortController().signal,
    })

    expect(capturedSystem).toContain("You are a helpful test assistant.")
    expect(capturedSystem).toContain("You are operating as a Sixb agent")
    expect(capturedSystem).toContain("sandboxed bash tool")
    expect(capturedSystem).toContain("Extra sandbox context.")
  })

  test("records a run-level failure on the record (model error)", async () => {
    const failingModel = new MockLanguageModelV3({
      modelId: "mock-model",
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            controller.error(new Error("provider boom"))
          },
        }),
      }),
    })
    const sixb = buildSixb(failingModel)
    const storage = agentStorageOf(sixb)

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const { threadId } = await sixb.agents.request({ agentId: "assistant", text: "hi" })
      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "running" ? found : null
        },
        { label: "run failed" }
      )
      expect(run.status).toBe("failed")
      expect(run.error).toBeDefined()
      expect(
        (await listRunStreamRecords(sixb.broker, run.id)).find(
          (record) => record.name === "agent.run.finished"
        )?.payload
      ).toMatchObject({
        type: "agent.run.finished",
        status: "failed",
        runId: run.id,
        attempt: 1,
      })

      // Thread released so a later message can run.
      const thread = await storage.threads.getById({ projectId: PROJECT_ID, id: threadId })
      expect(thread?.activeRunId).toBeNull()
    } finally {
      await worker.stop()
    }
  })

  test("cancels the run when the worker is stopped mid-turn", async () => {
    // A model whose stream blocks until the call is aborted, so the turn is reliably in-flight.
    const blockingModel = new MockLanguageModelV3({
      modelId: "mock-model",
      doStream: async (options) => {
        const blocked = new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            const abort = () => controller.error(new DOMException("Aborted", "AbortError"))
            if (options.abortSignal?.aborted) {
              abort()
            } else {
              options.abortSignal?.addEventListener("abort", abort, { once: true })
            }
          },
        })
        return { stream: blocked }
      },
    })
    const sixb = buildSixb(blockingModel)
    const storage = agentStorageOf(sixb)

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    const { threadId, runId } = await sixb.agents.request({ agentId: "assistant", text: "hang" })

    // Wait until the run is reserved and in-flight, then stop the worker.
    await waitFor(
      async () => {
        const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
        return list.runs[0]?.status === "running" ? list.runs[0] : null
      },
      { label: "run running" }
    )
    await worker.stop()

    const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
    expect(list.runs[0]?.status).toBe("cancelled")
    expect(
      (await listRunStreamRecords(sixb.broker, runId)).find(
        (record) => record.name === "agent.run.finished"
      )?.payload
    ).toMatchObject({
      type: "agent.run.finished",
      status: "cancelled",
      runId,
      attempt: 1,
    })
    const thread = await storage.threads.getById({ projectId: PROJECT_ID, id: threadId })
    expect(thread?.activeRunId).toBeNull()
  })

  test("absorbs a transient finalize blip in place: one run, one message, no lock", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    // The worker sees a storage whose `finish` fails twice before succeeding; the trigger keeps using
    // the real storage (both delegate to the same underlying state).
    const workerSixb = {
      id: sixb.id,
      broker: sixb.broker,
      events: sixb.events,
      storage: withFlakyAgentFinishStorage(sixb.storage, 2),
      queues: sixb.queues,
      agents: sixb.agents,
      sandboxes: sixb.sandboxes,
    }

    const worker = new AgentWorker(workerSixb, workerOptions({ tools: echoTool }))
    await worker.start()
    try {
      const { threadId } = await sixb.agents.request({ agentId: "assistant", text: "echo hi" })
      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "running" ? found : null
        },
        { label: "run finalized after blip" }
      )

      // The in-place retry recovered: the run succeeded on this delivery, with exactly one assistant
      // message (no redelivery, so no duplicate turn), and the thread is released (no silent lock).
      expect(run.status).toBe("succeeded")
      expect(run.attempt).toBe(1)
      const thread = await storage.threads.getById({ projectId: PROJECT_ID, id: threadId })
      expect(thread?.activeRunId).toBeNull()
      const assistants = (await listMessages(storage, threadId)).filter(
        (m) => m.role === "assistant"
      )
      expect(assistants).toHaveLength(1)
    } finally {
      await worker.stop()
    }
  })

  test("rolls back the assistant message when finalization fails before redelivery", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    const request = await sixb.agents.request({ agentId: "assistant", text: "echo hi" })
    const run = await storage.runs.reserve({
      id: request.runId,
      projectId: PROJECT_ID,
      threadId: request.threadId,
      agentId: "assistant",
      triggerMessageId: request.triggerMessageId,
      requestedByPrincipal: REQUESTER,
      lease: { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() + 60_000) },
    })

    const failingStorage = withAlwaysFailingTransactionalFinish(sixb.storage)
    await expect(
      runAgentTurn({
        context: {
          id: PROJECT_ID,
          storage: workerStorageOf(failingStorage),
          tools: echoTool,
          streamSink: createBrokerStreamSink({
            broker: sixb.broker,
            projectId: PROJECT_ID,
          }),
          leaseMs: 60_000,
          heartbeatMs: 20_000,
          defaultMaxSteps: 4,
          turnTimeoutMs: 60_000,
        },
        agent: sixb.agents.getById("assistant")!,
        run,
        signal: new AbortController().signal,
      })
    ).rejects.toBeInstanceOf(AgentFinalizationError)

    const afterFailure = await storage.runs.getById({ projectId: PROJECT_ID, id: request.runId })
    expect(afterFailure?.status).toBe("running")
    expect(
      (await listMessages(storage, request.threadId)).filter((m) => m.role === "assistant")
    ).toHaveLength(0)
    const afterFailureRecords = await listRunStreamRecords(sixb.broker, request.runId)
    expect(afterFailureRecords.some((record) => record.name === "agent.ui.chunk")).toBe(true)
    expect(afterFailureRecords.some((record) => record.name === "agent.message.finalized")).toBe(
      false
    )
    expect(afterFailureRecords.some((record) => record.name === "agent.run.finished")).toBe(false)

    const reclaimed = await storage.runs.reclaim({
      projectId: PROJECT_ID,
      id: request.runId,
      lease: { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() + 60_000) },
      now: new Date(Date.now() + 120_000),
    })
    await runAgentTurn({
      context: {
        id: PROJECT_ID,
        storage: workerStorageOf(sixb.storage),
        tools: echoTool,
        streamSink: createBrokerStreamSink({
          broker: sixb.broker,
          projectId: PROJECT_ID,
        }),
        leaseMs: 60_000,
        heartbeatMs: 20_000,
        defaultMaxSteps: 4,
        turnTimeoutMs: 60_000,
      },
      agent: sixb.agents.getById("assistant")!,
      run: reclaimed,
      signal: new AbortController().signal,
    })

    const finalRun = await storage.runs.getById({ projectId: PROJECT_ID, id: request.runId })
    expect(finalRun?.status).toBe("succeeded")
    expect(finalRun?.attempt).toBe(2)
    expect(
      (await listMessages(storage, request.threadId)).filter((m) => m.role === "assistant")
    ).toHaveLength(1)

    const finalRecords = await listRunStreamRecords(sixb.broker, request.runId)
    const finalizedRecords = finalRecords.filter(
      (record) => record.name === "agent.message.finalized"
    )
    expect(finalizedRecords).toHaveLength(1)
    expect(finalizedRecords[0]?.payload).toMatchObject({
      type: "agent.message.finalized",
      runId: request.runId,
      attempt: 2,
    })
    const finishedRecords = finalRecords.filter((record) => record.name === "agent.run.finished")
    expect(finishedRecords).toHaveLength(1)
    expect(finishedRecords[0]?.payload).toMatchObject({
      type: "agent.run.finished",
      status: "succeeded",
      runId: request.runId,
      attempt: 2,
    })
  })

  test("fails the run and releases the thread when a turn exceeds its wall-clock budget", async () => {
    const sixb = buildSixb(hangingModel())
    const storage = agentStorageOf(sixb)

    const worker = new AgentWorker(sixb, workerOptions({ turnTimeoutMs: 50 }))
    await worker.start()
    try {
      const { threadId } = await sixb.agents.request({ agentId: "assistant", text: "hang" })
      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "running" ? found : null
        },
        { label: "run timed out" }
      )

      expect(run.status).toBe("failed")
      expect(run.error).toContain("turn budget")
      expect(
        (await listRunStreamRecords(sixb.broker, run.id)).find(
          (record) => record.name === "agent.run.finished"
        )?.payload
      ).toMatchObject({
        type: "agent.run.finished",
        status: "failed",
        runId: run.id,
        attempt: 1,
      })
      // Thread released so a later message can run, and no assistant message was persisted.
      const thread = await storage.threads.getById({ projectId: PROJECT_ID, id: threadId })
      expect(thread?.activeRunId).toBeNull()
      const messages = await listMessages(storage, threadId)
      expect(messages.every((m) => m.role !== "assistant")).toBe(true)
    } finally {
      await worker.stop()
    }
  })

  test("holds a different turn behind a live active run without stealing it (single-flight, worker layer)", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    // A live run (valid, far-future lease) owns the thread, triggered by message "A".
    const {
      threadId,
      runId: activeRunId,
      triggerMessageId: triggerA,
    } = await sixb.agents.request({
      agentId: "assistant",
      text: "first",
    })
    const [queuedA] = await sixb.queues.agents.claim({
      projectId: PROJECT_ID,
      workerId: "test-drain",
      limit: 1,
      leaseMs: 60_000,
    })
    if (!queuedA) {
      throw new Error("expected queued first turn")
    }
    await sixb.queues.agents.complete({
      projectId: PROJECT_ID,
      jobId: queuedA.job.id,
      leaseId: queuedA.leaseId,
    })

    await storage.runs.reserve({
      id: activeRunId,
      projectId: PROJECT_ID,
      threadId,
      agentId: "assistant",
      triggerMessageId: triggerA,
      requestedByPrincipal: REQUESTER,
      lease: { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() + 300_000) },
    })

    // A redelivered job for a *different* trigger lands while that run is live. The worker must hold
    // it (single-flight), never reclaiming the still-leased run.
    await sixb.queues.agents.enqueue({
      projectId: PROJECT_ID,
      jobs: [
        {
          type: "agent.run.requested",
          payload: {
            agentId: "assistant",
            threadId,
            runId: createAgentRunId(),
            triggerMessageId: "trigger-B",
          },
        },
      ],
    })

    const worker = new AgentWorker(sixb, workerOptions({ tools: echoTool }))
    await worker.start()
    try {
      // Let the worker claim + hold the job (held jobs are rescheduled a full lease out, so B will
      // not run again inside the test window). The active run must be untouched: not reclaimed, no
      // second run created, and no assistant message written.
      await Bun.sleep(150)

      const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
      expect(list.runs).toHaveLength(1)
      expect(list.runs[0]?.id).toBe(activeRunId)
      expect(list.runs[0]?.status).toBe("running")
      expect(list.runs[0]?.attempt).toBe(1)
      const assistants = (await listMessages(storage, threadId)).filter(
        (m) => m.role === "assistant"
      )
      expect(assistants).toHaveLength(0)
    } finally {
      await worker.stop()
    }
  })
})

describe("finishRunOrThrow", () => {
  function finishingStorage(finish: AgentStorage["runs"]["finish"]): AgentStorage {
    return { runs: { finish } } as unknown as AgentStorage
  }

  const succeededInput = {
    projectId: PROJECT_ID,
    id: "agt_run_x",
    leaseId: "agt_lease_x",
    status: "succeeded",
  } as const

  test("raises AgentFinalizationError when an infra error persists across retries", async () => {
    const storage = finishingStorage(() => Promise.reject(new Error("db down")))
    await expect(finishRunOrThrow(storage, succeededInput)).rejects.toBeInstanceOf(
      AgentFinalizationError
    )
  })

  test("raises AgentLeaseLostError when the run is no longer ours (terminal storage error)", async () => {
    const storage = finishingStorage(() =>
      Promise.reject(new AgentStorageError("lease_lost", "gone"))
    )
    await expect(finishRunOrThrow(storage, succeededInput)).rejects.toBeInstanceOf(
      AgentLeaseLostError
    )
  })
})
