import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider"
import { exa } from "@sixb/connector-exa"
import { exaWebFetch, exaWebSearch } from "@sixb/connector-exa/agent-tools"
import {
  type AgentReasoningLevel,
  AgentRequestError,
  type AgentToolDefinition,
  type BlobStorage,
  type Broker,
  type CommandResult,
  type ConnectorDefinition,
  type CreateSandboxOptions,
  defineAgent,
  defineAgentStep,
  defineAgentTool,
  defineConnector,
  defineGroup,
  defineWorkflow,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type Queues,
  type RunCommandOptions,
  type Sandbox,
  type SandboxFactory,
  type SandboxFileRecord,
  Sixb,
  type SixbErrorContext,
  type Storage,
} from "@sixb/core"
import { type AgentRunStreamEvent, agentRunStreamId } from "@sixb/core/agents/streams"
import {
  type AgentsRuntime,
  createAgentRunExecutionToken,
  createAgentRunId,
  publishAgentRunCancel,
} from "@sixb/core/internal/agents"
import { attachSixbErrorReporter } from "@sixb/core/internal/error-reporting"
import type { EventsRuntime } from "@sixb/core/internal/events"
import {
  type AgentStorage,
  AgentStorageError,
  type AppendAgentMessageInput,
} from "@sixb/core/storage"
import { jsonSchema, type ToolSet, tool } from "ai"
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import { AgentWorker, type AgentWorkerOptions } from "../src"
import { loadAgentSkills } from "../src/agent-skills"
import { normalizeApiBaseUrl } from "../src/api-url"
import { prepareAgentAttachments } from "../src/attachments"
import { AgentExecutionLostError, AgentFinalizationError, AgentWorkerError } from "../src/errors"
import { finishRunOrThrow } from "../src/finalize"
import { reconcileAgentExecutionIdentity } from "../src/identity"
import { runAgentTurn } from "../src/run-agent-turn"
import { createConversationAgentEnvironment } from "../src/run-environment"
import { createBrokerStreamSink, NOOP_STREAM_SINK } from "../src/stream-sink"
import type { AgentWorkerContext, AgentWorkerSixb, AgentWorkerStorage } from "../src/types"
import { waitFor, writeProjectSkill } from "./helpers"

const PROJECT_ID = "agent-worker-tests"
const TEST_AGENT_API_BASE_URL = "http://localhost:3002/api/"
const REQUESTER = { type: "user", id: "usr_requester" } as const
const AGENT_RUNTIME_GROUP = defineGroup("agent-runtime", { label: "Agent runtime" })

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
}

function stream(chunks: LanguageModelV4StreamPart[]) {
  return { stream: convertArrayToReadableStream(chunks) }
}

function finish(unified: "stop" | "tool-calls"): LanguageModelV4StreamPart {
  return { type: "finish", finishReason: { unified, raw: unified }, usage: USAGE }
}

/**
 * A model that, on its first call, calls the `echo` tool, then on its second call answers with
 * reasoning + text. A stateful `doStream` (not the array form) guarantees per-call ordering.
 */
function toolThenAnswerModel(captureReplay?: (prompt: string) => void): MockLanguageModelV4 {
  let call = 0
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: async (options) => {
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
      if (call === 3) {
        captureReplay?.(JSON.stringify(options.prompt))
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

function webSearchThenAnswerModel(): MockLanguageModelV4 {
  let call = 0
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: async () => {
      call += 1
      if (call === 1) {
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "web-search-call",
            toolName: "web_search",
            input: JSON.stringify({ query: "sixb connector tools" }),
          },
          finish("tool-calls"),
        ])
      }
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "Search complete" },
        { type: "text-end", id: "answer" },
        finish("stop"),
      ])
    },
  })
}

function webFetchThenAnswerModel(
  config: { readonly captureReplay?: (prompt: string) => void; readonly url?: string } = {}
): MockLanguageModelV4 {
  let call = 0
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: async (options) => {
      call += 1
      if (call === 1) {
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "web-fetch-call",
            toolName: "web_fetch",
            input: JSON.stringify({ url: config.url ?? "https://sixb.ai/docs" }),
          },
          finish("tool-calls"),
        ])
      }
      if (call === 3) config.captureReplay?.(JSON.stringify(options.prompt))
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: `answer-${call}` },
        { type: "text-delta", id: `answer-${call}`, delta: "Fetch complete" },
        { type: "text-end", id: `answer-${call}` },
        finish("stop"),
      ])
    },
  })
}

function answerModel(captureTools?: (names: readonly string[]) => void): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: async (options) => {
      captureTools?.((options.tools ?? []).map((tool) => tool.name))
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "Done" },
        { type: "text-end", id: "answer" },
        finish("stop"),
      ])
    },
  })
}

function failingToolThenAnswerModel(captureReplay: (prompt: string) => void): MockLanguageModelV4 {
  let call = 0
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: async (options) => {
      call += 1
      if (call === 1) {
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "invalid-result-call",
            toolName: "invalid_result",
            input: JSON.stringify({}),
          },
          finish("tool-calls"),
        ])
      }
      if (call === 3) {
        captureReplay(JSON.stringify(options.prompt))
      }
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: `answer-${call}` },
        { type: "text-delta", id: `answer-${call}`, delta: "Recovered" },
        { type: "text-end", id: `answer-${call}` },
        finish("stop"),
      ])
    },
  })
}

function slowAnswerModel(delayMs: number): MockLanguageModelV4 {
  let call = 0
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: async () => {
      call += 1
      await Bun.sleep(delayMs)
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: `slow-${call}` },
        { type: "text-delta", id: `slow-${call}`, delta: `Slow answer ${call}` },
        { type: "text-end", id: `slow-${call}` },
        finish("stop"),
      ])
    },
  })
}

function toolOnlyModel(): MockLanguageModelV4 {
  let call = 0
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: async () => {
      call += 1
      return stream([
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: `tool-only-${call}`,
          toolName: "echo",
          input: JSON.stringify({ value: `step-${call}` }),
        },
        finish("tool-calls"),
      ])
    },
  })
}

function structuredToolThenAnswerModel(
  captureSystem?: (system: string | undefined) => void
): MockLanguageModelV4 {
  let call = 0
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doGenerate: async (options) => {
      captureSystem?.(options.prompt.find((message) => message.role === "system")?.content)
      call += 1
      if (call === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "workflow-lookup",
              toolName: "lookup_project",
              input: JSON.stringify({ query: "alpha" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage: USAGE,
          warnings: [],
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ answer: "Project Alpha", confidence: 0.96 }),
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        warnings: [],
      }
    },
  })
}

function bashThenAnswerModel(): MockLanguageModelV4 {
  let call = 0
  return new MockLanguageModelV4({
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

function outputBashThenAnswerModel(): MockLanguageModelV4 {
  let call = 0
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: async () => {
      call += 1
      if (call === 1) {
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "bash-output-call-1",
            toolName: "bash",
            input: JSON.stringify({ command: "create-agent-output" }),
          },
          finish("tool-calls"),
        ])
      }
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "I created the report." },
        { type: "text-end", id: "t" },
        finish("stop"),
      ])
    },
  })
}

function apiBashThenAnswerModel(
  captureSystem?: (system: string | undefined) => void
): MockLanguageModelV4 {
  let call = 0
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: async (options) => {
      captureSystem?.(options.prompt.find((message) => message.role === "system")?.content)
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
  readonly model: MockLanguageModelV4
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
    model: new MockLanguageModelV4({
      modelId: "mock-model",
      doStream: async (options) => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
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

// Streams `partial` text and then blocks until the turn is aborted, so a cancel lands mid-response
// with real streamed content to persist.
function partialTextThenBlockingModel(partial: string): {
  readonly model: MockLanguageModelV4
  waitForStarted(): Promise<void>
} {
  let started = 0
  const waiters: Array<() => void> = []
  return {
    model: new MockLanguageModelV4({
      modelId: "mock-model",
      doStream: async (options) => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            started += 1
            for (const resolve of waiters.splice(0)) resolve()
            controller.enqueue({ type: "stream-start", warnings: [] })
            controller.enqueue({ type: "text-start", id: "t1" })
            controller.enqueue({ type: "text-delta", id: "t1", delta: partial })
            // No text-end / finish: the turn hangs here until the abort signal errors the stream.
            const abort = () => controller.error(new DOMException("Aborted", "AbortError"))
            if (options.abortSignal?.aborted) {
              abort()
            } else {
              options.abortSignal?.addEventListener("abort", abort, { once: true })
            }
          },
        }),
      }),
    }),
    waitForStarted() {
      if (started >= 1) return Promise.resolve()
      return new Promise((resolve) => waiters.push(resolve))
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

const echoAgentTool = defineAgentTool("echo")
  .description("Echo a value back.")
  .input({ value: "string" })
  .run(({ input }) => ({ echoed: input.value }))

// Sixb's generics overflow TS2589 when instantiated with an empty ontology in a test; we only need a
// structural `AgentWorkerSixb`, so we construct through a narrowed constructor cast (as the
// action-worker tests do).
interface TestSixb {
  readonly id: string
  readonly projectRoot: string
  readonly broker: Broker
  readonly events: EventsRuntime
  readonly storage: Storage
  readonly queues: Queues
  readonly agents: AgentsRuntime
  readonly blobStorage: BlobStorage
  readonly sandboxes?: SandboxFactory
  readonly logs: NonNullable<AgentWorkerSixb["logs"]>
  readonly ontology: NonNullable<AgentWorkerSixb["ontology"]>
  readonly connector: AgentWorkerSixb["connector"]
}

const SixbCtor = Sixb as unknown as new (options: Record<string, unknown>) => TestSixb

function workerOptions(
  options: Omit<AgentWorkerOptions, "apiBaseUrl"> & { readonly apiBaseUrl?: string } = {}
): AgentWorkerOptions {
  return {
    ...options,
    apiBaseUrl: options.apiBaseUrl ?? TEST_AGENT_API_BASE_URL,
    idlePollMs: options.idlePollMs ?? 5,
  }
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
  readonly writtenFiles: SandboxFileRecord[] = []
  readonly outputFiles = new Map<string, Uint8Array>()
  readonly outputListedSizeOverrides = new Map<string, number>()
  destroyed = false

  constructor(id: string) {
    this.id = id
    this.workingDirectory = `/tmp/sixb-recording-sandbox/${id}`
  }

  /** Read a materialized file's text back, mirroring what a subsequent runCommand would see. */
  readFileContents(path: string): string {
    const record = this.writtenFiles.find((file) => file.path === path)
    if (!record) {
      throw new Error(`[test] sandbox did not materialize ${path}`)
    }
    return typeof record.contents === "string"
      ? record.contents
      : new TextDecoder().decode(record.contents)
  }

  async writeFiles(files: readonly SandboxFileRecord[]): Promise<void> {
    this.writtenFiles.push(...files)
  }

  writeOutputFile(relativePath: string, contents: string | Uint8Array): void {
    this.outputFiles.set(
      relativePath,
      typeof contents === "string" ? new TextEncoder().encode(contents) : contents
    )
  }

  async runCommand(command: string, args: readonly string[] = [], options: RunCommandOptions = {}) {
    this.commands.push({ command, args, options })
    const script = args.at(-1)
    if (command === "bash" && script === "create-agent-output") {
      this.writeOutputFile("report.txt", "generated report")
      return {
        exitCode: 0,
        stdout: "created report.txt",
        stderr: "",
        durationMs: 1,
      }
    }
    if (
      command === "bash" &&
      typeof script === "string" &&
      script.includes("sixb-list-agent-output-files")
    ) {
      return {
        exitCode: 0,
        stdout: [...this.outputFiles.entries()]
          .filter(([relativePath]) => relativePath !== ".keep")
          .sort(([left], [right]) => left.localeCompare(right))
          .map(
            ([relativePath, bytes]) =>
              `${this.outputListedSizeOverrides.get(relativePath) ?? bytes.byteLength}\t${Buffer.from(
                relativePath,
                "utf-8"
              ).toString("base64")}`
          )
          .join("\n"),
        stderr: "",
        durationMs: 1,
      }
    }
    if (
      command === "bash" &&
      typeof script === "string" &&
      script.includes("sixb-read-agent-output-file")
    ) {
      const encoded = options.env?.SIXB_OUTPUT_REL_B64
      const relativePath = encoded ? Buffer.from(encoded, "base64").toString("utf-8") : ""
      const bytes = this.outputFiles.get(relativePath)
      return bytes
        ? {
            exitCode: 0,
            stdout: Buffer.from(bytes).toString("base64"),
            stderr: "",
            durationMs: 1,
          }
        : {
            exitCode: 2,
            stdout: "",
            stderr: "output file not found",
            durationMs: 1,
          }
    }
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
          `attachments=${env.SIXB_ATTACHMENTS ?? ""}`,
          `attachmentDir=${env.SIXB_ATTACHMENT_DIR ?? ""}`,
          `outputStagingDir=${env.SIXB_OUTPUT_STAGING_DIR ?? ""}`,
          `outputDir=${env.SIXB_OUTPUT_DIR ?? ""}`,
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

class BlockingOutputCollectionSandbox extends RecordingSandbox {
  readonly listStarted: Promise<void>
  private markListStarted!: () => void

  constructor(id: string) {
    super(id)
    this.listStarted = new Promise((resolve) => {
      this.markListStarted = resolve
    })
  }

  override async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    const script = args.at(-1)
    if (
      command === "bash" &&
      typeof script === "string" &&
      script.includes("sixb-list-agent-output-files")
    ) {
      this.commands.push({ command, args, options })
      this.markListStarted()
      return new Promise((resolve) => {
        const finish = (): void =>
          resolve({ exitCode: 137, stdout: "", stderr: "cancelled", durationMs: 1 })
        if (options.signal?.aborted) {
          finish()
        } else {
          options.signal?.addEventListener("abort", finish, { once: true })
        }
      })
    }
    return super.runCommand(command, args, options)
  }
}

class BlockingOutputCollectionSandboxFactory implements SandboxFactory {
  readonly sandbox = new BlockingOutputCollectionSandbox("blocking-output-collection")

  async create(): Promise<Sandbox> {
    return this.sandbox
  }
}

class OversizedOutputSandboxFactory extends RecordingSandboxFactory {
  override async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    const sandbox = (await super.create(options)) as RecordingSandbox
    sandbox.outputListedSizeOverrides.set("report.txt", 25 * 1024 * 1024 + 1)
    return sandbox
  }
}

/** A factory whose provisioning always fails (e.g. missing isolation backend). */
class FailingSandboxFactory implements SandboxFactory {
  async create(): Promise<Sandbox> {
    throw new Error("sandbox provisioning unavailable")
  }
}

function buildSixb(
  model: LanguageModelV4,
  broker: Broker = new InMemoryBroker(),
  sandboxes: SandboxFactory = new RecordingSandboxFactory(),
  options: {
    readonly reasoning?: AgentReasoningLevel
    readonly providerOptions?: LanguageModelV4CallOptions["providerOptions"]
    readonly projectRoot?: string
    readonly agentTools?: readonly AgentToolDefinition[]
    readonly connectors?: readonly ConnectorDefinition[]
  } = {}
): TestSixb {
  const agent = defineAgent("assistant", {
    name: "Assistant",
    model,
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions }),
    instructions: "You are a helpful test assistant.",
    groups: [AGENT_RUNTIME_GROUP],
    ...(options.agentTools === undefined ? {} : { tools: options.agentTools }),
    loop: { stopWhen: { maxSteps: 4 } },
  })
  return new SixbCtor({
    id: PROJECT_ID,
    ontology: [],
    agents: [agent],
    ...(options.connectors === undefined ? {} : { connectors: options.connectors }),
    groups: [AGENT_RUNTIME_GROUP],
    broker,
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    sandboxes,
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
  })
}

function buildSixbWithEchoTool(
  model: LanguageModelV4,
  broker: Broker = new InMemoryBroker(),
  sandboxes: SandboxFactory = new RecordingSandboxFactory()
): TestSixb {
  return buildSixb(model, broker, sandboxes, { agentTools: [echoAgentTool] })
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
  input: { readonly apiBaseUrl?: string } = {}
): AgentWorkerContext {
  if (!sixb.sandboxes) {
    throw new Error("expected sandbox factory")
  }
  return {
    id: sixb.id,
    storage: workerStorageOf(sixb.storage),
    blobStorage: sixb.blobStorage,
    sandboxes: sixb.sandboxes,
    connector: (definition) => sixb.connector(definition),
    logs: sixb.logs,
    valueTypesById: sixb.ontology.getValueTypesById(),
    // Mirror the production boundary (worker.ts buildAgentContext): normalize the server base once.
    apiBaseUrl: normalizeApiBaseUrl(input.apiBaseUrl ?? TEST_AGENT_API_BASE_URL),
    streamSink: NOOP_STREAM_SINK,
    agentSkills: loadAgentSkills({ projectSkillsDir: false }),
    defaultMaxSteps: 4,
    turnTimeoutMs: 60_000,
  }
}

function freshTestExecution() {
  return {
    token: createAgentRunExecutionToken(),
    queueLeaseExpiresAt: new Date(Date.now() + 60_000),
  }
}

async function reserveRequestedRun(
  sixb: TestSixb,
  request: { readonly run: { readonly id: string } }
) {
  return agentStorageOf(sixb).runs.start({
    id: request.run.id,
    projectId: PROJECT_ID,
    execution: freshTestExecution(),
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
  return broker
    .read({
      projectId: PROJECT_ID,
      streamId: agentRunStreamId(runId),
    })
    .then((page) => page.records)
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
      create: (input) => agents.runs.create(input),
      start: (input) => agents.runs.start(input),
      finishQueued: (input) => agents.runs.finishQueued(input),
      reclaim: (input) => agents.runs.reclaim(input),
      confirmExecutionOwnership: (input) => agents.runs.confirmExecutionOwnership(input),
      getById: (params) => agents.runs.getById(params),
      getByIds: (params) => agents.runs.getByIds(params),
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
      create: (input) => agents.runs.create(input),
      start: (input) => agents.runs.start(input),
      finishQueued: (input) => agents.runs.finishQueued(input),
      reclaim: (input) => agents.runs.reclaim(input),
      confirmExecutionOwnership: (input) => agents.runs.confirmExecutionOwnership(input),
      getById: (params) => agents.runs.getById(params),
      getByIds: (params) => agents.runs.getByIds(params),
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
function hangingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: async (options) => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
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

  test("executes a headless workflow agent node and publishes its resume", async () => {
    let capturedSystem: string | undefined
    const model = structuredToolThenAnswerModel((system) => {
      capturedSystem = system
    })
    let lookupCalls = 0
    const lookupProject = defineAgentTool("lookup_project")
      .description("Look up a project.")
      .input({ query: "string" })
      .run(({ input, run }) => {
        lookupCalls += 1
        return { project: "Project Alpha", query: input.query, runId: run.id }
      })
    const agent = defineAgent("workflow-resolver", {
      name: "Workflow resolver",
      model,
      instructions: "Resolve the best project.",
      groups: [AGENT_RUNTIME_GROUP],
      tools: [lookupProject],
    })
    const agentStep = defineAgentStep("resolve-project", agent)
      .input({ query: "string" })
      .output({ answer: "string", confidence: "double" })
      .prompt(({ input }) => `Resolve '${input.query}'.`)
    const workflow = defineWorkflow("resolve-project-workflow")
      .input({ query: "string" })
      .then(agentStep)
    const sixb = new SixbCtor({
      id: PROJECT_ID,
      ontology: [],
      agents: [agent],
      workflows: [workflow],
      groups: [AGENT_RUNTIME_GROUP],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      sandboxes: new RecordingSandboxFactory(),
    })
    const runs = sixb.storage.workflowRuns!
    const runId = "workflow-agent-run"
    const nodeRunId = `${runId}:node:0`
    await runs.start({
      id: runId,
      projectId: PROJECT_ID,
      workflowId: workflow.id,
      input: { query: "alpha" },
    })
    await runs.nodes.start({
      id: nodeRunId,
      projectId: PROJECT_ID,
      workflowRunId: runId,
      workflowId: workflow.id,
      nodeIndex: 0,
      nodeType: "agent",
      nodeId: agentStep.id,
      nodeKey: "resolveProject",
      input: { query: "alpha" },
    })
    await runs.agentNodes.create({
      projectId: PROJECT_ID,
      nodeRunId,
      agentId: agent.id,
      prompt: "Resolve 'alpha'.",
    })
    await runs.nodes.wait({ projectId: PROJECT_ID, id: nodeRunId })
    await runs.wait({ projectId: PROJECT_ID, id: runId })
    await sixb.queues.agents.enqueue({
      projectId: PROJECT_ID,
      jobs: [
        {
          id: `wfa_job_${nodeRunId}`,
          type: "agent.workflow-node.requested",
          payload: { agentId: agent.id, nodeRunId },
        },
      ],
    })

    const worker = new AgentWorker(sixb, workerOptions({ skillsDir: false }))
    await worker.start()
    try {
      const execution = await waitFor(
        async () => {
          const record = await runs.agentNodes.getByNodeRunId({
            projectId: PROJECT_ID,
            nodeRunId,
          })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "workflow agent node terminal" }
      )
      expect(execution).toMatchObject({
        status: "succeeded",
        agentId: agent.id,
        modelId: "mock-model",
        finishReason: "stop",
        attempt: 1,
      })
      expect(execution.execution).toBeUndefined()
      expect(execution.trace).toBeArray()
      expect(lookupCalls).toBe(1)
      expect(execution.trace).toContainEqual(
        expect.objectContaining({
          type: "tool-call",
          toolName: lookupProject.name,
          state: "output-available",
          output: {
            project: "Project Alpha",
            query: "alpha",
            runId: nodeRunId,
          },
        })
      )
      expect(capturedSystem).toContain("Execution mode: workflow-task")
      expect(capturedSystem).toContain("headless Sixb workflow agent")
      expect(capturedSystem).toContain("Do not ask a user follow-up question")
      expect(await runs.nodes.getById({ projectId: PROJECT_ID, id: nodeRunId })).toMatchObject({
        status: "succeeded",
        output: { answer: "Project Alpha", confidence: 0.96 },
      })
      const [resume] = await sixb.queues.workflows.claim({
        projectId: PROJECT_ID,
        workerId: "workflow-test-worker",
      })
      expect(resume?.job).toMatchObject({
        type: "workflow.run.resume.requested",
        payload: {
          runId,
          workflowId: workflow.id,
          resume: { kind: "agentNode", nodeRunId },
        },
      })
    } finally {
      await worker.stop()
    }
  })

  test("fails startup when a project Agent Skill is invalid", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "sixb-agent-skills-startup-"))
    try {
      await writeProjectSkill(
        projectRoot,
        "acme-style",
        ["---", "name: acme-style", "---", "", "# Acme Style"].join("\n")
      )
      const worker = new AgentWorker(
        buildSixb(toolThenAnswerModel(), new InMemoryBroker(), new RecordingSandboxFactory(), {
          projectRoot,
        }),
        workerOptions()
      )

      await expect(worker.start()).rejects.toThrow("[SixbAgentWorker] Agent skill")
      await worker.stop()
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test("attributes a managed service account to the agent worker, not to system at large", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const agent = sixb.agents.getById("assistant")
    if (!agent) {
      throw new Error("Expected test agent.")
    }
    const context = buildAgentWorkerContext(sixb, { apiBaseUrl: "http://sixb-api.local/api/" })
    const identity = await reconcileAgentExecutionIdentity(context.storage, PROJECT_ID, agent)
    // Audit attribution must stay the worker's own identity, distinct from the generic core
    // SYSTEM_PRINCIPAL ({ id: "system" }) — a shared-literal refactor once silently flattened it.
    expect(identity.serviceAccount.createdByPrincipal).toEqual({
      type: "system",
      id: "agent-worker",
    })
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
      createConversationAgentEnvironment({ context, agent, run: firstRun }),
      createConversationAgentEnvironment({ context, agent, run: secondRun }),
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
      expect(systemAddendum).toContain("Execution mode: conversation")
      expect(systemAddendum).toContain("Use $SIXB_SKILLS_DIR and attachment/output env vars")
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

  test("materializes message attachments and manifest into the sandbox", async () => {
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(toolThenAnswerModel(), new InMemoryBroker(), sandboxes)
    const agent = sixb.agents.getById("assistant")
    if (!agent) {
      throw new Error("Expected test agent.")
    }
    const fileRef = await sixb.blobStorage.put({
      body: new TextEncoder().encode("attachment contents"),
      fileName: "note.txt",
      mediaType: "text/plain",
    })
    const request = await sixb.agents.request({
      agentId: "assistant",
      text: "read this",
      attachments: [fileRef],
    })
    const run = await reserveRequestedRun(sixb, request)
    const context = buildAgentWorkerContext(sixb, { apiBaseUrl: "http://sixb-api.local/api/" })

    const environment = await createConversationAgentEnvironment({ context, agent, run })
    try {
      await environment.turnContext.sandboxReady
      const sandbox = sandboxes.sandboxes[0]
      if (!sandbox) {
        throw new Error("Expected sandbox.")
      }
      const attachmentFile = sandbox.writtenFiles.find((file) => file.path.endsWith("1-note.txt"))
      expect(attachmentFile).toBeDefined()
      expect(sandbox.readFileContents(attachmentFile!.path)).toBe("attachment contents")

      const manifestFile = sandbox.writtenFiles.find((file) =>
        file.path.endsWith(".sixb/agent/context/attachments.json")
      )
      expect(manifestFile).toBeDefined()
      const manifest = JSON.parse(sandbox.readFileContents(manifestFile!.path))
      expect(manifest.attachments).toHaveLength(1)
      expect(manifest.attachments[0]).toMatchObject({
        messageId: request.run.triggerMessageId,
        fileName: "note.txt",
        mediaType: "text/plain",
        inlineDisposition: "text",
      })
      expect(manifest.attachments[0].sandboxPath).toStartWith(".sixb/agent/attachments/")
      expect(manifest.attachments[0].sandboxPath).toEndWith("1-note.txt")
      expect(manifest.attachments[0].contentUrl).toContain("/__sixb/agent-api/")
    } finally {
      await environment.dispose()
    }
  })

  test("adds text attachment context to model prompts", async () => {
    let capturedPrompt: unknown
    const model = new MockLanguageModelV4({
      modelId: "mock-model",
      doStream: async (options) => {
        capturedPrompt = options.prompt
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
    const fileRef = await sixb.blobStorage.put({
      body: new TextEncoder().encode("invoice total: 42"),
      fileName: "invoice.txt",
      mediaType: "text/plain",
    })
    const request = await sixb.agents.request({
      agentId: "assistant",
      text: "summarize",
      attachments: [fileRef],
    })
    const run = await reserveRequestedRun(sixb, request)
    const context = buildAgentWorkerContext(sixb)
    const environment = await createConversationAgentEnvironment({
      context,
      agent: sixb.agents.getById("assistant")!,
      run,
    })
    try {
      await runAgentTurn({
        context: environment.turnContext,
        agent: sixb.agents.getById("assistant")!,
        run,
        signal: new AbortController().signal,
      })
    } finally {
      await environment.dispose()
    }

    const promptJson = JSON.stringify(capturedPrompt)
    expect(promptJson).toContain("<attachment")
    expect(promptJson).toContain("invoice.txt")
    expect(promptJson).toContain("invoice total: 42")
    expect(promptJson).toContain("contentUrl")
  })

  test("inlines supported images only when the Bun runtime provides image processing", async () => {
    let capturedPrompt: unknown
    const model = new MockLanguageModelV4({
      modelId: "mock-model",
      supportedUrls: { "image/*": [/^data:/] },
      doStream: async (options) => {
        capturedPrompt = options.prompt
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Saw image" },
          { type: "text-end", id: "t" },
          finish("stop"),
        ])
      },
    })
    const sixb = buildSixb(model)
    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64"
      )
    )
    const fileRef = await sixb.blobStorage.put({
      body: png,
      fileName: "pixel.png",
      mediaType: "image/png",
    })
    const request = await sixb.agents.request({
      agentId: "assistant",
      text: "describe",
      attachments: [fileRef],
    })
    const run = await reserveRequestedRun(sixb, request)
    const context = buildAgentWorkerContext(sixb)
    const environment = await createConversationAgentEnvironment({
      context,
      agent: sixb.agents.getById("assistant")!,
      run,
    })
    try {
      await runAgentTurn({
        context: environment.turnContext,
        agent: sixb.agents.getById("assistant")!,
        run,
        signal: new AbortController().signal,
      })
    } finally {
      await environment.dispose()
    }

    const promptJson = JSON.stringify(capturedPrompt)
    expect(promptJson).toContain("pixel.png")
    if (typeof Bun.Image === "function") {
      expect(promptJson).toContain('"type":"file"')
      expect(promptJson).toContain("image/png")
      expect(promptJson).toContain("iVBORw0KGgo")
    } else {
      expect(promptJson).not.toContain('"type":"file"')
      expect(promptJson).toContain("this Bun runtime does not provide image processing")
    }
  })

  test("keeps image attachments metadata-only when the model does not advertise images", async () => {
    let capturedPrompt: unknown
    const model = new MockLanguageModelV4({
      modelId: "mock-model",
      doStream: async (options) => {
        capturedPrompt = options.prompt
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
    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64"
      )
    )
    const fileRef = await sixb.blobStorage.put({
      body: png,
      fileName: "pixel.png",
      mediaType: "image/png",
    })
    const request = await sixb.agents.request({
      agentId: "assistant",
      text: "describe",
      attachments: [fileRef],
    })
    const run = await reserveRequestedRun(sixb, request)
    const context = buildAgentWorkerContext(sixb)
    const environment = await createConversationAgentEnvironment({
      context,
      agent: sixb.agents.getById("assistant")!,
      run,
    })
    try {
      await runAgentTurn({
        context: environment.turnContext,
        agent: sixb.agents.getById("assistant")!,
        run,
        signal: new AbortController().signal,
      })
    } finally {
      await environment.dispose()
    }

    const promptJson = JSON.stringify(capturedPrompt)
    expect(promptJson).toContain("pixel.png")
    expect(promptJson).toContain("does not advertise image input support")
    expect(promptJson).not.toContain('"type":"file"')
    expect(promptJson).not.toContain("iVBORw0KGgo")
  })

  test("keeps historical assistant files metadata-only and bounds their projection", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const fileRef = await blobStorage.put({
      body: new TextEncoder().encode("sensitive generated contents"),
      fileName: "generated.txt",
      mediaType: "text/plain",
      logicalPath: "reports/generated.txt",
    })
    const messages = Array.from({ length: 51 }, (_, index) => ({
      id: `assistant-${index}`,
      projectId: PROJECT_ID,
      threadId: "thread-1",
      runId: `run-${index}`,
      role: "assistant" as const,
      seq: index + 1,
      parts: [{ type: "file" as const, fileRef }],
      contentVersion: 1,
      createdAt: new Date(2026, 0, 1, 0, 0, index),
    }))

    const prepared = await prepareAgentAttachments({
      projectId: PROJECT_ID,
      threadId: "thread-1",
      messages,
      blobStorage,
      apiBaseUrl: TEST_AGENT_API_BASE_URL,
      inlineImages: true,
    })

    expect(prepared.entries).toHaveLength(50)
    expect(prepared.promptTextByPartKey.has("assistant-0:0")).toBe(false)
    expect(prepared.promptTextByPartKey.get("assistant-50:0")).toContain(
      "Generated file kept as metadata"
    )
    expect(JSON.stringify([...prepared.promptTextByPartKey.values()])).not.toContain(
      "sensitive generated contents"
    )
    expect(prepared.modelFileDataByPartKey.size).toBe(0)
  })

  test("provisions the sandbox concurrently without blocking turn start", async () => {
    // Gate sandbox creation so we can prove the turn context is ready before the
    // sandbox finishes booting. If creation were on the critical path, awaiting
    // createConversationAgentEnvironment below would hang until releaseCreate().
    let releaseCreate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    const recording = new RecordingSandboxFactory()
    const sandboxes: SandboxFactory = {
      async create(options: CreateSandboxOptions = {}) {
        await gate
        return recording.create(options)
      },
    }
    const sixb = buildSixb(toolThenAnswerModel(), new InMemoryBroker(), sandboxes)
    const agent = sixb.agents.getById("assistant")
    if (!agent) {
      throw new Error("Expected test agent.")
    }
    const request = await sixb.agents.request({ agentId: "assistant", text: "hi" })
    const run = await reserveRequestedRun(sixb, request)
    const context = buildAgentWorkerContext(sixb, { apiBaseUrl: "http://sixb-api.local/api/" })
    await reconcileAgentExecutionIdentity(context.storage, PROJECT_ID, agent)

    // Resolves while create() is still gated: the system prompt is ready and the
    // sandbox has not been built yet.
    const environment = await createConversationAgentEnvironment({ context, agent, run })
    expect(environment.turnContext.systemAddendum).toContain("Available Agent Skills")
    expect(recording.sandboxes).toHaveLength(0)

    try {
      // Boot completes -> the bash tool resolves the sandbox and runs.
      releaseCreate()
      const bash = await runBashTool(environment.turnContext, "echo hi")
      expect(bash.stdout).toContain("ran bash")
      expect(recording.sandboxes).toHaveLength(1)
    } finally {
      await environment.dispose()
    }
    expect(recording.sandboxes[0]?.destroyed).toBe(true)
  })

  test("dispose detaches an in-flight sandbox teardown that destroys once boot settles", async () => {
    // The "model answered before the sandbox finished booting" case: dispose must not stall on the
    // in-flight boot, but the teardown must not be orphaned either. It is handed to onDetachedTeardown
    // (which AgentWorker registers and drains on stop()). Here we assert that seam deterministically.
    let releaseCreate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    const recording = new RecordingSandboxFactory()
    const sandboxes: SandboxFactory = {
      async create(options: CreateSandboxOptions = {}) {
        await gate
        return recording.create(options)
      },
    }
    const sixb = buildSixb(toolThenAnswerModel(), new InMemoryBroker(), sandboxes)
    const agent = sixb.agents.getById("assistant")
    if (!agent) {
      throw new Error("Expected test agent.")
    }
    const request = await sixb.agents.request({ agentId: "assistant", text: "hi" })
    const run = await reserveRequestedRun(sixb, request)
    const context = buildAgentWorkerContext(sixb)
    await reconcileAgentExecutionIdentity(context.storage, PROJECT_ID, agent)

    let detached: Promise<void> | null = null
    const environment = await createConversationAgentEnvironment({
      context,
      agent,
      run,
      onDetachedTeardown: (teardown) => {
        detached = teardown
      },
    })

    // Dispose while boot is still gated (in flight): the teardown is detached, not awaited inline,
    // and nothing has been created or destroyed yet.
    await environment.dispose()
    if (!detached) {
      throw new Error("Expected dispose to detach the in-flight teardown.")
    }
    expect(recording.sandboxes).toHaveLength(0)

    // Let provisioning finish; the drained teardown then reaps the now-created sandbox.
    releaseCreate()
    await detached
    expect(recording.sandboxes).toHaveLength(1)
    expect(recording.sandboxes[0]?.destroyed).toBe(true)
  })

  test("trigger atomically persists the user message and queued run before dispatch", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    const result = await sixb.agents.request({
      agentId: "assistant",
      text: "hello",
      principal: REQUESTER,
    })

    expect(result.createdThread).toBe(true)
    expect(result.jobId).toBeDefined()
    expect(result.run.status).toBe("queued")
    expect(result.run.id.startsWith("agt_run_")).toBe(true)

    const messages = await listMessages(storage, result.run.threadId)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: "user", runId: null })
    expect(messages[0]?.authorPrincipal).toEqual(REQUESTER)
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "hello" }])

    const runs = await storage.runs.list({ projectId: PROJECT_ID, threadId: result.run.threadId })
    expect(runs.runs).toHaveLength(1)
    expect(runs.runs[0]).toMatchObject({ id: result.run.id, status: "queued", attempt: 0 })
    const thread = await storage.threads.getById({ projectId: PROJECT_ID, id: result.run.threadId })
    expect(thread?.activeRunId).toBe(result.run.id)
  })

  test("keeps the queued run visible when dispatch fails", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    sixb.queues.agents.enqueue = () => Promise.reject(new Error("queue unavailable"))

    const originalConsoleError = console.error
    console.error = () => {}
    let result: Awaited<ReturnType<typeof sixb.agents.request>>
    try {
      result = await sixb.agents.request({
        agentId: "assistant",
        text: "persist me",
        principal: REQUESTER,
      })
    } finally {
      console.error = originalConsoleError
    }
    expect(result.run.status).toBe("queued")
    expect(result.jobId).toBeUndefined()

    const threads = await storage.threads.list({ projectId: PROJECT_ID })
    expect(threads.threads).toHaveLength(1)
    const thread = threads.threads[0]
    if (!thread) throw new Error("expected durable thread")
    const runs = await storage.runs.list({ projectId: PROJECT_ID, threadId: thread.id })
    expect(runs.runs).toHaveLength(1)
    expect(runs.runs[0]).toMatchObject({ status: "queued", attempt: 0 })
    expect(thread.activeRunId).toBe(runs.runs[0]?.id)
    expect(await listMessages(storage, thread.id)).toHaveLength(1)
  })

  test("dispatches a durable queued run after the request-time enqueue fails", async () => {
    const sixb = buildSixbWithEchoTool(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    const queue = sixb.queues.agents
    const originalEnqueue = queue.enqueue.bind(queue)
    let enqueueCalls = 0
    queue.enqueue = (params) => {
      enqueueCalls += 1
      if (enqueueCalls === 1) return Promise.reject(new Error("queue unavailable"))
      return originalEnqueue(params)
    }

    const originalConsoleError = console.error
    console.error = () => {}
    let request: Awaited<ReturnType<typeof sixb.agents.request>>
    try {
      request = await sixb.agents.request({ agentId: "assistant", text: "recover me" })
    } finally {
      console.error = originalConsoleError
    }
    expect(request.jobId).toBeUndefined()

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const run = await waitFor(
        async () => {
          const record = await storage.runs.getById({ projectId: PROJECT_ID, id: request.run.id })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "recovered dispatch terminal" }
      )
      expect(run.status).toBe("succeeded")
      expect(enqueueCalls).toBeGreaterThanOrEqual(2)
    } finally {
      await worker.stop()
    }
  })

  test("runs only the current agent's selected tools with connector, metadata, and logs", async () => {
    let connectorCalls = 0
    const knowledge = defineConnector("knowledge", {
      type: "knowledge",
      connect() {
        connectorCalls += 1
        return { echo: (value: string) => `connected:${value}` }
      },
    })
    let handlerContext:
      | { readonly runId: string; readonly agentId: string; readonly threadId?: string }
      | undefined
    let handlerSignal: AbortSignal | undefined
    let selectedCalls = 0
    let successfulReplay = ""
    const selectedEcho = defineAgentTool("echo")
      .description("Echo through the registered knowledge connector.")
      .input({ value: "string" })
      .run(async ({ input, run, signal, connector, logger }) => {
        selectedCalls += 1
        handlerContext = { runId: run.id, agentId: run.agentId, threadId: run.threadId }
        handlerSignal = signal
        const client = await connector(knowledge)
        logger.info("selected tool called", { value: input.value })
        return { echoed: client.echo(input.value) }
      })
    const research = defineAgent("research", {
      name: "Research",
      model: toolThenAnswerModel((prompt) => {
        successfulReplay = prompt
      }),
      instructions: "Research with selected tools.",
      groups: [AGENT_RUNTIME_GROUP],
      tools: [selectedEcho],
    })
    let unselectedToolNames: readonly string[] = []
    const plain = defineAgent("plain", {
      name: "Plain",
      model: answerModel((names) => {
        unselectedToolNames = names
      }),
      instructions: "Answer without the research tool.",
      groups: [AGENT_RUNTIME_GROUP],
    })
    const sixb = new SixbCtor({
      id: PROJECT_ID,
      ontology: [],
      agents: [research, plain],
      connectors: [knowledge],
      groups: [AGENT_RUNTIME_GROUP],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      sandboxes: new RecordingSandboxFactory(),
    })
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions({ skillsDir: false }))
    await worker.start()
    try {
      const selectedRequest = await sixb.agents.request({ agentId: research.id, text: "echo hi" })
      const selectedRun = await waitFor(
        async () => {
          const record = await storage.runs.getById({
            projectId: PROJECT_ID,
            id: selectedRequest.run.id,
          })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "selected tool run terminal" }
      )
      const plainRequest = await sixb.agents.request({ agentId: plain.id, text: "answer" })
      await waitFor(
        async () => {
          const record = await storage.runs.getById({
            projectId: PROJECT_ID,
            id: plainRequest.run.id,
          })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "unselected agent run terminal" }
      )

      expect(selectedRun.status).toBe("succeeded")
      expect(selectedCalls).toBe(1)
      expect(connectorCalls).toBe(1)
      expect(handlerSignal).toBeInstanceOf(AbortSignal)
      expect(handlerContext).toEqual({
        runId: selectedRequest.run.id,
        agentId: research.id,
        threadId: selectedRequest.run.threadId,
      })
      expect(unselectedToolNames).toContain("bash")
      expect(unselectedToolNames).not.toContain(selectedEcho.name)

      const messages = await listMessages(storage, selectedRequest.run.threadId)
      expect(
        messages
          .find((message) => message.role === "assistant")
          ?.parts.find((part) => part.type === "tool-call" && part.toolName === selectedEcho.name)
      ).toMatchObject({
        state: "output-available",
        input: { value: "hi" },
        output: { echoed: "connected:hi" },
      })

      const followUp = await sixb.agents.request({
        agentId: research.id,
        threadId: selectedRequest.run.threadId,
        text: "continue",
      })
      await waitFor(
        async () => {
          const record = await storage.runs.getById({ projectId: PROJECT_ID, id: followUp.run.id })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "successful selected tool replay terminal" }
      )
      expect(successfulReplay).toContain(selectedEcho.name)
      expect(successfulReplay).toContain("connected:hi")

      const logs = await waitFor(
        async () => {
          const page = await sixb.logs.read({
            run: { kind: "agent", id: selectedRequest.run.id },
          })
          return page.lines.length > 0 ? page.lines : null
        },
        { label: "selected tool logs flushed" }
      )
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatchObject({
        level: "info",
        message: "selected tool called",
        fields: {
          agentId: research.id,
          threadId: selectedRequest.run.threadId,
          value: "hi",
        },
        context: { run: { kind: "agent", id: selectedRequest.run.id } },
      })
    } finally {
      await worker.stop()
    }
  })

  test("runs a bounded Exa web_search through a registered connector", async () => {
    const originalFetch = globalThis.fetch
    let requestHeaders: Headers | undefined
    let requestBody: unknown
    let worker: AgentWorker | undefined
    try {
      globalThis.fetch = (async (_input, init) => {
        requestHeaders = new Headers(init?.headers)
        requestBody = JSON.parse(String(init?.body))
        return Response.json({
          results: [
            {
              id: "https://sixb.ai/docs",
              title: "Sixb docs",
              url: "https://sixb.ai/docs",
              author: "Sixb",
              publishedDate: "2026-08-03",
              text: "connector-backed search content",
            },
          ],
          requestId: "exa-request-1",
          costDollars: { total: 0.008 },
        })
      }) as typeof fetch
      const exaConnector = defineConnector("exa", exa({ apiKey: "exa-test-key" }))
      const webSearch = exaWebSearch(exaConnector, {
        maxResults: 1,
        maxCharactersPerResult: 12,
        maxTotalCharacters: 12,
        timeoutMs: 1_000,
      })
      const sixb = buildSixb(
        webSearchThenAnswerModel(),
        new InMemoryBroker(),
        new RecordingSandboxFactory(),
        { agentTools: [webSearch], connectors: [exaConnector] }
      )
      const storage = agentStorageOf(sixb)
      worker = new AgentWorker(sixb, workerOptions({ skillsDir: false }))
      await worker.start()
      const request = await sixb.agents.request({
        agentId: "assistant",
        text: "search for connector tools",
      })
      const run = await waitFor(
        async () => {
          const record = await storage.runs.getById({
            projectId: PROJECT_ID,
            id: request.run.id,
          })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "Exa web_search run terminal" }
      )

      expect(run.status).toBe("succeeded")
      expect(requestHeaders?.get("x-api-key")).toBe("exa-test-key")
      expect(requestBody).toEqual({
        query: "sixb connector tools",
        numResults: 1,
        contents: { text: { maxCharacters: 12 } },
      })
      const messages = await listMessages(storage, request.run.threadId)
      expect(
        messages
          .find((message) => message.role === "assistant")
          ?.parts.find((part) => part.type === "tool-call" && part.toolName === "web_search")
      ).toMatchObject({
        state: "output-available",
        input: { query: "sixb connector tools" },
        output: {
          results: [
            {
              title: "Sixb docs",
              url: "https://sixb.ai/docs",
              author: "Sixb",
              publishedDate: "2026-08-03",
              text: "connector-ba",
            },
          ],
          requestId: "exa-request-1",
          costDollars: { total: 0.008 },
        },
      })
    } finally {
      await worker?.stop()
      globalThis.fetch = originalFetch
    }
  })

  test("runs and replays a bounded Exa web_fetch through a registered connector", async () => {
    const originalFetch = globalThis.fetch
    let requestHeaders: Headers | undefined
    let requestBody: unknown
    let replayedPrompt = ""
    let worker: AgentWorker | undefined
    try {
      globalThis.fetch = (async (_input, init) => {
        requestHeaders = new Headers(init?.headers)
        requestBody = JSON.parse(String(init?.body))
        return Response.json({
          results: [
            {
              id: "https://sixb.ai/docs",
              title: "Sixb docs",
              url: "https://sixb.ai/docs",
              text: "connector-backed fetch content",
            },
          ],
          statuses: [
            {
              id: "https://sixb.ai/docs",
              status: "success",
              source: "cached",
            },
          ],
          requestId: "exa-contents-request-1",
          costDollars: { total: 0.001 },
        })
      }) as typeof fetch
      const exaConnector = defineConnector("exa", exa({ apiKey: "exa-test-key" }))
      const webFetch = exaWebFetch(exaConnector, {
        maxCharacters: 12,
        timeoutMs: 1_000,
        allowedDomains: ["sixb.ai"],
      })
      const sixb = buildSixb(
        webFetchThenAnswerModel({
          captureReplay(prompt) {
            replayedPrompt = prompt
          },
        }),
        new InMemoryBroker(),
        new RecordingSandboxFactory(),
        { agentTools: [webFetch], connectors: [exaConnector] }
      )
      const storage = agentStorageOf(sixb)
      worker = new AgentWorker(sixb, workerOptions({ skillsDir: false }))
      await worker.start()
      const request = await sixb.agents.request({
        agentId: "assistant",
        text: "fetch the Sixb docs",
      })
      const run = await waitFor(
        async () => {
          const record = await storage.runs.getById({
            projectId: PROJECT_ID,
            id: request.run.id,
          })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "Exa web_fetch run terminal" }
      )

      expect(run.status).toBe("succeeded")
      expect(requestHeaders?.get("x-api-key")).toBe("exa-test-key")
      expect(requestBody).toEqual({
        urls: ["https://sixb.ai/docs"],
        text: { maxCharacters: 12 },
        subpages: 0,
      })
      const messages = await listMessages(storage, request.run.threadId)
      expect(
        messages
          .find((message) => message.role === "assistant")
          ?.parts.find((part) => part.type === "tool-call" && part.toolName === "web_fetch")
      ).toMatchObject({
        state: "output-available",
        input: { url: "https://sixb.ai/docs" },
        output: {
          title: "Sixb docs",
          url: "https://sixb.ai/docs",
          content: "connector-ba",
          status: { status: "success", source: "cached" },
          requestId: "exa-contents-request-1",
          costDollars: { total: 0.001 },
        },
      })

      const followUp = await sixb.agents.request({
        agentId: "assistant",
        threadId: request.run.threadId,
        text: "continue",
      })
      await waitFor(
        async () => {
          const record = await storage.runs.getById({
            projectId: PROJECT_ID,
            id: followUp.run.id,
          })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "Exa web_fetch replay terminal" }
      )
      expect(replayedPrompt).toContain("web_fetch")
      expect(replayedPrompt).toContain("connector-ba")
    } finally {
      await worker?.stop()
      globalThis.fetch = originalFetch
    }
  })

  test("preserves actionable Exa web_fetch errors through the worker", async () => {
    const exaConnector = defineConnector("exa", exa({ apiKey: "exa-test-key" }))
    const webFetch = exaWebFetch(exaConnector, { allowedDomains: ["sixb.ai"] })
    const sixb = buildSixb(
      webFetchThenAnswerModel({ url: "https://outside.example/docs" }),
      new InMemoryBroker(),
      new RecordingSandboxFactory(),
      { agentTools: [webFetch], connectors: [exaConnector] }
    )
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions({ skillsDir: false }))

    await worker.start()
    try {
      const request = await sixb.agents.request({
        agentId: "assistant",
        text: "fetch a URL outside the policy",
      })
      const run = await waitFor(
        async () => {
          const record = await storage.runs.getById({
            projectId: PROJECT_ID,
            id: request.run.id,
          })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "Exa web_fetch policy failure terminal" }
      )

      expect(run.status).toBe("succeeded")
      const messages = await listMessages(storage, request.run.threadId)
      expect(
        messages
          .find((message) => message.role === "assistant")
          ?.parts.find((part) => part.type === "tool-call" && part.toolName === "web_fetch")
      ).toMatchObject({
        state: "output-error",
        errorText:
          '[SixbExa] web_fetch requested URL is outside the allowed domain policy: "outside.example".',
      })
    } finally {
      await worker.stop()
    }
  })

  test("persists and replays selected tool failures with clear non-JSON diagnostics", async () => {
    let replayedPrompt = ""
    const invalidResult = {
      kind: "agentTool",
      name: "invalid_result",
      description: "Return an invalid result.",
      input: {},
      handler: async () => ({ invalid: undefined }),
    } as unknown as AgentToolDefinition
    const sixb = buildSixb(
      failingToolThenAnswerModel((prompt) => {
        replayedPrompt = prompt
      }),
      new InMemoryBroker(),
      new RecordingSandboxFactory(),
      { agentTools: [invalidResult] }
    )
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions({ skillsDir: false }))
    await worker.start()
    try {
      const first = await sixb.agents.request({ agentId: "assistant", text: "run the tool" })
      const firstRun = await waitFor(
        async () => {
          const record = await storage.runs.getById({ projectId: PROJECT_ID, id: first.run.id })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "invalid selected tool run terminal" }
      )
      expect(firstRun.status).toBe("succeeded")

      const firstAssistant = (await listMessages(storage, first.run.threadId)).find(
        (message) => message.role === "assistant"
      )
      expect(
        firstAssistant?.parts.find(
          (part) => part.type === "tool-call" && part.toolName === invalidResult.name
        )
      ).toMatchObject({
        state: "output-error",
        errorText:
          "[SixbAgentWorker] Agent tool 'invalid_result' returned a non-JSON result; result.invalid is undefined.",
      })

      const second = await sixb.agents.request({
        agentId: "assistant",
        threadId: first.run.threadId,
        text: "continue",
      })
      await waitFor(
        async () => {
          const record = await storage.runs.getById({ projectId: PROJECT_ID, id: second.run.id })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "tool failure replay run terminal" }
      )
      expect(replayedPrompt).toContain("invalid_result")
      expect(replayedPrompt).toContain("returned a non-JSON result")
    } finally {
      await worker.stop()
    }
  })

  test("runs a full multi-step turn: starts, persists the assistant message, finalizes with usage", async () => {
    const sixb = buildSixbWithEchoTool(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    const auth = authStorageOf(sixb)

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const {
        run: { threadId, id: runId },
      } = await sixb.agents.request({
        agentId: "assistant",
        text: "echo hi",
      })

      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "queued" && found.status !== "running" ? found : null
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

  test("projects successful queue renewals onto execution authorization", async () => {
    const sixb = buildSixb(slowAnswerModel(300))
    const storage = agentStorageOf(sixb)
    const queue = sixb.queues.agents
    const originalRenew = queue.renewLease?.bind(queue)
    if (!originalRenew) throw new Error("expected queue lease renewal")

    let firstRenewedExpiration: string | undefined
    queue.renewLease = async (params) => {
      const renewed = await originalRenew(params)
      firstRenewedExpiration ??= renewed?.leaseExpiresAt
      return renewed
    }

    const worker = new AgentWorker(sixb, workerOptions({ leaseMs: 90, idlePollMs: 5 }))
    await worker.start()
    try {
      const request = await sixb.agents.request({ agentId: "assistant", text: "keep owning" })
      await waitFor(
        async () => {
          if (!firstRenewedExpiration) return null
          const run = await storage.runs.getById({ projectId: PROJECT_ID, id: request.run.id })
          const projected = run?.execution?.queueLeaseExpiresAt.getTime()
          return projected !== undefined && projected >= Date.parse(firstRenewedExpiration)
            ? run
            : null
        },
        { label: "queue ownership projection" }
      )
    } finally {
      await worker.stop()
    }
  })

  test("continues processing after a turn outlives its initial queue lease", async () => {
    const sixb = buildSixb(slowAnswerModel(120))
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions({ leaseMs: 45, idlePollMs: 5 }))

    await worker.start()
    try {
      const first = await sixb.agents.request({ agentId: "assistant", text: "first" })
      const firstRun = await waitFor(
        async () => {
          const run = await storage.runs.getById({ projectId: PROJECT_ID, id: first.run.id })
          return run && run.status !== "queued" && run.status !== "running" ? run : null
        },
        { label: "slow first run terminal" }
      )
      expect(firstRun.status).toBe("succeeded")

      const second = await sixb.agents.request({
        agentId: "assistant",
        threadId: first.run.threadId,
        text: "second",
      })
      const secondRun = await waitFor(
        async () => {
          const run = await storage.runs.getById({ projectId: PROJECT_ID, id: second.run.id })
          return run && run.status !== "queued" && run.status !== "running" ? run : null
        },
        { label: "slow second run terminal" }
      )
      expect(secondRun.status).toBe("succeeded")
    } finally {
      await worker.stop()
    }
  })

  test("redelivers without reporting when queue ownership is lost", async () => {
    const sixb = buildSixb(slowAnswerModel(120))
    const storage = agentStorageOf(sixb)
    let reportCount = 0
    const reporter = attachSixbErrorReporter(sixb, () => {
      reportCount += 1
    })
    const queue = sixb.queues.agents
    const originalRenew = queue.renewLease?.bind(queue)
    if (!originalRenew) throw new Error("expected queue lease renewal")

    let renewals = 0
    queue.renewLease = async (params) => {
      renewals += 1
      if (renewals === 1) return null
      return originalRenew(params)
    }

    const worker = new AgentWorker(sixb, workerOptions({ leaseMs: 45, idlePollMs: 5 }))
    const originalConsoleError = console.error
    console.error = () => {}
    await worker.start()
    try {
      const request = await sixb.agents.request({ agentId: "assistant", text: "recover" })
      const finalRun = await waitFor(
        async () => {
          const run = await storage.runs.getById({ projectId: PROJECT_ID, id: request.run.id })
          return run && run.status !== "queued" && run.status !== "running" ? run : null
        },
        { label: "redelivered run terminal" }
      )

      expect(finalRun).toMatchObject({ status: "succeeded", attempt: 2 })
      const assistants = (await listMessages(storage, request.run.threadId)).filter(
        (message) => message.role === "assistant"
      )
      expect(assistants).toHaveLength(1)
      await reporter.flush()
      expect(reportCount).toBe(0)
    } finally {
      await worker.stop()
      console.error = originalConsoleError
    }
  })

  test("adds visible guidance when the step limit is reached before an answer", async () => {
    const sixb = buildSixbWithEchoTool(toolOnlyModel())
    const storage = agentStorageOf(sixb)

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const {
        run: { threadId },
      } = await sixb.agents.request({
        agentId: "assistant",
        text: "use tools forever",
      })

      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "queued" && found.status !== "running" ? found : null
        },
        { label: "tool-only run terminal" }
      )

      expect(run.status).toBe("succeeded")
      expect(run.finishReason).toBe("tool-calls")

      const messages = await listMessages(storage, threadId)
      const assistant = messages.find((message) => message.role === "assistant")
      const parts = assistant?.parts ?? []
      expect(parts.filter((part) => part.type === "tool-call")).toHaveLength(4)
      expect(
        parts.some(
          (part) =>
            part.type === "text" &&
            part.text.includes("configured 4-step limit") &&
            part.text.includes("producing a final answer")
        )
      ).toBe(true)
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
      const {
        run: { threadId },
      } = await sixb.agents.request({
        agentId: "assistant",
        text: "run bash",
      })

      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "queued" && found.status !== "running" ? found : null
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
      const command = sandbox?.commands.find(
        (record) =>
          record.command === "bash" && record.args.at(-1) === "echo 'Hello, world!' | grep Hello"
      )
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

  test("attaches files written to the sandbox output directory to the assistant message", async () => {
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(outputBashThenAnswerModel(), new InMemoryBroker(), sandboxes)
    const storage = agentStorageOf(sixb)

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const {
        run: { threadId },
      } = await sixb.agents.request({
        agentId: "assistant",
        text: "create a report",
      })

      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "queued" && found.status !== "running" ? found : null
        },
        { label: "output attachment run terminal" }
      )

      expect(run.status).toBe("succeeded")
      const messages = await listMessages(storage, threadId)
      const assistant = messages.find((message) => message.role === "assistant")
      const filePart = assistant?.parts.find((part) => part.type === "file")
      expect(filePart).toMatchObject({
        type: "file",
        fileRef: {
          fileName: "report.txt",
          mediaType: "text/plain",
          logicalPath: "report.txt",
        },
      })
      if (!filePart || filePart.type !== "file") {
        throw new Error("Expected assistant output file part.")
      }
      const stored = await sixb.blobStorage.open(filePart.fileRef.blobId)
      expect(await new Response(stored).text()).toBe("generated report")
      const listCommand = sandboxes.sandboxes[0]?.commands.find((command) =>
        String(command.args.at(-1)).includes("sixb-list-agent-output-files")
      )
      expect(listCommand).toBeDefined()
      // Vercel's stock sandbox image has no /dev/fd, so Bash process substitution is unavailable.
      const listScript = String(listCommand?.args.at(-1))
      expect(listScript).toContain('find "$dir" -type f -print0 | while')
      expect(listScript).not.toContain("< <(")
    } finally {
      await worker.stop()
    }
  })

  test("finalizes as cancelled when cancellation arrives during output collection", async () => {
    const sandboxes = new BlockingOutputCollectionSandboxFactory()
    const sixb = buildSixb(outputBashThenAnswerModel(), new InMemoryBroker(), sandboxes)
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions({ idlePollMs: 10 }))
    await worker.start()
    try {
      const request = await sixb.agents.request({
        agentId: "assistant",
        text: "create a report",
      })
      await sandboxes.sandbox.listStarted

      await publishAgentRunCancel(sixb.broker, {
        projectId: PROJECT_ID,
        runId: request.run.id,
      })

      const run = await waitFor(
        async () => {
          const record = await storage.runs.getById({
            projectId: PROJECT_ID,
            id: request.run.id,
          })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "cancel during output collection" }
      )
      expect(run.status).toBe("cancelled")
      const messages = await listMessages(storage, request.run.threadId)
      const persistedAssistant = messages.find((message) => message.role === "assistant")
      expect(persistedAssistant?.parts.some((part) => part.type === "file")).toBe(false)
    } finally {
      await worker.stop()
    }
  })

  test("stores output collection warnings as run diagnostics, not assistant text", async () => {
    const sandboxes = new OversizedOutputSandboxFactory()
    const sixb = buildSixb(outputBashThenAnswerModel(), new InMemoryBroker(), sandboxes)
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const request = await sixb.agents.request({
        agentId: "assistant",
        text: "create a report",
      })
      const run = await waitFor(
        async () => {
          const record = await storage.runs.getById({
            projectId: PROJECT_ID,
            id: request.run.id,
          })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "diagnostic output run terminal" }
      )
      expect(run.status).toBe("succeeded")
      expect(run.diagnostics).toEqual([
        {
          code: "output_file_too_large",
          severity: "warning",
          scope: "output",
          path: "report.txt",
          message: "This generated file exceeds the per-file attachment limit and was skipped.",
        },
      ])

      const messages = await listMessages(storage, request.run.threadId)
      const assistant = messages.find((message) => message.role === "assistant")
      expect(assistant?.parts.some((part) => part.type === "file")).toBe(false)
      expect(
        assistant?.parts.some(
          (part) => part.type === "text" && part.text.includes("per-file attachment limit")
        )
      ).toBe(false)
    } finally {
      await worker.stop()
    }
  })

  test("advertises and materializes project Agent Skills", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "sixb-agent-skills-"))
    try {
      await writeProjectSkill(
        projectRoot,
        "acme-style",
        [
          "---",
          "name: acme-style",
          "description: >",
          "  Use when drafting Acme customer-facing",
          "  messages.",
          "---",
          "",
          "# Acme Style",
          "",
          "Read references/examples.md before drafting customer-facing copy.",
        ].join("\n"),
        { "references/examples.md": "Prefer concise, operational summaries." }
      )

      let capturedSystem: string | undefined
      const sandboxes = new RecordingSandboxFactory()
      const sixb = buildSixb(
        apiBashThenAnswerModel((system) => {
          capturedSystem = system
        }),
        new InMemoryBroker(),
        sandboxes,
        { projectRoot }
      )
      const storage = agentStorageOf(sixb)
      const worker = new AgentWorker(sixb, workerOptions())
      await worker.start()
      try {
        const {
          run: { threadId },
        } = await sixb.agents.request({
          agentId: "assistant",
          text: "draft a note",
        })
        const run = await waitFor(
          async () => {
            const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
            const found = list.runs[0]
            return found && found.status !== "queued" && found.status !== "running" ? found : null
          },
          { label: "project skills run terminal" }
        )
        expect(run.status).toBe("succeeded")
        expect(capturedSystem).toContain("Path: $SIXB_SKILLS_DIR/acme-style")
        expect(capturedSystem).toContain("Use when drafting Acme customer-facing messages.")
        expect(capturedSystem).toContain("Path: $SIXB_SKILLS_DIR/sixb-query")

        const command = sandboxes.sandboxes[0]?.commands[0]
        const skillsDir = command?.options.env?.SIXB_SKILLS_DIR
        if (!skillsDir) {
          throw new Error("Expected project skill sandbox env.")
        }
        const sandbox = sandboxes.sandboxes[0]
        if (!sandbox) {
          throw new Error("Expected project skill sandbox.")
        }
        expect(sandbox.readFileContents(join(skillsDir, "acme-style", "SKILL.md"))).toContain(
          "# Acme Style"
        )
        expect(
          sandbox.readFileContents(join(skillsDir, "acme-style", "references", "examples.md"))
        ).toContain("Prefer concise")
        expect(sandbox.readFileContents(join(skillsDir, "sixb-query", "SKILL.md"))).toContain(
          "name: sixb-query"
        )
      } finally {
        await worker.stop()
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
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
      const {
        run: { threadId, id: runId },
      } = await sixb.agents.request({
        agentId: "assistant",
        text: "inspect sixb api context",
      })

      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "queued" && found.status !== "running" ? found : null
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
      expect(env?.SIXB_ATTACHMENTS).toContain("/.sixb/agent/context/attachments.json")
      expect(env?.SIXB_ATTACHMENT_DIR).toContain("/.sixb/agent/attachments")
      expect(env?.SIXB_OUTPUT_STAGING_DIR).toContain("/.sixb/agent/outputs/staging")
      expect(env?.SIXB_OUTPUT_DIR).toContain("/.sixb/agent/outputs/published")
      expect(env?.SIXB_API_GUIDE).toBeUndefined()
      expect(env?.SIXB_ACCESS_TOKEN).toBeUndefined()

      if (!env?.SIXB_SKILLS_DIR || !env.SIXB_RUN_CONTEXT) {
        throw new Error("Expected sandbox API env.")
      }

      // Skills + run context are materialized through sandbox.writeFiles (not the host fs), so read
      // them back from the sandbox's captured records the way a guest command would.
      const sandbox = sandboxes.sandboxes[0]
      if (!sandbox) {
        throw new Error("Expected a provisioned sandbox.")
      }

      const querySkill = sandbox.readFileContents(
        join(env.SIXB_SKILLS_DIR, "sixb-query", "SKILL.md")
      )
      expect(querySkill).toContain("name: sixb-query")
      expect(querySkill).toContain("/api/object-types")
      expect(querySkill).toContain("references/query-api.md")
      expect(querySkill).toContain("Do not invent alternative")
      expect(querySkill).not.toContain("SIXB_ACCESS_TOKEN")

      const queryApiReference = sandbox.readFileContents(
        join(env.SIXB_SKILLS_DIR, "sixb-query", "references", "query-api.md")
      )
      expect(queryApiReference).toContain("/api/objects/query")
      expect(queryApiReference).toContain("/api/objects/query/facets")
      expect(queryApiReference).toContain("Do not send top-level")
      expect(queryApiReference).toContain("simple storage-backed browsing")
      expect(queryApiReference).toContain("includeTotal: false")
      expect(queryApiReference).toContain("Do not use `/api/objects/{objectTypeId}`")
      expect(queryApiReference).toContain("Common Mistakes")
      expect(queryApiReference).toContain('/api/objects/customer"')
      expect(queryApiReference).toContain('"kind":"limit"')

      const queryShapesReference = sandbox.readFileContents(
        join(env.SIXB_SKILLS_DIR, "sixb-query", "references", "query-shapes.md")
      )
      expect(queryShapesReference).toContain('"kind": "page"')
      expect(queryShapesReference).toContain('"pageSize": 20')
      expect(queryShapesReference).toContain(
        '"pageToken": "next-page-token-from-previous-response"'
      )

      const queryExamplesReference = sandbox.readFileContents(
        join(env.SIXB_SKILLS_DIR, "sixb-query", "references", "examples.md")
      )
      expect(queryExamplesReference).toContain("keep pagination and limits inside")
      expect(queryExamplesReference).toContain('"kind": "limit"')

      const telemetrySkill = sandbox.readFileContents(
        join(env.SIXB_SKILLS_DIR, "sixb-telemetry", "SKILL.md")
      )
      expect(telemetrySkill).toContain("name: sixb-telemetry")
      expect(telemetrySkill).toContain("references/telemetry-api.md")

      const telemetryApiReference = sandbox.readFileContents(
        join(env.SIXB_SKILLS_DIR, "sixb-telemetry", "references", "telemetry-api.md")
      )
      expect(telemetryApiReference).toContain("/api/telemetry/history")
      expect(telemetryApiReference).toContain("/telemetry/rpm/latest")

      const actionsSkill = sandbox.readFileContents(
        join(env.SIXB_SKILLS_DIR, "sixb-actions", "SKILL.md")
      )
      expect(actionsSkill).toContain("name: sixb-actions")
      expect(actionsSkill).toContain("references/actions-api.md")

      const actionsApiReference = sandbox.readFileContents(
        join(env.SIXB_SKILLS_DIR, "sixb-actions", "references", "actions-api.md")
      )
      expect(actionsApiReference).toContain("/api/actions")
      expect(actionsApiReference).toContain("ask for approval")
      expect(actionsApiReference).toContain("Do not request the action until the user approves")
      expect(actionsApiReference).toContain("/api/action-runs/action_run_id")
      expect(actionsApiReference).toContain("without a `kind`")
      expect(actionsApiReference).toContain('"objectTypeId": "customer", "primaryId": "cust-001"')

      const filesSkill = sandbox.readFileContents(
        join(env.SIXB_SKILLS_DIR, "sixb-files", "SKILL.md")
      )
      expect(filesSkill).toContain("name: sixb-files")
      expect(filesSkill).toContain("POST /api/files")

      const workflowsSkill = sandbox.readFileContents(
        join(env.SIXB_SKILLS_DIR, "sixb-workflows", "SKILL.md")
      )
      expect(workflowsSkill).toContain("name: sixb-workflows")
      expect(workflowsSkill).toContain("Ask for approval")
      expect(workflowsSkill).toContain("never start another workflow")

      const runContext = JSON.parse(sandbox.readFileContents(env.SIXB_RUN_CONTEXT)) as unknown
      expect(runContext).toMatchObject({
        projectId: PROJECT_ID,
        agentId: "assistant",
        threadId,
        runId,
        apiBaseUrl: env.SIXB_API_BASE_URL,
        outputDir: env.SIXB_OUTPUT_DIR,
        outputStagingDir: env.SIXB_OUTPUT_STAGING_DIR,
      })
      if (!env.SIXB_OUTPUT_STAGING_DIR || !env.SIXB_OUTPUT_DIR) {
        throw new Error("Expected sandbox output publication env.")
      }
      expect(sandbox.readFileContents(join(env.SIXB_OUTPUT_STAGING_DIR, ".keep"))).toBe("")
      expect(sandbox.readFileContents(join(env.SIXB_OUTPUT_DIR, ".keep"))).toBe("")

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
      expect(stdout).toContain(`outputDir=${env.SIXB_OUTPUT_DIR}`)
      expect(stdout).toContain(`outputStagingDir=${env.SIXB_OUTPUT_STAGING_DIR}`)
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

    const worker = new AgentWorker(sixb, workerOptions({ concurrency: 2, idlePollMs: 10 }))
    await worker.start()
    try {
      await waitFor(() => (controlled.startedCount() >= 1 ? true : null), {
        label: "first model stream started",
      })
      const firstInitiallyRunning = await storage.runs.getById({
        projectId: PROJECT_ID,
        id: firstRequest.run.id,
      })
      expect(firstInitiallyRunning?.status).toBe("running")

      const secondRequest = await sixb.agents.request({ agentId: "assistant", text: "second" })

      await waitFor(() => (controlled.startedCount() >= 2 ? true : null), {
        label: "two concurrent model streams started",
      })

      const [firstRunning, secondRunning] = await Promise.all([
        storage.runs.getById({ projectId: PROJECT_ID, id: firstRequest.run.id }),
        storage.runs.getById({ projectId: PROJECT_ID, id: secondRequest.run.id }),
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
              id: firstRequest.run.id,
            })
            return run && run.status !== "queued" && run.status !== "running" ? run : null
          },
          { label: "first concurrent run terminal" }
        ),
        waitFor(
          async () => {
            const run = await storage.runs.getById({
              projectId: PROJECT_ID,
              id: secondRequest.run.id,
            })
            return run && run.status !== "queued" && run.status !== "running" ? run : null
          },
          { label: "second concurrent run terminal" }
        ),
      ])

      expect(firstRun.status).toBe("succeeded")
      expect(secondRun.status).toBe("succeeded")
      expect(
        (await listMessages(storage, firstRequest.run.threadId)).some(
          (message) => message.role === "assistant"
        )
      ).toBe(true)
      expect(
        (await listMessages(storage, secondRequest.run.threadId)).some(
          (message) => message.role === "assistant"
        )
      ).toBe(true)

      const streamRecords = await Promise.all([
        listRunStreamRecords(sixb.broker, firstRequest.run.id),
        listRunStreamRecords(sixb.broker, secondRequest.run.id),
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

  test("cancels an in-flight run without reporting a failure", async () => {
    const controlled = controlledBlockingAnswerModel()
    const sixb = buildSixb(controlled.model, new InMemoryBroker(), new RecordingSandboxFactory())
    const storage = agentStorageOf(sixb)
    let reportCount = 0
    const reporter = attachSixbErrorReporter(sixb, () => {
      reportCount += 1
    })

    const request = await sixb.agents.request({ agentId: "assistant", text: "go" })

    const worker = new AgentWorker(sixb, workerOptions({ idlePollMs: 10 }))
    await worker.start()
    try {
      await waitFor(() => (controlled.startedCount() >= 1 ? true : null), {
        label: "model stream started",
      })

      // Exactly what POST /api/agent-threads/:threadId/cancel publishes.
      await publishAgentRunCancel(sixb.broker, { projectId: PROJECT_ID, runId: request.run.id })

      const run = await waitFor(
        async () => {
          const record = await storage.runs.getById({ projectId: PROJECT_ID, id: request.run.id })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "run terminal after cancel" }
      )
      expect(run.status).toBe("cancelled")

      // The thread is released, so the user can immediately steer with a new message.
      const thread = await storage.threads.getById({
        projectId: PROJECT_ID,
        id: request.run.threadId,
      })
      expect(thread?.activeRunId).toBeNull()

      // A cancelled turn persists no partial assistant message (messages are finalized-only).
      const persisted = await listMessages(storage, request.run.threadId)
      expect(persisted.some((message) => message.role === "assistant")).toBe(false)

      // The client learns of the stop through the run's terminal stream event.
      const records = await listRunStreamRecords(sixb.broker, request.run.id)
      const finished = records.find((record) => record.name === "agent.run.finished")
      expect((finished?.payload as { status?: string } | undefined)?.status).toBe("cancelled")
      await reporter.flush()
      expect(reportCount).toBe(0)
    } finally {
      await worker.stop()
    }
  })

  test("propagates run cancellation to an active selected tool handler", async () => {
    const started = Promise.withResolvers<void>()
    let handlerWasCancelled = false
    const blockingEcho = defineAgentTool("echo")
      .description("Wait for cancellation.")
      .input({ value: "string" })
      .run(async ({ signal }) => {
        started.resolve()
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
        handlerWasCancelled = signal.aborted
        return { cancelled: signal.aborted }
      })
    const sixb = buildSixb(
      toolThenAnswerModel(),
      new InMemoryBroker(),
      new RecordingSandboxFactory(),
      { agentTools: [blockingEcho] }
    )
    const storage = agentStorageOf(sixb)
    const request = await sixb.agents.request({ agentId: "assistant", text: "wait" })
    const worker = new AgentWorker(sixb, workerOptions({ skillsDir: false }))
    await worker.start()
    try {
      await started.promise
      await publishAgentRunCancel(sixb.broker, {
        projectId: PROJECT_ID,
        runId: request.run.id,
      })

      const run = await waitFor(
        async () => {
          const record = await storage.runs.getById({ projectId: PROJECT_ID, id: request.run.id })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "selected tool run terminal after cancel" }
      )
      expect(run.status).toBe("cancelled")
      expect(handlerWasCancelled).toBe(true)
    } finally {
      await worker.stop()
    }
  })

  test("persists the partial assistant message when a mid-response run is cancelled", async () => {
    const partial = "Let me start by checking the pipeline logs"
    const controlled = partialTextThenBlockingModel(partial)
    const sixb = buildSixb(controlled.model, new InMemoryBroker(), new RecordingSandboxFactory())
    const storage = agentStorageOf(sixb)

    const request = await sixb.agents.request({ agentId: "assistant", text: "go" })

    const worker = new AgentWorker(sixb, workerOptions({ idlePollMs: 10 }))
    await worker.start()
    try {
      await controlled.waitForStarted()
      // Wait until the streamed text has actually been processed and published (a real model delivers
      // tokens over time); cancelling before then would race the SDK reading the buffered chunk.
      await waitFor(
        async () => {
          const records = await listRunStreamRecords(sixb.broker, request.run.id)
          return JSON.stringify(records).includes(partial) ? true : null
        },
        { label: "partial text streamed" }
      )

      await publishAgentRunCancel(sixb.broker, { projectId: PROJECT_ID, runId: request.run.id })

      const run = await waitFor(
        async () => {
          const record = await storage.runs.getById({ projectId: PROJECT_ID, id: request.run.id })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "run terminal after cancel" }
      )
      expect(run.status).toBe("cancelled")

      // The half-streamed answer is kept, so the next (steering) turn sees what the agent was doing.
      const messages = await listMessages(storage, request.run.threadId)
      const assistant = messages.find((message) => message.role === "assistant")
      expect(assistant).toBeDefined()
      const text = assistant?.parts
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("")
      expect(text).toBe(partial)

      // The thread is freed for the steering message.
      const thread = await storage.threads.getById({
        projectId: PROJECT_ID,
        id: request.run.threadId,
      })
      expect(thread?.activeRunId).toBeNull()
    } finally {
      await worker.stop()
    }
  })

  test("publishes UI chunks before appending the finalized assistant message", async () => {
    const sixb = buildSixbWithEchoTool(toolThenAnswerModel())
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
      blobStorage: sixb.blobStorage,
      sandboxes: sixb.sandboxes,
      logs: sixb.logs,
      ontology: sixb.ontology,
      connector: sixb.connector.bind(sixb),
    }

    const worker = new AgentWorker(workerSixb, workerOptions())
    await worker.start()
    try {
      const {
        run: { threadId },
      } = await sixb.agents.request({ agentId: "assistant", text: "echo hi" })
      await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "queued" && found.status !== "running" ? found : null
        },
        { label: "run terminal" }
      )

      expect(chunksBeforeAssistantAppend).toBeGreaterThan(0)
      expect(finalizedBeforeAssistantAppend).toBe(false)
    } finally {
      await worker.stop()
    }
  })

  test("does not report broker run stream publication failures", async () => {
    const sixb = buildSixbWithEchoTool(toolThenAnswerModel(), new FailingRunStreamBroker())
    const storage = agentStorageOf(sixb)
    let reportCount = 0
    const reporter = attachSixbErrorReporter(sixb, () => {
      reportCount += 1
    })
    const originalConsoleError = console.error
    console.error = () => {}

    const worker = new AgentWorker(sixb, workerOptions())
    try {
      await worker.start()
      const {
        run: { threadId },
      } = await sixb.agents.request({ agentId: "assistant", text: "echo hi" })
      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "queued" && found.status !== "running" ? found : null
        },
        { label: "run terminal despite stream publish failures" }
      )

      expect(run.status).toBe("succeeded")
      const assistants = (await listMessages(storage, threadId)).filter(
        (message) => message.role === "assistant"
      )
      expect(assistants).toHaveLength(1)
      await reporter.flush()
      expect(reportCount).toBe(0)
    } finally {
      await worker.stop()
      console.error = originalConsoleError
    }
  })

  test("continues the turn when a custom stream sink fails", async () => {
    const sixb = buildSixbWithEchoTool(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    const originalConsoleError = console.error
    console.error = () => {}

    const worker = new AgentWorker(
      sixb,
      workerOptions({
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
      const {
        run: { threadId },
      } = await sixb.agents.request({ agentId: "assistant", text: "echo hi" })
      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "queued" && found.status !== "running" ? found : null
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
    const run = await storage.runs.start({
      id: request.run.id,
      projectId: PROJECT_ID,
      execution: freshTestExecution(),
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

    expect(await listRunStreamRecords(sixb.broker, request.run.id)).toHaveLength(0)
    expect(await storage.runs.getById({ projectId: PROJECT_ID, id: request.run.id })).toMatchObject(
      {
        status: "running",
        attempt: 1,
      }
    )
  })

  test("rejects a second message while a run is active (single-flight, trigger layer)", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    // Open a thread and simulate a worker starting its queued run.
    const first = await sixb.agents.request({ agentId: "assistant", text: "first" })
    await storage.runs.start({
      id: first.run.id,
      projectId: PROJECT_ID,
      execution: freshTestExecution(),
    })

    const promise = sixb.agents.request({
      agentId: "assistant",
      text: "second",
      threadId: first.run.threadId,
    })
    await expect(promise).rejects.toBeInstanceOf(AgentRequestError)
    await expect(promise).rejects.toMatchObject({ code: "active_run_exists" })
  })

  test("reclaims a crashed run on redelivery and completes it (attempt++)", async () => {
    const sixb = buildSixbWithEchoTool(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    // Trigger normally, then simulate a worker that crashed after starting the durable run. The
    // redelivered queue job rotates its execution token before continuing.
    const {
      run: { id: runId },
    } = await sixb.agents.request({
      agentId: "assistant",
      text: "echo hi",
    })
    const crashedRunId = runId
    await storage.runs.start({
      id: crashedRunId,
      projectId: PROJECT_ID,
      execution: freshTestExecution(),
    })

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const reclaimed = await waitFor(
        async () => {
          const run = await storage.runs.getById({ projectId: PROJECT_ID, id: crashedRunId })
          return run && run.status !== "queued" && run.status !== "running" ? run : null
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

  test("a worker whose execution token was rotated writes nothing (fencing)", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    const {
      run: { threadId, id: runId },
    } = await sixb.agents.request({
      agentId: "assistant",
      text: "echo hi",
    })

    // This worker started the run, but another delivery rotated its execution token.
    const staleRun = await storage.runs.start({
      id: runId,
      projectId: PROJECT_ID,
      execution: freshTestExecution(),
    })
    await storage.runs.reclaim({
      projectId: PROJECT_ID,
      id: runId,
      execution: freshTestExecution(),
    })

    const promise = runAgentTurn({
      context: {
        id: PROJECT_ID,
        storage: workerStorageOf(sixb.storage),
        blobStorage: sixb.blobStorage,
        tools: echoTool,
        streamSink: NOOP_STREAM_SINK,
        defaultMaxSteps: 4,
        turnTimeoutMs: 60_000,
      },
      agent: sixb.agents.getById("assistant")!,
      run: staleRun,
      signal: new AbortController().signal,
    })
    await expect(promise).rejects.toBeInstanceOf(AgentExecutionLostError)

    // No assistant message was written; the run is still owned by the reclaiming worker.
    const messages = await listMessages(storage, threadId)
    expect(messages.every((message) => message.role !== "assistant")).toBe(true)
    const run = await storage.runs.getById({ projectId: PROJECT_ID, id: runId })
    expect(run?.status).toBe("running")
  })

  test("adds concise Sixb context to every model system prompt", async () => {
    let capturedSystem: string | undefined
    const model = new MockLanguageModelV4({
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
        blobStorage: sixb.blobStorage,
        tools: {},
        systemAddendum: "Extra sandbox context.",
        streamSink: NOOP_STREAM_SINK,
        defaultMaxSteps: 4,
        turnTimeoutMs: 60_000,
      },
      agent: sixb.agents.getById("assistant")!,
      run,
      signal: new AbortController().signal,
    })

    expect(capturedSystem).toBeDefined()
    if (!capturedSystem) throw new Error("Expected a system prompt")

    expect(capturedSystem).toContain("<sixb_core_rules>")
    expect(capturedSystem).toContain("You are operating as a Sixb agent")
    expect(capturedSystem).toContain("sandboxed bash tool")
    expect(capturedSystem).toContain("<sixb_runtime_context>")
    expect(capturedSystem).toContain("Extra sandbox context.")
    expect(capturedSystem).toContain("<agent_instructions>")
    expect(capturedSystem).toContain("You are a helpful test assistant.")
    expect(capturedSystem.indexOf("<sixb_core_rules>")).toBeLessThan(
      capturedSystem.indexOf("<agent_instructions>")
    )
  })

  test("passes agent model options into streamText", async () => {
    let capturedReasoning: unknown
    let capturedProviderOptions: unknown
    const model = new MockLanguageModelV4({
      modelId: "mock-model",
      doStream: async (options) => {
        capturedReasoning = options.reasoning
        capturedProviderOptions = options.providerOptions
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Done" },
          { type: "text-end", id: "t" },
          finish("stop"),
        ])
      },
    })
    const sixb = buildSixb(model, new InMemoryBroker(), new RecordingSandboxFactory(), {
      reasoning: "high",
      providerOptions: { openai: { reasoningSummary: "detailed" } },
    })
    const request = await sixb.agents.request({ agentId: "assistant", text: "hello" })
    const run = await reserveRequestedRun(sixb, request)

    await runAgentTurn({
      context: {
        id: PROJECT_ID,
        storage: workerStorageOf(sixb.storage),
        blobStorage: sixb.blobStorage,
        tools: {},
        streamSink: NOOP_STREAM_SINK,
        defaultMaxSteps: 4,
        turnTimeoutMs: 60_000,
      },
      agent: sixb.agents.getById("assistant")!,
      run,
      signal: new AbortController().signal,
    })

    expect(capturedReasoning).toBe("high")
    expect(capturedProviderOptions).toEqual({ openai: { reasoningSummary: "detailed" } })
  })

  test("reports a terminal model failure exactly once with the original error", async () => {
    const originalError = new Error("provider boom")
    const failingModel = new MockLanguageModelV4({
      modelId: "mock-model",
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            controller.error(originalError)
          },
        }),
      }),
    })
    const sixb = buildSixb(failingModel)
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    const reporter = attachSixbErrorReporter(sixb, (error, context) => {
      reports.push({ error, context })
    })
    const storage = agentStorageOf(sixb)

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const {
        run: { threadId },
      } = await sixb.agents.request({ agentId: "assistant", text: "hi" })
      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "queued" && found.status !== "running" ? found : null
        },
        { label: "run failed" }
      )
      expect(run.status).toBe("failed")
      expect(run.error).toMatchObject({
        code: "internal.unexpected",
        message: "provider boom",
        details: { agentId: "assistant", runId: run.id, threadId },
      })
      expect(run.error?.at).toBe(run.completedAt?.toISOString())
      await reporter.flush()
      expect(reports).toHaveLength(1)
      expect(reports[0]?.error).toBe(originalError)
      expect(reports[0]?.context).toMatchObject({
        type: "run.failed",
        notificationId: `project:${PROJECT_ID}:run:agent:${run.id}:failed:${run.completedAt?.toISOString()}`,
        projectId: PROJECT_ID,
        attempt: 1,
        run: { kind: "agent", runId: run.id, agentId: "assistant" },
      })
      expect(reports[0]?.context.occurredAt).toBe(run.completedAt?.toISOString() ?? "")
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

  test("fails the run when the sandbox cannot be provisioned (no bash used)", async () => {
    // The model answers without ever invoking bash. Provisioning runs concurrently and fails; the
    // run must be recorded `failed` rather than finalizing as a success with no working sandbox.
    const answerModel = new MockLanguageModelV4({
      modelId: "mock-model",
      doStream: async () =>
        stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Answer without bash" },
          { type: "text-end", id: "t" },
          finish("stop"),
        ]),
    })
    const sixb = buildSixb(answerModel, new InMemoryBroker(), new FailingSandboxFactory())
    const storage = agentStorageOf(sixb)

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const {
        run: { threadId },
      } = await sixb.agents.request({ agentId: "assistant", text: "hi" })
      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "queued" && found.status !== "running" ? found : null
        },
        { label: "run failed" }
      )
      expect(run.status).toBe("failed")
      expect(run.error?.message).toContain("sandbox provisioning unavailable")

      // The turn threw before finalizing, so no assistant message was persisted.
      const messages = await listMessages(storage, threadId)
      expect(messages.every((message) => message.role !== "assistant")).toBe(true)

      // Thread released so a later message can run.
      const thread = await storage.threads.getById({ projectId: PROJECT_ID, id: threadId })
      expect(thread?.activeRunId).toBeNull()
    } finally {
      await worker.stop()
    }
  })

  test("cancels the run when the worker is stopped mid-turn", async () => {
    // A model whose stream blocks until the call is aborted, so the turn is reliably in-flight.
    const blockingModel = new MockLanguageModelV4({
      modelId: "mock-model",
      doStream: async (options) => {
        const blocked = new ReadableStream<LanguageModelV4StreamPart>({
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
    const {
      run: { threadId, id: runId },
    } = await sixb.agents.request({ agentId: "assistant", text: "hang" })

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
    const sixb = buildSixbWithEchoTool(toolThenAnswerModel())
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
      blobStorage: sixb.blobStorage,
      sandboxes: sixb.sandboxes,
      logs: sixb.logs,
      ontology: sixb.ontology,
      connector: sixb.connector.bind(sixb),
    }

    const worker = new AgentWorker(workerSixb, workerOptions())
    await worker.start()
    try {
      const {
        run: { threadId },
      } = await sixb.agents.request({ agentId: "assistant", text: "echo hi" })
      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "queued" && found.status !== "running" ? found : null
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
    const run = await storage.runs.start({
      id: request.run.id,
      projectId: PROJECT_ID,
      execution: freshTestExecution(),
    })

    const failingStorage = withAlwaysFailingTransactionalFinish(sixb.storage)
    await expect(
      runAgentTurn({
        context: {
          id: PROJECT_ID,
          storage: workerStorageOf(failingStorage),
          blobStorage: sixb.blobStorage,
          tools: echoTool,
          streamSink: createBrokerStreamSink({
            broker: sixb.broker,
            projectId: PROJECT_ID,
          }),
          defaultMaxSteps: 4,
          turnTimeoutMs: 60_000,
        },
        agent: sixb.agents.getById("assistant")!,
        run,
        signal: new AbortController().signal,
      })
    ).rejects.toBeInstanceOf(AgentFinalizationError)

    const afterFailure = await storage.runs.getById({ projectId: PROJECT_ID, id: request.run.id })
    expect(afterFailure?.status).toBe("running")
    expect(
      (await listMessages(storage, request.run.threadId)).filter((m) => m.role === "assistant")
    ).toHaveLength(0)
    const afterFailureRecords = await listRunStreamRecords(sixb.broker, request.run.id)
    expect(afterFailureRecords.some((record) => record.name === "agent.ui.chunk")).toBe(true)
    expect(afterFailureRecords.some((record) => record.name === "agent.message.finalized")).toBe(
      false
    )
    expect(afterFailureRecords.some((record) => record.name === "agent.run.finished")).toBe(false)

    const reclaimed = await storage.runs.reclaim({
      projectId: PROJECT_ID,
      id: request.run.id,
      execution: freshTestExecution(),
    })
    await runAgentTurn({
      context: {
        id: PROJECT_ID,
        storage: workerStorageOf(sixb.storage),
        blobStorage: sixb.blobStorage,
        tools: echoTool,
        streamSink: createBrokerStreamSink({
          broker: sixb.broker,
          projectId: PROJECT_ID,
        }),
        defaultMaxSteps: 4,
        turnTimeoutMs: 60_000,
      },
      agent: sixb.agents.getById("assistant")!,
      run: reclaimed,
      signal: new AbortController().signal,
    })

    const finalRun = await storage.runs.getById({ projectId: PROJECT_ID, id: request.run.id })
    expect(finalRun?.status).toBe("succeeded")
    expect(finalRun?.attempt).toBe(2)
    expect(
      (await listMessages(storage, request.run.threadId)).filter((m) => m.role === "assistant")
    ).toHaveLength(1)

    const finalRecords = await listRunStreamRecords(sixb.broker, request.run.id)
    const finalizedRecords = finalRecords.filter(
      (record) => record.name === "agent.message.finalized"
    )
    expect(finalizedRecords).toHaveLength(1)
    expect(finalizedRecords[0]?.payload).toMatchObject({
      type: "agent.message.finalized",
      runId: request.run.id,
      attempt: 2,
    })
    const finishedRecords = finalRecords.filter((record) => record.name === "agent.run.finished")
    expect(finishedRecords).toHaveLength(1)
    expect(finishedRecords[0]?.payload).toMatchObject({
      type: "agent.run.finished",
      status: "succeeded",
      runId: request.run.id,
      attempt: 2,
    })
  })

  test("fails the run and releases the thread when a turn exceeds its wall-clock budget", async () => {
    const sixb = buildSixb(hangingModel())
    const storage = agentStorageOf(sixb)

    const worker = new AgentWorker(sixb, workerOptions({ turnTimeoutMs: 50 }))
    await worker.start()
    try {
      const {
        run: { threadId },
      } = await sixb.agents.request({ agentId: "assistant", text: "hang" })
      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "queued" && found.status !== "running" ? found : null
        },
        { label: "run timed out" }
      )

      expect(run.status).toBe("failed")
      expect(run.error?.message).toContain("turn budget")
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

  test("reports a queued run failed when its agent is no longer registered", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    const reporter = attachSixbErrorReporter(sixb, (error, context) => {
      reports.push({ error, context })
    })
    const threadId = "thread-missing-agent"
    const runId = createAgentRunId()
    const triggerMessageId = "message-missing-agent"
    await storage.threads.create({
      id: threadId,
      projectId: PROJECT_ID,
      agentId: "removed-agent",
      ownerPrincipal: REQUESTER,
    })
    await storage.messages.append({
      id: triggerMessageId,
      projectId: PROJECT_ID,
      threadId,
      runId: null,
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    })
    await storage.runs.create({
      id: runId,
      projectId: PROJECT_ID,
      threadId,
      agentId: "removed-agent",
      triggerMessageId,
      requestedByPrincipal: REQUESTER,
    })
    await sixb.queues.agents.enqueue({
      projectId: PROJECT_ID,
      jobs: [
        {
          type: "agent.run.requested",
          payload: { agentId: "removed-agent", threadId, runId, triggerMessageId },
        },
      ],
    })

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const failed = await waitFor(
        async () => {
          const run = await storage.runs.getById({ projectId: PROJECT_ID, id: runId })
          return run?.status === "failed" ? run : null
        },
        { label: "missing agent run failed" }
      )
      expect(failed).toMatchObject({ status: "failed", attempt: 0 })
      expect(failed.error?.message).toContain("not registered")
      await reporter.flush()
      expect(reports).toHaveLength(1)
      expect(reports[0]?.error).toBeInstanceOf(AgentWorkerError)
      expect(reports[0]?.context).toMatchObject({
        projectId: PROJECT_ID,
        attempt: 1,
        run: { kind: "agent", runId, agentId: "removed-agent" },
      })
      await expect(
        storage.threads.getById({ projectId: PROJECT_ID, id: threadId })
      ).resolves.toMatchObject({
        activeRunId: null,
      })
    } finally {
      await worker.stop()
    }
  })

  test("rejects an orphan queue job without stealing the thread's durable active run", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    // A running durable run owns the thread, triggered by message "A".
    const {
      run: { threadId, id: activeRunId },
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

    await storage.runs.start({
      id: activeRunId,
      projectId: PROJECT_ID,
      execution: freshTestExecution(),
    })

    // A malformed legacy job with no durable run lands while that run is live. The worker must fail
    // it without touching the current run.
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

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      // Let the worker reject the orphan job. The active run must be untouched: not reclaimed, no
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
    executionToken: "agt_exec_x",
    status: "succeeded",
  } as const

  test("raises AgentFinalizationError when an infra error persists across retries", async () => {
    const storage = finishingStorage(() => Promise.reject(new Error("db down")))
    await expect(finishRunOrThrow(storage, succeededInput)).rejects.toBeInstanceOf(
      AgentFinalizationError
    )
  })

  test("raises AgentExecutionLostError when the run is no longer ours", async () => {
    const storage = finishingStorage(() =>
      Promise.reject(new AgentStorageError("execution_lost", "gone"))
    )
    await expect(finishRunOrThrow(storage, succeededInput)).rejects.toBeInstanceOf(
      AgentExecutionLostError
    )
  })
})
