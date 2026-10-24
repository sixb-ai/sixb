import { afterEach, describe, expect, jest, setSystemTime, spyOn, test } from "bun:test"
import { join } from "node:path"
import {
  type AgentMessagePart,
  type AgentRuntime,
  type AgentSkillDefinition,
  type AgentToolDefinition,
  type AgentToolFile,
  AgentToolPublicError,
  type AgentToolResult,
  type AgentToolRunInfo,
  AuthorizationError,
  agent,
  type BlobStorage,
  type Broker,
  type CommandResult,
  type ConnectorDefinition,
  type CreateSandboxOptions,
  can,
  defineAgentStep,
  defineAgentTool,
  defineConnector,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineRole,
  defineWorkflow,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type JsonValue,
  type ModelCatalogInput,
  type ObjectTypeWithPropertyTokens,
  type OntologyDocsInput,
  prop,
  type RunCommandOptions,
  type Sandbox,
  type SandboxConfig,
  type SandboxFactory,
  type SandboxFileRecord,
  type SandboxRequestCredential,
  type SandboxSourceAuth,
  type SixbErrorContext,
  SixbHost,
  type SixbHostOptions,
  type Storage,
} from "@sixb/core"
import type { AgentRunStreamEvent } from "@sixb/core/agents/streams"
import { bindDurableAgentExecution } from "@sixb/core/internal/agent-execution"
import {
  agentRunQueueJobId,
  createAgentRunExecutionToken,
  createAgentRunId,
  createSubagentRunId,
  createSubagentThreadId,
  ensureManagedAgentExecutionIdentity,
  holdAgentApprovalCall,
  isAgentToolResult,
  publishAgentRunCancel,
} from "@sixb/core/internal/agents"
import { agentRunStreamId } from "@sixb/core/internal/agents/streams"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import { attachSixbErrorReporter, flushSixbErrors } from "@sixb/core/internal/error-reporting"
import { createSixbError } from "@sixb/core/internal/errors"
import { enqueueAiModelCallRecovery } from "@sixb/core/internal/model-execution"
import { renderOntologyDocs } from "@sixb/core/internal/ontology"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import { QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"
import { workflowAgentStepActorId } from "@sixb/core/internal/workflows"
import type {
  ImageModel,
  LanguageModel,
  LanguageModelRequest,
  LanguageModelStreamEvent,
  ModelFinishReason,
  ModelTool,
  ModelUsage,
} from "@sixb/core/models"
import { ModelProviderError, UnsupportedModelFeatureError } from "@sixb/core/models"
import type { AgentQueueJob, ClaimedQueueJob } from "@sixb/core/queues"
import {
  initializeSandboxEnvironment,
  SandboxStateUnavailableError,
  sandboxConfig,
} from "@sixb/core/sandboxes"
import {
  type AgentMemoryChange,
  type AgentRunRecord,
  type AgentStorage,
  AgentStorageError,
  type AgentThreadRecord,
  type AiUsageStorage,
  type AppendAgentMessageInput,
  type ArtifactRecord,
  type ArtifactStorage,
  type ArtifactVersionRecord,
  type ConversationAgentRunRecord,
  type RecordAiModelCallInput,
  type SubagentRunRecord,
  type WorkflowRunStorage,
} from "@sixb/core/storage"
import {
  createTestAgentExecution,
  createTestSixb,
  createTestWorkflowExecution,
} from "@sixb/core/testing"
import { createVercelGateway } from "../../../models/vercel-ai-gateway/src"
import { AgentWorker, type AgentWorkerOptions } from "../src"
import { renderAgentSystemPrompt, renderCurrentTime } from "../src/agent-prompt"
import { agentMemoryFileHash } from "../src/agent-runtime/memory"
import { AGENT_RUNTIME_PROFILE } from "../src/agent-runtime/profile"
import { normalizeApiBaseUrl } from "../src/api-url"
import { InstalledArtifacts, installArtifactsPublishedBy } from "../src/artifacts/materialize"
import { prepareAgentAttachments } from "../src/attachments"
import { storeChildOutputs } from "../src/child-files"
import * as conversationPreparation from "../src/context-compaction"
import { MAX_AGENT_DELIVERY_ATTEMPTS } from "../src/delivery-policy"
import {
  AgentExecutionLostError,
  AgentFinalizationError,
  AgentRunOwnedElsewhereError,
  AgentTurnTimeoutError,
} from "../src/errors"
import { resolveAgentExecutionPlan } from "../src/execution-plan"
import { finishRunOrThrow } from "../src/finalize"
import { runAgentTurn, stoppedByWorker } from "../src/run-agent-turn"
import * as agentEnvironment from "../src/run-environment"
import {
  createConversationAgentEnvironment,
  createSubagentEnvironment,
  createWorkflowAgentNodeEnvironment,
} from "../src/run-environment"
import { createBrokerStreamSink, NOOP_STREAM_SINK } from "../src/stream-sink"
import { SubagentCoordinator, WAIT_ANSWER_MARGIN_MS } from "../src/subagent-tools"
import { AgentFileBudget } from "../src/tools/tool-files"
import { createAgentTurnRuntime } from "../src/turn-runtime"
import type {
  AgentExecutionContext,
  AgentRunFiles,
  AgentWorkerContext,
  AgentWorkerHost,
  AgentWorkerStorage,
} from "../src/types"
import * as workspaceFiles from "../src/workspace-files"
import { WorkspaceRunFilesConflictError } from "../src/workspace-files"
import { waitFor as pollFor } from "./helpers"
import { testStream, WorkerTestModel, type WorkerTestStreamEvent } from "./worker-model-fixture"

const PROJECT_ID = "agent-worker-tests"
const TEST_AGENT_API_BASE_URL = "http://localhost:3002/api/"
const REQUESTER = { type: "user", id: "usr_requester" } as const
const AGENT_PRINCIPAL = { type: "serviceAccount", id: "svc_agent_assistant" } as const
const AGENT_RUNTIME_GROUP = defineGroup("agent-runtime", { label: "Agent runtime" })
const TEST_PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64"
  )
)

const USAGE: ModelUsage = {
  inputTokens: 10,
  outputTokens: 7,
  uncachedInputTokens: 10,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  textOutputTokens: 7,
  reasoningOutputTokens: 0,
  raw: { input_tokens: 10, output_tokens: 7, provider_meter: 1 },
}

const COMPACTION_USAGE: ModelUsage = {
  inputTokens: 111_000,
  outputTokens: 100,
  raw: { input_tokens: 111_000, output_tokens: 100 },
}

// A test that times out skips its `finally`: never let its fake timers leak into the next test.
afterEach(() => {
  jest.useRealTimers()
})

/** The shared poll at 1ms: every condition polled in this file is an in-memory read. */
const waitFor: typeof pollFor = (fn, options = {}) => pollFor(fn, { intervalMs: 1, ...options })

/** Latch the first settlement (complete, fail or retry) of a queue delivery. */
function observeQueueSettlement<TFailure>(queue: {
  complete(input: { projectId: string; jobId: string; leaseId: string }): Promise<void>
  retry(input: {
    projectId: string
    jobId: string
    leaseId: string
    availableAt?: string
  }): Promise<void>
  fail(input: {
    projectId: string
    jobId: string
    leaseId: string
    failure: TFailure
  }): Promise<void>
}) {
  const complete = queue.complete.bind(queue)
  const fail = queue.fail.bind(queue)
  const retry = queue.retry.bind(queue)
  const settled = Promise.withResolvers<void>()
  let outcome: "complete" | "fail" | "retry" | undefined
  const settle = (kind: "complete" | "fail" | "retry") => {
    outcome ??= kind
    settled.resolve()
  }
  const observer = spyOn(queue, "complete").mockImplementation(async (input) => {
    await complete(input)
    settle("complete")
  })
  const failed = spyOn(queue, "fail").mockImplementation(async (input) => {
    await fail(input)
    settle("fail")
  })
  const retried = spyOn(queue, "retry").mockImplementation(async (input) => {
    await retry(input)
    settle("retry")
  })
  return {
    wait: () => settled.promise,
    settled: () => outcome !== undefined,
    outcome: () => outcome,
    restore: () => {
      observer.mockRestore()
      failed.mockRestore()
      retried.mockRestore()
    },
  }
}

/**
 * One real event-loop turn, so pending I/O settles while timers are fake. A message is used because
 * a `setImmediate` callback was seen to wait up to a second for an unrelated wake-up in this mode.
 */
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

/**
 * Drive fake timers until `check` holds. Each step takes one real event-loop turn, then moves fake
 * time forward by `stepMs`. A step of 0 never moves the clock, to wait for a phase without letting
 * a deadline pass (Bun's `advanceTimersByTime(0)` moves it 1ms, so it is not called).
 */
async function underFakeTime<T>(
  check: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  label: string,
  stepMs = 50
): Promise<T> {
  for (let step = 0; step < 2_000; step += 1) {
    await realLoopTurn()
    const value = await check()
    if (value !== null && value !== undefined && value !== false) return value
    if (stepMs > 0) jest.advanceTimersByTime(stepMs)
  }
  throw new Error(`[test] ${label} did not settle under fake time.`)
}

/** Settle a promise whose work waits on fake timers, with its value or its error. */
async function settleUnderFakeTime<T>(promise: Promise<T>, label: string): Promise<T> {
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

/** Stop a worker started under fake timers: its shutdown may still wait on a backoff. */
function stopUnderFakeTime(worker: AgentWorker): Promise<void> {
  return settleUnderFakeTime(worker.stop(), "worker stop")
}

/**
 * Pin a production backoff: the fake time spent since `start` covers the whole backoff and at
 * most a few driver steps more, so a shortened or stretched backoff fails.
 */
function expectBackoffSpent(start: number, backoffMs: number): void {
  const spent = Date.now() - start
  expect(spent).toBeGreaterThanOrEqual(backoffMs)
  expect(spent).toBeLessThan(backoffMs + 500)
}

async function terminalRun(storage: AgentStorage, runId: string) {
  const run = await storage.runs.getById({ projectId: PROJECT_ID, id: runId })
  return run && run.status !== "queued" && run.status !== "running" ? run : null
}

async function terminalAgentNode(runs: WorkflowRunStorage, nodeRunId: string) {
  const node = await runs.agentNodes.getByNodeRunId({ projectId: PROJECT_ID, nodeRunId })
  return node && node.status !== "queued" && node.status !== "running" ? node : null
}

const ACME_CSV = "quarter,revenue,margin\nQ2,1200,15%\nQ3,1100,12%\n"

const Q3_REVIEW_MARKDOWN =
  "# Q3 review\n\nRestorations within SLA rose to 94%.\n\n## Regions\n\nNorth led.\n"

function toolCallStream(toolCallId: string, toolName: string, input: Record<string, unknown>) {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    finish("tool-calls"),
  ])
}

function answerStream(text: string) {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    finish("stop"),
  ])
}

function artifactStorageOf(sixb: TestSixb | undefined): ArtifactStorage {
  const artifacts = sixb?.storage.artifacts
  if (!artifacts) throw new Error("Expected artifact storage.")
  return artifacts
}

async function onlyArtifact(sixb: TestSixb | undefined): Promise<ArtifactRecord> {
  const { artifacts } = await artifactStorageOf(sixb).list({ projectId: PROJECT_ID })
  const [artifact] = artifacts
  if (!artifact || artifacts.length !== 1) {
    throw new Error(`Expected one artifact, found ${artifacts.length}.`)
  }
  return artifact
}

async function waitForTerminalRun(storage: AgentStorage, runId: string) {
  return waitFor(() => terminalRun(storage, runId), { label: `run ${runId} terminal` })
}

/** A model stream that only ends when its call is aborted. */
function untilAborted(options: LanguageModelRequest) {
  return {
    stream: new ReadableStream<WorkerTestStreamEvent>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] })
        const abort = () => controller.error(new DOMException("Aborted", "AbortError"))
        if (options.signal?.aborted) abort()
        else options.signal?.addEventListener("abort", abort, { once: true })
      },
    }),
  }
}

function stream(chunks: WorkerTestStreamEvent[]) {
  return testStream(chunks)
}

function finish(unified: ModelFinishReason): WorkerTestStreamEvent {
  return { type: "finish", finishReason: unified, rawFinishReason: unified, usage: USAGE }
}

/**
 * A model that, on its first call, calls the `echo` tool, then on its second call answers with
 * reasoning + text. A stateful stream handler guarantees per-call ordering.
 */
function toolThenAnswerModel(captureReplay?: (prompt: string) => void): WorkerTestModel {
  let call = 0
  return new WorkerTestModel({
    modelId: "mock-model",
    stream: async (options) => {
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
        captureReplay?.(JSON.stringify(options.messages))
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

function invalidMetadataAnswerModel(): WorkerTestModel {
  const invalidProviderMetadata = { mock: { generatedAt: new Date() } } as never
  return new WorkerTestModel({
    modelId: "mock-model",
    stream: async () =>
      stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "answer", providerData: invalidProviderMetadata },
        { type: "text-delta", id: "answer", delta: "Done" },
        { type: "text-end", id: "answer" },
        finish("stop"),
      ]),
  })
}

function answerModel(
  captureTools?: (names: readonly string[]) => void,
  captureSystem?: (system: string | undefined) => void
): WorkerTestModel {
  return new WorkerTestModel({
    modelId: "mock-model",
    stream: async (options) => {
      captureTools?.((options.tools ?? []).map((tool) => tool.name))
      captureSystem?.(options.messages.find((message) => message.role === "system")?.content)
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

function delegatingParentModel(input: {
  readonly childRunId: () => string
  readonly childModel: { readonly provider: string; readonly modelId: string } | "heavy"
  readonly onCall?: (options: LanguageModelRequest) => void
}): WorkerTestModel {
  let call = 0
  return new WorkerTestModel({
    providerId: "parent-provider",
    modelId: "parent-model",
    stream: async (options) => {
      input.onCall?.(options)
      call += 1
      if (call === 1) {
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "spawn-child",
            toolName: "spawn_agent",
            input: JSON.stringify({
              key: "research",
              task: "Research the exact delegated fact.",
              model: input.childModel,
              reasoning: "high",
            }),
          },
          finish("tool-calls"),
        ])
      }
      if (call === 2) {
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "wait-child",
            toolName: "wait_agent",
            input: JSON.stringify({ runIds: [input.childRunId()] }),
          },
          finish("tool-calls"),
        ])
      }
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "parent-answer" },
        { type: "text-delta", id: "parent-answer", delta: "Delegation complete" },
        { type: "text-end", id: "parent-answer" },
        finish("stop"),
      ])
    },
  })
}

function compactingAnswerModel(input: {
  readonly provider?: string
  readonly modelId?: string
  readonly captureSummaryPrompt: (prompt: LanguageModelRequest["messages"]) => void
  readonly captureAnswerPrompt: (prompt: LanguageModelRequest["messages"]) => void
  readonly captureSummaryReasoning?: (reasoning: LanguageModelRequest["reasoning"]) => void
  readonly captureAnswerReasoning?: (reasoning: LanguageModelRequest["reasoning"]) => void
}): WorkerTestModel {
  return new WorkerTestModel({
    ...(input.provider === undefined ? {} : { providerId: input.provider }),
    modelId: input.modelId ?? "mock-model",
    stream: async (options) => {
      if (options.tools.length > 0) {
        input.captureAnswerPrompt(options.messages)
        input.captureAnswerReasoning?.(options.reasoning)
        return stream([
          { type: "stream-start" },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "Continued after compaction." },
          { type: "text-end", id: "answer" },
          { type: "finish", finishReason: "stop", usage: COMPACTION_USAGE },
        ])
      }
      expect(options.tools).toEqual([])
      expect(options.maxOutputTokens).toBeGreaterThan(0)
      input.captureSummaryPrompt(options.messages)
      input.captureSummaryReasoning?.(options.reasoning)
      return stream([
        { type: "stream-start" },
        {
          type: "response-metadata",
          id: "compaction-summary-response",
          modelId: "served-summary-model",
        },
        { type: "text-start", id: "summary" },
        {
          type: "text-delta",
          id: "summary",
          delta: [
            "## Goal",
            "Continue the durable test conversation.",
            "## User Constraints and Preferences",
            "Keep the answer concise.",
            "## Established Facts and Results",
            "Earlier turns were completed.",
            "## Completed Actions",
            "Recorded earlier answers.",
            "## Open Work",
            "Answer the latest request.",
            "## Key Decisions",
            "Retain the latest complete turn.",
            "## Important Identifiers and Files",
            "Thread remains authoritative.",
          ].join("\n"),
        },
        { type: "text-end", id: "summary" },
        { type: "finish", finishReason: "stop", usage: COMPACTION_USAGE },
      ])
    },
  })
}

function lengthLimitedSummaryModel(onAnswerCall: () => void): WorkerTestModel {
  return new WorkerTestModel({
    modelId: "mock-model",
    stream: async (request) => {
      if (request.maxOutputTokens !== undefined)
        return stream([
          { type: "stream-start" },
          { type: "text-start", id: "summary" },
          { type: "text-delta", id: "summary", delta: "## Goal\nPartial summary" },
          { type: "text-end", id: "summary" },
          finish("length"),
        ])
      onAnswerCall()
      return stream([finish("stop")])
    },
  })
}

function failingToolThenAnswerModel(captureReplay: (prompt: string) => void): WorkerTestModel {
  let call = 0
  return new WorkerTestModel({
    modelId: "mock-model",
    stream: async (options) => {
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
        captureReplay(JSON.stringify(options.messages))
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

function toolOnlyModel(): WorkerTestModel {
  let call = 0
  return new WorkerTestModel({
    modelId: "mock-model",
    stream: async () => {
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

function structuredAnswerModel(): WorkerTestModel {
  return new WorkerTestModel({
    modelId: "mock-model",
    generate: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ answer: "Project Alpha", confidence: 0.96 }),
        },
      ],
      finishReason: { unified: "stop", raw: "stop" },
      usage: USAGE,
      warnings: [],
    }),
  })
}

function trackedStructuredAnswerModel(
  onCall: (phase: "research" | "finalize") => void,
  modelId = "workflow-model"
) {
  return new WorkerTestModel({
    modelId,
    generate: async (request) => {
      onCall(request.responseFormat?.type === "json" ? "finalize" : "research")
      expect(request.maxOutputTokens).toBe(16_384)
      return {
        content: [
          { type: "text", text: JSON.stringify({ answer: "Project Alpha", confidence: 0.96 }) },
        ],
        finishReason: "stop",
        usage: USAGE,
      }
    },
  })
}

function invalidStructuredAnswerModel(): WorkerTestModel {
  return new WorkerTestModel({
    modelId: "mock-model",
    generate: async () => ({
      content: [{ type: "text", text: JSON.stringify({ answer: 42, confidence: "high" }) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: USAGE,
      warnings: [],
    }),
  })
}

function structuredToolThenAnswerModel(
  captureSystem?: (system: string | undefined) => void
): WorkerTestModel {
  let call = 0
  return new WorkerTestModel({
    modelId: "mock-model",
    generate: async (options) => {
      captureSystem?.(options.messages.find((message) => message.role === "system")?.content)
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

function bashThenAnswerModel(): WorkerTestModel {
  let call = 0
  return new WorkerTestModel({
    modelId: "mock-model",
    stream: async () => {
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

function apiBashThenAnswerModel(
  captureSystem?: (system: string | undefined) => void
): WorkerTestModel {
  let call = 0
  return new WorkerTestModel({
    modelId: "mock-model",
    stream: async (options) => {
      captureSystem?.(options.messages.find((message) => message.role === "system")?.content)
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
  readonly model: WorkerTestModel
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
    model: new WorkerTestModel({
      modelId: "mock-model",
      stream: async (options) => ({
        stream: new ReadableStream<WorkerTestStreamEvent>({
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
            if (options.signal.aborted) {
              abort()
            } else {
              options.signal.addEventListener("abort", abort, { once: true })
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
  readonly model: WorkerTestModel
  waitForStarted(): Promise<void>
} {
  let started = 0
  const waiters: Array<() => void> = []
  return {
    model: new WorkerTestModel({
      modelId: "mock-model",
      stream: async (options) => ({
        stream: new ReadableStream<WorkerTestStreamEvent>({
          start(controller) {
            started += 1
            for (const resolve of waiters.splice(0)) resolve()
            controller.enqueue({ type: "stream-start", warnings: [] })
            controller.enqueue({ type: "text-start", id: "t1" })
            controller.enqueue({ type: "text-delta", id: "t1", delta: partial })
            // No text-end / finish: the turn hangs here until the abort signal errors the stream.
            const abort = () => controller.error(new DOMException("Aborted", "AbortError"))
            if (options.signal.aborted) {
              abort()
            } else {
              options.signal.addEventListener("abort", abort, { once: true })
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

const echoTool: readonly ModelTool[] = [
  {
    name: "echo",
    description: "Echo a value back.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    parseInput(input) {
      if (
        typeof input !== "object" ||
        input === null ||
        Array.isArray(input) ||
        typeof (input as { value?: unknown }).value !== "string"
      ) {
        throw new TypeError("echo.value must be a string")
      }
      return input as { readonly value: string }
    },
    async execute(input) {
      return { echoed: (input as { readonly value: string }).value }
    },
    errorText: () => "Echo failed.",
  },
]

const echoAgentTool = defineAgentTool("echo")
  .description("Echo a value back.")
  .input({ value: "string" })
  .run(({ input }) => ({ echoed: input.value }))

type TestSixb = AgentWorkerHost & { readonly blobStorage: BlobStorage }
type TestSecurity = Pick<SixbHostOptions, "ontology" | "markings" | "groups" | "roles">
type TestUser = { readonly type: "user"; readonly id: string }

class InspectableAgentWorker extends AgentWorker {
  decideExecutionError(claimed: ClaimedQueueJob<AgentQueueJob>, error: unknown) {
    return this.onExecutionError(claimed, error)
  }

  decideAbortError(claimed: ClaimedQueueJob<AgentQueueJob>, error: unknown) {
    return this.onAbortError(claimed, error)
  }
}

/** Fail the worker's durable execution reads while `failing(read)` says so. */
function withFailingExecutionReads(sixb: TestSixb, failing: (read: number) => boolean) {
  const reads = { count: 0 }
  const host = withStorage(
    sixb,
    new Proxy(sixb.storage, {
      get: (target, property, receiver) =>
        property === "executions"
          ? {
              ...target.executions,
              getById: async (params: Parameters<Storage["executions"]["getById"]>[0]) => {
                reads.count += 1
                if (failing(reads.count)) throw new Error("storage blip")
                return target.executions.getById(params)
              },
            }
          : Reflect.get(target, property, receiver),
    })
  )
  return { host, reads }
}

function workerOptions(
  options: Omit<AgentWorkerOptions, "apiBaseUrl"> & { readonly apiBaseUrl?: string } = {}
): AgentWorkerOptions {
  return {
    ...options,
    apiBaseUrl: options.apiBaseUrl ?? TEST_AGENT_API_BASE_URL,
    defaultMaxSteps: options.defaultMaxSteps ?? 4,
  }
}

function toolFileThenAnswerModel(
  capture: {
    readonly live?: (prompt: unknown) => void
    readonly replay?: (prompt: unknown) => void
    readonly viewed?: (prompt: unknown) => void
  } = {}
): WorkerTestModel {
  let call = 0
  return new WorkerTestModel({
    modelId: "mock-model",
    capabilities: { inputMediaTypes: ["image/png"], localTools: true },
    stream: async (options) => {
      call += 1
      if (call === 1) {
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "image-call-1",
            toolName: "create_image",
            input: JSON.stringify({}),
          },
          finish("tool-calls"),
        ])
      }
      if (call === 2) capture.live?.(options.messages)
      if (call === 3) {
        capture.replay?.(options.messages)
        const promptJson = JSON.stringify(options.messages)
        const sandboxPath = promptJson.match(/sandboxPath=\\"([^"]+generated\.png)\\"/)?.[1]
        if (!sandboxPath) throw new Error("Expected replay attachment sandbox path.")
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "view-image-call-1",
            toolName: "view_file",
            input: JSON.stringify({ path: sandboxPath }),
          },
          finish("tool-calls"),
        ])
      }
      if (call === 4) capture.viewed?.(options.messages)
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "Created the image" },
        { type: "text-end", id: "t" },
        finish("stop"),
      ])
    },
  })
}

function bashImageThenViewModel(captureViewed: (prompt: unknown) => void): WorkerTestModel {
  let call = 0
  return new WorkerTestModel({
    modelId: "mock-model",
    capabilities: { inputMediaTypes: ["image/png"], localTools: true },
    stream: async (options) => {
      call += 1
      if (call === 1) {
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "bash-image-call-1",
            toolName: "bash",
            input: JSON.stringify({ command: "create-view-image" }),
          },
          finish("tool-calls"),
        ])
      }
      if (call === 2) {
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "view-bash-image-call-1",
            toolName: "view_file",
            input: JSON.stringify({ path: "scratch/bash-image.png" }),
          },
          finish("tool-calls"),
        ])
      }
      captureViewed(options.messages)
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "Viewed the bash image" },
        { type: "text-end", id: "t" },
        finish("stop"),
      ])
    },
  })
}

const MeetingRoom = defineObjectType({
  id: "MeetingRoom",
  name: "Meeting room",
  description: "A bookable meeting room. Synced from the facilities system.",
  properties: [prop("id", "string", { required: true, primary: true })],
})

function testSkill(name: string): AgentSkillDefinition {
  return {
    name,
    description: `Use for ${name}.`,
    files: [
      { path: "SKILL.md", contents: `---\nname: ${name}\ndescription: Use for ${name}.\n---\n` },
    ],
  }
}

function testSystemPrompt(): string {
  return renderAgentSystemPrompt({
    mode: "conversation",
    skills: [],
  })
}

interface RecordedCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly options: RunCommandOptions
}

class RecordingSandbox implements Sandbox {
  readonly id: string
  readonly provider: string
  readonly workingDirectory: string
  status: "running" | "stopped" | "failed" = "running"
  readonly commands: RecordedCommand[] = []
  readonly writtenFiles: SandboxFileRecord[] = []
  readonly files = new Map<string, Uint8Array>()
  /** Symbolic links, by the absolute path of the link to the absolute path it leads to. */
  readonly links = new Map<string, string>()
  destroyed = false

  constructor(id: string, provider = "recording") {
    this.id = id
    this.provider = provider
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
    for (const file of files) {
      const path = file.path.startsWith("/") ? file.path : join(this.workingDirectory, file.path)
      this.files.set(
        path,
        typeof file.contents === "string"
          ? new TextEncoder().encode(file.contents)
          : new Uint8Array(file.contents)
      )
    }
  }

  writeWorkingFile(relativePath: string, contents: string): void {
    this.files.set(join(this.workingDirectory, relativePath), new TextEncoder().encode(contents))
  }

  async runCommand(command: string, args: readonly string[] = [], options: RunCommandOptions = {}) {
    this.commands.push({ command, args, options })
    const script = args.at(-1)
    if (
      command === "bash" &&
      typeof script === "string" &&
      script.includes("SIXB_BASH_ENV_READY")
    ) {
      return {
        exitCode: 0,
        stdout: "node\t22.0.0\tsixb agent CLI 1\n",
        stderr: "",
        durationMs: 1,
      }
    }
    if (command === "bash" && script === "sixb doctor") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          profile: AGENT_RUNTIME_PROFILE,
          cli: { version: "1" },
          javascript: { name: "node", version: "22.0.0" },
          project: { id: PROJECT_ID },
        }),
        stderr: "",
        durationMs: 1,
      }
    }
    if (command === "bash" && script === "create-view-image") {
      this.files.set(join(this.workingDirectory, "scratch", "bash-image.png"), TEST_PNG_BYTES)
      return { exitCode: 0, stdout: "created image", stderr: "", durationMs: 1 }
    }
    if (command === "bash" && script === "write-q3-review") {
      this.writeWorkingFile("work/q3-review/document.md", Q3_REVIEW_MARKDOWN)
      this.writeWorkingFile("work/q3-review/.draft-notes", "not for the reader")
      return { exitCode: 0, stdout: "wrote work/q3-review", stderr: "", durationMs: 1 }
    }
    if (command === "bash" && script === "write-handoff-files") {
      this.writeWorkingFile("reports/acme.csv", ACME_CSV)
      this.writeWorkingFile("reports/notes/summary.md", "# Acme\n\nMargins fell.\n")
      this.files.set(join(this.workingDirectory, "out", "logo.png"), TEST_PNG_BYTES)
      this.writeWorkingFile("out/brief.txt", "Brief v1\n")
      this.links.set(
        join(this.workingDirectory, "ctx"),
        join(this.workingDirectory, ".sixb/agent/context")
      )
      for (let index = 0; index < 51; index += 1) {
        this.writeWorkingFile(`reports/daily/${index}.csv`, `day,${index}\n`)
      }
      this.files.set(
        join(this.workingDirectory, "reports", "scan.bin"),
        new Uint8Array(25 * 1024 * 1024 + 1)
      )
      return { exitCode: 0, stdout: "wrote reports", stderr: "", durationMs: 1 }
    }
    if (command === "bash" && script === "write-many-outputs") {
      for (let index = 0; index < 51; index += 1) {
        this.writeWorkingFile(`out/daily/${index}.csv`, `day,${index}\n`)
      }
      return { exitCode: 0, stdout: "wrote out", stderr: "", durationMs: 1 }
    }
    if (command === "bash" && script === "write-child-outputs") {
      this.files.set(join(this.workingDirectory, "out", "margins.png"), TEST_PNG_BYTES)
      this.writeWorkingFile("out/tables/margins.csv", "quarter,margin\nQ3,12%\n")
      this.writeWorkingFile("out/brief.txt", "Brief v2\n")
      this.writeWorkingFile("scratch/draft.md", "not for the parent")
      return { exitCode: 0, stdout: "wrote out", stderr: "", durationMs: 1 }
    }
    if (command === "bash" && script === 'cat "$SIXB_ATTACHMENTS"') {
      return {
        exitCode: 0,
        stdout: this.readFileContents(String(options.env?.SIXB_ATTACHMENTS)),
        stderr: "",
        durationMs: 1,
      }
    }
    if (
      command === "bash" &&
      typeof script === "string" &&
      script.includes("sixb-resolve-sandbox-path")
    ) {
      const encoded = options.env?.SIXB_RESOLVE_PATH_B64
      let path = encoded ? Buffer.from(encoded, "base64").toString("utf-8") : ""
      if (this.links.has(path)) return { exitCode: 0, stdout: "link\n", stderr: "", durationMs: 1 }
      for (const [link, target] of this.links) {
        if (path.startsWith(`${link}/`)) path = `${target}${path.slice(link.length)}`
      }
      const kind = this.files.has(path)
        ? "file"
        : [...this.files.keys()].some((file) => file.startsWith(`${path}/`))
          ? "directory"
          : "missing"
      return {
        exitCode: 0,
        stdout:
          kind === "missing"
            ? "missing\n"
            : `${kind}\n${Buffer.from(path, "utf-8").toString("base64")}\n`,
        stderr: "",
        durationMs: 1,
      }
    }
    if (
      command === "bash" &&
      typeof script === "string" &&
      script.includes("sixb-list-sandbox-files")
    ) {
      const prefix = `${options.env?.SIXB_LIST_DIR}/`
      return {
        exitCode: 0,
        stdout: [...this.files.entries()]
          .filter(([path]) => path.startsWith(prefix))
          .map(
            ([path, bytes]) =>
              `${bytes.byteLength}\t${Buffer.from(path.slice(prefix.length), "utf-8").toString("base64")}`
          )
          .join("\n"),
        stderr: "",
        durationMs: 1,
      }
    }
    if (
      command === "bash" &&
      typeof script === "string" &&
      script.includes("sixb-read-sandbox-file")
    ) {
      const encoded = options.env?.SIXB_READ_PATH_B64
      const path = encoded ? Buffer.from(encoded, "base64").toString("utf-8") : ""
      const bytes = this.files.get(path)
      return bytes
        ? {
            exitCode: 0,
            stdout: `${bytes.byteLength}\n${Buffer.from(bytes).toString("base64")}`,
            stderr: "",
            durationMs: 1,
          }
        : { exitCode: 2, stdout: "", stderr: "file not found", durationMs: 1 }
    }
    if (command === "bash" && script === "print-sixb-env") {
      const env = options.env ?? {}
      return {
        exitCode: 0,
        stdout: [
          `base=${env.SIXB_API_BASE_URL ?? ""}`,
          `project=${env.SIXB_PROJECT_ID ?? ""}`,
          `agent=${env.SIXB_ACTOR_ID ?? ""}`,
          `thread=${env.SIXB_THREAD_ID ?? ""}`,
          `run=${env.SIXB_RUN_ID ?? ""}`,
          `skills=${env.SIXB_SKILLS_DIR ?? ""}`,
          `bin=${env.SIXB_BIN_DIR ?? ""}`,
          `bashEnv=${env.BASH_ENV ?? ""}`,
          `context=${env.SIXB_RUN_CONTEXT ?? ""}`,
          `attachments=${env.SIXB_ATTACHMENTS ?? ""}`,
          `attachmentDir=${env.SIXB_ATTACHMENT_DIR ?? ""}`,
          `artifacts=${env.SIXB_ARTIFACTS ?? ""}`,
          `artifactsDir=${env.SIXB_ARTIFACTS_DIR ?? ""}`,
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

/** Records the lifecycle of a step's workspace: clone, setup, run files and credentials. */
class LoggedSandbox extends RecordingSandbox {
  constructor(
    id: string,
    private readonly events: string[],
    private readonly failingCommand?: string
  ) {
    super(id)
  }

  async setRequestCredentials(credentials: readonly SandboxRequestCredential[]): Promise<void> {
    this.events.push(credentials.length ? "renew" : "clear")
  }

  override async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    const script = args.at(-1) ?? ""
    if (command === "git" && args[0] === "clone") this.events.push("clone")
    if (script.includes("/.sixb/agent/")) this.events.push("exclude-run-files")
    if (script === this.failingCommand) {
      this.commands.push({ command, args, options })
      return { exitCode: 1, stdout: "", stderr: "setup failed", durationMs: 1 }
    }
    return super.runCommand(command, args, options)
  }

  override async writeFiles(files: readonly SandboxFileRecord[]): Promise<void> {
    if (files.some((file) => file.path.includes("/.sixb/agent/")))
      this.events.push("write-run-files")
    await super.writeFiles(files)
  }

  override async destroy(): Promise<void> {
    this.events.push("destroy")
    await super.destroy()
  }
}

/** A step's own factory: it applies its recipe the way a provider does and logs each event. */
class StepSandboxFactory implements SandboxFactory {
  readonly configuration: SandboxConfig
  readonly supportsRequestCredentials = true
  readonly createOptions: CreateSandboxOptions[] = []
  readonly sandboxes: LoggedSandbox[] = []

  constructor(
    recipe: SandboxConfig,
    /** Shared with the step's source auth, so one log orders the whole lifecycle. */
    readonly events: string[] = [],
    private readonly behavior: {
      /** A setup command that exits non-zero. */
      readonly failingCommand?: string
      /** Runs after the session exists and before the clone, like a slow provider boot. */
      readonly beforeClone?: () => Promise<void>
    } = {}
  ) {
    this.configuration = sandboxConfig(recipe)
  }

  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    this.createOptions.push(options)
    this.events.push(options.requestCredentials?.length ? "inject" : "create")
    const sandbox = new LoggedSandbox(
      `step-sandbox-${this.sandboxes.length + 1}`,
      this.events,
      this.behavior.failingCommand
    )
    this.sandboxes.push(sandbox)
    try {
      await this.behavior.beforeClone?.()
      return await initializeSandboxEnvironment(sandbox, options.environment ?? {}, options.signal)
    } catch (error) {
      // Providers reclaim a sandbox whose initialization failed.
      await sandbox.destroy()
      throw error
    }
  }
}

/** Source auth that logs issuance and revocation; renewals can be made to fail. */
function stepSourceAuth(
  events: string[],
  options: {
    readonly firstLifetimeMs?: number
    readonly failRenewal?: boolean
    /** A slow integration: "revoked" is logged only once revocation completes. */
    readonly revokeDelayMs?: number
    /** Every revocation is refused. */
    readonly failRevocation?: boolean
  } = {}
) {
  const accesses: (string | undefined)[] = []
  let issued = 0
  const auth: SandboxSourceAuth = {
    authorize: async ({ source }) => {
      accesses.push(source.access)
      issued++
      if (issued > 1 && options.failRenewal) throw new Error("renewal refused")
      events.push("issue")
      return {
        requests: [
          {
            origin: "https://example.com",
            path: "/repository.git/info/refs",
            method: "GET",
            headers: { Authorization: "step-secret" },
          },
        ],
        env: { GIT_AUTHOR_NAME: "Step agent" },
        expiresAt: new Date(
          Date.now() + (issued === 1 ? (options.firstLifetimeMs ?? 3_600_000) : 3_600_000)
        ),
        revoke: async () => {
          events.push("revoke")
          if (options.failRevocation) throw new Error("revocation refused")
          if (options.revokeDelayMs === undefined) return

          await new Promise((resolve) => setTimeout(resolve, options.revokeDelayMs))
          events.push("revoked")
        },
      }
    },
  }
  return { auth, accesses }
}

/** The worker's log lines about closing source credentials, from a `console.error` spy. */
function credentialCleanupLogs(errors: ReturnType<typeof spyOn<Console, "error">>): string[] {
  return errors.mock.calls
    .map(([message]) => String(message))
    .filter((message) => message.includes("revoked") || message.includes("cleanup failed"))
}

/** Answers the workflow request at once, keeping the first system prompt it receives. */
function promptCapturingAnswerModel(capture: (system: string) => void): WorkerTestModel {
  let captured = false
  return new WorkerTestModel({
    modelId: "mock-model",
    generate: async (request) => {
      const system = request.messages.find((message) => message.role === "system")?.content
      if (!captured && typeof system === "string") {
        captured = true
        capture(system)
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ answer: "Project Alpha", confidence: 0.96 }) },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        warnings: [],
      }
    },
  })
}

/** Holds a step's provisioning until the test lets it continue. */
function provisioningGate() {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    entered,
    release,
    wait: async () => {
      enter()
      await released
    },
  }
}

/** A factory whose provisioning always fails (e.g. missing isolation backend). */
class FailingSandboxFactory implements SandboxFactory {
  async create(): Promise<Sandbox> {
    throw new Error("sandbox provisioning unavailable")
  }
}

function buildSixb(
  model: LanguageModel,
  broker: Broker = new InMemoryBroker(),
  sandboxes: SandboxFactory = new RecordingSandboxFactory(),
  options: {
    readonly sandboxConfig?: SandboxConfig
    readonly skills?: readonly AgentSkillDefinition[]
    readonly projectInstructions?: string
    readonly ontology?: readonly ObjectTypeWithPropertyTokens[]
    readonly ontologyDocs?: OntologyDocsInput
    readonly agentTools?: readonly AgentToolDefinition[]
    readonly projectTools?: readonly AgentToolDefinition[]
    readonly connectors?: readonly ConnectorDefinition[]
    readonly models?: ModelCatalogInput
    readonly security?: TestSecurity
  } = {}
): TestSixb {
  return new SixbHost({
    id: PROJECT_ID,
    ontology: options.ontology ?? [],
    tools: options.projectTools ?? options.agentTools,
    ...(options.connectors === undefined ? {} : { connectors: options.connectors }),
    groups: [AGENT_RUNTIME_GROUP],
    ...options.security,
    broker,
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    sandboxes: {
      configuration: options.sandboxConfig,
      supportsRequestCredentials: sandboxes.supportsRequestCredentials,
      create: async (input) => {
        const sandbox = await sandboxes.create(input)
        return input?.environment
          ? initializeSandboxEnvironment(sandbox, input.environment, input.signal)
          : sandbox
      },
      ...(sandboxes.resume
        ? {
            resume: (name: string, input?: import("@sixb/core").ResumeSandboxOptions) =>
              sandboxes.resume!(name, input),
          }
        : {}),
    },
    models: options.models ?? { language: [model] },
    agent: {
      ...(options.skills === undefined ? {} : { skills: options.skills }),
      ...(options.projectInstructions === undefined
        ? {}
        : { instructions: options.projectInstructions }),
      ...(options.ontologyDocs === undefined ? {} : { ontologyDocs: options.ontologyDocs }),
    },
  })
}

function buildSixbWithEchoTool(
  model: LanguageModel,
  broker: Broker = new InMemoryBroker(),
  sandboxes: SandboxFactory = new RecordingSandboxFactory()
): TestSixb {
  return buildSixb(model, broker, sandboxes, { agentTools: [echoAgentTool] })
}

function withOneFailingWorkflowAgentFinalization(storage: Storage): Storage {
  const rootRuns = storage.workflowRuns
  if (!rootRuns) throw new Error("expected workflow run storage")
  let failed = false
  const wrapRuns = (runs: WorkflowRunStorage): WorkflowRunStorage => {
    const agentNodes = new Proxy(runs.agentNodes, {
      get(target, property, receiver) {
        if (property === "finish") {
          return (input: Parameters<typeof target.finish>[0]) => {
            if (!failed) {
              failed = true
              return Promise.reject(new Error("workflow node finalization unavailable"))
            }
            return target.finish(input)
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    return new Proxy(runs, {
      get(target, property, receiver) {
        if (property === "agentNodes") return agentNodes
        const value = Reflect.get(target, property, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  }

  return {
    ...storage,
    workflowRuns: rootRuns,
    transaction: (run, options) =>
      storage.transaction((tx) => {
        const runs = tx.workflowRuns
        return run({
          ...tx,
          ...(runs ? { workflowRuns: wrapRuns(runs) } : {}),
        })
      }, options),
  }
}

/** Calls `onFinish` as a workflow agent node's terminal state is written. */
function observeWorkflowAgentNodeFinish(storage: Storage, onFinish: () => void): Storage {
  const wrapRuns = (runs: WorkflowRunStorage): WorkflowRunStorage => {
    const agentNodes = new Proxy(runs.agentNodes, {
      get(target, property, receiver) {
        if (property === "finish") {
          return (input: Parameters<typeof target.finish>[0]) => {
            onFinish()
            return target.finish(input)
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    return new Proxy(runs, {
      get(target, property, receiver) {
        if (property === "agentNodes") return agentNodes
        const value = Reflect.get(target, property, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  }

  return {
    ...storage,
    transaction: (run, options) =>
      storage.transaction((tx) => {
        const runs = tx.workflowRuns
        return run({ ...tx, ...(runs ? { workflowRuns: wrapRuns(runs) } : {}) })
      }, options),
  }
}

async function terminalWorkflowAgentNode(runs: WorkflowRunStorage, nodeRunId: string) {
  return waitFor(
    async () => {
      const record = await runs.agentNodes.getByNodeRunId({ projectId: PROJECT_ID, nodeRunId })
      return record && record.status !== "queued" && record.status !== "running" ? record : null
    },
    { label: "workflow agent node terminal" }
  )
}

async function seedRequesterUser(storage: Storage, principal: TestUser = REQUESTER): Promise<void> {
  const auth = storage.auth
  if (!auth) throw new Error("expected auth storage")
  const existing = await auth.users.getById({ projectId: PROJECT_ID, id: principal.id })
  if (!existing) {
    await auth.users.create({
      id: principal.id,
      projectId: PROJECT_ID,
      email: `${principal.id}@example.com`,
    })
  }
}

async function queueWorkflowAgentNode(input: {
  readonly model: LanguageModel
  readonly models?: ModelCatalogInput
  readonly tools?: readonly AgentToolDefinition[]
  readonly storage?: Storage
  readonly sandboxes?: SandboxFactory
  /** The step's own sandbox factory. */
  readonly stepSandbox?: SandboxFactory
  readonly runId: string
  readonly requestedByPrincipal?: typeof REQUESTER
  readonly requesterGroupIds?: readonly string[]
  /** Declared groups double as the step's groups. */
  readonly security?: TestSecurity
}) {
  const agentStep = defineAgentStep("workflow-usage-step", {
    model: input.model,
    instructions: "Resolve the best project.",
    groups: input.security?.groups ?? [AGENT_RUNTIME_GROUP],
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.stepSandbox === undefined ? {} : { sandbox: input.stepSandbox }),
  })
    .input({ query: "string" })
    .output({ answer: "string", confidence: "double" })
    .prompt(({ input: stepInput }) => `Resolve '${stepInput.query}'.`)
  const workflow = defineWorkflow("workflow-usage-test").input({ query: "string" }).then(agentStep)
  const sixb = new SixbHost({
    id: PROJECT_ID,
    ontology: [],
    workflows: [workflow],
    tools: input.tools ?? [],
    groups: [AGENT_RUNTIME_GROUP],
    ...input.security,
    broker: new InMemoryBroker(),
    storage: input.storage ?? new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    sandboxes: input.sandboxes ?? new RecordingSandboxFactory(),
    ...(input.models === undefined ? {} : { models: input.models }),
  })
  const runs = sixb.storage.workflowRuns
  if (!runs) throw new Error("expected workflow run storage")
  const requestedBy = input.requestedByPrincipal ?? REQUESTER
  await seedRequesterUser(sixb.storage, requestedBy)

  const nodeRunId = `${input.runId}:node:0`
  const actorId = workflowAgentStepActorId(workflow.id, agentStep.id)
  const executionId = await createTestWorkflowExecution(sixb.storage.executions, {
    projectId: PROJECT_ID,
    workflowId: workflow.id,
    runId: input.runId,
    requestedBy,
    requesterGroupIds: input.requesterGroupIds ?? ["workflow-users"],
  })
  await runs.queue({
    id: input.runId,
    projectId: PROJECT_ID,
    executionId,
    workflowId: workflow.id,
    input: { query: "alpha" },
  })
  await runs.start({ id: input.runId, projectId: PROJECT_ID })
  await runs.nodes.start({
    id: nodeRunId,
    projectId: PROJECT_ID,
    workflowRunId: input.runId,
    workflowId: workflow.id,
    nodeIndex: 0,
    nodeType: "agent",
    nodeId: agentStep.id,
    nodeKey: "workflowUsageStep",
    input: { query: "alpha" },
  })
  const agentExecutionId = await createTestAgentExecution(sixb.storage, {
    projectId: PROJECT_ID,
    actorId: actorId,
    runId: nodeRunId,
    sourceExecutionId: executionId,
  })
  await runs.agentNodes.create({
    projectId: PROJECT_ID,
    nodeRunId,
    executionId: agentExecutionId,
    actorId: actorId,
    prompt: "Resolve 'alpha'.",
  })
  await runs.nodes.wait({ projectId: PROJECT_ID, id: nodeRunId })
  await runs.wait({ projectId: PROJECT_ID, id: input.runId })
  await sixb.queues.agents.enqueue({
    projectId: PROJECT_ID,
    jobs: [
      {
        id: `wfa_job_${nodeRunId}`,
        type: "agent.workflow-node.requested",
        payload: { nodeRunId },
      },
    ],
  })

  return { sixb, runs, workflow, agentStep, nodeRunId, agentExecutionId }
}

/** Record a workflow agent node's success the way the worker does, without running a model. */
async function succeedWorkflowAgentNode(runs: WorkflowRunStorage, nodeRunId: string) {
  const token = "test-execution-token"
  await runs.agentNodes.start({
    projectId: PROJECT_ID,
    nodeRunId,
    execution: { token, queueLeaseExpiresAt: new Date(Date.now() + 60_000) },
  })
  await runs.agentNodes.finish({
    projectId: PROJECT_ID,
    nodeRunId,
    executionToken: token,
    status: "succeeded",
  })
  await runs.nodes.finish({
    projectId: PROJECT_ID,
    id: nodeRunId,
    status: "succeeded",
    output: { answer: "Project Alpha", confidence: 0.96 },
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

function withStorage(sixb: TestSixb, storage: Storage): TestSixb {
  return new Proxy(sixb, {
    get(target, property, receiver) {
      return property === "storage" ? storage : Reflect.get(target, property, receiver)
    },
  })
}

function withAiUsageRecordInterceptor(
  storage: Storage,
  intercept: (
    input: RecordAiModelCallInput,
    record: () => ReturnType<AiUsageStorage["recordModelCall"]>
  ) => ReturnType<AiUsageStorage["recordModelCall"]>
): Storage {
  const wrap = (usage: AiUsageStorage): AiUsageStorage => ({
    getLatestForExecution: (input) => usage.getLatestForExecution(input),
    recordModelCall: (input) => intercept(input, () => usage.recordModelCall(input)),
    summarizeExecution: (input) => usage.summarizeExecution(input),
    summarizeExecutions: (input) => usage.summarizeExecutions(input),
    recordModelCallFiles: (input) => usage.recordModelCallFiles(input),
    getModelCallFiles: (input) => usage.getModelCallFiles(input),
  })
  return {
    ...storage,
    transaction: (run, options) =>
      storage.transaction((tx) => {
        const usage = tx.aiUsage
        return run({
          ...tx,
          ...(usage ? { aiUsage: wrap(usage) } : {}),
        })
      }, options),
  }
}

function aiUsageStorageOf(sixb: TestSixb): AiUsageStorage {
  const storage = sixb.storage.aiUsage
  if (!storage) {
    throw new Error("expected AI usage storage")
  }
  return storage
}

function recoverAiModelCall(sixb: TestSixb) {
  return (record: Parameters<typeof enqueueAiModelCallRecovery>[1]) =>
    enqueueAiModelCallRecovery(sixb.queues.agents, record)
}

function workerStorageOf(storage: Storage): AgentWorkerStorage {
  if (!storage.agents) {
    throw new Error("expected agent storage")
  }
  if (!storage.auth) {
    throw new Error("expected auth storage")
  }
  if (!storage.aiUsage) {
    throw new Error("expected AI usage storage")
  }
  if (!storage.aiCosts) {
    throw new Error("expected AI cost storage")
  }
  return storage as AgentWorkerStorage
}

function executionPlanFor(sixb: TestSixb, defaultMaxSteps = 4) {
  return resolveAgentExecutionPlan({
    models: sixb.definitions.models?.language,
    tools: sixb.definitions.tools,
    skills: sixb.definitions.agent.skills,
    defaultMaxSteps,
  })
}

async function buildAgentWorkerContext(
  sixb: TestSixb,
  input: { readonly apiBaseUrl?: string } = {}
): Promise<AgentExecutionContext> {
  if (!sixb.sandboxes) {
    throw new Error("expected sandbox factory")
  }
  const context: AgentWorkerContext = {
    id: sixb.id,
    storage: workerStorageOf(sixb.storage),
    sandboxes: sixb.sandboxes,
    logging: sixb.logging,
    valueTypesById: sixb.definitions.ontology.getValueTypesById(),
    ontologyDocs: sixb.definitions.agent.ontologyDocs,
    // Mirror the production boundary (worker.ts buildAgentContext): normalize the server base once.
    apiBaseUrl: normalizeApiBaseUrl(input.apiBaseUrl ?? TEST_AGENT_API_BASE_URL),
    streamSink: NOOP_STREAM_SINK,
    recoverAiModelCall: recoverAiModelCall(sixb),
    defaultMaxSteps: 4,
    turnTimeoutMs: 60_000,
    subagentConcurrencyPerRun: 4,
    locale: sixb.locale,
    timeZone: sixb.timeZone,
  }
  const runId = "direct-agent-worker-test"
  const executionId = await createTestAgentExecution(context.storage, {
    projectId: PROJECT_ID,
    runId,
  })
  const execution = await context.storage.executions.getById({
    projectId: PROJECT_ID,
    id: executionId,
  })
  if (!execution) throw new Error("Expected test Agent execution.")
  const agentSixb = bindDurableAgentExecution(sixb, {
    execution,
    runId,
    authorization: { type: "disabled" },
  })
  return {
    ...context,
    sixb: agentSixb,
    blobStorage: agentSixb.blobs,
  }
}

function requestAgent(sixb: TestSixb, input: Parameters<AgentRuntime["runs"]["request"]>[0]) {
  return createTestSixb(sixb).agent.runs.request(input)
}

async function requestAgentAs(
  sixb: TestSixb,
  principal: TestUser,
  input: Parameters<AgentRuntime["runs"]["request"]>[0]
) {
  const auth = sixb.storage.auth
  if (!auth) throw new Error("Expected auth storage.")
  const existing = await auth.users.getById({ projectId: PROJECT_ID, id: principal.id })
  if (!existing) {
    await auth.users.create({
      id: principal.id,
      projectId: PROJECT_ID,
      email: `${principal.id}@example.com`,
    })
  }
  const sessionId = crypto.randomUUID()
  await auth.sessions.create({
    id: sessionId,
    projectId: PROJECT_ID,
    userId: principal.id,
    strategyId: "test",
    tokenHash: sessionId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  })
  const grants = { ...emptyGrantIndex(), "run:agent": true }
  return bindRequestExecution(sixb, {
    request: new Request("http://localhost/test"),
    authorization: {
      type: "principal",
      context: { principal, sessionId, groupIds: [], roleIds: [], grants },
      credential: { type: "session", id: sessionId },
    },
  }).agent.runs.request(input)
}

/**
 * A turn running elsewhere and the children it spawned, before any worker runs them: only the
 * children's deliveries run in the test.
 */
async function spawnChildOfRunningTurn(
  sixb: TestSixb,
  request: Parameters<AgentRuntime["runs"]["request"]>[0],
  input: { readonly deadline?: Date; readonly keys?: readonly string[] } = {}
) {
  const storage = agentStorageOf(sixb)
  const requested = await requestAgent(sixb, request)
  const [parentJob] = await sixb.queues.agents.claim({ projectId: PROJECT_ID, workerId: "parent" })
  if (!parentJob) throw new Error("Expected the parent job")
  await sixb.queues.agents.complete({
    projectId: PROJECT_ID,
    jobId: parentJob.job.id,
    leaseId: parentJob.leaseId,
  })
  const parent = requireConversationRun(
    await storage.runs.start({
      projectId: PROJECT_ID,
      id: requested.run.id,
      execution: freshTestExecution(),
    })
  )
  const execution = await sixb.storage.executions.getById({
    projectId: PROJECT_ID,
    id: parent.executionId,
  })
  if (!execution) throw new Error("Expected the turn's execution.")

  const coordinator = new SubagentCoordinator(
    sixb,
    await buildAgentWorkerContext(sixb),
    parent,
    execution,
    input.deadline ?? new Date(Date.now() + 60_000)
  )
  const children = []
  for (const key of input.keys ?? ["research"]) {
    children.push(
      await coordinator.spawn({ key, task: `Research ${key}.` }, new AbortController().signal)
    )
  }
  return { parent, children, coordinator }
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
  const run = await agentStorageOf(sixb).runs.start({
    id: request.run.id,
    projectId: PROJECT_ID,
    execution: freshTestExecution(),
  })
  return requireConversationRun(run)
}

function requireConversationRun(run: AgentRunRecord): ConversationAgentRunRecord {
  if (run.kind !== "conversation") throw new Error("Expected a conversational Agent run.")
  return run
}

async function runBashTool(
  context: { readonly tools: readonly ModelTool[] },
  command: string
): Promise<{ readonly stdout: string }> {
  const bash = context.tools.find((candidate) => candidate.name === "bash")
  if (!bash) throw new Error("expected bash tool")
  const input = bash.parseInput({ command })
  return bash.execute(input, {
    signal: new AbortController().signal,
    callId: "test-bash-call",
    toolCallId: "test-bash-tool-call",
  }) as Promise<{ readonly stdout: string }>
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
 * A thread the requester started a minute ago, with a memory save before it started (`# Before`)
 * and one since (`# After`).
 */
async function seedMemoryAroundThreadStart(sixb: TestSixb, threadId: string): Promise<void> {
  const startedAt = Date.now() - 60_000
  await agentStorageOf(sixb).threads.create({
    id: threadId,
    projectId: PROJECT_ID,
    ownerPrincipal: REQUESTER,
    createdAt: new Date(startedAt),
  })
  const save = (baseRevision: number, at: number, changes: AgentMemoryChange[]) =>
    agentStorageOf(sixb).memory.save({
      projectId: PROJECT_ID,
      repoId: `user:${REQUESTER.id}`,
      baseRevision,
      message: "Remember",
      author: REQUESTER,
      changes,
      createdAt: new Date(at),
    })
  await save(0, startedAt - 60_000, [{ path: "MEMORY.md", contents: "# Before\n" }])
  await save(1, startedAt + 30_000, [
    { path: "MEMORY.md", contents: "# After\n" },
    { path: "topics/payments.md", contents: "- Excluding VAT\n" },
  ])
}

function systemPromptOf(messages: LanguageModelRequest["messages"] | undefined): string {
  const system = messages?.find((message) => message.role === "system")
  if (typeof system?.content !== "string") throw new Error("Expected a system prompt.")
  return system.content
}

async function waitForSettledRun(sixb: TestSixb, runId: string): Promise<AgentRunRecord> {
  return waitFor(
    async () => {
      const record = await agentStorageOf(sixb).runs.getById({ projectId: PROJECT_ID, id: runId })
      return record && record.status !== "queued" && record.status !== "running" ? record : null
    },
    { label: `settled run ${runId}` }
  )
}

async function seedCompletedConversationTurn(input: {
  readonly sixb: TestSixb
  readonly threadId: string
  readonly index: number
  readonly text: string
  readonly assistantText?: string
  readonly includeAttachment?: boolean
}): Promise<void> {
  const storage = agentStorageOf(input.sixb)
  const runId = `history_run_${input.index}`
  const userMessageId = `history_user_${input.index}`
  await storage.messages.append({
    id: userMessageId,
    projectId: PROJECT_ID,
    threadId: input.threadId,
    runId: null,
    role: "user",
    parts: [
      { type: "text", text: `historical user ${input.index}: ${input.text}` },
      ...(input.includeAttachment
        ? [
            {
              type: "file" as const,
              fileRef: {
                blobId: `blob_${"0".repeat(64)}`,
                digest: `sha256:${"0".repeat(64)}` as const,
                sizeBytes: 32,
                fileName: "historical.txt",
                mediaType: "text/plain",
              },
            },
          ]
        : []),
    ],
    authorPrincipal: REQUESTER,
  })
  const executionId = await createTestAgentExecution(input.sixb.storage, {
    projectId: PROJECT_ID,
    runId,
  })
  await storage.runs.create({
    id: runId,
    projectId: PROJECT_ID,
    executionId,
    threadId: input.threadId,
    triggerMessageId: userMessageId,
    spec: { model: { provider: "test", modelId: "test-model" } },
  })
  const executionToken = `history_execution_${input.index}`
  await storage.runs.start({
    id: runId,
    projectId: PROJECT_ID,
    execution: {
      token: executionToken,
      queueLeaseExpiresAt: new Date(Date.now() + 60_000),
    },
  })
  await storage.messages.append({
    id: `history_assistant_${input.index}`,
    projectId: PROJECT_ID,
    threadId: input.threadId,
    runId,
    role: "assistant",
    parts: [
      {
        type: "text",
        text: `historical assistant ${input.index}: ${input.assistantText ?? input.text}`,
      },
    ],
    authorPrincipal: AGENT_PRINCIPAL,
  })
  await storage.runs.finish({
    id: runId,
    projectId: PROJECT_ID,
    executionToken,
    status: "succeeded",
    modelId: "mock-model",
    finishReason: "stop",
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
    checkpoints: agents.checkpoints,
    memory: agents.memory,
    approvals: agents.approvals,
    approvalModes: agents.approvalModes,
    runs: {
      create: (input) => agents.runs.create(input),
      createSubagent: (input) => agents.runs.createSubagent(input),
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
    checkpoints: agents.checkpoints,
    memory: agents.memory,
    approvals: agents.approvals,
    approvalModes: agents.approvalModes,
    runs: {
      create: (input) => agents.runs.create(input),
      createSubagent: (input) => agents.runs.createSubagent(input),
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
    checkpoints: agents.checkpoints,
    memory: agents.memory,
    approvals: agents.approvals,
    approvalModes: agents.approvalModes,
    messages: {
      getById: (params) => agents.messages.getById(params),
      list: (input) => agents.messages.list(input),
      append: async (input) => {
        await onBeforeAppend(input)
        return agents.messages.append(input)
      },
      deleteByRunId: (input) => agents.messages.deleteByRunId(input),
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
function hangingModel(onStart?: () => void): WorkerTestModel {
  return new WorkerTestModel({
    modelId: "mock-model",
    stream: async (options) => ({
      stream: new ReadableStream<WorkerTestStreamEvent>({
        start(controller) {
          onStart?.()
          controller.enqueue({ type: "stream-start", warnings: [] })
          const abort = () => controller.error(new DOMException("Aborted", "AbortError"))
          if (options.signal.aborted) {
            abort()
          } else {
            options.signal.addEventListener("abort", abort, { once: true })
          }
        },
      }),
    }),
  })
}

/** A summary request that hangs until the shared turn deadline aborts it. */
function hangingCompactionModel(onStart: () => void): WorkerTestModel {
  return new WorkerTestModel({
    modelId: "mock-model",
    stream: async (options) =>
      new Promise((_, reject) => {
        onStart()
        const abort = () => reject(new DOMException("Aborted", "AbortError"))
        if (options.signal.aborted) {
          abort()
        } else {
          options.signal.addEventListener("abort", abort, { once: true })
        }
      }),
  })
}

describe("AgentWorker", () => {
  test.each([
    "preflight",
    "model",
  ] as const)("interrupts %s when environment authentication renewal fails", async (phase) => {
    // Regression proof: omit the environment failure signal from preflight or runAgentTurn.
    let authorizations = 0
    let revocations = 0
    let interruption: unknown
    let reached = false
    const waitForFailure = (signal: AbortSignal) =>
      new Promise<never>((_, reject) => {
        reached = true
        const abort = () => {
          interruption = signal.reason
          reject(signal.reason)
        }
        if (signal.aborted) abort()
        else signal.addEventListener("abort", abort, { once: true })
      })
    const sandbox = Object.assign(new RecordingSandbox("auth-failure"), {
      setRequestCredentials: async () => {},
    })
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async (options) => waitForFailure(options.signal),
    })
    const host = buildSixb(
      model,
      new InMemoryBroker(),
      {
        supportsRequestCredentials: true,
        create: async () => sandbox,
        resume: async () => sandbox,
      },
      {
        sandboxConfig: {
          source: { type: "git", url: "https://example.com/repo.git" },
          auth: {
            authorize: async () => {
              if (++authorizations > 1) throw new Error("private renewal detail")
              return {
                requests: [
                  {
                    origin: "https://example.com",
                    path: "/repo.git/info/refs",
                    method: "GET",
                    headers: { Authorization: "test-token" },
                  },
                ],
                expiresAt: new Date(Date.now() + 61_000),
                revoke: async () => {
                  revocations++
                },
              }
            },
          },
        },
      }
    )
    attachSixbErrorReporter(host, () => {})
    const prepare = conversationPreparation.prepareAgentConversationContext
    const preflight = spyOn(
      conversationPreparation,
      "prepareAgentConversationContext"
    ).mockImplementation((input) =>
      phase === "preflight" ? waitForFailure(input.runtime.signal) : prepare(input)
    )
    const sdk = createTestSixb(host)
    const thread = await sdk.agent.threads.create({ sandbox: {} })
    const requested = await requestAgent(host, { threadId: thread.id, text: "Work" })
    const completion = observeQueueSettlement(host.queues.agents)
    // The grant's renewal is due one second after it is issued: drive that with fake time.
    jest.useFakeTimers()
    const worker = new AgentWorker(host, workerOptions())
    try {
      await worker.start()
      await underFakeTime(() => reached, `${phase} started`, 0)
      jest.advanceTimersByTime(1_000)
      await underFakeTime(completion.settled, "queue delivery settled", 0)
      const run = await agentStorageOf(host).runs.getById({
        projectId: PROJECT_ID,
        id: requested.run.id,
      })
      expect(run?.status).toBe("failed")
      expect(JSON.stringify(run)).not.toContain("private renewal detail")
      expect(interruption).toMatchObject({
        message: "[SixbAgentWorker] Workspace authentication could not be confirmed.",
      })
      expect(authorizations).toBe(2)
      expect(revocations).toBe(1)
      expect((await sdk.agent.threads.getById(thread.id))?.sandboxState?.status).toBe("blocked")
      expect(sandbox.status).toBe("stopped")
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
      completion.restore()
      preflight.mockRestore()
    }
  })

  test("reports the integration's authentication error to onError, not to the run", async () => {
    // Regression proof: throw authError() without the caught error in WorkspaceAuthSession;
    // the reported chain no longer reaches the integration's message.
    const reported: Error[] = []
    const sandbox = Object.assign(new RecordingSandbox("auth-rejected"), {
      setRequestCredentials: async () => {},
    })
    const host = buildSixb(
      hangingModel(),
      new InMemoryBroker(),
      {
        supportsRequestCredentials: true,
        create: async () => sandbox,
        resume: async () => sandbox,
      },
      {
        sandboxConfig: {
          source: { type: "git", url: "https://example.com/repo.git" },
          auth: {
            authorize: async () => {
              throw new Error("[Integration] Grant the missing permission.")
            },
          },
        },
      }
    )
    attachSixbErrorReporter(host, (error) => {
      reported.push(error)
    })
    const sdk = createTestSixb(host)
    const thread = await sdk.agent.threads.create({ sandbox: {} })
    const requested = await requestAgent(host, { threadId: thread.id, text: "Work" })
    const completion = observeQueueSettlement(host.queues.agents)
    const worker = new AgentWorker(host, workerOptions())
    await worker.start()

    try {
      await completion.wait()
      await flushSixbErrors(host)
      const run = await agentStorageOf(host).runs.getById({
        projectId: PROJECT_ID,
        id: requested.run.id,
      })

      expect(run?.status).toBe("failed")
      expect(JSON.stringify(run)).not.toContain("Grant the missing permission")
      expect(reported).toHaveLength(1)
      expect(reported[0]?.message).toBe(
        "[SixbAgentWorker] Workspace authentication could not be confirmed."
      )
      expect(reported[0]?.cause).toMatchObject({
        message: "[Integration] Grant the missing permission.",
      })
    } finally {
      await worker.stop()
      completion.restore()
    }
  })

  test("does not save a partially prepared environment after losing the queue lease", async () => {
    // Regression proof: remove the lease-loss guard in the environment preparation catch.
    const controller = new AbortController()
    const lost = new QueueDeliveryLeaseLostError("lease lost")
    const sandbox = new RecordingSandbox("lost-during-preparation")
    sandbox.writeFiles = async () => {
      controller.abort(lost)
      throw lost
    }
    const stop = spyOn(sandbox, "stop")
    const host = buildSixb(
      answerModel(),
      new InMemoryBroker(),
      {
        create: async () => sandbox,
        resume: async () => sandbox,
      },
      { sandboxConfig: { setup: [] } }
    )
    const sdk = createTestSixb(host)
    const thread = await sdk.agent.threads.create({ sandbox: {} })
    const requested = await requestAgent(host, { threadId: thread.id, text: "Work" })
    const run = await reserveRequestedRun(host, requested)
    try {
      const error = await createConversationAgentEnvironment({
        context: await buildAgentWorkerContext(host),
        plan: executionPlanFor(host),
        thread,
        sandboxDefinition: host.sandboxDefinition,
        run,
        signal: controller.signal,
      }).catch((caught: unknown) => caught)
      expect(error).toBe(lost)
      expect(stop).not.toHaveBeenCalled()
      expect(sandbox.destroyed).toBe(false)
      expect((await sdk.agent.threads.getById(thread.id))?.sandboxState?.status).toBe("busy")
    } finally {
      stop.mockRestore()
    }
  })

  test.each([
    "preflight",
    "materialization",
  ] as const)("preserves or quarantines the sandbox before terminalizing a failed %s", async (phase) => {
    // Regression proof: remove the save in createConversationAgentEnvironment's catch.
    let acquired = false
    let modelCalls = 0
    const sandbox = new RecordingSandbox("preparation-failure")
    if (phase === "materialization") {
      sandbox.writeFiles = async () => {
        throw new Error("file transport failed")
      }
    }
    const host = buildSixb(
      answerModel(() => {
        modelCalls++
      }),
      new InMemoryBroker(),
      {
        create: async () => {
          acquired = true
          return sandbox
        },
        resume: async () => sandbox,
      },
      { sandboxConfig: { setup: [] } }
    )
    attachSixbErrorReporter(host, () => {})
    const sdk = createTestSixb(host)
    const thread = await sdk.agent.threads.create({ sandbox: {} })
    const requested = await requestAgent(host, { threadId: thread.id, text: "Work" })
    const agents = agentStorageOf(host)
    const prepare = conversationPreparation.prepareAgentConversationContext
    const history = spyOn(
      conversationPreparation,
      "prepareAgentConversationContext"
    ).mockImplementation(async (input) => {
      if (phase === "preflight" && acquired) throw new Error("history unavailable")
      return prepare(input)
    })
    const stop = sandbox.stop.bind(sandbox)
    // Recorded, not asserted here: the worker would swallow a failed expectation thrown by stop().
    const runStatusAtSave: (string | undefined)[] = []
    const preservation = spyOn(sandbox, "stop").mockImplementation(async () => {
      runStatusAtSave.push(
        (await agents.runs.getById({ projectId: PROJECT_ID, id: requested.run.id }))?.status
      )
      await stop()
    })
    const completion = observeQueueSettlement(host.queues.agents)
    const worker = new AgentWorker(host, workerOptions())
    await worker.start()
    try {
      await completion.wait()
      expect(
        await agents.runs.getById({ projectId: PROJECT_ID, id: requested.run.id })
      ).toMatchObject({ status: "failed" })
      expect(await sdk.agent.threads.getById(thread.id)).toMatchObject({
        activeRunId: null,
        sandboxState: { status: phase === "preflight" ? "ready" : "blocked" },
      })
      expect(runStatusAtSave).toEqual(["running"])
      expect(modelCalls).toBe(0)
      expect(sandbox.destroyed).toBe(false)
    } finally {
      await worker.stop()
      completion.restore()
      history.mockRestore()
      preservation.mockRestore()
    }
  })

  test("rejects a none network policy before acquiring state or compute", async () => {
    // Regression proof: treat none like an empty restricted policy in workspaceNetwork; provider
    // calls start.
    let providerCalls = 0
    let modelCalls = 0
    const provision = async () => {
      providerCalls++
      return new RecordingSandbox("denied")
    }
    const host = buildSixb(
      answerModel(() => {
        modelCalls++
      }),
      new InMemoryBroker(),
      {
        create: provision,
        resume: provision,
      },
      { sandboxConfig: { resolve: () => ({ network: { mode: "none" } }) } }
    )
    attachSixbErrorReporter(host, () => {})
    const sdk = createTestSixb(host)
    const thread = await sdk.agent.threads.create({ sandbox: {} })
    const requested = await requestAgent(host, { threadId: thread.id, text: "Work" })
    const completion = observeQueueSettlement(host.queues.agents)
    const worker = new AgentWorker(host, workerOptions())
    await worker.start()
    try {
      await completion.wait()
      expect(
        await agentStorageOf(host).runs.getById({ projectId: PROJECT_ID, id: requested.run.id })
      ).toMatchObject({ status: "failed" })
      expect(providerCalls).toBe(0)
      expect(modelCalls).toBe(0)
      expect((await sdk.agent.threads.getById(thread.id))?.sandboxState).toBeUndefined()
    } finally {
      await worker.stop()
      completion.restore()
    }
  })

  test("quarantines an interrupted acquisition even when the provider resolves late", async () => {
    // Regression proof: remove durable acquisition before factory.create; recovery has no anchor.
    let resolveCreate!: (sandbox: Sandbox) => void
    let requestedName: string | undefined
    const late = new Promise<Sandbox>((resolve) => {
      resolveCreate = resolve
    })
    const host = buildSixb(
      answerModel(),
      new InMemoryBroker(),
      {
        create: (options) => {
          if (!options?.persistence) throw new Error("No ephemeral fallback")
          requestedName = options.persistence.name
          return late
        },
        resume: async () => {
          throw new Error("Must not resume")
        },
      },
      {
        sandboxConfig: {
          params: {},
          resolve: () => ({
            source: { type: "git", url: "https://example.com/repository.git" },
          }),
        },
      }
    )
    const sdk = createTestSixb(host)
    const thread = await sdk.agent.threads.create({ sandbox: {} })
    await requestAgent(host, { threadId: thread.id, text: "Work" })
    const worker = new AgentWorker(host, workerOptions())
    await worker.start()
    try {
      await waitFor(() => Promise.resolve(requestedName !== undefined), {
        label: "provider acquisition started",
      })
      await worker.stop()
      const blocked = await sdk.agent.threads.getById(thread.id)
      expect(blocked?.sandboxState?.status).toBe("blocked")
      const oldName = blocked!.sandboxState!.name
      const fresh = await sdk.agent.threads.recreateSandbox(thread.id, {
        expectedSandboxName: oldName,
      })
      expect(fresh.sandboxState?.name).not.toBe(oldName)
      const sandbox = new RecordingSandbox("late-session")
      resolveCreate(sandbox)
      await Promise.resolve()
      expect(sandbox.commands).toHaveLength(0)
      expect(sandbox.destroyed).toBe(false)
      expect((await sdk.agent.threads.getById(thread.id))?.sandboxState).toEqual(fresh.sandboxState)
    } finally {
      resolveCreate(new RecordingSandbox("cleanup-late"))
      await worker.stop()
    }
  })

  test.each([
    true,
    false,
  ])("saves before finalizing and resumes without rerunning setup (Git source: %s)", async (withSource) => {
    // Regression proof: remove beforeFinalize in runAgentTurn; the stop count fails on the first run.
    const authEvents: string[] = []
    const withAuth = withSource
    const prompts: string[] = []
    let grants = 0
    const sandbox = Object.assign(new RecordingSandbox("persistent"), {
      setRequestCredentials: async (
        credentials: readonly { headers: Readonly<Record<string, string>> }[]
      ) => {
        authEvents.push(credentials.length ? "inject" : "clear")
      },
    })
    const auth: SandboxSourceAuth = {
      authorize: async () => {
        grants++
        authEvents.push("issue")
        return {
          expiresAt: new Date(Date.now() + 3_600_000),
          requests: [
            {
              origin: "https://example.com",
              path: "/repository.git/info/refs",
              method: "GET",
              headers: { Authorization: "workspace-secret" },
            },
          ],
          revoke: async () => {
            authEvents.push("revoke")
          },
        }
      },
    }
    let creates = 0
    let resumes = 0
    let resolutions = 0
    let sourceUrl = "https://example.com/repository.git"
    const names: string[] = []
    const policies: CreateSandboxOptions["network"][] = []
    const factory: SandboxFactory = {
      supportsRequestCredentials: true,
      async create(options) {
        // Regression proof: omit persistence from workspace creation; the first run must fail.
        if (!options?.persistence) throw new Error("No ephemeral fallback")
        expect(this).toBe(factory)
        creates++
        policies.push(options.network)
        names.push(options.persistence.name)
        if (options.requestCredentials)
          await sandbox.setRequestCredentials(options.requestCredentials)
        return sandbox
      },
      async resume(name, options) {
        // Class-based providers require their receiver, not a detached resume function.
        expect(this).toBe(factory)
        expect(options).not.toHaveProperty("persistence")
        // Even source-free recipes explicitly confirm current auth requirements on resume.
        expect(options?.requestCredentials).toBeDefined()
        if (!withSource) expect(options?.requestCredentials).toEqual([])
        resumes++
        policies.push(options?.network)
        names.push(name)
        sandbox.status = "running"
        if (options?.requestCredentials)
          await sandbox.setRequestCredentials(options.requestCredentials)
        return sandbox
      },
    }
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async (options) => {
        prompts.push(JSON.stringify(options.messages))
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "Done" },
          { type: "text-end", id: "answer" },
          finish("stop"),
        ])
      },
    })
    const host = buildSixb(model, new InMemoryBroker(), factory, {
      sandboxConfig: {
        params: {},
        auth,
        resolve: async () => {
          resolutions++
          return {
            ...(withSource ? { source: { type: "git" as const, url: sourceUrl } } : {}),
            setup: ["setup-once"],
            network: {
              mode: "restricted",
              allow: [
                { name: "sixb-api", origin: new URL(TEST_AGENT_API_BASE_URL).origin },
                { name: "workspace-repository", origin: new URL(sourceUrl).origin },
                ...(resolutions === 1
                  ? [{ name: "npm", origin: "https://registry.npmjs.org" }]
                  : []),
              ],
            },
          }
        },
      },
    })
    const sdk = createTestSixb(host)
    const thread = await sdk.agent.threads.create({ sandbox: {} })
    const runs = agentStorageOf(host).runs
    attachSixbErrorReporter(host, () => {})
    const stopSession = sandbox.stop.bind(sandbox)
    const observer = spyOn(sandbox, "stop").mockImplementation(async () => {
      const current = await agentStorageOf(host).threads.getById({
        projectId: PROJECT_ID,
        id: thread.id,
      })
      expect(current?.activeRunId).not.toBeNull()
      expect(current?.sandboxState?.status).toBe("busy")
      if (withAuth) expect(authEvents.slice(-2)).toEqual(["clear", "revoke"])
      await stopSession()
    })
    try {
      for (let i = 0; i < 2; i++) {
        const requested = await requestAgent(host, { threadId: thread.id, text: "Continue" })
        const completion = observeQueueSettlement(host.queues.agents)
        const worker = new AgentWorker(host, workerOptions())
        await worker.start()
        try {
          await completion.wait()
          expect(await runs.getById({ projectId: PROJECT_ID, id: requested.run.id })).toMatchObject(
            { status: "succeeded" }
          )
          expect(observer).toHaveBeenCalledTimes(i + 1)
          expect(sandbox.status).toBe("stopped")
          // The stored identity is the exact provider name, not an input to another derivation.
          expect((await sdk.agent.threads.getById(thread.id))?.sandboxState?.name).toBe(names[i])
        } finally {
          await worker.stop()
          completion.restore()
        }
      }
      expect(creates).toBe(1)
      expect(resumes).toBe(1)
      expect(resolutions).toBe(2)
      expect(grants).toBe(withAuth ? 2 : 0)
      // Regression proof: omit workspace in renderAgentSystemPrompt's call; these fail.
      expect(prompts).toHaveLength(2)
      for (const prompt of prompts) {
        expect(prompt).toContain("<workspace>")
        expect(prompt).toContain(
          withSource ? `${sandbox.workingDirectory}/repository` : sandbox.workingDirectory
        )
        if (withSource) expect(prompt).toContain(sourceUrl)
        else expect(prompt).not.toContain("Source (git)")
        expect(prompt).not.toContain("workspace-secret")
        if (withAuth) expect(prompt).toContain("Authenticated access: read.")
        else expect(prompt).not.toContain("Authenticated access:")
      }
      expect(JSON.stringify(sandbox.commands)).not.toContain("workspace-secret")
      expect(JSON.stringify(sandbox.writtenFiles)).not.toContain("workspace-secret")
      if (withAuth)
        expect(authEvents).toEqual([
          "issue",
          "inject",
          "clear",
          "revoke",
          "issue",
          "inject",
          "clear",
          "revoke",
        ])
      // Regression proof: omit recipe.network on acquisition; the first assertion fails.
      expect(policies[0]).toMatchObject({
        mode: "restricted",
        allow: expect.arrayContaining([{ name: "npm", origin: "https://registry.npmjs.org" }]),
      })
      expect(policies[1]).toMatchObject({
        mode: "restricted",
        allow: [
          { name: "sixb-api", origin: expect.any(String) },
          { name: "workspace-repository", origin: "https://example.com" },
        ],
      })
      expect(names[0]).toBe(names[1])
      expect(sandbox.destroyed).toBe(false)
      expect(
        sandbox.commands.filter((call) => call.command === "git" && call.args[0] === "clone")
      ).toHaveLength(withSource ? 1 : 0)
      expect(sandbox.commands.filter((call) => call.args.includes("setup-once"))).toHaveLength(1)
      if (!withSource) {
        expect(sandbox.commands.some((call) => call.command === "git")).toBe(false)
        return
      }
      {
        sourceUrl = "https://example.com/other.git"
        const requested = await requestAgent(host, { threadId: thread.id, text: "Continue" })
        const completion = observeQueueSettlement(host.queues.agents)
        const worker = new AgentWorker(host, workerOptions())
        await worker.start()
        try {
          await completion.wait()
          expect(await runs.getById({ projectId: PROJECT_ID, id: requested.run.id })).toMatchObject(
            { status: "failed" }
          )
          expect(resumes).toBe(1)
          expect(creates).toBe(1)
          expect((await sdk.agent.threads.getById(thread.id))?.sandboxState?.status).toBe("ready")
        } finally {
          await worker.stop()
          completion.restore()
        }
      }
    } finally {
      observer.mockRestore()
    }
  })

  test.each([
    true,
    false,
  ])("recreates confirmed lost state and retains reset context (Git source: %s)", async (withSource) => {
    // Regression proof: disable the unavailable-state branch in createOrResume; run 2 fails.
    const sessions: RecordingSandbox[] = []
    const names: string[] = []
    const prompts: string[] = []
    let resumes = 0
    let resolutions = 0
    let issued = 0
    let revoked = 0
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async (options) => {
        prompts.push(JSON.stringify(options.messages))
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "Done" },
          { type: "text-end", id: "answer" },
          finish("stop"),
        ])
      },
    })
    const host = buildSixb(
      model,
      new InMemoryBroker(),
      {
        supportsRequestCredentials: true,
        async create(options) {
          names.push(options!.persistence!.name)
          if (withSource)
            expect(options?.requestCredentials?.[0]?.headers.Authorization).toBe(`token-${issued}`)
          const session = Object.assign(new RecordingSandbox(`replacement-${sessions.length}`), {
            setRequestCredentials: async () => {},
          })
          sessions.push(session)
          return session
        },
        async resume(name, options) {
          if (withSource)
            expect(options?.requestCredentials?.[0]?.headers.Authorization).toBe(`token-${issued}`)
          resumes++
          if (resumes === 1) throw new SandboxStateUnavailableError("expired")
          expect(name).toBe(names[1])
          sessions[1]!.status = "running"
          return sessions[1]!
        },
      },
      {
        sandboxConfig: {
          auth: {
            authorize: async () => {
              issued++
              return {
                requests: [
                  {
                    origin: "https://example.com",
                    path: "/repo.git/info/refs",
                    method: "GET",
                    headers: { Authorization: `token-${issued}` },
                  },
                ],
                expiresAt: new Date(Date.now() + 3_600_000),
                revoke: async () => {
                  revoked++
                },
              }
            },
          },
          params: {},
          resolve: () => {
            resolutions++
            return {
              ...(withSource
                ? { source: { type: "git" as const, url: "https://example.com/repo.git" } }
                : {}),
              setup: ["prepare-environment"],
            }
          },
        },
      }
    )
    const sdk = createTestSixb(host)
    const thread = await sdk.agent.threads.create({ sandbox: {} })
    let resetAt: string | undefined
    for (let i = 0; i < 3; i++) {
      const requested = await requestAgent(host, { threadId: thread.id, text: "Continue" })
      const completion = observeQueueSettlement(host.queues.agents)
      const worker = new AgentWorker(host, workerOptions())
      await worker.start()
      try {
        await completion.wait()
        expect(
          await agentStorageOf(host).runs.getById({ projectId: PROJECT_ID, id: requested.run.id })
        ).toMatchObject({ status: "succeeded" })
        const state = (
          await agentStorageOf(host).threads.getById({ projectId: PROJECT_ID, id: thread.id })
        )?.sandboxState
        expect(state?.status).toBe("ready")
        if (i === 0) {
          expect(state?.resetAt).toBeUndefined()
          expect(prompts[i]).not.toContain("<sandbox_state>")
        } else {
          expect(state?.resetAt).toEqual(expect.any(String))
          if (i === 1) resetAt = state?.resetAt
          expect(state?.resetAt).toBe(resetAt)
          expect(prompts[i]).toContain("<sandbox_state>")
          expect(prompts[i]).toContain("from before that time are not in it")
        }
      } finally {
        await worker.stop()
        completion.restore()
      }
    }
    expect(resolutions).toBe(3)
    expect(issued).toBe(withSource ? 3 : 0)
    expect(revoked).toBe(issued)
    expect(sessions).toHaveLength(2)
    expect(names[0]).not.toBe(names[1])
    for (const session of sessions) {
      expect(session.destroyed).toBe(false)
      expect(
        session.commands.filter((call) => call.args.includes("prepare-environment"))
      ).toHaveLength(1)
      expect(
        session.commands.filter((call) => call.command === "git" && call.args[0] === "clone")
      ).toHaveLength(withSource ? 1 : 0)
    }
  })

  test.each([
    "transport",
    "replacement-failed",
  ] as const)("does not silently bypass %s during recovery", async (failure) => {
    // Regression proof: recreate on every resume error; counts fail.
    let creates = 0
    let calls = 0
    const names: string[] = []
    const sandbox = new RecordingSandbox("recovery-failure")
    const host = buildSixb(
      answerModel(() => {
        calls++
      }),
      new InMemoryBroker(),
      {
        async create(options) {
          creates++
          names.push(options!.persistence!.name)
          if (creates > 1) throw new Error("creation outcome unknown")
          return sandbox
        },
        async resume() {
          if (failure === "transport") throw new Error("connection lost")
          throw new SandboxStateUnavailableError("expired")
        },
      },
      {
        sandboxConfig: {
          params: {},
          resolve: () => ({ source: { type: "git", url: "https://example.com/repo.git" } }),
        },
      }
    )
    attachSixbErrorReporter(host, () => {})
    const sdk = createTestSixb(host)
    const thread = await sdk.agent.threads.create({ sandbox: {} })
    for (let i = 0; i < 2; i++) {
      const requested = await requestAgent(host, { threadId: thread.id, text: "Continue" })
      const completion = observeQueueSettlement(host.queues.agents)
      const worker = new AgentWorker(host, workerOptions())
      await worker.start()
      try {
        await completion.wait()
        expect(
          await agentStorageOf(host).runs.getById({ projectId: PROJECT_ID, id: requested.run.id })
        ).toMatchObject({ status: i === 0 ? "succeeded" : "failed" })
      } finally {
        await worker.stop()
        completion.restore()
      }
    }
    expect(calls).toBe(1)
    expect(creates).toBe(failure === "replacement-failed" ? 2 : 1)
    if (names.length > 1) expect(names[0]).not.toBe(names[1])
    expect(sandbox.destroyed).toBe(false)
    expect((await sdk.agent.threads.getById(thread.id))?.sandboxState?.status).toBe("blocked")
  })

  test.each([
    "snapshot",
    "cleanup",
    "credential-revocation",
  ] as const)("blocks the workspace after %s failure", async (failure) => {
    const sandbox = Object.assign(new RecordingSandbox("save-failure"), {
      setRequestCredentials: async () => {},
    })
    if (failure === "snapshot") {
      sandbox.stop = async () => {
        throw new Error("snapshot failed")
      }
    } else if (failure === "cleanup") {
      const runCommand = sandbox.runCommand.bind(sandbox)
      let cleanups = 0
      sandbox.runCommand = async (command, args = [], options) => {
        if (args.some((arg) => arg.includes("rm -rf -- .sixb/agent")) && ++cleanups === 2) {
          return { exitCode: 1, stdout: "", stderr: "cleanup failed", durationMs: 1 }
        }
        return runCommand(command, args, options)
      }
    }
    const host = buildSixb(
      answerModel(),
      new InMemoryBroker(),
      {
        supportsRequestCredentials: true,
        create: async (options) => {
          if (!options?.persistence) throw new Error("No ephemeral fallback")
          return sandbox
        },
        resume: async () => sandbox,
      },
      {
        sandboxConfig: {
          params: {},
          ...(failure === "credential-revocation"
            ? {
                auth: {
                  authorize: async () => ({
                    requests: [
                      {
                        origin: "https://example.com",
                        path: "/repository.git/info/refs",
                        method: "GET" as const,
                        headers: { Authorization: "private" },
                      },
                    ],
                    expiresAt: new Date(Date.now() + 3_600_000),
                    revoke: async () => {
                      throw new Error("provider secret must not escape")
                    },
                  }),
                },
              }
            : {}),
          resolve: () => ({
            source: { type: "git", url: "https://example.com/repository.git" },
          }),
        },
      }
    )
    attachSixbErrorReporter(host, () => {})
    const sdk = createTestSixb(host)
    const thread = await sdk.agent.threads.create({ sandbox: {} })
    const requested = await requestAgent(host, { threadId: thread.id, text: "Work" })
    const completion = observeQueueSettlement(host.queues.agents)
    const worker = new AgentWorker(host, workerOptions())
    await worker.start()
    try {
      await completion.wait()
      expect(
        await agentStorageOf(host).runs.getById({ projectId: PROJECT_ID, id: requested.run.id })
      ).toMatchObject({ status: "failed" })
      expect((await sdk.agent.threads.getById(thread.id))?.sandboxState?.status).toBe("blocked")
      await expect(
        requestAgent(host, { threadId: thread.id, text: "Again" })
      ).rejects.toMatchObject({ code: "sandbox_execution_unavailable" })
      expect(sandbox.destroyed).toBe(false)
      if (failure !== "snapshot") expect(sandbox.status).toBe("stopped")
    } finally {
      await worker.stop()
      completion.restore()
    }
  })

  test.each([
    "unsupported",
    "denied",
  ] as const)("rejects %s authentication before acquiring workspace state", async (failure) => {
    // Regression proof: move auth preparation after acquire/create; state or provider counts change.
    let provisions = 0
    let authorizations = 0
    let modelCalls = 0
    const built = buildSixb(
      answerModel(() => {
        modelCalls++
      }),
      new InMemoryBroker(),
      {
        supportsRequestCredentials: true,
        create: async () => {
          provisions++
          throw new Error("should not provision")
        },
        resume: async () => {
          provisions++
          throw new Error("should not resume")
        },
      },
      {
        sandboxConfig: {
          source: { type: "git", url: "https://github.com/acme/repo.git" },
          auth: {
            authorize: async () => {
              authorizations++
              throw new Error("private authorization detail")
            },
          },
        },
      }
    )
    // SixbHost rejects this pairing at construction. A worker host is structural, so the worker
    // keeps its own guard: give it a provider without credential injection.
    const host =
      failure === "unsupported"
        ? new Proxy(built, {
            get(target, property, receiver) {
              const value = Reflect.get(target, property, receiver)
              return property === "sandboxes"
                ? { ...value, supportsRequestCredentials: false }
                : value
            },
          })
        : built
    attachSixbErrorReporter(host, () => {})
    const thread = await createTestSixb(host).agent.threads.create({ sandbox: {} })
    const requested = await requestAgent(host, { threadId: thread.id, text: "Continue" })
    const completion = observeQueueSettlement(host.queues.agents)
    const worker = new AgentWorker(host, workerOptions())
    await worker.start()
    try {
      await completion.wait()
      const run = await agentStorageOf(host).runs.getById({
        projectId: PROJECT_ID,
        id: requested.run.id,
      })
      expect(run?.status).toBe("failed")
      expect(JSON.stringify(run)).not.toContain("private authorization detail")
      expect(
        (await agentStorageOf(host).threads.getById({ projectId: PROJECT_ID, id: thread.id }))
          ?.sandboxState
      ).toBeUndefined()
      expect(provisions).toBe(0)
      expect(modelCalls).toBe(0)
      expect(authorizations).toBe(failure === "unsupported" ? 0 : 1)
    } finally {
      await worker.stop()
      completion.restore()
    }
  })

  test("applies the authentication guest environment on creation and resume", async () => {
    // Regression proof: build WorkspaceAccess's session env without grant.env; the session and
    // command assertions fail. Spread grant.env after recipe.env; the GUEST_SHARED value fails.
    const expected = { GIT_AUTHOR_NAME: "Integration", GUEST_SHARED: "recipe" }
    const sessions: (Readonly<Record<string, string>> | undefined)[] = []
    const sandbox = Object.assign(new RecordingSandbox("guest-env"), {
      setRequestCredentials: async () => {},
    })

    // Each run calls bash once, then answers from its result.
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async (options) =>
        options.messages.at(-1)?.role === "tool"
          ? stream([
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "answer" },
              { type: "text-delta", id: "answer", delta: "Done" },
              { type: "text-end", id: "answer" },
              finish("stop"),
            ])
          : stream([
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "print-guest-env",
                toolName: "bash",
                input: JSON.stringify({ command: "print-guest-env" }),
              },
              finish("tool-calls"),
            ]),
    })
    const host = buildSixb(
      model,
      new InMemoryBroker(),
      {
        supportsRequestCredentials: true,
        create: async (options) => {
          sessions.push(options?.env)
          return sandbox
        },
        resume: async (_name, options) => {
          sessions.push(options?.env)
          sandbox.status = "running"
          return sandbox
        },
      },
      {
        sandboxConfig: {
          source: { type: "git", url: "https://example.com/repository.git" },
          env: { GUEST_SHARED: "recipe" },
          auth: {
            authorize: async () => ({
              requests: [
                {
                  origin: "https://example.com",
                  path: "/repository.git/info/refs",
                  method: "GET",
                  headers: { Authorization: "workspace-secret" },
                },
              ],
              env: { GIT_AUTHOR_NAME: "Integration", GUEST_SHARED: "auth" },
              expiresAt: new Date(Date.now() + 3_600_000),
              revoke: async () => {},
            }),
          },
        },
      }
    )
    const sdk = createTestSixb(host)
    const thread = await sdk.agent.threads.create({ sandbox: {} })

    for (let i = 0; i < 2; i++) {
      const requested = await requestAgent(host, { threadId: thread.id, text: "Continue" })
      const completion = observeQueueSettlement(host.queues.agents)
      const worker = new AgentWorker(host, workerOptions())
      await worker.start()
      try {
        await completion.wait()
        expect(
          await agentStorageOf(host).runs.getById({ projectId: PROJECT_ID, id: requested.run.id })
        ).toMatchObject({ status: "succeeded" })
      } finally {
        await worker.stop()
        completion.restore()
      }
    }

    const commands = sandbox.commands.filter((call) => call.args.at(-1) === "print-guest-env")
    expect(sessions).toEqual([expected, expected])
    expect(commands).toHaveLength(2)
    for (const call of commands) expect(call.options.env).toMatchObject(expected)
  })

  test("rejects an invalid authentication guest environment before provisioning", async () => {
    // Regression proof: replace captureSandboxEnv(grant.env) with grant.env in
    // WorkspaceAuthSession; the provider is called with the invalid environment.
    let provisions = 0
    let revocations = 0
    let modelCalls = 0
    const provision = async () => {
      provisions++
      return new RecordingSandbox("invalid-guest-env")
    }
    const host = buildSixb(
      answerModel(() => {
        modelCalls++
      }),
      new InMemoryBroker(),
      {
        supportsRequestCredentials: true,
        create: provision,
        resume: provision,
      },
      {
        sandboxConfig: {
          source: { type: "git", url: "https://example.com/repository.git" },
          auth: {
            authorize: async () => ({
              requests: [
                {
                  origin: "https://example.com",
                  path: "/repository.git/info/refs",
                  method: "GET",
                  headers: { Authorization: "workspace-secret" },
                },
              ],
              env: { "GIT=AUTHOR": "Integration" },
              expiresAt: new Date(Date.now() + 3_600_000),
              revoke: async () => {
                revocations++
              },
            }),
          },
        },
      }
    )
    attachSixbErrorReporter(host, () => {})
    const thread = await createTestSixb(host).agent.threads.create({ sandbox: {} })
    const requested = await requestAgent(host, { threadId: thread.id, text: "Continue" })
    const completion = observeQueueSettlement(host.queues.agents)
    const worker = new AgentWorker(host, workerOptions())
    await worker.start()
    try {
      await completion.wait()
      expect(
        await agentStorageOf(host).runs.getById({ projectId: PROJECT_ID, id: requested.run.id })
      ).toMatchObject({ status: "failed" })
      expect(
        (await agentStorageOf(host).threads.getById({ projectId: PROJECT_ID, id: thread.id }))
          ?.sandboxState
      ).toBeUndefined()
      expect(provisions).toBe(0)
      expect(modelCalls).toBe(0)
      expect(revocations).toBe(1)
    } finally {
      await worker.stop()
      completion.restore()
    }
  })

  test.each([
    "omitted",
    "restricted",
    "all",
  ] as const)("opens every authentication origin when the network policy is %s", async (mode) => {
    // Regression proof: drop credentialOrigins from workspaceNetwork's required targets; the
    // omitted and restricted policies fail. Return a restricted policy unchanged; it fails too.
    const api = new URL(TEST_AGENT_API_BASE_URL).origin
    const repository = "https://example.com"
    const graphql = "https://api.example.com"
    const registry = { name: "npm", origin: "https://registry.npmjs.org" }
    const network =
      mode === "omitted"
        ? undefined
        : mode === "all"
          ? { mode: "all" as const }
          : { mode: "restricted" as const, allow: [registry] }
    const injections: (readonly SandboxRequestCredential[])[] = []
    let issued = 0
    let created: CreateSandboxOptions | undefined
    let renewed!: () => void
    const renewal = new Promise<void>((resolve) => {
      renewed = resolve
    })
    const sandbox = Object.assign(new RecordingSandbox("credential-network"), {
      setRequestCredentials: async (credentials: readonly SandboxRequestCredential[]) => {
        injections.push(credentials)
        if (credentials.length) renewed()
      },
    })

    // Hold the run open until the first grant has been renewed.
    let modelStarted = false
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async () => {
        modelStarted = true
        await renewal
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "Done" },
          { type: "text-end", id: "answer" },
          finish("stop"),
        ])
      },
    })
    const host = buildSixb(
      model,
      new InMemoryBroker(),
      {
        supportsRequestCredentials: true,
        create: async (options) => {
          created = options
          return sandbox
        },
        resume: async () => sandbox,
      },
      {
        sandboxConfig: {
          source: { type: "git", url: `${repository}/repository.git` },
          ...(network ? { network } : {}),
          auth: {
            authorize: async () => {
              const token = `token-${++issued}`
              return {
                requests: [
                  { origin: repository, path: "/repository.git/info/refs", method: "GET" as const },
                  { origin: graphql, path: "/graphql", method: "POST" as const },
                ].map((target) => ({ ...target, headers: { Authorization: token } })),
                // The first grant is renewed one second after issuance.
                expiresAt: new Date(Date.now() + (issued === 1 ? 61_000 : 3_600_000)),
                revoke: async () => {},
              }
            },
          },
        },
      }
    )
    const sdk = createTestSixb(host)
    const thread = await sdk.agent.threads.create({ sandbox: {} })
    const requested = await requestAgent(host, { threadId: thread.id, text: "Work" })
    const completion = observeQueueSettlement(host.queues.agents)
    // The renewal is due one second after the first grant is issued: drive that with fake time.
    jest.useFakeTimers()
    const worker = new AgentWorker(host, workerOptions())
    try {
      await worker.start()
      await underFakeTime(() => modelStarted, "model held for the renewal", 0)
      jest.advanceTimersByTime(1_000)
      await underFakeTime(completion.settled, "queue delivery settled", 0)
      expect(
        await agentStorageOf(host).runs.getById({ projectId: PROJECT_ID, id: requested.run.id })
      ).toMatchObject({ status: "succeeded" })
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
      completion.restore()
    }

    const required = [
      { name: "sixb-api", origin: api },
      { name: "workspace-repository", origin: repository },
      { name: "workspace-auth", origin: graphql },
    ]
    expect(created?.network).toEqual(
      mode === "all"
        ? { mode: "all" }
        : { mode: "restricted", allow: mode === "restricted" ? [registry, ...required] : required }
    )

    // Every request reaches the provider, at creation and on renewal.
    const targets = (credentials: readonly SandboxRequestCredential[] | undefined) =>
      credentials?.map((credential) => [credential.origin, credential.headers.Authorization])
    expect(targets(created?.requestCredentials)).toEqual([
      [repository, "token-1"],
      [graphql, "token-1"],
    ])
    expect(targets(injections[0])).toEqual([
      [repository, "token-2"],
      [graphql, "token-2"],
    ])
  })

  test("reports a repository that claims the run-file directory when a thread acquires it", async () => {
    // Regression proof: drop the WorkspaceRunFilesConflictError pass-through from
    // acquisitionError in persistent-run-sandbox.ts; the generic recovery error is reported.
    const reported: Error[] = []
    const sandbox = new RecordingSandbox("claimed-run-files")
    const host = buildSixb(
      answerModel(() => {}),
      new InMemoryBroker(),
      { create: async () => sandbox, resume: async () => sandbox },
      { sandboxConfig: { source: { type: "git", url: "https://example.com/repository.git" } } }
    )
    attachSixbErrorReporter(host, (error) => {
      reported.push(error)
    })

    // workspace-files.test.ts runs the script against real repositories; here it only refuses.
    const runFiles = spyOn(workspaceFiles, "prepareWorkspaceRunFiles").mockRejectedValue(
      new WorkspaceRunFilesConflictError()
    )
    const thread = await createTestSixb(host).agent.threads.create({ sandbox: {} })
    const requested = await requestAgent(host, { threadId: thread.id, text: "Continue" })
    const completion = observeQueueSettlement(host.queues.agents)
    const worker = new AgentWorker(host, workerOptions())
    await worker.start()
    try {
      await completion.wait()

      const run = await agentStorageOf(host).runs.getById({
        projectId: PROJECT_ID,
        id: requested.run.id,
      })
      expect(run?.status).toBe("failed")
      expect(reported.map((error) => error.message)).toEqual([
        new WorkspaceRunFilesConflictError().message,
      ])
    } finally {
      await worker.stop()
      completion.restore()
      runFiles.mockRestore()
    }
  })

  test("refuses a stored workspace without a recipe before model or sandbox work", async () => {
    // Regression proof: remove the configuration guard in persistentRunSandbox.
    let modelCalls = 0
    const factory = new RecordingSandboxFactory()
    const model = answerModel(() => {
      modelCalls++
    })
    const sixb = buildSixb(model, new InMemoryBroker(), factory)
    attachSixbErrorReporter(sixb, () => {})
    const thread = await agentStorageOf(sixb).threads.create({
      projectId: PROJECT_ID,
      id: "sandbox-thread",
      ownerPrincipal: { type: "system", id: "system" },
      sandboxParams: { clientId: "acme" },
    })
    const executionId = await createTestAgentExecution(sixb.storage, {
      projectId: PROJECT_ID,
      runId: "sandbox-run",
      authority: "inherited",
    })
    await agentStorageOf(sixb).messages.append({
      projectId: PROJECT_ID,
      id: "sandbox-message",
      threadId: thread.id,
      runId: null,
      role: "user",
      parts: [{ type: "text", text: "Already queued" }],
    })
    const run = await agentStorageOf(sixb).runs.create({
      id: "sandbox-run",
      projectId: PROJECT_ID,
      threadId: thread.id,
      executionId,
      triggerMessageId: "sandbox-message",
      spec: { model: { provider: model.providerId, modelId: model.modelId } },
    })
    await sixb.queues.agents.enqueue({
      projectId: PROJECT_ID,
      jobs: [
        { id: "agt_job_sandbox-run", type: "agent.run.requested", payload: { runId: run.id } },
      ],
    })
    const completion = observeQueueSettlement(sixb.queues.agents)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      await completion.wait()
      expect(modelCalls).toBe(0)
      expect(factory.sandboxes).toHaveLength(0)
      expect(
        await agentStorageOf(sixb).runs.getById({ projectId: PROJECT_ID, id: run.id })
      ).toMatchObject({ status: "failed", error: { code: "agent.execution_failed" } })
    } finally {
      await worker.stop()
      completion.restore()
    }
  })
  test("gives the conversational Agent its delegation tools", async () => {
    // Regression proof: drop the SubagentCoordinator injection in the worker; this fails.
    let toolNames: readonly string[] = []
    const sixb = buildSixb(
      answerModel((names) => {
        toolNames = names
      }),
      new InMemoryBroker(),
      new RecordingSandboxFactory(),
      { projectTools: [echoAgentTool] }
    )
    const requested = await requestAgent(sixb, { text: "Hello" })
    const completion = observeQueueSettlement(sixb.queues.agents)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      await completion.wait()
      expect(toolNames).toEqual(
        expect.arrayContaining(["echo", "read", "view_file", "bash", "spawn_agent", "wait_agent"])
      )
      expect(
        await agentStorageOf(sixb).runs.getById({
          projectId: PROJECT_ID,
          id: requested.run.id,
        })
      ).toMatchObject({ status: "succeeded" })
    } finally {
      await worker.stop()
      completion.restore()
    }
  })

  test("rechecks AI limits after a queued conversation is claimed", async () => {
    let providerCalls = 0
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async () => {
        providerCalls += 1
        throw new Error("A denied conversation call must not reach the provider")
      },
    })
    const sixb = buildSixb(model)
    const reporter = attachSixbErrorReporter(sixb, () => {})
    const request = await requestAgent(sixb, { text: "queued first" })
    await sixb.storage.aiLimits?.createPolicy({
      id: "project_tokens_exhausted_after_queue",
      projectId: PROJECT_ID,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 0 },
    })

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const failed = await waitFor(
        async () => {
          const run = await agentStorageOf(sixb).runs.getById({
            projectId: PROJECT_ID,
            id: request.run.id,
          })
          return run?.status === "failed" ? run : null
        },
        { label: "queued conversation limit failure" }
      )

      expect(providerCalls).toBe(0)
      expect(failed.error).toMatchObject({
        code: "ai.usage_limit_exceeded",
        details: {
          resetAt: expect.any(String),
        },
      })
      expect(failed.error?.details).not.toHaveProperty("policies")
      expect(await listMessages(agentStorageOf(sixb), request.run.threadId)).toHaveLength(1)
      await reporter.flush()
    } finally {
      await worker.stop()
    }
  })

  test("uses eight concurrent jobs by default and accepts an explicit limit", () => {
    const sixb = buildSixb(toolThenAnswerModel())

    expect(new AgentWorker(sixb, workerOptions()).concurrency).toBe(8)
    expect(new AgentWorker(sixb, workerOptions({ concurrency: 7 })).concurrency).toBe(7)
  })
  test("requires an API base URL", () => {
    const sixb = buildSixb(toolThenAnswerModel())

    expect(() => new AgentWorker(sixb, { apiBaseUrl: "" })).toThrow(
      "Agent workers require options.apiBaseUrl."
    )
  })

  test("rejects invalid turn timeout values at the worker boundary", () => {
    const sixb = new SixbHost({
      id: PROJECT_ID,
      ontology: [],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      sandboxes: new RecordingSandboxFactory(),
    })
    const invalidTimeouts = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]

    for (const turnTimeoutMs of invalidTimeouts) {
      expect(() => new AgentWorker(sixb, workerOptions({ turnTimeoutMs }))).toThrow(
        "Agent turn timeout must be a positive integer no greater than 2147483647ms."
      )
    }
  })

  test("warns at execution time when the selected model has no context limit", async () => {
    // Regression proof: reject an undefined model window in resolveAgentContextBudget.
    const base = toolThenAnswerModel()
    const { contextWindow: _contextWindow, ...definition } = base.definition
    let resolutions = 0
    const sixb = buildSixb({
      providerId: base.providerId,
      modelId: base.modelId,
      definition,
      stream: () => {
        throw new Error("must not run inference")
      },
      resolve: async () => {
        resolutions += 1
        return new WorkerTestModel({ definition })
      },
    })
    const worker = new AgentWorker(sixb, workerOptions())
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await worker.start()
      expect(resolutions).toBe(0)
      expect(warning).not.toHaveBeenCalled()
      const request = await requestAgent(sixb, { text: "Hello" })
      const run = await waitForTerminalRun(agentStorageOf(sixb), request.run.id)
      expect(run.status).toBe("succeeded")
      expect(resolutions).toBe(1)
      expect(warning).toHaveBeenCalledTimes(1)
      expect(warning.mock.calls[0]?.[0]).toContain("128,000-token fallback")
    } finally {
      warning.mockRestore()
      await worker.stop()
    }
  })

  test("an unused model resolver cannot block worker startup or a selected model run", async () => {
    // Regression proof: restore catalog-wide prepareAgentModel calls in AgentWorker.start;
    // startup throws the unused resolver error before the valid model can run.
    const selected = new WorkerTestModel()
    const unused = new WorkerTestModel({ modelId: "unused-model" })
    let resolutions = 0
    const sixb = buildSixb(selected, new InMemoryBroker(), new RecordingSandboxFactory(), {
      models: {
        language: [
          selected,
          {
            providerId: unused.providerId,
            modelId: unused.modelId,
            definition: unused.definition,
            stream: (request) => unused.stream(request),
            resolve: async () => {
              resolutions += 1
              throw new Error("unused resolver unavailable")
            },
          },
        ],
      },
    })
    const worker = new AgentWorker(sixb, workerOptions())
    try {
      await worker.start()
      const request = await requestAgent(sixb, { text: "Hello" })
      const run = await waitForTerminalRun(agentStorageOf(sixb), request.run.id)
      expect(run.status).toBe("succeeded")
      expect(resolutions).toBe(0)
    } finally {
      await worker.stop()
    }
  })

  test("automatically checkpoints with the selected model's catalog budget", async () => {
    const summaryPrompts: LanguageModelRequest["messages"][] = []
    const modelId = "gemini-2.5-flash-image"
    // Regression proof: execute the unprepared catalog binding, or use the default model's budget.
    const answeringModel = compactingAnswerModel({
      provider: "google",
      modelId,
      captureSummaryPrompt: (prompt) => {
        summaryPrompts.push(prompt)
      },
      captureAnswerPrompt: () => {},
    })
    const { contextWindow: _contextWindow, ...definition } = answeringModel.definition
    let resolutions = 0
    const selectedModel: LanguageModel = {
      providerId: answeringModel.providerId,
      modelId: answeringModel.modelId,
      definition,
      stream: async () => {
        throw new Error("Must execute the resolved binding")
      },
      resolve: async () => {
        resolutions += 1
        return {
          providerId: answeringModel.providerId,
          modelId: answeringModel.modelId,
          definition: { ...definition, contextWindow: 32_768 },
          stream: (request: LanguageModelRequest) => answeringModel.stream(request),
        }
      },
    }
    const defaultModel = new WorkerTestModel({ modelId: "default-model" })
    const sixb = buildSixb(defaultModel, new InMemoryBroker(), new RecordingSandboxFactory(), {
      models: { language: [defaultModel, selectedModel] },
    })
    const storage = agentStorageOf(sixb)
    const threadId = "automatic_compaction_thread"
    await storage.threads.create({
      id: threadId,
      projectId: PROJECT_ID,
      ownerPrincipal: REQUESTER,
    })
    for (let index = 0; index < 5; index += 1) {
      await seedCompletedConversationTurn({
        sixb,
        threadId,
        index,
        text: `${`automatic-turn-${index}-`}${"x".repeat(12_000)}`,
      })
    }

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const request = await requestAgentAs(sixb, REQUESTER, {
        threadId,
        text: "Continue with the catalog-derived context budget.",
        model: { provider: selectedModel.providerId, modelId: selectedModel.modelId },
      })
      const run = await waitForTerminalRun(storage, request.run.id)

      expect(run.status).toBe("succeeded")
      // The selected metadata snapshot is prepared once and shared by compaction and generation.
      expect(resolutions).toBe(1)
      await expect(
        storage.checkpoints.getLatest({ projectId: PROJECT_ID, threadId })
      ).resolves.toMatchObject({
        createdByRunId: run.id,
        summaryModelId: modelId,
      })
      expect(summaryPrompts).toHaveLength(1)
    } finally {
      await worker.stop()
    }
  })

  test("checkpoints an over-budget thread, continues, and preserves the full transcript", async () => {
    const summaryPrompts: LanguageModelRequest["messages"][] = []
    const answerPrompts: LanguageModelRequest["messages"][] = []
    const summaryReasoning: LanguageModelRequest["reasoning"][] = []
    const answerReasoning: LanguageModelRequest["reasoning"][] = []
    const sixb = buildSixb(
      compactingAnswerModel({
        provider: "test-provider",
        captureSummaryPrompt: (prompt) => {
          summaryPrompts.push(prompt)
        },
        captureAnswerPrompt: (prompt) => {
          answerPrompts.push(prompt)
        },
        captureSummaryReasoning: (reasoning) => {
          summaryReasoning.push(reasoning)
        },
        captureAnswerReasoning: (reasoning) => {
          answerReasoning.push(reasoning)
        },
      }),
      new InMemoryBroker(),
      new RecordingSandboxFactory(),
      {}
    )
    const storage = agentStorageOf(sixb)
    const threadId = "compaction_thread"
    await storage.threads.create({
      id: threadId,
      projectId: PROJECT_ID,
      ownerPrincipal: REQUESTER,
    })
    for (let index = 0; index < 6; index += 1) {
      await seedCompletedConversationTurn({
        sixb,
        threadId,
        index,
        // Over the continuation budget, but the serialized removable turns fit the summary call.
        text: `${`turn-${index}-`}${"x".repeat(index === 5 ? 2_000 : 44_000)}`,
        includeAttachment: index === 0,
      })
    }
    const before = await listMessages(storage, threadId)
    expect(before).toHaveLength(12)

    const messageReads: Parameters<AgentStorage["messages"]["list"]>[0][] = []
    const listStoredMessages = storage.messages.list.bind(storage.messages)
    storage.messages.list = (input) => {
      messageReads.push(input)
      return listStoredMessages(input)
    }
    const blobStats: string[] = []
    const statBlob = sixb.blobStorage.stat.bind(sixb.blobStorage)
    sixb.blobStorage.stat = (blobId) => {
      blobStats.push(blobId)
      return statBlob(blobId)
    }

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const request = await requestAgentAs(sixb, REQUESTER, {
        threadId,
        text: "Continue from the latest completed turn.",
        reasoning: "high",
      })
      const run = await waitForTerminalRun(storage, request.run.id)
      expect(run.status).toBe("succeeded")

      const checkpoint = await storage.checkpoints.getLatest({ projectId: PROJECT_ID, threadId })
      expect(checkpoint).toMatchObject({
        id: `agt_ctx_${run.id}`,
        createdByRunId: run.id,
        reason: "threshold",
        observedHeadSeq: 13,
        summaryModelId: "mock-model",
      })
      expect(checkpoint?.summarizedThroughSeq).toBeGreaterThan(0)
      expect(checkpoint?.estimatedInputTokensBefore).toBeGreaterThan(
        checkpoint?.estimatedInputTokensAfter ?? Number.POSITIVE_INFINITY
      )
      expect(messageReads.map((read) => read.afterSeq)).toEqual([
        undefined,
        checkpoint?.summarizedThroughSeq,
      ])
      expect(blobStats).toEqual([])

      const summaryPrompt = summaryPrompts[0]
      const answerPrompt = answerPrompts[0]
      if (!summaryPrompt || !answerPrompt) {
        throw new Error("Expected both summary and answer model calls.")
      }
      const serializedSummaryPrompt = JSON.stringify(summaryPrompt)
      const serializedAnswerPrompt = JSON.stringify(answerPrompt)
      expect(serializedSummaryPrompt).toContain("historical user 0")
      expect(serializedSummaryPrompt).not.toContain("historical user 5")
      expect(serializedAnswerPrompt).toContain("<sixb_thread_summary>")
      expect(serializedAnswerPrompt).not.toContain("historical user 0")
      expect(serializedAnswerPrompt).toContain("historical user 5")
      expect(serializedAnswerPrompt).toContain("Continue from the latest completed turn.")

      const transcript = await listMessages(storage, threadId)
      expect(transcript).toHaveLength(14)
      expect(transcript.slice(0, before.length)).toEqual([...before])
      expect(transcript.at(-1)?.parts).toContainEqual({
        type: "text",
        text: "Continued after compaction.",
      })

      await expect(
        aiUsageStorageOf(sixb).summarizeExecution({
          projectId: PROJECT_ID,
          executionId: run.executionId,
        })
      ).resolves.toMatchObject({ modelCallCount: 2 })
      // Regression proof: omit onModelCallEnd in generateCheckpointSummary and this row disappears.
      const accounting = await sixb.storage.aiCosts?.listModelCalls({
        projectId: PROJECT_ID,
        executionId: run.executionId,
        from: new Date("2000-01-01T00:00:00.000Z"),
        to: new Date("2100-01-01T00:00:00.000Z"),
      })
      const summaryCall = accounting?.items.find(
        (item) => item.usage.responseModelId === "served-summary-model"
      )
      expect(summaryCall).toMatchObject({
        usage: {
          responseId: "compaction-summary-response",
          responseModelId: "served-summary-model",
          requestedReasoning: "none",
          rawUsage: COMPACTION_USAGE.raw,
        },
        cost: { status: "unpriceable", reason: "missingRateCard" },
      })

      const streamRecords = await listRunStreamRecords(sixb.broker, run.id)
      const streamNames = streamRecords.map((record) => record.name)
      expect(streamNames[0]).toBe("agent.run.started")
      expect(streamNames).toContain("agent.compaction.started")
      expect(streamNames).toContain("agent.compaction.completed")
      expect(streamNames.indexOf("agent.compaction.started")).toBeLessThan(
        streamNames.indexOf("agent.compaction.completed")
      )
      expect(streamNames.indexOf("agent.compaction.completed")).toBeLessThan(
        streamNames.indexOf("agent.ui.chunk")
      )
      const compactionPayloads = streamRecords
        .filter((record) => record.name?.startsWith("agent.compaction."))
        .map((record) => record.payload)
      expect(JSON.stringify(compactionPayloads)).not.toContain("## Goal")

      const secondRequest = await requestAgentAs(sixb, REQUESTER, {
        threadId,
        text: `second-compaction-${"y".repeat(3_000)}`,
      })
      const secondRun = await waitForTerminalRun(storage, secondRequest.run.id)
      expect(secondRun.status).toBe("succeeded")
      const secondCheckpoint = await storage.checkpoints.getLatest({
        projectId: PROJECT_ID,
        threadId,
      })
      expect(secondCheckpoint).toMatchObject({
        id: `agt_ctx_${secondRun.id}`,
        previousCheckpointId: checkpoint?.id,
        createdByRunId: secondRun.id,
      })
      expect(secondCheckpoint?.summarizedThroughSeq).toBeGreaterThan(
        checkpoint?.summarizedThroughSeq ?? Number.POSITIVE_INFINITY
      )
      expect(summaryPrompts).toHaveLength(2)
      expect(JSON.stringify(summaryPrompts[1])).toContain("<sixb_previous_summary>")
      expect(JSON.stringify(summaryPrompts[1])).toContain("Continue the durable test conversation")
      expect(summaryReasoning).toEqual(["none", "none"])
      expect(answerPrompts).toHaveLength(2)
      expect(answerReasoning).toEqual(["high", undefined])
      expect(await listMessages(storage, threadId)).toHaveLength(16)
    } finally {
      await worker.stop()
    }
  })

  test("installs the requester's memory and shows MEMORY.md as of the thread's start", async () => {
    const answerPrompts: LanguageModelRequest["messages"][] = []
    const sandboxes = new RecordingSandboxFactory()
    const assistants = defineGroup("assistants")
    const sixb = buildSixb(
      compactingAnswerModel({
        captureSummaryPrompt: () => {},
        captureAnswerPrompt: (prompt) => {
          answerPrompts.push(prompt)
        },
      }),
      new InMemoryBroker(),
      sandboxes,
      {
        security: {
          ontology: [],
          groups: [AGENT_RUNTIME_GROUP, assistants],
          roles: [
            defineRole("assistant.user", { grantedTo: [assistants], grants: [can.run(agent)] }),
          ],
        },
      }
    )
    await authStorageOf(sixb).users.create({
      id: REQUESTER.id,
      projectId: PROJECT_ID,
      email: `${REQUESTER.id}@example.com`,
    })
    await authStorageOf(sixb).groupMemberships.upsert({
      projectId: PROJECT_ID,
      userId: REQUESTER.id,
      groupId: assistants.id,
      source: "manual",
    })
    const threadId = "memory_thread"
    await seedMemoryAroundThreadStart(sixb, threadId)
    await agentStorageOf(sixb).memory.save({
      projectId: PROJECT_ID,
      repoId: "project",
      baseRevision: 0,
      message: "Share",
      author: { type: "user", id: "usr_keeper" },
      changes: [{ path: "MEMORY.md", contents: "# Shared\n" }],
      createdAt: new Date(Date.now() - 600_000),
    })

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const request = await requestAgentAs(sixb, REQUESTER, {
        threadId,
        text: "What do you remember?",
      })
      expect((await waitForSettledRun(sixb, request.run.id)).status).toBe("succeeded")

      // A save after the thread started reaches the files but not the prompt, so it stays cached.
      // Regression proof: drop `asOf` in loadConversationMemory and the prompt shows "# After".
      const system = systemPromptOf(answerPrompts[0])
      expect(system).toContain(
        '<memory repo="user">\n# Before\n</memory>\n\n<memory repo="project">\n# Shared\n</memory>\n</sixb_memory>'
      )
      // Everyone who can run the agent reads and adds to the project's memory.
      expect(system).toContain("- project/: what everyone in this project should know")
      expect(system).not.toContain("# After")
      expect(system).toContain(
        "To organize entries into topic files or merge a conflict, read .sixb/agent/skills/sixb-memory/SKILL.md."
      )

      const sandbox = await waitFor(
        () =>
          sandboxes.sandboxes.find((candidate) =>
            candidate.writtenFiles.some((file) => file.path.endsWith("/memory.json"))
          ),
        { label: "installed memory" }
      )
      const agentDir = `${sandbox.workingDirectory}/.sixb/agent`
      expect(sandbox.readFileContents(`${agentDir}/memory/user/MEMORY.md`)).toBe("# After\n")
      expect(sandbox.readFileContents(`${agentDir}/memory/user/topics/payments.md`)).toBe(
        "- Excluding VAT\n"
      )
      expect(JSON.parse(sandbox.readFileContents(`${agentDir}/context/memory.json`))).toEqual({
        repos: {
          user: {
            revision: 2,
            files: {
              "MEMORY.md": agentMemoryFileHash("# After\n"),
              "topics/payments.md": agentMemoryFileHash("- Excluding VAT\n"),
            },
          },
          project: {
            revision: 1,
            files: { "MEMORY.md": agentMemoryFileHash("# Shared\n") },
          },
        },
      })
      expect(sandbox.readFileContents(`${agentDir}/memory/project/MEMORY.md`)).toBe("# Shared\n")
      expect(
        sandbox.commands.find((command) => command.options.env?.SIXB_MEMORY_DIR)?.options.env
      ).toMatchObject({
        SIXB_MEMORY_DIR: `${agentDir}/memory`,
      })
      // The memory section names the memory skill, installed with the memory.
      expect(sandbox.readFileContents(`${agentDir}/skills/sixb-memory/SKILL.md`)).toContain(
        "sixb memory save user"
      )
    } finally {
      await worker.stop()
    }
  })

  test("shows the latest MEMORY.md once the thread is compacted", async () => {
    const answerPrompts: LanguageModelRequest["messages"][] = []
    const sixb = buildSixb(
      compactingAnswerModel({
        captureSummaryPrompt: () => {},
        captureAnswerPrompt: (prompt) => {
          answerPrompts.push(prompt)
        },
      })
    )
    const threadId = "compacted_memory_thread"
    await seedMemoryAroundThreadStart(sixb, threadId)
    for (let index = 0; index < 6; index += 1) {
      await seedCompletedConversationTurn({
        sixb,
        threadId,
        index,
        text: `${`turn-${index}-`}${"x".repeat(index === 5 ? 2_000 : 44_000)}`,
      })
    }

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const request = await requestAgentAs(sixb, REQUESTER, {
        threadId,
        text: "Continue from the latest completed turn.",
      })
      expect((await waitForSettledRun(sixb, request.run.id)).status).toBe("succeeded")

      // Regression proof: load memory for the continuation as of the old checkpoint, and this
      // prompt keeps "# Before".
      expect(
        await agentStorageOf(sixb).checkpoints.getLatest({ projectId: PROJECT_ID, threadId })
      ).toMatchObject({ createdByRunId: request.run.id })
      const system = systemPromptOf(answerPrompts[0])
      expect(system).toContain('<memory repo="user">\n# After\n</memory>')
      expect(system).not.toContain("# Before")
    } finally {
      await worker.stop()
    }
  })

  test("preserves AI limit failure during context compaction", async () => {
    // Removal proof: bypass wrapModel in generateCheckpointSummary or drop admissionError retention.
    const summaries: LanguageModelRequest["messages"][] = []
    const sixb = buildSixb(
      compactingAnswerModel({
        captureSummaryPrompt: (prompt) => summaries.push(prompt),
        captureAnswerPrompt: () => {},
      }),
      new InMemoryBroker(),
      new RecordingSandboxFactory(),
      {}
    )
    const storage = agentStorageOf(sixb)
    const threadId = "limited_compaction"
    await storage.threads.create({
      id: threadId,
      projectId: PROJECT_ID,
      ownerPrincipal: REQUESTER,
    })
    await seedCompletedConversationTurn({
      sixb,
      threadId,
      index: 0,
      text: "Research this organization.",
      assistantText: "x".repeat(460_000),
    })
    const request = await requestAgentAs(sixb, REQUESTER, {
      threadId,
      text: "Continue.",
    })
    await sixb.storage.aiLimits?.createPolicy({
      id: "exhausted",
      projectId: PROJECT_ID,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 0 },
    })
    const reporter = attachSixbErrorReporter(sixb, () => {})
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const run = await waitFor(
        async () => {
          const row = await storage.runs.getById({ projectId: PROJECT_ID, id: request.run.id })
          return row?.status === "failed" ? row : null
        },
        { label: "compaction admission failure" }
      )
      expect(run.error?.code).toBe("ai.usage_limit_exceeded")
      expect(summaries).toHaveLength(0)
      expect(await storage.checkpoints.getLatest({ projectId: PROJECT_ID, threadId })).toBeNull()
      const records = await listRunStreamRecords(sixb.broker, run.id)
      expect(records.map((record) => record.name)).toContain("agent.compaction.started")
      await reporter.flush()
    } finally {
      await worker.stop()
    }
  })

  // Regression proof: remove the summary-request budget check; the smaller model gets called.
  test.each([
    ["summary input budget", { contextWindow: 32_768 }, "Continue."],
    ["summary input budget", { contextWindow: 128_000, maxInputTokens: 20_000 }, "Continue."],
    ["retained turn and tools", { contextWindow: 32_768 }, "x".repeat(160_000)],
  ] as const)("rejects an unsafe model switch exceeding %s", async (reason, limits, continuation) => {
    const large = answerModel()
    let smallCalls = 0
    const small: LanguageModel = {
      providerId: "mock",
      modelId: "small",
      definition: {
        kind: "language",
        providerId: "mock",
        modelId: "small",
        capabilities: {},
        ...limits,
      },
      stream: async () => {
        smallCalls += 1
        throw new Error("An over-budget summary must not reach the provider")
      },
    }
    const sixb = buildSixb(large, new InMemoryBroker(), new RecordingSandboxFactory(), {
      models: { language: [large, small] },
    })
    const reportedErrors: Error[] = []
    const reporter = attachSixbErrorReporter(sixb, (error) => {
      reportedErrors.push(error)
    })
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const first = await requestAgent(sixb, {
        text: `Long historical input. ${"x".repeat(160_000)}`,
      })
      await waitFor(
        async () =>
          (
            await storage.runs.getById({
              projectId: PROJECT_ID,
              id: first.run.id,
            })
          )?.status === "succeeded",
        { label: "large-model turn" }
      )
      const before = await listMessages(storage, first.run.threadId)
      const next = await requestAgent(sixb, {
        threadId: first.run.threadId,
        text: continuation,
        model: { provider: small.providerId, modelId: small.modelId },
      })
      const failed = await waitFor(
        async () => {
          const current = await storage.runs.getById({ projectId: PROJECT_ID, id: next.run.id })
          return current?.status === "failed" ? current : null
        },
        { label: "incompatible model switch" }
      )
      expect(failed.spec?.model).toEqual({ provider: small.providerId, modelId: small.modelId })
      expect(smallCalls).toBe(0)
      await reporter.flush()
      expect(reportedErrors).toHaveLength(1)
      expect(reportedErrors[0]?.message).toContain(reason)
      expect(
        await storage.checkpoints.getLatest({ projectId: PROJECT_ID, threadId: first.run.threadId })
      ).toBeNull()
      expect((await listMessages(storage, first.run.threadId)).slice(0, before.length)).toEqual([
        ...before,
      ])
      expect(
        await storage.threads.getById({ projectId: PROJECT_ID, id: first.run.threadId })
      ).toMatchObject({ activeRunId: null })
      expect(
        (await listRunStreamRecords(sixb.broker, failed.id)).find(
          (record) => record.name === "agent.compaction.failed"
        )?.payload
      ).toMatchObject({ errorCode: "context_limit_exceeded" })
      expect(
        await aiUsageStorageOf(sixb).summarizeExecution({
          projectId: PROJECT_ID,
          executionId: failed.executionId,
        })
      ).toMatchObject({ modelCallCount: 0 })
    } finally {
      await worker.stop()
    }
  })

  test("checkpoints one oversized completed turn before a short follow-up", async () => {
    const summaryPrompts: LanguageModelRequest["messages"][] = []
    const answerPrompts: LanguageModelRequest["messages"][] = []
    const sixb = buildSixb(
      compactingAnswerModel({
        captureSummaryPrompt: (prompt) => {
          summaryPrompts.push(prompt)
        },
        captureAnswerPrompt: (prompt) => {
          answerPrompts.push(prompt)
        },
      }),
      new InMemoryBroker(),
      new RecordingSandboxFactory(),
      {}
    )
    const storage = agentStorageOf(sixb)
    const threadId = "oversized_turn_compaction_thread"
    await storage.threads.create({
      id: threadId,
      projectId: PROJECT_ID,
      ownerPrincipal: REQUESTER,
    })
    await seedCompletedConversationTurn({
      sixb,
      threadId,
      index: 0,
      text: "Research this organization.",
      assistantText: `oversized-result-marker ${"x".repeat(460_000)}`,
    })

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const request = await requestAgentAs(sixb, REQUESTER, {
        threadId,
        text: "Continue on.",
      })
      const run = await waitForTerminalRun(storage, request.run.id)

      expect(run.status).toBe("succeeded")
      await expect(
        storage.checkpoints.getLatest({ projectId: PROJECT_ID, threadId })
      ).resolves.toMatchObject({
        createdByRunId: run.id,
        summarizedThroughSeq: 2,
        observedHeadSeq: 3,
      })
      expect(JSON.stringify(summaryPrompts)).toContain("oversized-result-marker")
      expect(JSON.stringify(answerPrompts)).not.toContain("oversized-result-marker")
      expect(JSON.stringify(answerPrompts)).toContain("Continue on.")
      expect(await listMessages(storage, threadId)).toHaveLength(4)
    } finally {
      await worker.stop()
    }
  })

  test("rejects a length-limited summary without creating a checkpoint or calling the agent", async () => {
    let answerCalls = 0
    const sixb = buildSixb(
      lengthLimitedSummaryModel(() => {
        answerCalls += 1
      }),
      new InMemoryBroker(),
      new RecordingSandboxFactory(),
      {}
    )
    const storage = agentStorageOf(sixb)
    const threadId = "failed_compaction_thread"
    await storage.threads.create({
      id: threadId,
      projectId: PROJECT_ID,
      ownerPrincipal: REQUESTER,
    })
    for (let index = 0; index < 2; index += 1) {
      await seedCompletedConversationTurn({
        sixb,
        threadId,
        index,
        text: `${`failed-turn-${index}-`}${"x".repeat(112_000)}`,
      })
    }

    const worker = new AgentWorker(sixb, workerOptions())
    const originalConsoleError = console.error
    console.error = () => {}
    await worker.start()
    try {
      const request = await requestAgentAs(sixb, REQUESTER, {
        threadId,
        text: "This should not run after a partial summary.",
      })
      const run = await waitForTerminalRun(storage, request.run.id)
      expect(run.status).toBe("failed")
      expect(answerCalls).toBe(0)
      await expect(
        storage.checkpoints.getLatest({ projectId: PROJECT_ID, threadId })
      ).resolves.toBeNull()
      expect(await listMessages(storage, threadId)).toHaveLength(5)
      await expect(
        aiUsageStorageOf(sixb).summarizeExecution({
          projectId: PROJECT_ID,
          executionId: run.executionId,
        })
      ).resolves.toMatchObject({ modelCallCount: 1 })

      const records = await listRunStreamRecords(sixb.broker, run.id)
      expect(records.map((record) => record.name)).toEqual([
        "agent.run.started",
        "agent.compaction.started",
        "agent.compaction.failed",
        "agent.run.finished",
      ])
      expect(
        records.find((record) => record.name === "agent.compaction.failed")?.payload
      ).toMatchObject({ errorCode: "summary_failed", reason: "threshold" })
    } finally {
      await worker.stop()
      console.error = originalConsoleError
    }
  })

  test("fails coded non-retryable errors and retries unknown infrastructure failures", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const worker = new InspectableAgentWorker(sixb, workerOptions())
    const now = new Date().toISOString()
    const claimed: ClaimedQueueJob<AgentQueueJob> = {
      leaseId: "lease-1",
      claimedAt: now,
      leaseExpiresAt: now,
      job: {
        id: "job-1",
        projectId: PROJECT_ID,
        createdAt: now,
        availableAt: now,
        attempt: 1,
        type: "agent.run.requested",
        payload: { runId: "run-1" },
      },
    }

    await expect(
      worker.decideExecutionError(
        claimed,
        createSixbError("internal.unexpected", "[SixbAgentWorker] Deterministic worker failure.", {
          details: { runId: "run-1", threadId: "thread-1" },
        })
      )
    ).resolves.toEqual({ kind: "fail" })

    await expect(
      worker.decideExecutionError(claimed, new Error("storage unavailable"))
    ).resolves.toMatchObject({ kind: "retry", availableAt: expect.any(String) })
  })

  test("executes a headless workflow agent node and publishes its resume", async () => {
    let capturedSystem: string | undefined
    const model = structuredToolThenAnswerModel((system) => {
      capturedSystem ??= system
    })
    let lookupCalls = 0
    let toolRun: AgentToolRunInfo | undefined
    const lookupProject = defineAgentTool("lookup_project")
      .description("Look up a project.")
      .input({ query: "string" })
      .run(({ input, run }) => {
        lookupCalls += 1
        toolRun = run
        return { project: "Project Alpha", query: input.query, runId: run.id }
      })
    const agentStep = defineAgentStep("resolve-project", {
      // Regression proof: omit input.models in workflow-node-execution's agent lookup.
      model: {
        providerId: model.providerId,
        modelId: model.modelId,
        definition: model.definition,
        stream: async () => {
          throw new Error("Workflow must execute the prepared binding")
        },
        resolve: async () => model,
      },
      instructions: "Resolve the best project.",
      groups: [AGENT_RUNTIME_GROUP],
      tools: [lookupProject],
      skills: ["project-matching"],
    })
      .input({ query: "string" })
      .output({ answer: "string", confidence: "double" })
      .prompt(({ input }) => `Resolve '${input.query}'.`)
    const workflow = defineWorkflow("resolve-project-workflow")
      .input({ query: "string" })
      .then(agentStep)
    const sandboxes = new RecordingSandboxFactory()
    const sixb = new SixbHost({
      id: PROJECT_ID,
      ontology: [MeetingRoom],
      workflows: [workflow],
      tools: [lookupProject],
      agent: {
        skills: [testSkill("project-matching"), testSkill("customer-replies")],
        instructions: "Always answer in French.",
        ontologyDocs: {
          modules: [{ path: "meeting-room.ts", objectTypeIds: ["MeetingRoom"] }],
          docs: [
            { path: "meeting-room.md", contents: "Rooms are booked by the hour." },
            { path: "conventions.md", contents: "# Naming conventions" },
          ],
          scripts: [],
        },
      },
      groups: [AGENT_RUNTIME_GROUP],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      sandboxes,
    })
    const runs = sixb.storage.workflowRuns!
    const runId = "workflow-agent-run"
    const nodeRunId = `${runId}:node:0`
    const actorId = workflowAgentStepActorId(workflow.id, agentStep.id)
    await seedRequesterUser(sixb.storage)
    const executionId = await createTestWorkflowExecution(sixb.storage.executions, {
      projectId: PROJECT_ID,
      workflowId: workflow.id,
      runId,
      requestedBy: REQUESTER,
      requesterGroupIds: ["operations", "project-alpha"],
    })
    await runs.queue({
      id: runId,
      projectId: PROJECT_ID,
      executionId,
      workflowId: workflow.id,
      input: { query: "alpha" },
    })
    await runs.start({
      id: runId,
      projectId: PROJECT_ID,
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
    const agentExecutionId = await createTestAgentExecution(sixb.storage, {
      projectId: PROJECT_ID,
      actorId: actorId,
      runId: nodeRunId,
      sourceExecutionId: executionId,
    })
    await runs.agentNodes.create({
      projectId: PROJECT_ID,
      nodeRunId,
      executionId: agentExecutionId,
      actorId: actorId,
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
          payload: { nodeRunId },
        },
      ],
    })
    const recordedUsage: RecordAiModelCallInput[] = []
    const aiUsage = aiUsageStorageOf(sixb)
    const workerHost = withStorage(
      sixb,
      withAiUsageRecordInterceptor(sixb.storage, async (usage, record) => {
        recordedUsage.push(structuredClone(usage))
        return record()
      })
    )

    const worker = new AgentWorker(workerHost, workerOptions())
    await worker.start()
    try {
      const execution = await waitFor(() => terminalAgentNode(runs, nodeRunId), {
        label: "workflow agent node terminal",
      })
      expect(execution).toMatchObject({
        status: "succeeded",
        actorId: actorId,
        modelId: "mock-model",
        finishReason: "stop",
        attempt: 1,
      })
      expect(execution.execution).toBeUndefined()
      expect(execution.trace).toBeArray()
      expect(lookupCalls).toBe(1)
      // Regression proof: forwarding the managed actor id instead of step references fails here.
      expect(toolRun).toEqual({
        kind: "workflow",
        id: nodeRunId,
        workflowId: workflow.id,
        stepId: agentStep.id,
      })
      expect(recordedUsage).toHaveLength(3)
      expect(recordedUsage.map((usage) => usage.executionId)).toEqual([
        agentExecutionId,
        agentExecutionId,
        agentExecutionId,
      ])
      expect(recordedUsage.map((usage) => usage.attempt)).toEqual([1, 1, 1])
      expect(recordedUsage.map((usage) => usage.requesterGroupIds)).toEqual([
        ["operations", "project-alpha"],
        ["operations", "project-alpha"],
        ["operations", "project-alpha"],
      ])
      await expect(
        sixb.storage.executions.getById({ projectId: PROJECT_ID, id: agentExecutionId })
      ).resolves.toMatchObject({
        requestedBy: REQUESTER,
        source: { type: "execution", executionId },
      })
      expect(recordedUsage.map((usage) => usage.usage)).toEqual([
        {
          inputTokens: 10,
          outputTokens: 7,
          uncachedInputTokens: 10,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          textOutputTokens: 7,
          reasoningOutputTokens: 0,
        },
        {
          inputTokens: 10,
          outputTokens: 7,
          uncachedInputTokens: 10,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          textOutputTokens: 7,
          reasoningOutputTokens: 0,
        },
        {
          inputTokens: 10,
          outputTokens: 7,
          uncachedInputTokens: 10,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          textOutputTokens: 7,
          reasoningOutputTokens: 0,
        },
      ])
      expect(recordedUsage.map((usage) => usage.requestedModelId)).toEqual([
        "mock-model",
        "mock-model",
        "mock-model",
      ])
      expect(recordedUsage.map((usage) => usage.rawUsage)).toEqual([
        { input_tokens: 10, output_tokens: 7, provider_meter: 1 },
        { input_tokens: 10, output_tokens: 7, provider_meter: 1 },
        { input_tokens: 10, output_tokens: 7, provider_meter: 1 },
      ])
      expect(recordedUsage.every((usage) => usage.occurredAt instanceof Date)).toBe(true)
      expect(new Set(recordedUsage.map((usage) => usage.responseId)).size).toBe(3)
      await expect(
        aiUsage.summarizeExecution({
          projectId: PROJECT_ID,
          executionId: agentExecutionId,
        })
      ).resolves.toMatchObject({
        modelCallCount: 3,
        usage: {
          inputTokens: 30,
          outputTokens: 21,
          totalTokens: 51,
          reportingStatus: "complete",
        },
      })
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
      expect(capturedSystem).toContain("headless workflow agent")
      expect(capturedSystem).toContain("never ask a user for approval or a follow-up question")
      // The task works for whoever started the workflow.
      expect(capturedSystem).toContain('they mean the user {"type":"user","id":"usr_requester"}.')
      // Regression proof: give workflow plans every project skill, or the conversation's
      // project instructions, and these fail.
      expect(capturedSystem).toContain("- project-matching: Use for project-matching.")
      expect(capturedSystem).not.toContain("customer-replies")
      expect(capturedSystem).not.toContain("Always answer in French.")
      const installedSkills = sandboxes.sandboxes[0]?.writtenFiles
        .map((file) => file.path)
        .filter((path) => path.includes("/.sixb/agent/skills/"))
      expect(installedSkills?.map((path) => path.split("/.sixb/agent/skills/")[1])).toEqual([
        "project-matching/SKILL.md",
      ])
      // The step's service account cannot view MeetingRoom: neither its doc nor its notes are
      // mounted. Its prompt lists no ontology files; the files are there for its instructions.
      const installedOntologyDocs = sandboxes.sandboxes[0]?.writtenFiles
        .map((file) => file.path)
        .filter((path) => path.includes("/.sixb/agent/ontology/"))
      expect(installedOntologyDocs?.map((path) => path.split("/.sixb/agent/ontology/")[1])).toEqual(
        ["conventions.md"]
      )
      expect(capturedSystem).not.toContain("Ontology reference files")
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
        payload: { runId, nodeRunId },
      })
    } finally {
      await worker.stop()
    }
  })

  test("bounds a workflow node's environment by the node deadline", async () => {
    // Regression proof: start the deadline after createWorkflowAgentNodeEnvironment in
    // workflow-node-execution.ts; the environment is never cancelled and waits out its fallback.
    let environmentCancelled = false
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model: structuredAnswerModel(),
      runId: "workflow-environment-deadline",
    })
    attachSixbErrorReporter(sixb, () => {})

    // A slow environment, such as a long download: it waits for cancellation or a 3 s fallback.
    const createEnvironment = agentEnvironment.createWorkflowAgentNodeEnvironment
    const environments = spyOn(
      agentEnvironment,
      "createWorkflowAgentNodeEnvironment"
    ).mockImplementation(async (input) => {
      const { signal } = input
      environmentCancelled = await new Promise<boolean>((resolve) => {
        const fallback = setTimeout(() => resolve(false), 3_000)
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(fallback)
            resolve(true)
          },
          { once: true }
        )
      })
      signal?.throwIfAborted()
      return createEnvironment(input)
    })
    const worker = new AgentWorker(sixb, workerOptions({ turnTimeoutMs: 200 }))
    await worker.start()
    try {
      const node = await terminalWorkflowAgentNode(runs, nodeRunId)

      expect(environmentCancelled).toBe(true)
      expect(node.status).toBe("failed")
      expect(node.error?.message).toBe(
        "Agent execution failed. The task did not finish within the agent worker's turn budget (turnTimeoutMs: 200)."
      )
    } finally {
      await worker.stop()
      environments.mockRestore()
    }
  })

  test("cancels a workflow node's sandbox creation when its deadline elapses", async () => {
    // Regression proofs:
    // - drop the signal from ephemeralRunSandbox in createWorkflowAgentNodeEnvironment; creation
    //   is never cancelled, and the terminal write sees no abort reason.
    // - call sandboxReadiness.throwIfFailed() unconditionally in runWorkflowAgentNode; the
    //   provider's cancellation error replaces the deadline as the node's failure.
    const reasonsAtTerminalWrite: unknown[] = []
    let creation: AbortSignal | undefined
    let releaseBoot!: () => void
    const boot = new Promise<void>((resolve) => {
      releaseBoot = resolve
    })

    // A provider that boots until the test releases it, and fails with its own error when its
    // creation is cancelled first.
    const recording = new RecordingSandboxFactory()
    const sandboxes: SandboxFactory = {
      create: async (options) => {
        creation = options?.signal
        await new Promise<void>((resolve, reject) => {
          void boot.then(resolve)
          creation?.addEventListener(
            "abort",
            () => reject(new Error("[TestSandbox] Creation was cancelled.")),
            { once: true }
          )
        })
        return recording.create(options)
      },
    }
    const { model } = controlledBlockingAnswerModel()
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model,
      sandboxes,
      storage: observeWorkflowAgentNodeFinish(new InMemoryStorage(), () => {
        reasonsAtTerminalWrite.push(creation?.reason)
      }),
      runId: "workflow-sandbox-deadline",
    })
    attachSixbErrorReporter(sixb, () => {})

    // Nothing else ends the blocking model: the deadline is the node's only way out.
    const worker = new AgentWorker(sixb, workerOptions({ turnTimeoutMs: 300 }))
    await worker.start()
    try {
      const node = await terminalWorkflowAgentNode(runs, nodeRunId)
      expect(node.status).toBe("failed")

      // The elapsed deadline cancelled creation before the node recorded its fate, not its
      // teardown, and the deadline is the failure recorded.
      expect(reasonsAtTerminalWrite).toHaveLength(1)
      expect(reasonsAtTerminalWrite[0]).toBeInstanceOf(AgentTurnTimeoutError)
      expect(node.error?.message).toBe(
        "Agent execution failed. The task did not finish within the agent worker's turn budget (turnTimeoutMs: 300)."
      )
    } finally {
      releaseBoot()
      await worker.stop()
    }
  })

  test("lets a successful workflow node's sandbox finish booting, then destroys it", async () => {
    // Regression proof: pass the node signal, which ends with the node, to
    // createWorkflowAgentNodeEnvironment; finishing the node then aborts the boot.
    let creation: AbortSignal | undefined
    let releaseBoot!: () => void
    const boot = new Promise<void>((resolve) => {
      releaseBoot = resolve
    })
    const sandboxes = new RecordingSandboxFactory()
    const create = sandboxes.create.bind(sandboxes)
    sandboxes.create = async (options) => {
      creation = options?.signal
      await boot
      return create(options)
    }
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model: structuredAnswerModel(),
      sandboxes,
      runId: "workflow-sandbox-slow-boot",
    })
    const completion = observeQueueSettlement(sixb.queues.agents)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      expect((await terminalWorkflowAgentNode(runs, nodeRunId)).status).toBe("succeeded")
      await completion.wait()
      expect(creation?.aborted).toBe(false)

      releaseBoot()
      await waitFor(() => sandboxes.sandboxes[0]?.destroyed || null, {
        label: "late sandbox destroyed",
      })
    } finally {
      // stop() drains the detached teardown, which waits for the boot.
      releaseBoot()
      await worker.stop()
      completion.restore()
    }
  })

  const STEP_REPOSITORY = "https://example.com/repository.git"

  // Removal proof: drop sandboxModels from resolveWorkflowAgentStepExecutionPlan's call; the step's
  // prompt no longer names the image command.
  test("tells an agent step which of the project's media models it can call", async () => {
    let system: string | undefined
    const painter: ImageModel = {
      providerId: "test",
      modelId: "painter",
      definition: { kind: "image", providerId: "test", modelId: "painter" },
      generate: async () => ({ output: { images: [] } }),
    }
    const model = promptCapturingAnswerModel((prompt) => {
      system = prompt
    })
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model,
      models: { language: [model], image: [painter] },
      runId: "workflow-media-models",
    })
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      expect((await terminalWorkflowAgentNode(runs, nodeRunId)).status).toBe("succeeded")
      expect(system).toContain("`sixb models image")
      expect(system).toContain("- painter\n")
      expect(system).not.toContain("sixb models speech")
    } finally {
      await worker.stop()
    }
  })

  test("gives a workflow step without its own sandbox the project's blank sandbox", async () => {
    // Regression proof: give every workflow node's ephemeralRunSandbox the project factory's
    // static recipe; creation then receives a recipe and the prompt describes a workspace.
    let system: string | undefined
    const sandboxes = new RecordingSandboxFactory()
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model: promptCapturingAnswerModel((prompt) => {
        system = prompt
      }),
      sandboxes,
      runId: "workflow-project-sandbox",
    })
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      expect((await terminalWorkflowAgentNode(runs, nodeRunId)).status).toBe("succeeded")
      await waitFor(() => sandboxes.sandboxes[0]?.destroyed || null, {
        label: "project sandbox destroyed",
      })

      expect(sandboxes.createOptions).toEqual([
        {
          environment: {},
          network: {
            mode: "restricted",
            allow: [{ name: "sixb-api", origin: new URL(TEST_AGENT_API_BASE_URL).origin }],
          },
          signal: expect.any(AbortSignal),
        },
      ])
      expect(system).not.toContain("<workspace>")
    } finally {
      await worker.stop()
    }
  })

  test("runs a workflow step in a fresh checkout of its own sandbox recipe", async () => {
    // Regression proof: ignore node.agentStep.sandbox in workflow-node-execution.ts; the project
    // factory provisions a blank sandbox instead. Move prepareWorkspaceRunFiles after
    // provisioning in EphemeralWorkspace; run files are then written before they are excluded.
    let system: string | undefined
    const projectSandboxes = new RecordingSandboxFactory()
    const step = new StepSandboxFactory({
      source: { type: "git", url: STEP_REPOSITORY },
      setup: ["bun install"],
      env: { NODE_ENV: "test" },
    })
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model: promptCapturingAnswerModel((prompt) => {
        system = prompt
      }),
      sandboxes: projectSandboxes,
      stepSandbox: step,
      runId: "workflow-step-sandbox",
    })
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      expect((await terminalWorkflowAgentNode(runs, nodeRunId)).status).toBe("succeeded")
      await waitFor(() => step.sandboxes[0]?.destroyed || null, { label: "step sandbox destroyed" })

      expect(projectSandboxes.createOptions).toEqual([])
      expect(step.createOptions).toHaveLength(1)
      expect(step.createOptions[0]).toMatchObject({
        env: { NODE_ENV: "test" },
        network: {
          mode: "restricted",
          allow: [
            { name: "sixb-api", origin: new URL(TEST_AGENT_API_BASE_URL).origin },
            { name: "workspace-repository", origin: "https://example.com" },
          ],
        },
        environment: { source: { type: "git", url: STEP_REPOSITORY }, setup: ["bun install"] },
      })
      expect(step.createOptions[0]?.persistence).toBeUndefined()

      const { events } = step
      expect(events.slice(0, 2)).toEqual(["create", "clone"])
      expect(events.indexOf("exclude-run-files")).toBeGreaterThan(-1)
      expect(events.indexOf("exclude-run-files")).toBeLessThan(events.indexOf("write-run-files"))
      expect(events.at(-1)).toBe("destroy")

      expect(system).toContain(
        'Working directory: "/tmp/sixb-recording-sandbox/step-sandbox-1/repository"'
      )
      expect(system).toContain(`Source (git): "${STEP_REPOSITORY}"`)
      expect(system).toContain("This workspace is discarded when the task ends.")
      expect(system).toContain("Do not push: this task cannot publish changes to this repository.")
      expect(system).not.toContain("Files persist")
    } finally {
      await worker.stop()
    }
  })

  test("authenticates a step's checkout host-side and revokes before destroying it", async () => {
    // Regression proof: close credentials only when EphemeralWorkspace is released; the node is
    // then recorded before the grant is revoked.
    let system: string | undefined
    const events: string[] = []
    const atTerminalWrite: string[][] = []
    const { auth, accesses } = stepSourceAuth(events)
    const step = new StepSandboxFactory(
      { source: { type: "git", url: STEP_REPOSITORY, access: "write" }, auth },
      events
    )
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model: promptCapturingAnswerModel((prompt) => {
        system = prompt
      }),
      storage: observeWorkflowAgentNodeFinish(new InMemoryStorage(), () => {
        atTerminalWrite.push([...events])
      }),
      stepSandbox: step,
      runId: "workflow-step-authenticated-sandbox",
    })
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      expect((await terminalWorkflowAgentNode(runs, nodeRunId)).status).toBe("succeeded")
      await waitFor(() => step.sandboxes[0]?.destroyed || null, { label: "step sandbox destroyed" })

      expect(accesses).toEqual(["write"])
      expect(atTerminalWrite).toEqual([expect.arrayContaining(["clear", "revoke"])])
      expect(
        events.filter((event) => ["issue", "inject", "clear", "revoke", "destroy"].includes(event))
      ).toEqual(["issue", "inject", "clear", "revoke", "destroy"])

      expect(step.createOptions[0]?.env).toEqual({ GIT_AUTHOR_NAME: "Step agent" })
      expect(step.createOptions[0]?.requestCredentials).toEqual([
        expect.objectContaining({ headers: { Authorization: "step-secret" } }),
      ])
      expect(system).toContain("Repository access is authenticated outside the sandbox")
      expect(system).toContain("Authenticated access: read and write.")
      expect(system).toContain("Commit and push only when the task requires it.")
      expect(system).not.toContain("step-secret")
    } finally {
      await worker.stop()
    }
  })

  test(
    "fails a workflow step whose credentials cannot be renewed and revokes them",
    async () => {
      // Regression proof: drop failureSignal from the step environment in
      // createWorkflowAgentNodeEnvironment, or environmentFailureSignal from
      // runWorkflowAgentNode's abort signal; the node deadline aborts the model instead.
      let modelAbortReason: unknown
      const events: string[] = []
      const { auth } = stepSourceAuth(events, { firstLifetimeMs: 61_000, failRenewal: true })
      const step = new StepSandboxFactory(
        { source: { type: "git", url: STEP_REPOSITORY }, auth },
        events
      )

      // The model works until it is stopped; the first grant is renewed about a second in.
      const model = new WorkerTestModel({
        modelId: "mock-model",
        stream: async ({ signal }) => {
          if (!signal.aborted) {
            await new Promise((resolve) =>
              signal.addEventListener("abort", resolve, { once: true })
            )
          }
          modelAbortReason = signal.reason
          throw signal.reason
        },
      })
      const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
        model,
        stepSandbox: step,
        runId: "workflow-step-renewal-failure",
      })
      attachSixbErrorReporter(sixb, () => {})
      const worker = new AgentWorker(sixb, workerOptions({ turnTimeoutMs: 4_000 }))
      await worker.start()
      try {
        expect((await terminalWorkflowAgentNode(runs, nodeRunId)).status).toBe("failed")
        await waitFor(() => step.sandboxes[0]?.destroyed || null, {
          label: "step sandbox destroyed",
        })

        expect(modelAbortReason).toMatchObject({
          message: "[SixbAgentWorker] Workspace authentication could not be confirmed.",
        })
        expect(events.filter((event) => event === "revoke")).toHaveLength(1)
        expect(events.indexOf("revoke")).toBeLessThan(events.indexOf("destroy"))
      } finally {
        await worker.stop()
      }
    },
    { timeout: 10_000 }
  )

  test("records a successful step whose credentials cannot be revoked and destroys its sandbox", async () => {
    // Regression proof: remove the catch from closeCredentials in EphemeralWorkspace; the refused
    // revocation fails the node's terminal write path and the node never succeeds.
    const events: string[] = []
    const { auth } = stepSourceAuth(events, { failRevocation: true })
    const step = new StepSandboxFactory(
      { source: { type: "git", url: STEP_REPOSITORY }, auth },
      events
    )
    const errors = spyOn(console, "error").mockImplementation(() => {})
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model: structuredAnswerModel(),
      stepSandbox: step,
      runId: "workflow-step-revocation-failure",
    })
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      expect((await terminalWorkflowAgentNode(runs, nodeRunId)).status).toBe("succeeded")
      await waitFor(() => step.sandboxes[0]?.destroyed || null, { label: "step sandbox destroyed" })

      expect(events.indexOf("revoke")).toBeLessThan(events.indexOf("destroy"))
      expect(credentialCleanupLogs(errors)).toEqual([
        `[SixbAgentWorker] The workspace credentials of run '${nodeRunId}' could not be revoked; they stay valid until they expire.`,
      ])
    } finally {
      await worker.stop()
      errors.mockRestore()
    }
  })

  test("logs once when a step's refused first grant cannot be revoked either", async () => {
    // Regression proof: drop `this.closing = Promise.resolve()` from EphemeralWorkspace.authorize;
    // the node's beforeFinalize closes again and logs the same failure a second time.
    const events: string[] = []
    // A grant expiring within the renewal margin is refused after it was issued.
    const { auth } = stepSourceAuth(events, { firstLifetimeMs: 1_000, failRevocation: true })
    const step = new StepSandboxFactory(
      { source: { type: "git", url: STEP_REPOSITORY }, auth },
      events
    )
    const errors = spyOn(console, "error").mockImplementation(() => {})
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model: structuredAnswerModel(),
      stepSandbox: step,
      runId: "workflow-step-refused-grant",
    })
    attachSixbErrorReporter(sixb, () => {})
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      expect((await terminalWorkflowAgentNode(runs, nodeRunId)).status).toBe("failed")

      expect(step.createOptions).toEqual([])
      expect(events).toEqual(["issue", "revoke"])
      expect(credentialCleanupLogs(errors)).toEqual([
        "[SixbAgentWorker] Sandbox authentication cleanup failed before acquisition.",
      ])
    } finally {
      await worker.stop()
      errors.mockRestore()
    }
  })

  test("revokes and destroys a step's sandbox whose setup fails", async () => {
    // Two guards close the credentials here, and they overlap: EphemeralWorkspace.acquire closes
    // them before it rejects, so the beforeFinalize in createWorkflowAgentNodeEnvironment's catch
    // only awaits that close. Regression proof: remove both (acquire's catch destroys without
    // discard()); the grant is not revoked before the node's terminal write. Each one alone is
    // proven where the other cannot help: removing acquire's close fails the takeover test, whose
    // lost execution skips beforeFinalize; removing beforeFinalize fails the cancellation and
    // clone deadline tests, which record the node while provisioning is still in flight.
    let modelCalls = 0
    const events: string[] = []
    const atTerminalWrite: string[][] = []
    const { auth } = stepSourceAuth(events)
    const step = new StepSandboxFactory(
      { source: { type: "git", url: STEP_REPOSITORY }, setup: ["bun install"], auth },
      events,
      { failingCommand: "bun install" }
    )
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model: answerModel(() => {
        modelCalls++
      }),
      storage: observeWorkflowAgentNodeFinish(new InMemoryStorage(), () => {
        atTerminalWrite.push([...events])
      }),
      stepSandbox: step,
      runId: "workflow-step-setup-failure",
    })
    attachSixbErrorReporter(sixb, () => {})
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      expect((await terminalWorkflowAgentNode(runs, nodeRunId)).status).toBe("failed")

      expect(modelCalls).toBe(0)
      expect(step.sandboxes[0]?.destroyed).toBe(true)
      expect(atTerminalWrite).toEqual([expect.arrayContaining(["revoke"])])
    } finally {
      await worker.stop()
    }
  })

  test("revokes and destroys a step's sandbox when the node is cancelled during provisioning", async () => {
    // Regression proof: drop the signal from EphemeralWorkspace's create(); provisioning ignores
    // the cancellation. Drop beforeFinalize from createWorkflowAgentNodeEnvironment's catch; the
    // node is recorded before its slow revocation completes.
    let modelCalls = 0
    const gate = provisioningGate()
    const events: string[] = []
    const atTerminalWrite: string[][] = []
    const { auth } = stepSourceAuth(events, { revokeDelayMs: 200 })
    const step = new StepSandboxFactory(
      { source: { type: "git", url: STEP_REPOSITORY }, auth },
      events,
      { beforeClone: gate.wait }
    )
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model: answerModel(() => {
        modelCalls++
      }),
      storage: observeWorkflowAgentNodeFinish(new InMemoryStorage(), () => {
        atTerminalWrite.push([...events])
      }),
      stepSandbox: step,
      runId: "workflow-step-cancelled",
    })
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      await gate.entered
      await publishAgentRunCancel(sixb.broker, { projectId: PROJECT_ID, runId: nodeRunId })
      expect((await terminalWorkflowAgentNode(runs, nodeRunId)).status).toBe("cancelled")

      gate.release()
      await waitFor(() => step.sandboxes[0]?.destroyed || null, { label: "step sandbox destroyed" })

      expect(modelCalls).toBe(0)
      expect(step.createOptions[0]?.signal?.aborted).toBe(true)
      expect(atTerminalWrite).toEqual([expect.arrayContaining(["revoked"])])
      expect(events.indexOf("revoked")).toBeLessThan(events.indexOf("destroy"))
    } finally {
      // stop() drains the detached teardown, which waits for provisioning.
      gate.release()
      await worker.stop()
    }
  })

  test("revokes a step's credentials before recording a deadline reached during the clone", async () => {
    // Regression proof: drop beforeFinalize from createWorkflowAgentNodeEnvironment's catch; the
    // node is recorded before its slow revocation completes.
    let modelCalls = 0
    const gate = provisioningGate()
    const events: string[] = []
    const atTerminalWrite: string[][] = []
    const { auth } = stepSourceAuth(events, { revokeDelayMs: 100 })
    const step = new StepSandboxFactory(
      { source: { type: "git", url: STEP_REPOSITORY }, auth },
      events,
      { beforeClone: gate.wait }
    )
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model: answerModel(() => {
        modelCalls++
      }),
      storage: observeWorkflowAgentNodeFinish(new InMemoryStorage(), () => {
        atTerminalWrite.push([...events])
      }),
      stepSandbox: step,
      runId: "workflow-step-clone-deadline",
    })
    attachSixbErrorReporter(sixb, () => {})
    const worker = new AgentWorker(sixb, workerOptions({ turnTimeoutMs: 300 }))
    await worker.start()
    try {
      expect((await terminalWorkflowAgentNode(runs, nodeRunId)).status).toBe("failed")

      gate.release()
      await waitFor(() => step.sandboxes[0]?.destroyed || null, { label: "step sandbox destroyed" })

      expect(modelCalls).toBe(0)
      expect(atTerminalWrite).toEqual([expect.arrayContaining(["revoked"])])
    } finally {
      gate.release()
      await worker.stop()
    }
  })

  test("revokes a step's credentials before recording a model failure", async () => {
    // Regression proof: drop beforeFinalize from executeWorkflowAgentNode's failure path; the
    // credentials are then closed only by the release that follows the terminal write.
    const events: string[] = []
    const atTerminalWrite: string[][] = []
    const { auth } = stepSourceAuth(events)
    const step = new StepSandboxFactory(
      { source: { type: "git", url: STEP_REPOSITORY, access: "write" }, auth },
      events
    )
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model: new WorkerTestModel({
        modelId: "mock-model",
        generate: async () => {
          throw new Error("model unavailable")
        },
      }),
      storage: observeWorkflowAgentNodeFinish(new InMemoryStorage(), () => {
        atTerminalWrite.push([...events])
      }),
      stepSandbox: step,
      runId: "workflow-step-model-failure",
    })
    attachSixbErrorReporter(sixb, () => {})
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      expect((await terminalWorkflowAgentNode(runs, nodeRunId)).status).toBe("failed")
      await waitFor(() => step.sandboxes[0]?.destroyed || null, { label: "step sandbox destroyed" })

      expect(atTerminalWrite).toEqual([expect.arrayContaining(["clear", "revoke"])])
    } finally {
      await worker.stop()
    }
  })

  test("revokes and destroys a step's sandbox when the node is taken over during provisioning", async () => {
    // Regression proof: make the assertOwner createWorkflowAgentNodeEnvironment passes to
    // ephemeralRunSandbox a no-op; the stale run uses the checkout and records a terminal state
    // over the new owner's run. Destroy before closing credentials in EphemeralWorkspace.discard;
    // the sandbox is then destroyed before its grant is revoked. Destroy without discard() in
    // acquire's catch; nothing revokes the grant, since a lost execution skips beforeFinalize.
    let modelCalls = 0
    const gate = provisioningGate()
    const events: string[] = []
    const { auth } = stepSourceAuth(events)
    const step = new StepSandboxFactory(
      { source: { type: "git", url: STEP_REPOSITORY }, auth },
      events,
      { beforeClone: gate.wait }
    )
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model: answerModel(() => {
        modelCalls++
      }),
      stepSandbox: step,
      runId: "workflow-step-taken-over",
    })
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      await gate.entered
      await runs.agentNodes.reclaim({
        projectId: PROJECT_ID,
        nodeRunId,
        execution: {
          token: "another-delivery",
          queueLeaseExpiresAt: new Date(Date.now() + 60_000),
        },
      })

      gate.release()
      await waitFor(() => step.sandboxes[0]?.destroyed || null, { label: "step sandbox destroyed" })

      expect(modelCalls).toBe(0)
      expect(events.indexOf("revoke")).toBeGreaterThan(-1)
      expect(events.indexOf("revoke")).toBeLessThan(events.indexOf("destroy"))
      expect(
        await runs.agentNodes.getByNodeRunId({ projectId: PROJECT_ID, nodeRunId })
      ).toMatchObject({ status: "running", execution: { token: "another-delivery" } })
    } finally {
      await worker.stop()
    }
  })

  // Regression proof: catch the resume enqueue failure in workflow-node-execution.ts and the job is
  // acknowledged instead of retried, leaving the workflow waiting forever.
  test("keeps a workflow agent job until its resume is queued", async () => {
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model: structuredAnswerModel(),
      runId: "workflow-resume-unqueued",
    })
    sixb.queues.workflows.enqueue = () => Promise.reject(new Error("queue unavailable"))
    const agents = sixb.queues.agents
    const retry = agents.retry.bind(agents)
    const retried: string[] = []
    agents.retry = (params) => {
      retried.push(params.jobId)
      return retry(params)
    }
    const worker = new AgentWorker(sixb, workerOptions())
    const originalConsoleError = console.error
    console.error = () => {}
    await worker.start()
    try {
      await waitFor(() => retried.includes(`wfa_job_${nodeRunId}`), { label: "agent job retried" })
      expect(await runs.nodes.getById({ projectId: PROJECT_ID, id: nodeRunId })).toMatchObject({
        status: "succeeded",
      })
    } finally {
      await worker.stop()
      console.error = originalConsoleError
    }
  })

  test("a redelivery after the node succeeded only queues the resume", async () => {
    let modelCalls = 0
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model: new WorkerTestModel({
        generate: async () => {
          modelCalls += 1
          throw new Error("[test] the model must not run again")
        },
      }),
      runId: "workflow-resume-redelivered",
    })
    await succeedWorkflowAgentNode(runs, nodeRunId)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const [resume] = await waitFor(
        async () => {
          const claimed = await sixb.queues.workflows.claim({
            projectId: PROJECT_ID,
            workerId: "workflow-test-worker",
          })
          return claimed.length > 0 ? claimed : null
        },
        { label: "resume queued" }
      )
      expect(resume?.job).toMatchObject({
        type: "workflow.run.resume.requested",
        payload: { runId: "workflow-resume-redelivered", nodeRunId },
      })
      expect(modelCalls).toBe(0)
    } finally {
      await worker.stop()
    }
  })

  // Regression proof: restore the repair pass that lists `succeeded` agent nodes and re-sends a
  // resume for every one whose run is waiting. It resumes this run from the step after node 0.
  test("never re-sends the resume of an agent step the workflow has moved past", async () => {
    const runId = "workflow-moved-past-agent"
    const { sixb, runs, workflow, nodeRunId } = await queueWorkflowAgentNode({
      model: structuredAnswerModel(),
      runId,
    })
    await succeedWorkflowAgentNode(runs, nodeRunId)
    const [agentJob] = await sixb.queues.agents.claim({ projectId: PROJECT_ID, workerId: "test" })
    if (!agentJob) throw new Error("expected the agent node job")
    await sixb.queues.agents.complete({
      projectId: PROJECT_ID,
      jobId: agentJob.job.id,
      leaseId: agentJob.leaseId,
    })
    await runs.resume({ projectId: PROJECT_ID, id: runId })
    const approvalRunId = `${runId}:node:1`
    await runs.nodes.start({
      id: approvalRunId,
      projectId: PROJECT_ID,
      workflowRunId: runId,
      workflowId: workflow.id,
      nodeIndex: 1,
      nodeType: "intervention",
      nodeId: "approve",
      nodeKey: "approve",
      input: {},
    })
    await runs.nodes.wait({ projectId: PROJECT_ID, id: approvalRunId })
    await runs.wait({ projectId: PROJECT_ID, id: runId })

    const enqueued: string[] = []
    sixb.queues.workflows.enqueue = async (params) => {
      enqueued.push(...params.jobs.map((job) => job.type))
      return []
    }
    // The queued-node scan is the repair pass's last read; stop() then awaits the pass in flight.
    const list = runs.agentNodes.list.bind(runs.agentNodes)
    let scanned: () => void = () => {}
    const repairPassScanned = new Promise<void>((resolve) => {
      scanned = resolve
    })
    runs.agentNodes.list = async (input) => {
      const result = await list(input)
      if (input.statuses?.includes("queued")) scanned()
      return result
    }
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    await repairPassScanned
    await worker.stop()

    expect(enqueued).toEqual([])
  })

  // Regression proof: resolve an explicit step model through the catalog in the execution plan.
  test.each([
    ["the catalog's binding with the same id", "workflow-model"],
    ["a catalog that does not list it", "chat-model"],
  ])("executes a workflow task with its own model over %s", async (_, catalogModelId) => {
    const declaredCalls: string[] = []
    const catalogCalls: string[] = []
    const catalogModel = trackedStructuredAnswerModel(
      (phase) => catalogCalls.push(phase),
      catalogModelId
    )
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model: trackedStructuredAnswerModel((phase) => declaredCalls.push(phase)),
      models: { language: [catalogModel] },
      runId: `workflow-own-model-${catalogModelId}`,
    })
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const execution = await waitFor(
        async () => {
          const current = await runs.agentNodes.getByNodeRunId({ projectId: PROJECT_ID, nodeRunId })
          return current?.status === "succeeded" ? current : null
        },
        { label: "workflow agent node with its own model" }
      )
      expect(execution.modelId).toBe("workflow-model")
      expect(declaredCalls).toEqual(["research", "finalize"])
      expect(catalogCalls).toEqual([])
    } finally {
      await worker.stop()
    }
  })

  // Regression proof: prepare the model before reserveWorkflowAgentNode; the task stays queued.
  test.each([
    "queued",
    "running",
    "taken-over",
    "invalid-budget",
    "removed-definition",
  ] as const)("durably handles workflow model preparation failure from %s", async (state) => {
    const model = trackedStructuredAnswerModel(() => {})
    let takeoverToken: string | undefined
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model,
      runId: `workflow-preparation-${state}`,
    })
    attachSixbErrorReporter(sixb, () => {})
    if (state === "running" || state === "taken-over") {
      await runs.agentNodes.start({
        projectId: PROJECT_ID,
        nodeRunId,
        execution: freshTestExecution(),
      })
    }
    const failingModel: LanguageModel = {
      ...model,
      providerId: model.providerId,
      modelId: model.modelId,
      definition: model.definition,
      stream: () => {
        throw new Error("The model must not be called")
      },
      resolve: async () => {
        if (state === "invalid-budget") {
          return { ...failingModel, definition: { ...model.definition, contextWindow: 1 } }
        }
        if (state === "taken-over") {
          const execution = freshTestExecution()
          takeoverToken = execution.token
          await runs.agentNodes.reclaim({ projectId: PROJECT_ID, nodeRunId, execution })
        }
        throw createSixbError("internal.unexpected", "Invalid model preparation.")
      },
    }
    // Workflow-only models are prepared per task, not by the project language-catalog preflight.
    const definition = sixb.definitions.workflows.list()[0]!
    const definitionNode = definition.nodes[0]!
    if (definitionNode.type !== "agent") throw new Error("Expected an agent step")
    const lookup = spyOn(sixb.definitions.workflows, "getById").mockReturnValue(
      state === "removed-definition"
        ? null
        : {
            ...definition,
            nodes: [
              {
                ...definitionNode,
                agentStep: { ...definitionNode.agentStep, model: failingModel },
              },
            ],
          }
    )
    const worker = new AgentWorker(sixb, workerOptions())
    const completion = observeQueueSettlement(sixb.queues.agents)
    await worker.start()
    try {
      await waitFor(
        async () => {
          const current = await runs.agentNodes.getByNodeRunId({ projectId: PROJECT_ID, nodeRunId })
          return state === "taken-over" ? takeoverToken : current?.status === "failed"
        },
        { label: "workflow preparation failure" }
      )
      await completion.wait()
      const task = await runs.agentNodes.getByNodeRunId({ projectId: PROJECT_ID, nodeRunId })
      const node = await runs.nodes.getById({ projectId: PROJECT_ID, id: nodeRunId })
      const workflow = await runs.getById({
        projectId: PROJECT_ID,
        id: `workflow-preparation-${state}`,
      })
      if (state === "taken-over") {
        expect(task).toMatchObject({ status: "running", execution: { token: takeoverToken } })
        expect(node?.status).toBe("waiting")
        expect(workflow?.status).toBe("waiting")
      } else {
        expect(task).toMatchObject({ status: "failed", attempt: state === "running" ? 2 : 1 })
        expect(task?.execution).toBeUndefined()
        expect(node).toMatchObject({ status: "failed", error: { code: "workflow.node_failed" } })
        expect(workflow).toMatchObject({ status: "failed", error: node?.error })
      }
    } finally {
      await worker.stop()
      lookup.mockRestore()
      completion.restore()
    }
  })

  // Regression proof: remove monitorSandboxReadiness from runWorkflowAgentNode.
  test.each([
    1, 2,
  ])("fails a workflow when its sandbox rejects during model call %s", async (failedCall) => {
    const failure = new Error("sandbox provisioning unavailable")
    const sandbox = Promise.withResolvers<Sandbox>()
    const signals: AbortSignal[] = []
    const model = new WorkerTestModel({
      stream: async (request) => {
        signals.push(request.signal)
        const call = signals.length
        return {
          events: (async function* (): AsyncIterable<LanguageModelStreamEvent> {
            yield { type: "stream-start" }
            if (call === failedCall) {
              sandbox.reject(failure)
              await Bun.sleep(0)
              request.signal.throwIfAborted()
            }
            yield { type: "text-start", id: "answer" }
            yield {
              type: "text-delta",
              id: "answer",
              delta: '{"answer":"Project Alpha","confidence":0.96}',
            }
            yield { type: "text-end", id: "answer" }
            yield { type: "finish", finishReason: "stop", usage: USAGE }
          })(),
        }
      },
    })
    const runId = `workflow-sandbox-failure-${failedCall}`
    const { sixb, runs, nodeRunId, agentExecutionId } = await queueWorkflowAgentNode({
      model,
      runId,
      sandboxes: { create: () => sandbox.promise },
    })
    const errors: unknown[] = []
    const reporter = attachSixbErrorReporter(sixb, (error) => {
      errors.push(error)
    })
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const execution = await waitFor(() => terminalAgentNode(runs, nodeRunId), {
        label: "workflow sandbox failure",
      })
      expect(execution.status).toBe("failed")
      expect(signals).toHaveLength(failedCall)
      expect(signals.at(-1)?.aborted).toBe(true)
      await expect(
        runs.nodes.getById({ projectId: PROJECT_ID, id: nodeRunId })
      ).resolves.toMatchObject({ status: "failed" })
      await expect(runs.getById({ projectId: PROJECT_ID, id: runId })).resolves.toMatchObject({
        status: "failed",
      })
      await expect(
        aiUsageStorageOf(sixb).summarizeExecution({
          projectId: PROJECT_ID,
          executionId: agentExecutionId,
        })
      ).resolves.toMatchObject({ modelCallCount: failedCall })
      await reporter.flush()
      expect(errors).toEqual([failure])
    } finally {
      sandbox.reject(failure)
      await worker.stop()
    }
  })

  // Regression proof: restore Gateway's unknown-as-unsupported gate; research/finalization fails.
  test("finalizes workflow output through Gateway with missing capability metadata", async () => {
    const formats: unknown[] = []
    const gateway = createVercelGateway({
      fetch: async (url, init) => {
        if (String(url).endsWith("/models"))
          return Response.json({
            data: [
              {
                id: "creator/model",
                type: "language",
                context_window: 64_000,
              },
            ],
          })
        const body = JSON.parse(String(init?.body))
        formats.push(body.text?.format)
        const events = [
          {
            type: "response.output_text.done",
            item_id: "message",
            text: body.text
              ? '{"answer":"Project Alpha","confidence":0.96}'
              : "Project Alpha is the answer with confidence 0.96.",
          },
          {
            type: "response.completed",
            response: { status: "completed", usage: { input_tokens: 10, output_tokens: 7 } },
          },
        ]
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
      },
    })
    const runId = "workflow-gateway-unknown-output"
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model: gateway("creator/model"),
      runId,
    })
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const task = await waitFor(
        async () => {
          const current = await runs.agentNodes.getByNodeRunId({ projectId: PROJECT_ID, nodeRunId })
          return current?.status === "succeeded" ? current : null
        },
        { label: "Gateway structured workflow output" }
      )
      expect(task.modelId).toBe("creator/model")
      expect(formats).toEqual([
        undefined,
        expect.objectContaining({ type: "json_schema", strict: true }),
      ])
      expect(await runs.nodes.getById({ projectId: PROJECT_ID, id: nodeRunId })).toMatchObject({
        status: "succeeded",
      })
    } finally {
      await worker.stop()
    }
  })

  // Regression proof: remove output preflight or failure identity propagation; calls/phase differ.
  test.each([
    "unsupported-model",
    "unsupported-schema",
    "provider-rejection",
  ] as const)("persists safe workflow output failure %s at the correct phase", async (reason) => {
    const calls: string[] = []
    const base = trackedStructuredAnswerModel((call) => calls.push(call))
    const preflight = reason !== "provider-rejection"
    const model: LanguageModel = {
      providerId: base.providerId,
      modelId: base.modelId,
      definition: {
        ...base.definition,
        capabilities: reason === "unsupported-model" ? { nativeStructuredOutput: false } : {},
      },
      validateResponseFormat: (format) => {
        expect(format.schema).toMatchObject({ type: "object" })
        if (reason === "unsupported-schema") {
          throw new UnsupportedModelFeatureError("private schema details secret=123", { reason })
        }
      },
      stream: (request) => {
        if (request.responseFormat && !preflight) {
          throw new ModelProviderError("private request secret=123", "test", base.modelId, {
            status: 400,
          })
        }
        return base.stream(request)
      },
    }
    const runId = `workflow-output-failure-${reason}`
    const { sixb, runs, nodeRunId, agentExecutionId } = await queueWorkflowAgentNode({
      model,
      runId,
    })
    attachSixbErrorReporter(sixb, () => {})
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      await waitFor(
        async () => {
          const current = await runs.getById({ projectId: PROJECT_ID, id: runId })
          return current?.status === "failed" ? current : null
        },
        { label: "workflow output failure" }
      )
      const node = await runs.nodes.getById({ projectId: PROJECT_ID, id: nodeRunId })
      const run = await runs.getById({ projectId: PROJECT_ID, id: runId })
      expect(node?.error).toMatchObject({
        code: "workflow.node_failed",
        details: {
          failurePhase: preflight ? "output-preflight" : "structured-finalizer",
          modelId: model.modelId,
          modelFailure: { reason, message: expect.any(String) },
        },
      })
      expect(run?.error).toEqual(node?.error)
      expect(JSON.stringify(node?.error)).not.toContain("secret=123")
      expect(calls).toEqual(preflight ? [] : ["research"])
      await expect(
        aiUsageStorageOf(sixb).summarizeExecution({
          projectId: PROJECT_ID,
          executionId: agentExecutionId,
        })
      ).resolves.toMatchObject({ modelCallCount: preflight ? 0 : 1 })
    } finally {
      await worker.stop()
    }
  })

  test.each([
    "",
    "Partial",
  ])("fails a workflow agent step the output limit cut short (text: '%s')", async (text) => {
    // Removal proof: drop the `finishReason === "length"` check from runWorkflowAgentNode; the
    // partial answer is structured as if complete, or the failure no longer names the cause.
    const calls: string[] = []
    const model = new WorkerTestModel({
      generate: async (request) => {
        calls.push(request.responseFormat ? "finalize" : "research")
        return {
          content: request.responseFormat
            ? [{ type: "text", text: JSON.stringify({ answer: "Partial", confidence: 0.5 }) }]
            : text
              ? [{ type: "text", text }]
              : [],
          finishReason: request.responseFormat ? "stop" : "length",
          usage: USAGE,
        }
      },
    })
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model,
      runId: `workflow-output-limit-${text || "empty"}`,
    })
    attachSixbErrorReporter(sixb, () => {})
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const execution = await waitFor(
        async () => {
          const record = await runs.agentNodes.getByNodeRunId({ projectId: PROJECT_ID, nodeRunId })
          return record && record.status !== "queued" && record.status !== "running" ? record : null
        },
        { label: "cut-short workflow agent step" }
      )
      expect(execution).toMatchObject({
        status: "failed",
        finishReason: "length",
        error: {
          code: "agent.execution_failed",
          message:
            "Agent execution failed. The model reached its output limit before finishing its answer. Lower the step's reasoning, or raise maxOutputTokens on the model binding if it sets one.",
        },
      })
      expect(calls).toEqual(["research"])
      expect(
        (await runs.nodes.getById({ projectId: PROJECT_ID, id: nodeRunId }))?.error
      ).toMatchObject({
        code: "workflow.node_failed",
        message: expect.stringContaining("The model reached its output limit"),
      })
    } finally {
      await worker.stop()
    }
  })

  test("keeps workflow usage when structured output validation fails", async () => {
    const { sixb, runs, nodeRunId, agentExecutionId } = await queueWorkflowAgentNode({
      model: invalidStructuredAnswerModel(),
      runId: "workflow-invalid-output",
    })
    const worker = new AgentWorker(sixb, workerOptions())

    await worker.start()
    try {
      const execution = await waitFor(() => terminalAgentNode(runs, nodeRunId), {
        label: "workflow output validation failure",
      })

      expect(execution.status).toBe("failed")
      const node = await runs.nodes.getById({ projectId: PROJECT_ID, id: nodeRunId })
      expect(node?.error).toMatchObject({
        details: {
          failurePhase: "structured-finalizer",
          modelFailure: { reason: "invalid-output" },
        },
      })
      await expect(
        aiUsageStorageOf(sixb).summarizeExecution({
          projectId: PROJECT_ID,
          executionId: agentExecutionId,
        })
      ).resolves.toMatchObject({
        modelCallCount: 3,
        usage: {
          inputTokens: 30,
          outputTokens: 21,
          totalTokens: 51,
          reportingStatus: "complete",
        },
      })
    } finally {
      await worker.stop()
    }
  })

  test("hands failed workflow usage to durable recovery and fails closed", async () => {
    let modelCalls = 0
    const model = structuredToolThenAnswerModel(() => {
      modelCalls += 1
    })
    const lookup = defineAgentTool("lookup_project")
      .description("Look up a project.")
      .input({ query: "string" })
      .run(() => ({ project: "Project Alpha" }))
    const { sixb, runs, nodeRunId, agentExecutionId } = await queueWorkflowAgentNode({
      model,
      tools: [lookup],
      runId: "workflow-accounting-failure",
    })
    const aiUsage = aiUsageStorageOf(sixb)
    const queue = sixb.queues.agents
    const enqueue = queue.enqueue.bind(queue)
    let storageAvailable = false
    let appendAttempts = 0
    let recoveryJobs = 0
    const workerHost = withStorage(
      sixb,
      withAiUsageRecordInterceptor(sixb.storage, async (_input, record) => {
        if (storageAvailable) return record()
        appendAttempts += 1
        throw new Error("usage storage unavailable")
      })
    )
    queue.enqueue = async (params) => {
      const jobs = await enqueue(params)
      const handedOff = params.jobs.filter(
        (job) => job.type === "agent.ai-usage.record.requested"
      ).length
      if (handedOff > 0) {
        recoveryJobs += handedOff
        storageAvailable = true
      }
      return jobs
    }
    // Fake timers stand in for the recorder's storage retry backoff.
    jest.useFakeTimers()
    const start = Date.now()
    const worker = new AgentWorker(workerHost, workerOptions())
    try {
      await worker.start()
      const execution = await underFakeTime(
        () => terminalAgentNode(runs, nodeRunId),
        "workflow accounting failure"
      )
      // The recorder's storage retries: 50 + 200 + 600ms.
      expectBackoffSpent(start, 850)

      expect(execution.status).toBe("failed")
      expect(execution.error).toMatchObject({
        code: "agent.execution_failed",
        message: "Agent execution failed.",
        retryable: false,
        details: {
          agentStepId: "workflow-usage-step",
          workflowId: "workflow-usage-test",
          workflowRunId: "workflow-accounting-failure",
          nodeId: "workflow-usage-step",
          nodeRunId,
        },
      })
      await expect(
        runs.getById({ projectId: PROJECT_ID, id: "workflow-accounting-failure" })
      ).resolves.toMatchObject({ status: "failed" })
      const summary = await underFakeTime(async () => {
        const value = await aiUsage.summarizeExecution({
          projectId: PROJECT_ID,
          executionId: agentExecutionId,
        })
        return value.modelCallCount === 1 ? value : null
      }, "queued workflow AI usage recovery")
      expect(summary.modelCallCount).toBe(1)
      expect(modelCalls).toBe(1)
      expect(appendAttempts).toBe(4)
      expect(recoveryJobs).toBe(1)
      await expect(
        sixb.queues.workflows.claim({
          projectId: PROJECT_ID,
          workerId: "workflow-accounting-failure-test",
        })
      ).resolves.toHaveLength(0)
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test("keeps workflow usage outside a failed node-finalization transaction", async () => {
    const storage = withOneFailingWorkflowAgentFinalization(new InMemoryStorage())
    const { sixb, runs, nodeRunId, agentExecutionId } = await queueWorkflowAgentNode({
      model: structuredAnswerModel(),
      storage,
      runId: "workflow-finalization-failure",
    })
    const worker = new AgentWorker(sixb, workerOptions())

    await worker.start()
    try {
      const execution = await waitFor(() => terminalAgentNode(runs, nodeRunId), {
        label: "workflow node finalization failure",
      })

      expect(execution.status).toBe("failed")
      expect(execution.error).toMatchObject({
        code: "agent.execution_failed",
        message: "Agent execution failed.",
        retryable: false,
        details: {
          agentStepId: "workflow-usage-step",
          workflowId: "workflow-usage-test",
          workflowRunId: "workflow-finalization-failure",
          nodeId: "workflow-usage-step",
          nodeRunId,
        },
      })
      await expect(
        aiUsageStorageOf(sixb).summarizeExecution({
          projectId: PROJECT_ID,
          executionId: agentExecutionId,
        })
      ).resolves.toMatchObject({
        modelCallCount: 2,
        usage: { inputTokens: 20, outputTokens: 14, totalTokens: 34 },
      })
    } finally {
      await worker.stop()
    }
  })

  test("keeps completed workflow usage when the parent run is cancelled during a tool", async () => {
    let markToolStarted!: () => void
    let markToolAborted!: () => void
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve
    })
    const toolAborted = new Promise<void>((resolve) => {
      markToolAborted = resolve
    })
    const blockingTool = defineAgentTool("lookup_project")
      .description("Wait for a project lookup.")
      .input({ query: "string" })
      .run(async ({ signal }) => {
        markToolStarted()
        await new Promise<void>((_resolve, reject) => {
          const abort = () => {
            markToolAborted()
            reject(new DOMException("Aborted", "AbortError"))
          }
          if (signal.aborted) abort()
          else signal.addEventListener("abort", abort, { once: true })
        })
        return { project: "unreachable" }
      })
    const runId = "workflow-cancelled-during-tool"
    const { sixb, runs, nodeRunId, agentExecutionId } = await queueWorkflowAgentNode({
      model: structuredToolThenAnswerModel(),
      tools: [blockingTool],
      runId,
    })
    const worker = new AgentWorker(sixb, workerOptions())

    await worker.start()
    try {
      await toolStarted
      const cancelledAt = new Date()
      const agentCancellationFailure = {
        code: "runtime.cancelled",
        message: "Execution was cancelled.",
        retryable: false,
        at: cancelledAt.toISOString(),
        details: {
          agentStepId: "workflow-usage-step",
          workflowId: "workflow-usage-test",
          workflowRunId: runId,
          nodeRunId,
        },
      } as const
      const workflowCancellationFailure = {
        code: "runtime.cancelled",
        message: "Execution was cancelled.",
        retryable: false,
        at: cancelledAt.toISOString(),
        details: {
          workflowId: "workflow-usage-test",
          workflowRunId: runId,
          nodeRunId,
        },
      } as const
      await sixb.storage.transaction(async (tx) => {
        const transactionalRuns = tx.workflowRuns
        if (!transactionalRuns) throw new Error("expected transactional workflow storage")
        await transactionalRuns.agentNodes.cancel({
          projectId: PROJECT_ID,
          nodeRunId,
          error: agentCancellationFailure,
        })
        await transactionalRuns.nodes.finish({
          projectId: PROJECT_ID,
          id: nodeRunId,
          status: "cancelled",
          error: workflowCancellationFailure,
        })
        await transactionalRuns.finish({
          projectId: PROJECT_ID,
          id: runId,
          status: "cancelled",
          error: workflowCancellationFailure,
        })
      })
      await publishAgentRunCancel(sixb.broker, { projectId: PROJECT_ID, runId: nodeRunId })
      await toolAborted

      await expect(
        aiUsageStorageOf(sixb).summarizeExecution({
          projectId: PROJECT_ID,
          executionId: agentExecutionId,
        })
      ).resolves.toMatchObject({
        modelCallCount: 1,
        usage: {
          inputTokens: 10,
          outputTokens: 7,
          totalTokens: 17,
          reportingStatus: "complete",
        },
      })
      await expect(
        runs.agentNodes.getByNodeRunId({ projectId: PROJECT_ID, nodeRunId })
      ).resolves.toMatchObject({ status: "cancelled" })
    } finally {
      await worker.stop()
    }
  })

  test("translates a failed agent execution into the parent workflow vocabulary", async () => {
    const originalError = new Error("workflow agent provider failed")
    const model = new WorkerTestModel({
      modelId: "mock-model",
      generate: async () => {
        throw originalError
      },
    })
    const agentStep = defineAgentStep("resolve-or-fail", {
      model,
      instructions: "Fail for this test.",
      groups: [AGENT_RUNTIME_GROUP],
    })
      .input({ query: "string" })
      .output({ answer: "string" })
      .prompt(({ input }) => `Resolve '${input.query}'.`)
    const workflow = defineWorkflow("agent-failure-workflow")
      .input({ query: "string" })
      .then(agentStep)
    const sixb = new SixbHost({
      id: PROJECT_ID,
      ontology: [],
      workflows: [workflow],
      groups: [AGENT_RUNTIME_GROUP],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      sandboxes: new RecordingSandboxFactory(),
    })
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    const reporter = attachSixbErrorReporter(sixb, (error, context) => {
      reports.push({ error, context })
    })
    const runs = sixb.storage.workflowRuns!
    const runId = "workflow-agent-failure-run"
    const nodeRunId = `${runId}:node:0`
    const actorId = workflowAgentStepActorId(workflow.id, agentStep.id)
    const executionId = await createTestWorkflowExecution(sixb.storage.executions, {
      projectId: PROJECT_ID,
      workflowId: workflow.id,
      runId,
    })
    await runs.queue({
      id: runId,
      projectId: PROJECT_ID,
      executionId,
      workflowId: workflow.id,
      input: { query: "alpha" },
    })
    await runs.start({ id: runId, projectId: PROJECT_ID })
    await runs.nodes.start({
      id: nodeRunId,
      projectId: PROJECT_ID,
      workflowRunId: runId,
      workflowId: workflow.id,
      nodeIndex: 0,
      nodeType: "agent",
      nodeId: agentStep.id,
      nodeKey: "resolveOrFail",
      input: { query: "alpha" },
    })
    const agentExecutionId = await createTestAgentExecution(sixb.storage, {
      projectId: PROJECT_ID,
      actorId: actorId,
      runId: nodeRunId,
      sourceExecutionId: executionId,
    })
    await runs.agentNodes.create({
      projectId: PROJECT_ID,
      nodeRunId,
      executionId: agentExecutionId,
      actorId: actorId,
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
          payload: { nodeRunId },
        },
      ],
    })

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const execution = await waitFor(
        async () => {
          const record = await runs.agentNodes.getByNodeRunId({
            projectId: PROJECT_ID,
            nodeRunId,
          })
          return record?.status === "failed" ? record : null
        },
        { label: "workflow agent node failed" }
      )
      const [nodeRun, run] = await Promise.all([
        runs.nodes.getById({ projectId: PROJECT_ID, id: nodeRunId }),
        runs.getById({ projectId: PROJECT_ID, id: runId }),
      ])

      expect(execution.error).toMatchObject({
        code: "agent.execution_failed",
        message: "Agent execution failed.",
        retryable: false,
        details: {
          agentStepId: agentStep.id,
          workflowId: workflow.id,
          workflowRunId: runId,
          nodeId: agentStep.id,
          nodeRunId,
        },
      })
      expect(run?.status).toBe("failed")
      expect(run?.error).toMatchObject({
        code: "workflow.node_failed",
        message: "Workflow node execution failed.",
        retryable: false,
        details: {
          agentStepId: agentStep.id,
          workflowId: workflow.id,
          workflowRunId: runId,
          nodeId: agentStep.id,
          nodeRunId,
        },
      })
      expect(nodeRun?.error).toEqual(run?.error)

      await reporter.flush()
      expect(reports).toHaveLength(1)
      expect(reports[0]?.error).toBe(originalError)
      expect(reports[0]?.context).toMatchObject({
        type: "run.failed",
        runKind: "workflow",
        run: { runId, workflowId: workflow.id },
        failure: run?.error,
      })
    } finally {
      await worker.stop()
    }
  })

  test("enforces project AI limits at the workflow agent provider boundary", async () => {
    let providerCalls = 0
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async () => {
        providerCalls += 1
        throw new Error("A denied workflow Agent call must not reach the provider")
      },
    })
    const agentStep = defineAgentStep("limited-agent-step", {
      model,
      instructions: "This call is denied before the provider.",
      groups: [AGENT_RUNTIME_GROUP],
    })
      .input({ query: "string" })
      .output({ answer: "string" })
      .prompt(({ input }) => `Resolve '${input.query}'.`)
    const workflow = defineWorkflow("agent-limit-workflow")
      .input({ query: "string" })
      .then(agentStep)
    const sixb = new SixbHost({
      id: PROJECT_ID,
      ontology: [],
      workflows: [workflow],
      groups: [AGENT_RUNTIME_GROUP],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      sandboxes: new RecordingSandboxFactory(),
    })
    const reporter = attachSixbErrorReporter(sixb, () => {})
    await sixb.storage.aiLimits?.createPolicy({
      id: "project_tokens_exhausted",
      projectId: PROJECT_ID,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 0 },
    })
    const runs = sixb.storage.workflowRuns!
    const runId = "workflow-agent-limit-run"
    const nodeRunId = `${runId}:node:0`
    const actorId = workflowAgentStepActorId(workflow.id, agentStep.id)
    const executionId = await createTestWorkflowExecution(sixb.storage.executions, {
      projectId: PROJECT_ID,
      workflowId: workflow.id,
      runId,
    })
    await runs.queue({
      id: runId,
      projectId: PROJECT_ID,
      executionId,
      workflowId: workflow.id,
      input: { query: "alpha" },
    })
    await runs.start({ id: runId, projectId: PROJECT_ID })
    await runs.nodes.start({
      id: nodeRunId,
      projectId: PROJECT_ID,
      workflowRunId: runId,
      workflowId: workflow.id,
      nodeIndex: 0,
      nodeType: "agent",
      nodeId: agentStep.id,
      nodeKey: "limitedAgentStep",
      input: { query: "alpha" },
    })
    const agentExecutionId = await createTestAgentExecution(sixb.storage, {
      projectId: PROJECT_ID,
      actorId,
      runId: nodeRunId,
      sourceExecutionId: executionId,
    })
    await runs.agentNodes.create({
      projectId: PROJECT_ID,
      nodeRunId,
      executionId: agentExecutionId,
      actorId,
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
          payload: { nodeRunId },
        },
      ],
    })

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const execution = await waitFor(
        async () => {
          const record = await runs.agentNodes.getByNodeRunId({
            projectId: PROJECT_ID,
            nodeRunId,
          })
          return record?.status === "failed" ? record : null
        },
        { label: "workflow agent limit failure" }
      )
      const [nodeRun, run] = await Promise.all([
        runs.nodes.getById({ projectId: PROJECT_ID, id: nodeRunId }),
        runs.getById({ projectId: PROJECT_ID, id: runId }),
      ])

      expect(providerCalls).toBe(0)
      expect(execution.error).toMatchObject({
        code: "ai.usage_limit_exceeded",
        details: {
          agentStepId: agentStep.id,
          workflowId: workflow.id,
          workflowRunId: runId,
          nodeRunId,
          resetAt: expect.any(String),
        },
      })
      expect(execution.error?.details).not.toHaveProperty("policies")
      expect(run?.error).toMatchObject({
        code: "ai.usage_limit_exceeded",
        details: {
          resetAt: expect.any(String),
        },
      })
      expect(run?.error?.details).not.toHaveProperty("policies")
      expect(nodeRun?.error).toEqual(run?.error)
      await reporter.flush()
    } finally {
      await worker.stop()
    }
  })

  test("creates isolated gateway URLs and sandbox env per concurrent run environment", async () => {
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(toolThenAnswerModel(), new InMemoryBroker(), sandboxes)
    const plan = executionPlanFor(sixb)
    const [firstRequest, secondRequest] = await Promise.all([
      requestAgent(sixb, { text: "first" }),
      requestAgent(sixb, { text: "second" }),
    ])
    const [firstRun, secondRun] = await Promise.all([
      reserveRequestedRun(sixb, firstRequest),
      reserveRequestedRun(sixb, secondRequest),
    ])

    const context = await buildAgentWorkerContext(sixb, {
      apiBaseUrl: "http://sixb-api.local/api/",
    })
    const [firstEnvironment, secondEnvironment] = await Promise.all([
      createConversationAgentEnvironment({
        context,
        plan: plan,
        run: firstRun,
      }),
      createConversationAgentEnvironment({
        context,
        plan: plan,
        run: secondRun,
      }),
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
      const systemPrompt = firstEnvironment.turnContext.systemPrompt
      expect(systemPrompt).toContain("<sixb_mode_rules>")
      expect(systemPrompt).toContain("use relative paths from this prompt or sandboxPath values")
      expect(systemPrompt).toContain("inside a live Sixb project modeled as an ontology")
      expect(systemPrompt).toContain(
        "Use the `sixb` CLI only for the live project data or capability needed by the task"
      )
      expect(systemPrompt).toContain("Do not run `sixb --help`")
      expect(systemPrompt).toContain("sixb objects inspect <type> <id>")
      // The project has no skills; the catalog holds only the built-in one.
      expect(systemPrompt).toContain("Available Agent Skills:\n- sixb-artifacts: ")
      expect(systemPrompt).not.toContain("<agent_instructions>")
      expect(systemPrompt).not.toContain("/tmp/sixb-recording-sandbox")

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
    const plan = executionPlanFor(sixb)
    const fileRef = await sixb.blobStorage.put({
      body: new TextEncoder().encode("attachment contents"),
      fileName: "note.txt",
      mediaType: "text/plain",
    })
    const request = await requestAgent(sixb, {
      text: "read this",
      attachments: [fileRef],
    })
    const run = await reserveRequestedRun(sixb, request)
    const context = await buildAgentWorkerContext(sixb, {
      apiBaseUrl: "http://sixb-api.local/api/",
    })

    const environment = await createConversationAgentEnvironment({
      context,
      plan: plan,
      run,
    })
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

  const imageProcessing = typeof Bun.Image === "function"
  test.each([
    {
      name: "adds text attachment context to model prompts",
      file: { body: "invoice total: 42", fileName: "invoice.txt", mediaType: "text/plain" },
      capabilities: undefined,
      contains: ["<attachment", "invoice.txt", "invoice total: 42", "contentUrl"],
      omits: [],
    },
    {
      name: "inlines supported images only when the Bun runtime provides image processing",
      file: { body: TEST_PNG_BYTES, fileName: "pixel.png", mediaType: "image/png" },
      capabilities: { inputMediaTypes: ["image/*"] },
      contains: imageProcessing
        ? ["pixel.png", '"type":"file"', "image/png", "iVBORw0KGgo"]
        : ["pixel.png", "this Bun runtime does not provide image processing"],
      omits: imageProcessing ? [] : ['"type":"file"'],
    },
    {
      name: "keeps image attachments metadata-only when the model does not advertise images",
      file: { body: TEST_PNG_BYTES, fileName: "pixel.png", mediaType: "image/png" },
      capabilities: undefined,
      contains: ["pixel.png", "does not advertise image input support"],
      omits: ['"type":"file"', "iVBORw0KGgo"],
    },
  ])("$name", async ({ file, capabilities, contains, omits }) => {
    let capturedPrompt: unknown
    const model = new WorkerTestModel({
      ...(capabilities === undefined ? {} : { capabilities }),
      stream: async (options) => {
        capturedPrompt = options.messages
        return answerStream("Done")
      },
    })
    const sixb = buildSixb(model)
    const fileRef = await sixb.blobStorage.put({
      ...file,
      body: typeof file.body === "string" ? new TextEncoder().encode(file.body) : file.body,
    })
    const run = await reserveRequestedRun(
      sixb,
      await requestAgent(sixb, { text: "Use the attachment.", attachments: [fileRef] })
    )
    const plan = executionPlanFor(sixb)
    const environment = await createConversationAgentEnvironment({
      context: await buildAgentWorkerContext(sixb),
      plan,
      run,
    })
    try {
      await runAgentTurn({
        context: environment.turnContext,
        plan,
        run,
        signal: new AbortController().signal,
      })
    } finally {
      await environment.dispose()
    }

    const promptJson = JSON.stringify(capturedPrompt)
    for (const text of contains) expect(promptJson).toContain(text)
    for (const text of omits) expect(promptJson).not.toContain(text)
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
      "Historical file kept as metadata"
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
    const plan = executionPlanFor(sixb)
    const request = await requestAgent(sixb, { text: "hi" })
    const run = await reserveRequestedRun(sixb, request)
    const context = await buildAgentWorkerContext(sixb, {
      apiBaseUrl: "http://sixb-api.local/api/",
    })

    // Resolves while create() is still gated: the system prompt is ready and the
    // sandbox has not been built yet.
    const environment = await createConversationAgentEnvironment({
      context,
      plan: plan,
      run,
    })
    expect(environment.turnContext.systemPrompt).toContain("<sixb_runtime_context>")
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

  test("releases a run's sandbox when its environment fails after provisioning started", async () => {
    // Regression proof: remove dispose() from the system prompt's catch in startAgentEnvironment;
    // the sandbox is created and never destroyed.
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(toolThenAnswerModel(), new InMemoryBroker(), sandboxes)
    const request = await requestAgent(sixb, { text: "hi" })
    const run = await reserveRequestedRun(sixb, request)
    const context = await buildAgentWorkerContext(sixb)

    // The locale is read only to build the system prompt, after provisioning has started.
    const failing: AgentExecutionContext = Object.defineProperty({ ...context }, "locale", {
      get: () => {
        throw new Error("locale unavailable")
      },
    })

    await expect(
      createConversationAgentEnvironment({ context: failing, plan: executionPlanFor(sixb), run })
    ).rejects.toThrow("locale unavailable")

    await waitFor(() => sandboxes.sandboxes[0]?.destroyed || null, { label: "sandbox released" })
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
    const plan = executionPlanFor(sixb)
    const request = await requestAgent(sixb, { text: "hi" })
    const run = await reserveRequestedRun(sixb, request)
    const context = await buildAgentWorkerContext(sixb)

    let detached: Promise<void> | null = null
    const environment = await createConversationAgentEnvironment({
      context,
      plan: plan,
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

  test("keeps the queued run visible when dispatch fails, and dispatches it once the queue recovers", async () => {
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
    let request: Awaited<ReturnType<typeof requestAgent>>
    try {
      request = await requestAgent(sixb, { text: "recover me" })
    } finally {
      console.error = originalConsoleError
    }
    expect(request.run.status).toBe("queued")
    expect(request.jobId).toBeUndefined()
    const threads = await storage.threads.list({ projectId: PROJECT_ID })
    expect(threads.threads).toHaveLength(1)
    const thread = threads.threads[0]
    if (!thread) throw new Error("expected durable thread")
    const runs = await storage.runs.list({ projectId: PROJECT_ID, threadId: thread.id })
    expect(runs.runs).toHaveLength(1)
    expect(runs.runs[0]).toMatchObject({ id: request.run.id, status: "queued", attempt: 0 })
    expect(thread.activeRunId).toBe(request.run.id)
    expect(await listMessages(storage, thread.id)).toHaveLength(1)

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const run = await waitForTerminalRun(storage, request.run.id)
      expect(run.status).toBe("succeeded")
      expect(enqueueCalls).toBeGreaterThanOrEqual(2)
    } finally {
      await worker.stop()
    }
  })

  test("runs project tools with connector, metadata, and logs", async () => {
    let connectorCalls = 0
    const knowledge = defineConnector("knowledge", {
      type: "knowledge",
      connect() {
        connectorCalls += 1
        return { echo: (value: string) => `connected:${value}` }
      },
    })
    let handlerContext: { readonly runId: string; readonly threadId: string } | undefined
    let handlerSignal: AbortSignal | undefined
    let selectedCalls = 0
    let successfulReplay = ""
    const selectedEcho = defineAgentTool("echo")
      .description("Echo through the registered knowledge connector.")
      .input({ value: "string" })
      .run(async ({ input, run, signal, sixb, logger }) => {
        selectedCalls += 1
        if (run.kind !== "conversation") throw new Error("Expected a conversation Agent run.")
        handlerContext = { runId: run.id, threadId: run.threadId }
        handlerSignal = signal
        const client = await sixb.connector(knowledge)
        logger.info("selected tool called", { value: input.value })
        return { echoed: client.echo(input.value) }
      })
    const sixb = buildSixb(
      toolThenAnswerModel((prompt) => {
        successfulReplay = prompt
      }),
      new InMemoryBroker(),
      new RecordingSandboxFactory(),
      { projectTools: [selectedEcho], connectors: [knowledge] }
    )
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const selectedRequest = await requestAgent(sixb, { text: "echo hi" })
      const selectedRun = await waitForTerminalRun(storage, selectedRequest.run.id)
      expect(selectedRun.status).toBe("succeeded")
      expect(selectedCalls).toBe(1)
      expect(connectorCalls).toBe(1)
      expect(handlerSignal).toBeInstanceOf(AbortSignal)
      expect(handlerContext).toEqual({
        runId: selectedRequest.run.id,
        threadId: selectedRequest.run.threadId,
      })
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

      const followUp = await requestAgent(sixb, {
        threadId: selectedRequest.run.threadId,
        text: "continue",
      })
      await waitForTerminalRun(storage, followUp.run.id)
      expect(successfulReplay).toContain(selectedEcho.name)
      expect(successfulReplay).toContain("connected:hi")

      const logs = await waitFor(
        async () => {
          const page = await sixb.logging!.read({
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
          threadId: selectedRequest.run.threadId,
          value: "hi",
        },
        context: { run: { kind: "agent", id: selectedRequest.run.id } },
      })
    } finally {
      await worker.stop()
    }
  })

  test("publishes a selected tool's file to blob storage and the run sandbox", async () => {
    let published: AgentToolFile | undefined
    let receivedToolCallId: string | undefined
    let livePrompt: unknown
    let replayPrompt: unknown
    let viewedPrompt: unknown
    const createImage = defineAgentTool("create_image")
      .description("Create a test image.")
      .input({})
      .run(async ({ files, toolCallId }) => {
        receivedToolCallId = toolCallId
        published = await files.put({
          body: TEST_PNG_BYTES,
          fileName: "generated.png",
          mediaType: "image/png",
        })
        return {
          kind: "agentToolResult",
          content: [
            { type: "text", text: "Created an image." },
            { type: "file", fileRef: published.fileRef },
          ],
        } satisfies AgentToolResult
      })
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(
      toolFileThenAnswerModel({
        live: (prompt) => {
          livePrompt = prompt
        },
        replay: (prompt) => {
          replayPrompt = prompt
        },
        viewed: (prompt) => {
          viewedPrompt = prompt
        },
      }),
      new InMemoryBroker(),
      sandboxes,
      { agentTools: [createImage] }
    )
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions())

    await worker.start()
    try {
      const request = await requestAgent(sixb, {
        text: "create an image",
      })
      const run = await waitForTerminalRun(storage, request.run.id)

      expect(run.status).toBe("succeeded")
      expect(receivedToolCallId).toBe("image-call-1")
      expect(published).toBeDefined()
      if (!published) throw new Error("Expected the selected tool to publish a file.")

      expect(
        new Uint8Array(
          await new Response(await sixb.blobStorage.open(published.fileRef.blobId)).arrayBuffer()
        )
      ).toEqual(TEST_PNG_BYTES)
      const sandboxFile = sandboxes.sandboxes[0]?.writtenFiles.find((file) =>
        file.path.includes(".sixb/agent/tool-files/")
      )
      expect(sandboxFile?.contents).toEqual(TEST_PNG_BYTES)
      expect(published.sandboxPath).toEndWith("-generated.png")

      const messages = await listMessages(storage, request.run.threadId)
      const firstAssistant = messages.find(
        (message) =>
          message.role === "assistant" &&
          message.parts.some(
            (part) => part.type === "tool-call" && part.toolName === createImage.name
          )
      )
      expect(
        firstAssistant?.parts.find(
          (part) => part.type === "tool-call" && part.toolName === createImage.name
        )
      ).toMatchObject({
        state: "output-available",
        output: {
          kind: "agentToolResult",
          content: [{ type: "text" }, { type: "file", fileRef: published.fileRef }],
        },
      })
      // A tool's file stays in its result: the Agent publishes what the user should receive.
      expect(firstAssistant?.parts.filter((part) => part.type === "file")).toEqual([])
      const richToolPartIndex = firstAssistant?.parts.findIndex(
        (part) => part.type === "tool-call" && part.toolName === createImage.name
      )
      expect(richToolPartIndex).toBeGreaterThanOrEqual(0)
      const durableJson = JSON.stringify(messages)
      expect(durableJson).not.toContain("data:image")
      expect(durableJson).not.toContain("iVBORw0KGgo")
      expect(durableJson).not.toContain(published.sandboxPath)

      const livePromptJson = JSON.stringify(livePrompt)
      expect(livePromptJson).toContain("generated.png")
      expect(livePromptJson).toContain("<tool_file")
      expect(livePromptJson).toContain("<sixb_tool_files")
      const livePromptMessages = Array.isArray(livePrompt) ? livePrompt : []
      const liveToolResults = livePromptMessages.flatMap((message) => {
        if (
          typeof message !== "object" ||
          message === null ||
          !("role" in message) ||
          message.role !== "tool" ||
          !("content" in message) ||
          !Array.isArray(message.content)
        ) {
          return []
        }
        return message.content.filter(
          (part: unknown) =>
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            part.type === "tool-result"
        )
      })
      // The native contract retains originalOutput for durable tracing, separately from model output.
      const modelOutputs = liveToolResults.map((part: { output: unknown }) => part.output)
      expect(JSON.stringify(modelOutputs)).not.toContain('"type":"file"')
      if (typeof Bun.Image === "function") {
        expect(
          livePromptMessages.some(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              "role" in message &&
              message.role === "user" &&
              "content" in message &&
              Array.isArray(message.content) &&
              message.content.some(
                (part: unknown) =>
                  typeof part === "object" &&
                  part !== null &&
                  "type" in part &&
                  part.type === "file"
              )
          )
        ).toBe(true)
        expect(livePromptJson).toContain(Buffer.from(TEST_PNG_BYTES).toString("base64"))
      }

      const followup = await requestAgent(sixb, {
        threadId: request.run.threadId,
        text: "inspect it again",
      })
      const replayRun = await waitForTerminalRun(storage, followup.run.id)
      expect(replayRun.status).toBe("succeeded")

      const replayPromptJson = JSON.stringify(replayPrompt)
      expect(replayPromptJson).toContain("generated.png")
      expect(replayPromptJson).toContain(
        encodeURIComponent(`/parts/${richToolPartIndex}/output/content/1/fileRef`)
      )
      if (typeof Bun.Image === "function") {
        expect(replayPromptJson).not.toContain(Buffer.from(TEST_PNG_BYTES).toString("base64"))
      }
      expect(
        sandboxes.sandboxes[1]?.writtenFiles.some(
          (file) =>
            file.path.includes(".sixb/agent/attachments/") &&
            file.path.endsWith(`tool-${richToolPartIndex}-1-generated.png`) &&
            Buffer.from(file.contents).equals(Buffer.from(TEST_PNG_BYTES))
        )
      ).toBe(true)

      const viewedPromptJson = JSON.stringify(viewedPrompt)
      expect(viewedPromptJson).toContain("view_file")
      if (typeof Bun.Image === "function") {
        expect(viewedPromptJson).toContain(Buffer.from(TEST_PNG_BYTES).toString("base64"))
      }
      const replayMessages = await listMessages(storage, request.run.threadId)
      const replayAssistant = replayMessages.find(
        (message) =>
          message.runId === followup.run.id &&
          message.parts.some((part) => part.type === "tool-call" && part.toolName === "view_file")
      )
      expect(
        replayAssistant?.parts.find(
          (part) => part.type === "tool-call" && part.toolName === "view_file"
        )
      ).toMatchObject({
        state: "output-available",
        output: {
          kind: "agentToolResult",
          content: [{ type: "text" }, { type: "file", fileRef: published.fileRef }],
        },
      })
      expect(
        sandboxes.sandboxes[1]?.writtenFiles.filter((file) =>
          file.path.includes(".sixb/agent/tool-files/")
        )
      ).toHaveLength(0)
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
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const first = await requestAgent(sixb, { text: "run the tool" })
      const firstRun = await waitForTerminalRun(storage, first.run.id)
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
          "[SixbAgentWorker] Agent tool 'invalid_result' returned an invalid result; result.invalid is undefined.",
      })

      const second = await requestAgent(sixb, {
        threadId: first.run.threadId,
        text: "continue",
      })
      await waitForTerminalRun(storage, second.run.id)
      expect(replayedPrompt).toContain("invalid_result")
      expect(replayedPrompt).toContain("returned an invalid result")
    } finally {
      await worker.stop()
    }
  })

  test("runs a full multi-step turn: starts, persists the assistant message, finalizes with usage", async () => {
    const sixb = buildSixbWithEchoTool(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    const auth = authStorageOf(sixb)
    const bindScope = spyOn(sixb, "withScope")

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const {
        run: { threadId, id: runId },
      } = await requestAgent(sixb, {
        text: "echo hi",
      })

      const run = await waitForTerminalRun(storage, runId)

      expect(run.status).toBe("succeeded")
      expect(run.attempt).toBe(1)
      expect(run.finishReason).toBe("stop")
      expect(run.modelId).toBe("mock-model")
      const durableExecution = await sixb.storage.executions.getById({
        projectId: PROJECT_ID,
        id: run.executionId,
      })
      expect(durableExecution?.authorizationRef).toEqual({
        type: "disabled",
      })
      // Regression proof: restoring actorId in the worker's binding adds it to this executor.
      const scope = bindScope.mock.calls.find(
        ([scope]) => scope.execution.id === run.executionId
      )?.[0]
      expect(scope?.execution.executor).toEqual({ type: "agent", runId })
      await expect(
        aiUsageStorageOf(sixb).summarizeExecution({
          projectId: PROJECT_ID,
          executionId: run.executionId,
        })
      ).resolves.toEqual({
        modelCallCount: 2,
        usage: {
          inputTokens: 20,
          outputTokens: 14,
          totalTokens: 34,
          uncachedInputTokens: 20,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          textOutputTokens: 14,
          reasoningOutputTokens: 0,
          reportingStatus: "complete",
        },
      })

      // Thread released after finalization (single-flight pointer cleared).
      const thread = await storage.threads.getById({ projectId: PROJECT_ID, id: threadId })
      expect(thread?.activeRunId).toBeNull()

      const messages = await listMessages(storage, threadId)
      const assistant = messages.find((message) => message.role === "assistant")
      expect(assistant).toBeDefined()
      expect(assistant?.runId).toBe(run.id)
      expect(assistant?.authorPrincipal).toBeUndefined()

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

      // Regression proof: restoring the former startup ensure loop creates an identity here.
      expect((await auth.serviceAccounts.list({ projectId: PROJECT_ID })).total).toBe(0)
      const memberships = await auth.serviceAccountGroupMemberships.listForServiceAccount({
        projectId: PROJECT_ID,
        serviceAccountId: "svc_agent_assistant",
      })
      expect(memberships.map((membership) => [membership.groupId, membership.source])).toEqual([])

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
      bindScope.mockRestore()
    }
  })

  test("delegates to an isolated child lane without consuming another primary slot", async () => {
    let childRunId = ""
    const parentCalls: LanguageModelRequest[] = []
    const childCalls: LanguageModelRequest[] = []
    const childModel = new WorkerTestModel({
      providerId: "gateway",
      modelId: "deepseek/deepseek-v4-flash-vision-exp",
      stream: async (options) => {
        childCalls.push(options)
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "child-answer" },
          { type: "text-delta", id: "child-answer", delta: "The delegated fact is 42." },
          { type: "text-end", id: "child-answer" },
          finish("stop"),
        ])
      },
    })
    const parentModel = delegatingParentModel({
      childRunId: () => childRunId,
      childModel: { provider: childModel.providerId, modelId: childModel.modelId },
      onCall: (options) => parentCalls.push(options),
    })
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(parentModel, new InMemoryBroker(), sandboxes, {
      models: { language: [parentModel, childModel] },
      projectTools: [echoAgentTool],
    })
    const storage = agentStorageOf(sixb)
    const requested = await requestAgent(sixb, {
      text: "Delegate this research task.",
    })
    childRunId = createSubagentRunId(requested.run.id, "research")
    const worker = new AgentWorker(sixb, workerOptions({ concurrency: 1 }))

    // wait_agent polls the child every 250ms: drive that with fake time.
    jest.useFakeTimers()
    try {
      await worker.start()
      const parent = await underFakeTime(
        () => terminalRun(storage, requested.run.id),
        "delegating parent run terminal"
      )
      if (parent.kind !== "conversation") throw new Error("Expected the conversation run.")
      const loadedChild = await storage.runs.getById({
        projectId: PROJECT_ID,
        id: childRunId,
      })
      if (!loadedChild || loadedChild.kind !== "subagent") {
        throw new Error("Expected a durable child Agent run.")
      }
      const child: SubagentRunRecord = loadedChild

      expect(parent.status).toBe("succeeded")
      expect(child).toMatchObject({
        parentRunId: parent.id,
        spawnKey: "research",
        status: "succeeded",
        modelId: "deepseek/deepseek-v4-flash-vision-exp",
        finishReason: "stop",
        spec: {
          model: { provider: "gateway", modelId: "deepseek/deepseek-v4-flash-vision-exp" },
          reasoning: "high",
          task: "Research the exact delegated fact.",
          toolNames: ["echo"],
        },
      })
      expect(child.result).toEqual({ text: "The delegated fact is 42." })

      // Regression check: restore the free-string model schema in spawnInputSchema; this fails.
      const spawnTool = parentCalls[0]?.tools?.find((tool) => tool.name === "spawn_agent")
      if (!spawnTool) throw new Error("Expected spawn_agent tool.")
      expect(spawnTool.inputSchema.required).not.toContain("model")
      expect(spawnTool.inputSchema).toMatchObject({
        properties: {
          model: {
            description: expect.stringContaining("Keep provider and modelId unchanged"),
            anyOf: [
              { provider: "parent-provider", modelId: "parent-model" },
              { provider: "gateway", modelId: "deepseek/deepseek-v4-flash-vision-exp" },
            ].map(({ provider, modelId }) => ({
              type: "object",
              properties: {
                provider: { type: "string", enum: [provider] },
                modelId: { type: "string", enum: [modelId] },
              },
              required: ["provider", "modelId"],
              additionalProperties: false,
            })),
          },
        },
      })

      const [parentExecution, childExecution] = await Promise.all([
        sixb.storage.executions.getById({ projectId: PROJECT_ID, id: parent.executionId }),
        sixb.storage.executions.getById({ projectId: PROJECT_ID, id: child.executionId }),
      ])
      expect(parentExecution?.authorizationRef).toEqual({ type: "disabled" })
      expect(childExecution).toMatchObject({
        executor: { type: "agent", runId: child.id },
        source: { type: "execution", executionId: parent.executionId },
        correlationId: parentExecution?.correlationId,
        authorizationRef: { type: "disabled" },
      })
      expect(childExecution?.requestedBy).toEqual(parentExecution?.requestedBy)

      expect(childCalls).toHaveLength(1)
      expect(childCalls[0]?.reasoning).toBe("high")
      const childToolNames = childCalls[0]?.tools?.map((entry) => entry.name) ?? []
      expect(childToolNames).toEqual(expect.arrayContaining(["echo", "view_file", "read", "bash"]))
      expect(childToolNames).not.toContain("spawn_agent")
      expect(childToolNames).not.toContain("wait_agent")
      const childPrompt = JSON.stringify(childCalls[0]?.messages)
      expect(childPrompt).toContain("headless child agent")
      expect(childPrompt).toContain("Research the exact delegated fact.")

      expect(sandboxes.sandboxes).toHaveLength(2)
      expect(new Set(sandboxes.sandboxes.map((sandbox) => sandbox.id)).size).toBe(2)

      const childStream = await listRunStreamRecords(sixb.broker, child.id)
      expect(childStream.map((record) => record.name)).toEqual(
        expect.arrayContaining(["agent.run.started", "agent.ui.chunk", "agent.run.finished"])
      )
      expect(
        childStream.every((record) => {
          const payload = record.payload as unknown as Record<string, unknown>
          return payload.parentRunId === parent.id && !Object.hasOwn(payload, "threadId")
        })
      ).toBe(true)

      const conversationMessages = await listMessages(storage, parent.threadId)
      expect(conversationMessages).toHaveLength(2)
      expect(conversationMessages.some((message) => message.runId === child.id)).toBe(false)
      expect(
        conversationMessages.some(
          (message) => message.role === "assistant" && message.runId === parent.id
        )
      ).toBe(true)

      await expect(
        aiUsageStorageOf(sixb).summarizeExecution({
          projectId: PROJECT_ID,
          executionId: child.executionId,
        })
      ).resolves.toMatchObject({ modelCallCount: 1 })
      await expect(
        sixb.storage.aiCosts?.listModelCalls({
          projectId: PROJECT_ID,
          executionId: child.executionId,
          from: new Date("2000-01-01T00:00:00.000Z"),
          to: new Date("2100-01-01T00:00:00.000Z"),
        })
      ).resolves.toMatchObject({
        items: [
          {
            attribution: {
              kind: "subagent",
              subagentRunId: child.id,
              parentRunId: parent.id,
            },
          },
        ],
      })
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test("keeps a child's task and its work in a thread of its own, under the conversation", async () => {
    // Removal proof: finish the child with `finishRunOrThrow` again, without its work message;
    // its thread then holds the task alone.
    let childRunId = ""
    const childCalls: LanguageModelRequest[] = []
    const childModel = new WorkerTestModel({
      providerId: "gateway",
      modelId: "zai/glm-5.3-flash",
      stream: async (options) => {
        childCalls.push(options)
        return answerStream("The delegated fact is 42.")
      },
    })
    const parentModel = delegatingParentModel({
      childRunId: () => childRunId,
      childModel: { provider: childModel.providerId, modelId: childModel.modelId },
    })
    const sixb = buildSixb(parentModel, new InMemoryBroker(), new RecordingSandboxFactory(), {
      models: { language: [parentModel, childModel] },
    })
    const storage = agentStorageOf(sixb)
    const requested = await requestAgent(sixb, { text: "Delegate this research task." })
    childRunId = createSubagentRunId(requested.run.id, "research")
    const threadId = createSubagentThreadId(requested.run.id, "research")
    const worker = new AgentWorker(sixb, workerOptions())

    jest.useFakeTimers()
    try {
      await worker.start()
      await underFakeTime(() => terminalRun(storage, requested.run.id), "delegating parent")

      const child = await storage.runs.getById({ projectId: PROJECT_ID, id: childRunId })
      expect(child).toMatchObject({ kind: "subagent", status: "succeeded", threadId })
      const conversation = await storage.threads.getById({
        projectId: PROJECT_ID,
        id: requested.run.threadId,
      })
      const thread = await storage.threads.getById({ projectId: PROJECT_ID, id: threadId })
      expect(thread).toMatchObject({
        kind: "subagent",
        parent: { threadId: requested.run.threadId, spawnedBy: requested.run.id, key: "research" },
        ownerPrincipal: conversation?.ownerPrincipal,
        activeRunId: null,
        messageCount: 2,
      })

      const messages = await listMessages(storage, threadId)
      expect(messages).toMatchObject([
        {
          runId: childRunId,
          role: "user",
          parts: [{ type: "text", text: "Research the exact delegated fact." }],
        },
        {
          runId: childRunId,
          role: "assistant",
          parts: [{ type: "step-start" }, { type: "text", text: "The delegated fact is 42." }],
        },
      ])
      // Its model read its thread: the task, closed by when the thread was created.
      expect(childCalls[0]?.messages.slice(1)).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "Research the exact delegated fact." },
            { type: "text", text: expect.stringMatching(/^\n\n<sixb_current_time>/) },
          ],
        },
      ])

      // The conversation is still the only thread listed, and holds none of the child's messages.
      const listed = await storage.threads.list({ projectId: PROJECT_ID })
      expect(listed.threads.map((listedThread) => listedThread.id)).toEqual([
        requested.run.threadId,
      ])
      const conversationMessages = await listMessages(storage, requested.run.threadId)
      expect(conversationMessages.some((message) => message.runId === childRunId)).toBe(false)
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test("delegates to a tier's model", async () => {
    // Removal proof: drop the tier branch from SubagentCoordinator.resolveModel; the tier is
    // looked up as a model reference and the spawn fails.
    let childRunId = ""
    const parentCalls: LanguageModelRequest[] = []
    const heavyModel = new WorkerTestModel({
      providerId: "gateway",
      modelId: "anthropic/claude-opus-5.5",
      stream: async () =>
        stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "child-answer" },
          { type: "text-delta", id: "child-answer", delta: "The delegated fact is 42." },
          { type: "text-end", id: "child-answer" },
          finish("stop"),
        ]),
    })
    const parentModel = delegatingParentModel({
      childRunId: () => childRunId,
      childModel: "heavy",
      onCall: (options) => parentCalls.push(options),
    })
    const sixb = buildSixb(parentModel, new InMemoryBroker(), new RecordingSandboxFactory(), {
      models: { language: { standard: parentModel, heavy: heavyModel } },
    })
    const storage = agentStorageOf(sixb)
    const requested = await requestAgent(sixb, { text: "Delegate this research task." })
    childRunId = createSubagentRunId(requested.run.id, "research")
    const worker = new AgentWorker(sixb, workerOptions({ concurrency: 1 }))

    // wait_agent polls the child every 250ms: drive that with fake time.
    jest.useFakeTimers()
    try {
      await worker.start()
      const parent = await underFakeTime(
        () => terminalRun(storage, requested.run.id),
        "parent delegating to a tier terminal"
      )
      const child = await storage.runs.getById({ projectId: PROJECT_ID, id: childRunId })

      expect(parent.status).toBe("succeeded")
      expect(child).toMatchObject({
        status: "succeeded",
        spec: { model: { provider: "gateway", modelId: "anthropic/claude-opus-5.5" } },
      })

      // Only configured tiers are offered, ahead of the exact references.
      const spawnTool = parentCalls[0]?.tools?.find((tool) => tool.name === "spawn_agent")
      expect(spawnTool?.inputSchema).toMatchObject({
        properties: {
          model: {
            anyOf: [
              { type: "string", enum: ["standard", "heavy"] },
              { properties: { modelId: { enum: ["parent-model"] } } },
              { properties: { modelId: { enum: ["anthropic/claude-opus-5.5"] } } },
            ],
          },
        },
      })
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  // Regression proof: drop `approvalMode` from the child spec in `SubagentCoordinator.spawn`; the
  // child has none, and the gateway lets it run what its turn would have held.
  test("a child inherits its turn's approval mode", async () => {
    const sixb = buildSixb(answerModel())
    const storage = agentStorageOf(sixb)
    const requested = await requestAgentAs(sixb, REQUESTER, {
      text: "Delegate a task.",
      approvalMode: "accept-edits",
    })
    const parent = requireConversationRun(
      await storage.runs.start({
        projectId: PROJECT_ID,
        id: requested.run.id,
        execution: freshTestExecution(),
      })
    )
    const execution = await sixb.storage.executions.getById({
      projectId: PROJECT_ID,
      id: parent.executionId,
    })
    if (!execution) throw new Error("Expected the turn's execution.")

    const coordinator = new SubagentCoordinator(
      sixb,
      await buildAgentWorkerContext(sixb),
      parent,
      execution,
      new Date(Date.now() + 60_000)
    )
    const child = await coordinator.spawn(
      { key: "review", task: "Review the result." },
      new AbortController().signal
    )

    const stored = await storage.runs.getById({ projectId: PROJECT_ID, id: child.runId })
    expect(stored?.kind === "subagent" ? stored.spec.approvalMode : null).toBe("accept-edits")
  })

  test("a child knows the project as its conversation does, and none of the chat's rules", async () => {
    // Removal proof: drop `projectInstructions` from the child's plan, its ontology docs or memory
    // from createSubagentEnvironment, or its requester's settings from the spawned spec; this fails.
    let request: LanguageModelRequest | undefined
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async (options) => {
        request ??= options
        return answerStream("Rooms are booked by the hour.")
      },
    })
    const sixb = buildSixb(model, new InMemoryBroker(), new RecordingSandboxFactory(), {
      projectInstructions: "Revenue means netRevenue.",
      ontology: [MeetingRoom],
      ontologyDocs: {
        modules: [{ path: "rooms/meeting-room.ts", objectTypeIds: ["MeetingRoom"] }],
        docs: [],
        scripts: [],
      },
    })
    await agentStorageOf(sixb).memory.save({
      projectId: PROJECT_ID,
      repoId: "project",
      baseRevision: 0,
      message: "Remember",
      author: REQUESTER,
      changes: [{ path: "MEMORY.md", contents: "# Ours\n- Quarters start in February\n" }],
    })
    const {
      children: [child],
    } = await spawnChildOfRunningTurn(sixb, {
      text: "Delegate.",
      timeZone: "Europe/Paris",
      locale: "fr-FR",
    })
    if (!child) throw new Error("Expected the child.")
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const run = await waitForTerminalRun(agentStorageOf(sixb), child.runId)
      expect(run).toMatchObject({
        status: "succeeded",
        spec: { timeZone: "Europe/Paris", locale: "fr-FR" },
      })

      const system = systemPromptOf(request?.messages)
      expect(system).toContain(
        "<agent_instructions>\nRevenue means netRevenue.\n</agent_instructions>"
      )
      expect(system).toContain(
        ["└── rooms/", "    └── meeting-room.md  MeetingRoom: A bookable meeting room."].join("\n")
      )
      expect(system).toContain("Time zone: Europe/Paris. Locale: fr-FR.")
      expect(system).toContain(
        '<memory repo="project">\n# Ours\n- Quarters start in February\n</memory>'
      )
      expect(system).toContain("It is read-only for you: only the parent Agent saves to it.")
      expect(system).not.toContain("Speak like a helpful teammate")
      expect(system).not.toContain("sixb memory save")
      // The task is dated as its requester reads the time.
      expect(JSON.stringify(request?.messages.at(-1))).toContain(
        renderCurrentTime(run.createdAt, "Europe/Paris")
      )
    } finally {
      await worker.stop()
    }
  })

  test("a child publishes into its parent's thread and answers once; a retry takes it back", async () => {
    // Removal proofs: drop `publishing` from createSubagentEnvironment, and nothing is published;
    // build the child's result from every step again, and its narration reaches the parent; drop
    // installArtifactsFrom from SubagentCoordinator.installOutputs, and the parent's
    // $SIXB_ARTIFACTS never lists the child's artifact; drop the children from retryAgentRun's
    // cleanup, and the child's artifact outlives the retry.
    let childRunId = ""
    const parentCalls: LanguageModelRequest[] = []
    let childCall = 0
    const childModel = new WorkerTestModel({
      providerId: "child-provider",
      modelId: "child-model",
      stream: async () => {
        childCall += 1
        if (childCall === 1) {
          return stream([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "narration" },
            { type: "text-delta", id: "narration", delta: "Let me draft the review first." },
            { type: "text-end", id: "narration" },
            {
              type: "tool-call",
              toolCallId: "draft",
              toolName: "bash",
              input: JSON.stringify({ command: "write-q3-review" }),
            },
            finish("tool-calls"),
          ])
        }
        if (childCall === 2) {
          return toolCallStream("publish", "publish_artifact", {
            path: "work/q3-review",
            kind: "document",
            title: "Q3 review",
          })
        }
        return answerStream("The Q3 review is published.")
      },
    })
    const parentModel = new WorkerTestModel({
      providerId: "parent-provider",
      modelId: "parent-model",
      stream: async (options) => {
        parentCalls.push(options)
        if (parentCalls.length === 1) {
          return toolCallStream("spawn", "spawn_agent", {
            key: "q3-review",
            task: "Write the Q3 review and publish it.",
            model: { provider: childModel.providerId, modelId: childModel.modelId },
          })
        }
        if (parentCalls.length === 2) {
          return toolCallStream("wait", "wait_agent", { runIds: [childRunId] })
        }
        if (parentCalls.length === 3) {
          throw createSixbError("agent.execution_failed", "[test] The provider failed mid-turn.")
        }
        return answerStream("Retried.")
      },
    })
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(parentModel, new InMemoryBroker(), sandboxes, {
      models: { language: [parentModel, childModel] },
    })
    attachSixbErrorReporter(sixb, () => {})
    const storage = agentStorageOf(sixb)
    const requested = await requestAgent(sixb, { text: "Write the Q3 review." })
    childRunId = createSubagentRunId(requested.run.id, "q3-review")
    const worker = new AgentWorker(sixb, workerOptions())

    // wait_agent polls the child every 250ms: drive that with fake time.
    jest.useFakeTimers()
    try {
      await worker.start()
      const parent = await underFakeTime(
        () => terminalRun(storage, requested.run.id),
        "parent of a publishing child terminal"
      )
      expect(parent.status).toBe("failed")

      const artifact = await onlyArtifact(sixb)
      const thread = await storage.threads.getById({
        projectId: PROJECT_ID,
        id: requested.run.threadId,
      })
      const version = await artifactStorageOf(sixb).getVersion({
        projectId: PROJECT_ID,
        artifactId: artifact.id,
        version: 1,
      })
      if (!thread) throw new Error("Expected the thread.")
      expect(artifact.owner).toEqual(thread.ownerPrincipal)
      expect(version?.origin).toEqual({ threadId: requested.run.threadId, runId: childRunId })
      expect(
        await artifactStorageOf(sixb).listThreadIds({ projectId: PROJECT_ID, id: artifact.id })
      ).toEqual([requested.run.threadId])

      // The parent reads the child's answer, not how it got there.
      const child = await storage.runs.getById({ projectId: PROJECT_ID, id: childRunId })
      expect(child?.kind === "subagent" ? child.result : null).toEqual({
        text: "The Q3 review is published.",
      })
      const waited = JSON.stringify(parentCalls[2]?.messages)
      expect(waited).toContain("The Q3 review is published.")
      expect(waited).not.toContain("Let me draft the review first.")

      // Once wait_agent returns, the parent's sandbox holds the child's artifact like its own.
      const parentSandbox = sandboxes.sandboxes[0]
      if (!parentSandbox) throw new Error("Expected the parent's sandbox.")
      const inParent = (path: string) =>
        new TextDecoder().decode(
          parentSandbox.files.get(join(parentSandbox.workingDirectory, path))
        )
      expect(JSON.parse(inParent(".sixb/agent/context/artifacts.json"))).toMatchObject({
        artifacts: [
          {
            id: artifact.id,
            version: 1,
            pinned: `artifact:${artifact.id}@1`,
            directory: `.sixb/agent/artifacts/${artifact.id}`,
          },
        ],
      })
      expect(inParent(`.sixb/agent/artifacts/${artifact.id}/document.md`)).toBe(Q3_REVIEW_MARKDOWN)

      await createTestSixb(sixb).agent.runs.retry(requested.run.id)
      expect(
        await artifactStorageOf(sixb).get({ projectId: PROJECT_ID, id: artifact.id })
      ).toBeNull()
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test("hands a child files at their paths and gets back what it writes to out/", async () => {
    // Removal proofs: leave `files` out of the child's spec in SubagentCoordinator.admit, and the
    // child's sandbox lacks reports/acme.csv; drop storeChildOutputs from runSubagent, and
    // wait_agent lists nothing, the parent's sandbox holds no chart and the next turn's
    // $SIXB_ATTACHMENTS lists none; return the result as plain JSON from wait_agent's execute,
    // and the next turn lists none either; skip nothing in
    // storeChildOutputs, and the logo the parent handed over comes back to it; skip by size
    // instead of digest there, and the brief the child rewrote stays behind.
    let childRunId = ""
    const parentCalls: LanguageModelRequest[] = []
    const childCalls: LanguageModelRequest[] = []
    const childModel = new WorkerTestModel({
      providerId: "child-provider",
      modelId: "child-model",
      stream: async (options) => {
        childCalls.push(options)
        if (childCalls.length === 1) {
          return toolCallStream("chart", "bash", { command: "write-child-outputs" })
        }
        return answerStream("Acme's margin fell to 12%; the chart and table are in out/.")
      },
    })
    const parentModel = new WorkerTestModel({
      providerId: "parent-provider",
      modelId: "parent-model",
      stream: async (options) => {
        parentCalls.push(options)
        if (parentCalls.length === 1) {
          return toolCallStream("reports", "bash", { command: "write-handoff-files" })
        }
        if (parentCalls.length === 2) {
          return toolCallStream("spawn", "spawn_agent", {
            key: "acme-review",
            task: "Chart Acme's margins from the P&L.",
            model: { provider: childModel.providerId, modelId: childModel.modelId },
            files: ["reports/acme.csv", "reports/notes", "out/logo.png", "out/brief.txt"],
          })
        }
        if (parentCalls.length === 3) {
          return toolCallStream("wait", "wait_agent", { runIds: [childRunId] })
        }
        return answerStream("Acme's margin fell to 12%.")
      },
    })
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(parentModel, new InMemoryBroker(), sandboxes, {
      models: { language: [parentModel, childModel] },
    })
    const storage = agentStorageOf(sixb)
    const requested = await requestAgent(sixb, { text: "Review Acme's margins." })
    childRunId = createSubagentRunId(requested.run.id, "acme-review")
    const worker = new AgentWorker(sixb, workerOptions())

    // wait_agent polls the child every 250ms: drive that with fake time.
    jest.useFakeTimers()
    try {
      await worker.start()
      const parent = await underFakeTime(
        () => terminalRun(storage, requested.run.id),
        "parent of a child with files terminal"
      )
      expect(parent.status).toBe("succeeded")
      const [parentSandbox, childSandbox] = sandboxes.sandboxes
      if (!parentSandbox || !childSandbox) throw new Error("Expected two sandboxes.")
      const inChild = (path: string) =>
        childSandbox.files.get(join(childSandbox.workingDirectory, path))
      const inParent = (path: string) =>
        parentSandbox.files.get(join(parentSandbox.workingDirectory, path))

      // The child finds each file at the parent's path, and its task says where they are.
      const handed = [
        "out/brief.txt",
        "out/logo.png",
        "reports/acme.csv",
        "reports/notes/summary.md",
      ]
      expect(new TextDecoder().decode(inChild("reports/acme.csv"))).toBe(ACME_CSV)
      expect(inChild("reports/notes/summary.md")).toBeDefined()
      expect(inChild("out/logo.png")).toEqual(TEST_PNG_BYTES)
      const task = JSON.stringify(childCalls[0]?.messages.at(-1))
      expect(task).toContain("Chart Acme's margins from the P&L.")
      expect(task).toContain(`- reports/acme.csv (text/csv, ${ACME_CSV.length}B)`)
      expect(task).toContain("- reports/notes/summary.md (")
      const manifest = JSON.parse(
        new TextDecoder().decode(inChild(".sixb/agent/context/attachments.json"))
      ) as { readonly attachments: readonly { readonly sandboxPath: string }[] }
      expect(manifest.attachments.map((entry) => entry.sandboxPath).sort()).toEqual(handed)

      // What it wrote to out/ comes back under the parent's directory for it, and nothing else.
      const child = await storage.runs.getById({ projectId: PROJECT_ID, id: childRunId })
      if (child?.kind !== "subagent") throw new Error("Expected the child run.")
      expect(child.spec.files?.map((file) => file.path).sort()).toEqual(handed)
      // The brief it rewrote comes back, though its size did not change; the logo it left does not.
      expect(child.result?.files?.map((file) => file.path)).toEqual([
        "brief.txt",
        "margins.png",
        "tables/margins.csv",
      ])
      expect(inParent(".sixb/agent/children/acme-review/margins.png")).toEqual(TEST_PNG_BYTES)
      expect(
        new TextDecoder().decode(inParent(".sixb/agent/children/acme-review/tables/margins.csv"))
      ).toBe("quarter,margin\nQ3,12%\n")
      expect(inParent(".sixb/agent/children/acme-review/logo.png")).toBeUndefined()
      expect(inParent(".sixb/agent/children/acme-review/draft.md")).toBeUndefined()

      // This turn, the result names where each file is; it holds the files themselves.
      const waited = JSON.stringify(parentCalls[3]?.messages)
      for (const path of ["brief.txt", "margins.png", "tables/margins.csv"]) {
        const sandboxPath = join(".sixb/agent/children/acme-review", path)
        expect(waited).toContain(
          JSON.stringify(`"path":"${path}","sandboxPath":"${sandboxPath}"`).slice(1, -1)
        )
      }
      const answer = (await listMessages(storage, requested.run.threadId)).find(
        (message) => message.role === "assistant"
      )
      const waitPart = answer?.parts.find(
        (part) => part.type === "tool-call" && part.toolName === "wait_agent"
      )
      if (waitPart?.type !== "tool-call" || waitPart.state !== "output-available") {
        throw new Error("Expected the wait_agent result.")
      }
      // Each file names its child and its path, so no turn pairs them by their order.
      expect(waitPart.output).toMatchObject({
        kind: "agentToolResult",
        content: [
          { type: "text" },
          ...(child.result?.files ?? []).map(({ path, fileRef }) => ({
            type: "file",
            fileRef: {
              ...fileRef,
              fileName: `acme-review-${path.replaceAll("/", "-")}`,
              logicalPath: `acme-review/${path}`,
            },
          })),
        ],
      })

      // A later turn finds them in $SIXB_ATTACHMENTS, as files of that result.
      const next = await requestAgent(sixb, {
        threadId: requested.run.threadId,
        text: "Show the chart.",
      })
      await underFakeTime(() => terminalRun(storage, next.run.id), "next turn terminal")
      const nextSandbox = sandboxes.sandboxes.at(-1)
      if (!nextSandbox || nextSandbox === childSandbox) throw new Error("Expected a new sandbox.")
      const attachments = JSON.parse(
        new TextDecoder().decode(
          nextSandbox.files.get(
            join(nextSandbox.workingDirectory, ".sixb/agent/context/attachments.json")
          )
        )
      ) as {
        readonly attachments: readonly {
          readonly fileName: string
          readonly logicalPath?: string
          readonly sandboxPath: string
        }[]
      }
      const chart = attachments.attachments.find(
        (entry) => entry.logicalPath === "acme-review/margins.png"
      )
      expect(chart?.fileName).toBe("acme-review-margins.png")
      expect(chart?.sandboxPath).toStartWith(".sixb/agent/attachments/")
      expect(
        nextSandbox.files.get(join(nextSandbox.workingDirectory, chart?.sandboxPath ?? ""))
      ).toEqual(TEST_PNG_BYTES)
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test.each([
    ["a missing file", "reports/missing.csv", "'reports/missing.csv': it does not exist"],
    [
      "the run's own context through a link",
      "ctx/run.json",
      "'ctx/run.json': it is part of the run context Sixb installs under .sixb/agent.",
    ],
    [
      "a path outside the sandbox",
      "../elsewhere/acme.csv",
      "'../elsewhere/acme.csv': path must stay inside the sandbox working directory",
    ],
    [
      "the run's own context",
      ".sixb/agent/context/run.json",
      "'.sixb/agent/context/run.json': it is part of the run context Sixb installs under .sixb/agent.",
    ],
    ["too many files", "reports/daily", "51 files; a child receives at most 50."],
    [
      "a file too large",
      "reports/scan.bin",
      "'reports/scan.bin': it holds more than 25.0MB, the most a file handed to a child may hold",
    ],
  ])("refuses to hand a child %s, saying why", async (_case, path, reason) => {
    // Removal proofs: drop assertHandable, and the parent's run context reaches the child; check
    // it on the path as written instead of where it leads, and it does through a link; drop the
    // count or size checks of listHandedSources, and the child is admitted with the files.
    let childRunId = ""
    const parentCalls: LanguageModelRequest[] = []
    const parentModel = new WorkerTestModel({
      providerId: "parent-provider",
      modelId: "parent-model",
      stream: async (options) => {
        parentCalls.push(options)
        if (parentCalls.length === 1) {
          return toolCallStream("reports", "bash", { command: "write-handoff-files" })
        }
        if (parentCalls.length === 2) {
          return toolCallStream("spawn", "spawn_agent", {
            key: "acme-review",
            task: "Review Acme.",
            files: [path],
          })
        }
        return answerStream("I could not hand the file over.")
      },
    })
    const sixb = buildSixb(parentModel, new InMemoryBroker(), new RecordingSandboxFactory())
    const storage = agentStorageOf(sixb)
    const requested = await requestAgent(sixb, { text: "Review Acme." })
    childRunId = createSubagentRunId(requested.run.id, "acme-review")
    const worker = new AgentWorker(sixb, workerOptions())

    jest.useFakeTimers()
    try {
      await worker.start()
      const parent = await underFakeTime(
        () => terminalRun(storage, requested.run.id),
        "parent refused a hand-over terminal"
      )
      expect(parent.status).toBe("succeeded")
      expect(await storage.runs.getById({ projectId: PROJECT_ID, id: childRunId })).toBeNull()
      expect(JSON.stringify(parentCalls[2]?.messages.at(-1))).toContain(
        `[SixbAgentWorker] spawn_agent cannot hand over ${reason}`
      )
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test.each([
    {
      name: "past the active-child limit",
      spawns: [[{ key: "first" }], [{ key: "second", files: ["reports/acme.csv"] }]],
      refusal: "The current Agent run already has 1 active children.",
    },
    {
      name: "again under a key in use",
      spawns: [
        [{ key: "review", files: ["reports/notes"] }],
        [{ key: "review", files: ["reports/acme.csv"] }],
      ],
      refusal: "spawn_agent key 'review' was already used with different inputs.",
    },
    {
      name: "past the limit in the same step",
      spawns: [
        [
          { key: "first", files: ["reports/notes"] },
          { key: "second", files: ["reports/acme.csv"] },
        ],
      ],
      refusal: "The current Agent run already has 1 active children.",
    },
  ])("stores nothing for a spawn refused $name", async ({ spawns, refusal }) => {
    // Removal proofs: drop admissionOf from SubagentCoordinator.spawn, and the refused spawn's file
    // is stored though no child gets it; admit outside admitInTurn, and two spawns of one step both
    // pass the check before either is admitted; read the files before admitInTurn, and the
    // refused spawn reads its file.
    const parentCalls: LanguageModelRequest[] = []
    const childModel = new WorkerTestModel({
      providerId: "child-provider",
      modelId: "blocking-child",
      stream: async (options) => untilAborted(options),
    })
    const parentModel = new WorkerTestModel({
      providerId: "parent-provider",
      modelId: "parent-model",
      stream: async (options) => {
        parentCalls.push(options)
        if (parentCalls.length === 1) {
          return toolCallStream("reports", "bash", { command: "write-handoff-files" })
        }
        const step = spawns[parentCalls.length - 2]
        if (!step) return answerStream("Done.")
        return stream([
          { type: "stream-start", warnings: [] },
          ...step.map((spawn, index) => ({
            type: "tool-call" as const,
            toolCallId: `spawn-${parentCalls.length}-${index}`,
            toolName: "spawn_agent",
            input: JSON.stringify({
              ...spawn,
              task: "Review Acme.",
              model: { provider: childModel.providerId, modelId: childModel.modelId },
            }),
          })),
          finish("tool-calls"),
        ])
      },
    })
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(parentModel, new InMemoryBroker(), sandboxes, {
      models: { language: [parentModel, childModel] },
    })
    const storage = agentStorageOf(sixb)
    const requested = await requestAgent(sixb, { text: "Review Acme." })
    const worker = new AgentWorker(
      sixb,
      workerOptions({ subagentConcurrencyPerRun: 1, defaultMaxSteps: 6 })
    )

    jest.useFakeTimers()
    try {
      await worker.start()
      await underFakeTime(
        () => terminalRun(storage, requested.run.id),
        "parent of a refused spawn terminal"
      )

      const tool = JSON.stringify(parentCalls.at(-1)?.messages)
      expect(tool).toContain(JSON.stringify(refusal).slice(1, -1))
      const { runs } = await storage.runs.list({
        projectId: PROJECT_ID,
        kinds: ["subagent"],
        parentRunId: requested.run.id,
      })
      expect(runs).toHaveLength(1)

      // Only the admitted child's file is stored: each spawn here hands over a file of its own.
      const handed = new Set(
        runs
          .flatMap((run) => (run.kind === "subagent" ? run.spec.files : []) ?? [])
          .map((file) => file?.fileRef.blobId)
      )
      for (const contents of [ACME_CSV, "# Acme\n\nMargins fell.\n"]) {
        const blobId = `blob_${new Bun.CryptoHasher("sha256").update(contents).digest("hex")}`
        expect(Boolean(await sixb.blobStorage.stat(blobId))).toBe(handed.has(blobId))
      }
      // And no file was read but the admitted child's.
      const read = (sandboxes.sandboxes[0]?.commands ?? []).flatMap(({ options }) => {
        const encoded = options.env?.SIXB_READ_PATH_B64
        return encoded ? [Buffer.from(encoded, "base64").toString("utf-8")] : []
      })
      const admitted = new Set(
        runs
          .flatMap((run) => (run.kind === "subagent" ? (run.spec.files ?? []) : []))
          .map((file) => file.path)
      )
      for (const path of ["reports/acme.csv", "reports/notes/summary.md"]) {
        expect(read.some((readPath) => readPath.endsWith(path))).toBe(admitted.has(path))
      }
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  /** A parent's files as its environment gives them to its tools, in a sandbox the test fills. */
  function recordingRunFiles(
    sixb: TestSixb,
    options: {
      readonly budget?: AgentFileBudget
      readonly installArtifactsFrom?: AgentRunFiles["installArtifactsFrom"]
    } = {}
  ) {
    const sandbox = new RecordingSandbox("run-files")
    const runFiles: AgentRunFiles = {
      sandbox: async () => ({ sandbox }),
      blobStorage: sixb.blobStorage,
      budget: options.budget ?? new AgentFileBudget(),
      installArtifactsFrom: options.installArtifactsFrom ?? (async () => {}),
    }
    return { sandbox, runFiles }
  }

  test("wait_agent holds each child's files once, a result's worth, and says what it could not", async () => {
    // Removal proofs: attach a child's installed files on every wait in deliverFiles, and the
    // second result holds a's chart again; drop its `fits` check, and d's 30 files join b's 30;
    // drop its catch, and c's missing blob costs every answer; warn instead of reporting the
    // artifact failure, and the result does not say it.
    const sixb = buildSixb(answerModel())
    const storage = agentStorageOf(sixb)
    const { children: spawned, coordinator } = await spawnChildOfRunningTurn(
      sixb,
      { text: "Report on each region." },
      { keys: ["a", "b", "c", "d"] }
    )
    const put = (fileName: string, text: string) =>
      sixb.blobStorage.put({
        body: new TextEncoder().encode(text),
        fileName,
        mediaType: "text/csv",
      })
    const days = (region: string) =>
      Promise.all(
        Array.from({ length: 30 }, async (_, day) => ({
          path: `days/${day}.csv`,
          fileRef: await put(`${day}.csv`, `${region},${day}\n`),
        }))
      )
    const gone = "c".repeat(64)
    const outputs = [
      [{ path: "chart.csv", fileRef: await put("chart.csv", "a,1\n") }],
      await days("b"),
      [
        {
          path: "gone.csv",
          fileRef: { blobId: `blob_${gone}`, digest: `sha256:${gone}` as const, sizeBytes: 4 },
        },
      ],
      await days("d"),
    ]
    const runIds = []
    for (const [index, child] of spawned.entries()) {
      const execution = freshTestExecution()
      await storage.runs.start({ projectId: PROJECT_ID, id: child.runId, execution })
      await storage.runs.finish({
        projectId: PROJECT_ID,
        id: child.runId,
        executionToken: execution.token,
        status: "succeeded",
        result: { text: `Region ${index}.`, files: outputs[index] ?? [] },
      })
      runIds.push(child.runId)
    }
    const [a, b, c, d] = runIds as [string, string, string, string]
    const { runFiles } = recordingRunFiles(sixb, {
      installArtifactsFrom: async () => {
        throw new Error("[SixbAgentWorker] Could not install artifacts art_q3.")
      },
    })
    coordinator.attach(runFiles)
    const signal = new AbortController().signal

    const first = await coordinator.wait({ runIds: [a] }, signal)
    expect(first.files.map((file) => file.fileRef.logicalPath)).toEqual(["a/chart.csv"])

    const second = await coordinator.wait({ runIds: [a, b, c, d] }, signal)
    expect(second.results.map((result) => result.text)).toEqual([
      "Region 0.",
      "Region 1.",
      "Region 2.",
      "Region 3.",
    ])
    expect(second.results[0]?.files).toEqual([
      {
        path: "chart.csv",
        sandboxPath: ".sixb/agent/children/a/chart.csv",
        sizeBytes: 4,
        mediaType: "text/csv",
      },
    ])
    expect(second.files.map((file) => file.fileRef.logicalPath)).toEqual(
      outputs[1]?.map((file) => `b/${file.path}`)
    )
    expect(second.results[2]?.filesNote).toStartWith(
      "Its files could not be copied into your sandbox ("
    )
    expect(second.results[3]?.filesNote).toBe(
      "Its 30 files did not fit in this result, which holds at most 50 files, 100.0MB in all. Wait for this child again to get them."
    )
    expect(second.artifactsError).toBe(
      "What these children published could not all be installed in $SIXB_ARTIFACTS (Could not install artifacts art_q3.). The addresses in their answers still work."
    )

    const third = await coordinator.wait({ runIds: [d] }, signal)
    expect(third.files).toHaveLength(30)
  })

  test("a spawn after its turn ended is refused before its files are read", async () => {
    // Removal proof: drop the parent's status check from admissionOf; the files are stored and
    // only the storage transaction refuses the child.
    const sixb = buildSixb(answerModel())
    const storage = agentStorageOf(sixb)
    const { parent, coordinator } = await spawnChildOfRunningTurn(
      sixb,
      { text: "Review Acme." },
      { keys: [] }
    )
    const { sandbox, runFiles } = recordingRunFiles(sixb)
    sandbox.writeWorkingFile("reports/acme.csv", ACME_CSV)
    coordinator.attach(runFiles)
    await storage.runs.finish({
      projectId: PROJECT_ID,
      id: parent.id,
      executionToken: parent.execution?.token ?? "",
      status: "succeeded",
    })

    const refused = await coordinator
      .spawn(
        { key: "late", task: "Review Acme.", files: ["reports/acme.csv"] },
        new AbortController().signal
      )
      .catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(AgentToolPublicError)
    expect((refused as Error).message).toContain("The parent Agent run is no longer active.")
    const blobId = `blob_${new Bun.CryptoHasher("sha256").update(ACME_CSV).digest("hex")}`
    expect(await sixb.blobStorage.stat(blobId)).toBeNull()
  })

  test("a child's out/ has a budget of its own, apart from what it published", async () => {
    // Removal proof: reserve from the run's budget in storeChildOutputs; the run's budget, spent
    // by a publish, refuses the child's answer file.
    const sixb = buildSixb(answerModel())
    const { sandbox, runFiles } = recordingRunFiles(sixb, { budget: new AgentFileBudget(4) })
    sandbox.writeWorkingFile("out/answer.md", "The full answer.\n")

    const stored = await storeChildOutputs({
      files: runFiles,
      handed: [],
      signal: new AbortController().signal,
    })

    expect(stored.files.map((file) => file.path)).toEqual(["answer.md"])
    expect(stored).not.toHaveProperty("error")
  })

  test("installs an artifact a waited child published, whoever published its latest version", async () => {
    // Removal proof: look only at the latest version's origin in installArtifactsPublishedBy; the
    // artifact the child made is not installed once someone else revised it.
    const sixb = buildSixb(answerModel())
    const sandbox = new RecordingSandbox("artifacts")
    const bytes = new TextEncoder().encode(Q3_REVIEW_MARKDOWN)
    const fileRef = await sixb.blobStorage.put({ body: bytes, fileName: "document.md" })
    const version = (number: number, runId: string) =>
      ({
        artifactId: "art_q3",
        version: number,
        title: "Q3 review",
        files: [{ path: "document.md", file: fileRef }],
        entry: "document.md",
        outline: { kind: "document", headings: [] },
        origin: { threadId: "thread", runId },
      }) as unknown as ArtifactVersionRecord
    const artifact = {
      id: "art_q3",
      kind: "document",
      latestVersion: 2,
    } as unknown as ArtifactRecord
    const installed = new InstalledArtifacts(
      {
        directory: ".sixb/agent/artifacts",
        manifestPath: ".sixb/agent/context/artifacts.json",
        maxBytes: 1_000_000,
      },
      [],
      new Map(),
      []
    )

    await installArtifactsPublishedBy({
      installed,
      threadId: "thread",
      artifacts: {
        list: async () => ({ artifacts: [artifact], hasMore: false, total: 1 }),
        listVersions: async () => ({
          versions: [version(2, "someone-else"), version(1, "child-run")],
          hasMore: false,
          total: 2,
        }),
        getVersion: async () => version(2, "someone-else"),
      } as never,
      blobStorage: sixb.blobStorage,
      sandbox,
      runIds: ["child-run"],
      signal: new AbortController().signal,
    })

    expect(installed.versionOf("art_q3")).toBe(2)
    expect(
      sandbox.files.get(join(sandbox.workingDirectory, ".sixb/agent/artifacts/art_q3/document.md"))
    ).toEqual(bytes)
  })

  test("a child whose out/ holds more than comes back answers, and says why no file did", async () => {
    // Removal proofs: drop the count check from storeChildOutputs, and the child returns 51
    // files; throw for it as before, and the child fails and its answer is lost.
    let childRunId = ""
    const parentCalls: LanguageModelRequest[] = []
    let childCall = 0
    const childModel = new WorkerTestModel({
      providerId: "child-provider",
      modelId: "child-model",
      stream: async () => {
        childCall += 1
        if (childCall === 1) {
          return toolCallStream("daily", "bash", { command: "write-many-outputs" })
        }
        return answerStream("The daily tables are in out/daily.")
      },
    })
    const parentModel = delegatingParentModel({
      childRunId: () => childRunId,
      childModel: { provider: childModel.providerId, modelId: childModel.modelId },
      onCall: (options) => parentCalls.push(options),
    })
    const sixb = buildSixb(parentModel, new InMemoryBroker(), new RecordingSandboxFactory(), {
      models: { language: [parentModel, childModel] },
    })
    const storage = agentStorageOf(sixb)
    const requested = await requestAgent(sixb, { text: "Tabulate each day." })
    childRunId = createSubagentRunId(requested.run.id, "research")
    const worker = new AgentWorker(sixb, workerOptions())

    jest.useFakeTimers()
    try {
      await worker.start()
      await underFakeTime(
        () => terminalRun(storage, requested.run.id),
        "parent of a child with too many files terminal"
      )
      const filesError =
        "It left more than 50 files in out/, so none of its files came back: at most 50 files of 25.0MB, 100.0MB in all, do. To get them, spawn it again with a task that writes fewer or smaller files to out/, or that publishes them."
      const child = await terminalRun(storage, childRunId)
      expect(child).toMatchObject({
        status: "succeeded",
        result: { text: "The daily tables are in out/daily.", filesError },
      })
      expect(child?.kind === "subagent" ? child.result : null).not.toHaveProperty("files")
      expect(JSON.stringify(parentCalls[2]?.messages)).toContain(
        JSON.stringify(`"filesNote":"${filesError}"`).slice(1, -1)
      )
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test("a child that does not finish returns no files", async () => {
    // Removal proof: store the outputs in runSubagent before its output-limit check, and the chart
    // of a child that failed is stored, though its parent never gets it.
    let childRunId = ""
    const parentCalls: LanguageModelRequest[] = []
    let childCall = 0
    const childModel = new WorkerTestModel({
      providerId: "child-provider",
      modelId: "child-model",
      stream: async () => {
        childCall += 1
        if (childCall === 1) {
          return toolCallStream("chart", "bash", { command: "write-child-outputs" })
        }
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "child-answer" },
          { type: "text-delta", id: "child-answer", delta: "The chart is in" },
          { type: "text-end", id: "child-answer" },
          finish("length"),
        ])
      },
    })
    const parentModel = delegatingParentModel({
      childRunId: () => childRunId,
      childModel: { provider: childModel.providerId, modelId: childModel.modelId },
      onCall: (options) => parentCalls.push(options),
    })
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(parentModel, new InMemoryBroker(), sandboxes, {
      models: { language: [parentModel, childModel] },
    })
    attachSixbErrorReporter(sixb, () => {})
    const storage = agentStorageOf(sixb)
    const requested = await requestAgent(sixb, { text: "Chart Acme's margins." })
    childRunId = createSubagentRunId(requested.run.id, "research")
    const worker = new AgentWorker(sixb, workerOptions())

    jest.useFakeTimers()
    try {
      await worker.start()
      const parent = await underFakeTime(
        () => terminalRun(storage, requested.run.id),
        "parent of a child cut short terminal"
      )
      expect(parent.status).toBe("succeeded")
      expect(await terminalRun(storage, childRunId)).toMatchObject({ status: "failed" })

      const chartBlob = `blob_${new Bun.CryptoHasher("sha256").update(TEST_PNG_BYTES).digest("hex")}`
      expect(await sixb.blobStorage.stat(chartBlob)).toBeNull()
      const parentSandbox = sandboxes.sandboxes[0]
      expect(
        [...(parentSandbox?.files.keys() ?? [])].filter((path) =>
          path.includes(".sixb/agent/children")
        )
      ).toEqual([])
      const waited = JSON.stringify(
        parentCalls[2]?.messages.filter((message) => message.role === "tool").at(-1)
      )
      expect(waited).toContain("reached its output limit")
      expect(waited).not.toContain("children")
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test.each([
    "cancelled",
    "timed out",
  ] as const)("stops a running child when its parent is %s", async (ending) => {
    // Removal proof: the turn records its own cancel or timeout, then cancels its children. Drop
    // that cancelActiveSubagents call in AgentWorker.execute and either the child's watch on its
    // parent's cancel (cancelled) or its inherited deadline (timed out): the child runs on.
    let childStarted = false
    const childModel = new WorkerTestModel({
      providerId: "child-provider",
      modelId: "blocking-child",
      stream: async (options) => {
        childStarted = true
        return untilAborted(options)
      },
    })
    let childRunId = ""
    let parentCall = 0
    // The parent works a while before it delegates, so the child's own budget would outlive it.
    let delegate!: () => void
    const delegating = new Promise<void>((resolve) => {
      delegate = resolve
    })
    const parentModel = new WorkerTestModel({
      providerId: "parent-provider",
      modelId: "waiting-parent",
      stream: async (options) => {
        parentCall += 1
        if (parentCall === 1) {
          await delegating
          return toolCallStream("spawn", "spawn_agent", {
            key: "background-work",
            task: "Keep researching until stopped.",
            model: { provider: childModel.providerId, modelId: childModel.modelId },
          })
        }
        if (parentCall === 2) {
          return toolCallStream("wait", "wait_agent", { runIds: [childRunId] })
        }
        // Told the child is still at work, the parent works on until its turn ends.
        return untilAborted(options)
      },
    })
    const sixb = buildSixb(parentModel, new InMemoryBroker(), new RecordingSandboxFactory(), {
      models: { language: [parentModel, childModel] },
    })
    const storage = agentStorageOf(sixb)
    const requested = await requestAgent(sixb, { text: "Research in the background." })
    childRunId = createSubagentRunId(requested.run.id, "background-work")
    const worker = new AgentWorker(sixb, workerOptions({ turnTimeoutMs: 90_000 }))

    jest.useFakeTimers()
    try {
      await worker.start()
      await underFakeTime(() => parentCall === 1, "parent model started", 0)
      jest.advanceTimersByTime(5_000)
      delegate()
      await underFakeTime(() => childStarted, "child model started")
      if (ending === "cancelled") {
        await publishAgentRunCancel(sixb.broker, { projectId: PROJECT_ID, runId: requested.run.id })
      }
      const [parent, child] = await underFakeTime(
        async () => {
          const runs = await Promise.all([
            terminalRun(storage, requested.run.id),
            terminalRun(storage, childRunId),
          ])
          return runs.every(Boolean) ? runs : null
        },
        `parent ${ending} and child stopped`,
        100
      )

      expect(parent).toMatchObject(
        ending === "cancelled"
          ? { status: "cancelled" }
          : { status: "failed", finishReason: "timeout" }
      )
      expect(child?.status).not.toBe("succeeded")
      // It stops with its parent, not at the next repair pass.
      expect(
        (child?.completedAt?.getTime() ?? 0) - (parent?.completedAt?.getTime() ?? 0)
      ).toBeLessThan(1_000)
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test("wait_agent returns before its turn's deadline, with the children still at work", async () => {
    // Removal proof: drop the deadline from SubagentCoordinator.wait; it waits until the turn
    // times out, and the parent never answers.
    let childRunId = ""
    const parentCalls: { readonly at: number; readonly request: LanguageModelRequest }[] = []
    const childModel = new WorkerTestModel({
      providerId: "child-provider",
      modelId: "blocking-child",
      stream: async (options) => untilAborted(options),
    })
    const parentModel = new WorkerTestModel({
      providerId: "parent-provider",
      modelId: "waiting-parent",
      stream: async (options) => {
        parentCalls.push({ at: Date.now(), request: options })
        if (parentCalls.length === 1) {
          return toolCallStream("spawn", "spawn_agent", {
            key: "slow",
            task: "Research slowly.",
            model: { provider: childModel.providerId, modelId: childModel.modelId },
          })
        }
        if (parentCalls.length === 2) {
          return toolCallStream("wait", "wait_agent", { runIds: [childRunId] })
        }
        return answerStream("Here is what I have so far.")
      },
    })
    const sixb = buildSixb(parentModel, new InMemoryBroker(), new RecordingSandboxFactory(), {
      models: { language: [parentModel, childModel] },
    })
    const storage = agentStorageOf(sixb)
    const requested = await requestAgent(sixb, { text: "Research slowly." })
    childRunId = createSubagentRunId(requested.run.id, "slow")
    const turnTimeoutMs = 2 * WAIT_ANSWER_MARGIN_MS
    const worker = new AgentWorker(sixb, workerOptions({ turnTimeoutMs }))

    jest.useFakeTimers()
    try {
      await worker.start()
      const parent = await underFakeTime(
        () => terminalRun(storage, requested.run.id),
        "parent answering without its child",
        100
      )

      expect(parent.status).toBe("succeeded")
      const answeredAt = parentCalls[2]?.at ?? Number.POSITIVE_INFINITY
      const deadline = (parent.startedAt?.getTime() ?? 0) + turnTimeoutMs
      expect(answeredAt).toBeGreaterThanOrEqual(deadline - WAIT_ANSWER_MARGIN_MS)
      expect(answeredAt).toBeLessThan(deadline - WAIT_ANSWER_MARGIN_MS + 1_000)
      expect(JSON.stringify(parentCalls[2]?.request.messages.at(-1))).toContain(
        JSON.stringify(`"results":[{"runId":"${childRunId}","status":"running"}]`).slice(1, -1)
      )
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test("a child's wait in the queue counts against its parent's deadline", async () => {
    // Removal proof: create the child's runtime without `deadline` in executeSubagent; it gets the
    // worker's ten minutes from its start and outlives its parent.
    const model = new WorkerTestModel({
      modelId: "blocking-child",
      stream: async (options) => ({
        stream: new ReadableStream<WorkerTestStreamEvent>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            const abort = () => controller.error(new DOMException("Aborted", "AbortError"))
            if (options.signal?.aborted) abort()
            else options.signal?.addEventListener("abort", abort, { once: true })
          },
        }),
      }),
    })
    const sixb = buildSixb(model)
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions())

    jest.useFakeTimers()
    try {
      const deadline = new Date(Date.now() + 5_000)
      const {
        children: [spawned],
      } = await spawnChildOfRunningTurn(sixb, { text: "Delegate." }, { deadline })
      if (!spawned) throw new Error("Expected the child.")
      expect(
        await storage.runs.getById({ projectId: PROJECT_ID, id: spawned.runId })
      ).toMatchObject({ spec: { deadline: deadline.toISOString() } })

      // The child waits in the queue for 3 of its parent's 5 seconds.
      jest.advanceTimersByTime(3_000)
      await worker.start()
      const child = await underFakeTime(
        () => terminalRun(storage, spawned.runId),
        "child at its parent's deadline"
      )

      expect(child).toMatchObject({ status: "failed", finishReason: "timeout" })
      expect(child.completedAt?.getTime()).toBeGreaterThanOrEqual(deadline.getTime())
      expect(child.completedAt?.getTime()).toBeLessThan(deadline.getTime() + 1_000)
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test("lets one turn keep as many children at work as the worker's per-run limit allows", async () => {
    // Removal proof: pass a fixed 4 as maxActiveChildren in SubagentCoordinator.spawn again; the
    // second child is admitted.
    const childModel = new WorkerTestModel({
      providerId: "child-provider",
      modelId: "blocking-child",
      stream: async (options) => untilAborted(options),
    })
    const parentCalls: LanguageModelRequest[] = []
    const spawn = (key: string) => ({
      type: "tool-call" as const,
      toolCallId: `spawn-${key}`,
      toolName: "spawn_agent",
      input: JSON.stringify({
        key,
        task: `Research ${key}.`,
        model: { provider: childModel.providerId, modelId: childModel.modelId },
      }),
    })
    const parentModel = new WorkerTestModel({
      providerId: "parent-provider",
      modelId: "parent-model",
      stream: async (options) => {
        parentCalls.push(options)
        return parentCalls.length === 1
          ? stream([
              { type: "stream-start", warnings: [] },
              spawn("first"),
              spawn("second"),
              finish("tool-calls"),
            ])
          : answerStream("Started one.")
      },
    })
    const sixb = buildSixb(parentModel, new InMemoryBroker(), new RecordingSandboxFactory(), {
      models: { language: [parentModel, childModel] },
    })
    const requested = await requestAgent(sixb, { text: "Research twice." })
    const worker = new AgentWorker(sixb, workerOptions({ subagentConcurrencyPerRun: 1 }))
    await worker.start()
    try {
      const parent = await waitForTerminalRun(agentStorageOf(sixb), requested.run.id)

      expect(parent.status).toBe("succeeded")
      expect(JSON.stringify(parentCalls[1]?.messages)).toContain(
        "The current Agent run already has 1 active children."
      )
    } finally {
      await worker.stop()
    }
  })

  test("rejects a child limit that is not a positive integer", () => {
    const sixb = buildSixb(answerModel())

    for (const value of [0, -1, 1.5]) {
      expect(
        () => new AgentWorker(sixb, workerOptions({ subagentConcurrencyPerRun: value }))
      ).toThrow("Agent worker option subagentConcurrencyPerRun must be a positive integer.")
      expect(() => new AgentWorker(sixb, workerOptions({ subagentConcurrency: value }))).toThrow()
    }
  })

  test("runs as many children at once as the worker's subagent concurrency allows", async () => {
    // Removal proof: give the child lane a claim limit of 4 again; the other child starts while
    // the held one is still running.
    let releaseHeld!: () => void
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve
    })
    let heldTask: string | undefined
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async (options) => {
        const task = JSON.stringify(options.messages.at(-1))
        if (heldTask === undefined) {
          heldTask = task
          await held
        }
        return answerStream("Done.")
      },
    })
    const sixb = buildSixb(model)
    const storage = agentStorageOf(sixb)
    const { children } = await spawnChildOfRunningTurn(
      sixb,
      { text: "Delegate twice." },
      { keys: ["first", "second"] }
    )
    const worker = new AgentWorker(sixb, workerOptions({ subagentConcurrency: 1 }))
    await worker.start()
    try {
      await waitFor(() => heldTask !== undefined, { label: "a child model call" })
      releaseHeld()
      const runs = await Promise.all(
        children.map((child) => waitForTerminalRun(storage, child.runId))
      )
      expect(runs.map((run) => run.status)).toEqual(["succeeded", "succeeded"])

      const heldKey = heldTask?.includes("Research first.") ? "first" : "second"
      const heldRun = runs.find((run) => run.kind === "subagent" && run.spawnKey === heldKey)
      const otherRun = runs.find((run) => run !== heldRun)
      expect(otherRun?.startedAt?.getTime()).toBeGreaterThanOrEqual(
        heldRun?.completedAt?.getTime() ?? Number.POSITIVE_INFINITY
      )
    } finally {
      releaseHeld()
      await worker.stop()
    }
  })

  test("tells the parent which of a child's calls wait for the user's approval", async () => {
    // Removal proof: leave `awaitingApproval` out of waitedResult; the parent reads a finished child
    // and never learns its call is held on the turn.
    const sixb = buildSixb(answerModel())
    const storage = agentStorageOf(sixb)
    const {
      children: [spawned],
      coordinator,
    } = await spawnChildOfRunningTurn(sixb, { text: "Close the month.", approvalMode: "manual" })
    if (!spawned) throw new Error("Expected the child.")
    const execution = freshTestExecution()
    const child = await storage.runs.start({ projectId: PROJECT_ID, id: spawned.runId, execution })
    const hold = await holdAgentApprovalCall(storage, {
      projectId: PROJECT_ID,
      run: child,
      call: { kind: "workflow", workflowId: "close-month", input: {}, workflowRunId: "run_close" },
    })
    if (hold.kind !== "held") throw new Error("Expected the call to be held.")
    await storage.runs.finish({
      projectId: PROJECT_ID,
      id: child.id,
      executionToken: execution.token,
      status: "succeeded",
      result: { text: "Closing the month awaits the user's approval." },
    })

    const { results } = await coordinator.wait({ runIds: [child.id] }, new AbortController().signal)

    expect(results).toEqual([
      {
        runId: child.id,
        status: "succeeded",
        text: "Closing the month awaits the user's approval.",
        awaitingApproval: [
          { approvalId: hold.approval.id, call: { kind: "workflow", workflowId: "close-month" } },
        ],
      },
    ])
  })

  test("pauses a turn on a child's held call only once the child has ended", async () => {
    // Removal proof: pause on `approvals.holdsRun` alone in run-agent-turn's holdsApproval; the turn
    // pauses after the step that follows the child's held call, and that cancels the child.
    let childRunId = ""
    let releaseChild!: () => void
    const childReleased = new Promise<void>((resolve) => {
      releaseChild = resolve
    })
    let markHeld!: () => void
    const childHeld = new Promise<void>((resolve) => {
      markHeld = resolve
    })
    const host: { sixb?: TestSixb } = {}
    const childModel = new WorkerTestModel({
      providerId: "child-provider",
      modelId: "holding-child",
      stream: async () => {
        // What the gateway does when the child asks to start a workflow its mode does not run.
        if (!host.sixb) throw new Error("Expected the host.")
        const storage = agentStorageOf(host.sixb)
        const child = await storage.runs.getById({ projectId: PROJECT_ID, id: childRunId })
        if (!child) throw new Error("Expected the running child.")
        await holdAgentApprovalCall(storage, {
          projectId: PROJECT_ID,
          run: child,
          call: {
            kind: "workflow",
            workflowId: "close-month",
            input: {},
            workflowRunId: "run_close",
          },
        })
        markHeld()
        await childReleased
        return answerStream("Closing the month awaits the user's approval.")
      },
    })
    const spawnChild = {
      key: "close",
      task: "Close the month.",
      model: { provider: childModel.providerId, modelId: childModel.modelId },
    }
    let parentCall = 0
    const parentModel = new WorkerTestModel({
      providerId: "parent-provider",
      modelId: "parent-model",
      stream: async () => {
        parentCall += 1
        if (parentCall === 1) return toolCallStream("spawn", "spawn_agent", spawnChild)
        // A step taken while the child, still at work, holds its call.
        if (parentCall === 2) {
          await childHeld
          return toolCallStream("spawn-again", "spawn_agent", spawnChild)
        }
        if (parentCall === 3) {
          releaseChild()
          return toolCallStream("wait", "wait_agent", { runIds: [childRunId] })
        }
        return answerStream("The month closes once you approve it.")
      },
    })
    const sixb = buildSixb(parentModel, new InMemoryBroker(), new RecordingSandboxFactory(), {
      models: { language: [parentModel, childModel] },
    })
    host.sixb = sixb
    const storage = agentStorageOf(sixb)
    const requested = await requestAgent(sixb, { text: "Close the month.", approvalMode: "manual" })
    childRunId = createSubagentRunId(requested.run.id, "close")
    const worker = new AgentWorker(sixb, workerOptions())

    jest.useFakeTimers()
    try {
      await worker.start()
      const parent = await underFakeTime(
        () => terminalRun(storage, requested.run.id),
        "parent paused on its child's held call"
      )
      const child = await storage.runs.getById({ projectId: PROJECT_ID, id: childRunId })

      expect(child?.status).toBe("succeeded")
      expect(parent).toMatchObject({ status: "succeeded", finishReason: "awaiting_approval" })
      // It paused after the step whose wait_agent saw the child end, not before.
      expect(parentCall).toBe(3)
      // Spawning it again with its key wrote no second task into its thread.
      const childMessages = await listMessages(
        storage,
        createSubagentThreadId(requested.run.id, "close")
      )
      expect(childMessages.map((message) => message.role)).toEqual(["user", "assistant"])
    } finally {
      releaseChild()
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test("ends a child found running on redelivery as interrupted, once its lease lapses", async () => {
    // Removal proof: drop the `running` branch in executeSubagent, and the redelivery replays the
    // child: its model runs again. Drop its lease check, and it ends before its owner's lease does.
    const model = answerModel()
    const sixb = buildSixb(model)
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions())
    const modelCalls = spyOn(model, "stream")

    jest.useFakeTimers()
    try {
      const {
        children: [spawned],
      } = await spawnChildOfRunningTurn(sixb, { text: "Delegate." })
      if (!spawned) throw new Error("Expected the child.")
      // A delivery started the child, then died: its job comes back while its lease may still run.
      const leaseExpiresAt = new Date(Date.now() + 30_000)
      await storage.runs.start({
        projectId: PROJECT_ID,
        id: spawned.runId,
        execution: { token: createAgentRunExecutionToken(), queueLeaseExpiresAt: leaseExpiresAt },
      })

      await worker.start()
      const child = await underFakeTime(
        () => terminalRun(storage, spawned.runId),
        "redelivered child terminal"
      )

      expect(child).toMatchObject({
        status: "cancelled",
        finishReason: "interrupted",
        attempt: 2,
        error: {
          message: expect.stringContaining(
            "Spawn it again with a new key if its answer is still needed"
          ),
        },
      })
      expect(child.completedAt?.getTime()).toBeGreaterThanOrEqual(leaseExpiresAt.getTime())
      expect(modelCalls).not.toHaveBeenCalled()
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
      modelCalls.mockRestore()
    }
  })

  // A child whose inherited session was revoked fails before its model. A delivery that took the
  // child over during that check keeps it: the failing delivery writes nothing with a stale token.
  test.each([
    false,
    true,
  ])("fences a revoked child's delivery (concurrent takeover: %s)", async (takeover) => {
    const model = answerModel()
    const sixb = buildSixb(model)
    attachSixbErrorReporter(sixb, () => {})
    const storage = agentStorageOf(sixb)
    const auth = authStorageOf(sixb)
    const requested = await requestAgentAs(sixb, REQUESTER, { text: "Delegate a task." })
    // The parent is already running elsewhere; only the child's queue delivery runs in this test.
    const [parentJob] = await sixb.queues.agents.claim({
      projectId: PROJECT_ID,
      workerId: "parent",
    })
    if (!parentJob) throw new Error("Expected the parent job")
    await sixb.queues.agents.complete({
      projectId: PROJECT_ID,
      jobId: parentJob.job.id,
      leaseId: parentJob.leaseId,
    })
    const parent = requireConversationRun(
      await storage.runs.start({
        projectId: PROJECT_ID,
        id: requested.run.id,
        execution: freshTestExecution(),
      })
    )
    const execution = await sixb.storage.executions.getById({
      projectId: PROJECT_ID,
      id: parent.executionId,
    })
    if (
      !execution ||
      execution.authorizationRef.type !== "principal" ||
      execution.authorizationRef.credential?.type !== "session"
    )
      throw new Error("Expected inherited session")
    const coordinator = new SubagentCoordinator(
      sixb,
      await buildAgentWorkerContext(sixb),
      parent,
      execution,
      new Date(Date.now() + 60_000)
    )
    const child = await coordinator.spawn(
      { key: "review", task: "Review the result." },
      new AbortController().signal
    )
    await auth.sessions.revoke({
      projectId: PROJECT_ID,
      id: execution.authorizationRef.credential.id,
      revokedAt: new Date(),
    })
    let takeoverToken: string | undefined
    const getSession = auth.sessions.getById.bind(auth.sessions)
    const workerHost = withStorage(
      sixb,
      new Proxy(sixb.storage, {
        get: (target, property, receiver) =>
          property === "auth"
            ? {
                ...auth,
                sessions: {
                  ...auth.sessions,
                  getById: async (params: Parameters<typeof getSession>[0]) => {
                    if (takeover && !takeoverToken) {
                      const nextExecution = freshTestExecution()
                      takeoverToken = nextExecution.token
                      await storage.runs.reclaim({
                        projectId: PROJECT_ID,
                        id: child.runId,
                        execution: nextExecution,
                      })
                    }
                    return getSession(params)
                  },
                },
              }
            : Reflect.get(target, property, receiver),
      })
    )
    const modelCalls = spyOn(model, "stream")
    const worker = new AgentWorker(workerHost, workerOptions())
    const completion = observeQueueSettlement(sixb.queues.agentChildren)
    await worker.start()
    try {
      await waitFor(
        async () => {
          const run = await storage.runs.getById({ projectId: PROJECT_ID, id: child.runId })
          return takeover ? takeoverToken : run?.status === "failed"
        },
        { label: "revoked child delivery" }
      )
      await completion.wait()
      await worker.stop()
      const run = await storage.runs.getById({ projectId: PROJECT_ID, id: child.runId })
      expect(run).toMatchObject(
        takeover
          ? { status: "running", execution: { token: takeoverToken } }
          : { status: "failed", attempt: 1 }
      )
      expect(modelCalls).not.toHaveBeenCalled()
      expect(await storage.runs.getById({ projectId: PROJECT_ID, id: parent.id })).toMatchObject({
        status: "running",
      })
    } finally {
      await worker.stop()
      modelCalls.mockRestore()
      completion.restore()
    }
  })

  // Regression proof: omit wrapModel (project) or requestedBy (user); the child reaches the provider.
  test.each([
    "project",
    "user",
  ] as const)("enforces %s quotas for child model calls", async (subjectType) => {
    const model = answerModel()
    const sixb = buildSixb(model, new InMemoryBroker(), new RecordingSandboxFactory(), {
      models: { language: [model] },
    })
    const auth = authStorageOf(sixb)
    const sessionId = "session-agent"
    await auth.users.create({
      id: REQUESTER.id,
      projectId: PROJECT_ID,
      email: "requester@example.com",
    })
    await auth.sessions.create({
      id: sessionId,
      projectId: PROJECT_ID,
      userId: REQUESTER.id,
      strategyId: "test",
      tokenHash: "not-used-after-admission",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const grants = { ...emptyGrantIndex(), "run:agent": true }
    const scoped = bindRequestExecution(sixb, {
      request: new Request("https://sixb.test/api/agent-threads/thread-1/messages"),
      authorization: {
        type: "principal",
        context: {
          principal: REQUESTER,
          sessionId,
          groupIds: [],
          roleIds: [],
          grants,
        },
        credential: { type: "session", id: sessionId },
      },
    })
    const requested = await scoped.agent.runs.request({
      text: "Delegate a task.",
    })
    attachSixbErrorReporter(sixb, () => {})
    const storage = agentStorageOf(sixb)
    // The parent is already running elsewhere; only the child's queue delivery runs in this test.
    const [parentJob] = await sixb.queues.agents.claim({
      projectId: PROJECT_ID,
      workerId: "parent",
    })
    if (!parentJob) throw new Error("Expected the parent job")
    await sixb.queues.agents.complete({
      projectId: PROJECT_ID,
      jobId: parentJob.job.id,
      leaseId: parentJob.leaseId,
    })
    const parent = requireConversationRun(
      await storage.runs.start({
        projectId: PROJECT_ID,
        id: requested.run.id,
        execution: freshTestExecution(),
      })
    )
    const execution = await sixb.storage.executions.getById({
      projectId: PROJECT_ID,
      id: parent.executionId,
    })
    if (
      !execution ||
      execution.authorizationRef.type !== "principal" ||
      execution.authorizationRef.credential?.type !== "session"
    )
      throw new Error("Expected inherited session")
    const coordinator = new SubagentCoordinator(
      sixb,
      await buildAgentWorkerContext(sixb),
      parent,
      execution,
      new Date(Date.now() + 60_000)
    )
    const child = await coordinator.spawn(
      { key: "review", task: "Review the result." },
      new AbortController().signal
    )
    await sixb.storage.aiLimits!.createPolicy({
      id: "child-exhausted-quota",
      projectId: PROJECT_ID,
      subject: subjectType === "project" ? { type: "project" } : { type: "user", id: REQUESTER.id },
      limit: { meter: "tokens.total", amount: 0 },
    })
    const modelCalls = spyOn(model, "stream")
    const completion = observeQueueSettlement(sixb.queues.agentChildren)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      await completion.wait()
      const result = await storage.runs.getById({ projectId: PROJECT_ID, id: child.runId })
      expect(result).toMatchObject({
        status: "failed",
        error: { code: "ai.usage_limit_exceeded" },
      })
      expect(modelCalls).not.toHaveBeenCalled()
      expect(await storage.runs.getById({ projectId: PROJECT_ID, id: parent.id })).toMatchObject({
        status: "running",
      })
    } finally {
      await worker.stop()
      modelCalls.mockRestore()
      completion.restore()
    }
  })

  test("tells the parent a subagent's answer was cut short instead of passing it on", async () => {
    // Removal proof: drop the `finishReason === "length"` check from runSubagent; the child
    // succeeds and the parent receives "Partial" as if it were the complete answer.
    let childRunId = ""
    const parentCalls: LanguageModelRequest[] = []
    const childModel = new WorkerTestModel({
      providerId: "gateway",
      modelId: "zai/glm-5.3-flash",
      stream: async () =>
        stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "child-answer" },
          { type: "text-delta", id: "child-answer", delta: "Partial" },
          { type: "text-end", id: "child-answer" },
          finish("length"),
        ]),
    })
    const parentModel = delegatingParentModel({
      childRunId: () => childRunId,
      childModel: { provider: childModel.providerId, modelId: childModel.modelId },
      onCall: (options) => parentCalls.push(options),
    })
    const sixb = buildSixb(parentModel, new InMemoryBroker(), new RecordingSandboxFactory(), {
      models: { language: [parentModel, childModel] },
    })
    attachSixbErrorReporter(sixb, () => {})
    const storage = agentStorageOf(sixb)
    const requested = await requestAgent(sixb, { text: "Delegate this research task." })
    childRunId = createSubagentRunId(requested.run.id, "research")
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      await waitFor(
        async () =>
          (await storage.runs.getById({ projectId: PROJECT_ID, id: requested.run.id }))?.status ===
          "succeeded",
        { label: "delegating parent run terminal" }
      )
      const message =
        "Agent execution failed. The subagent's model reached its output limit before finishing its answer. Spawn it again with lower reasoning or a narrower task."
      expect(await storage.runs.getById({ projectId: PROJECT_ID, id: childRunId })).toMatchObject({
        status: "failed",
        error: { code: "agent.execution_failed", message },
      })
      const waited = JSON.stringify(parentCalls[2]?.messages.at(-1))
      expect(waited).toContain(JSON.stringify(message).slice(1, -1))
      expect(waited).not.toContain("Partial")

      // Its thread keeps what it wrote, as an interrupted turn does. Removal proof: record the
      // child's fate without its work; the thread then holds its task alone.
      const childThread = createSubagentThreadId(requested.run.id, "research")
      expect(await listMessages(storage, childThread)).toMatchObject([
        { role: "user" },
        {
          role: "assistant",
          runId: childRunId,
          parts: [{ type: "step-start" }, { text: "Partial" }],
        },
      ])
    } finally {
      await worker.stop()
    }
  })

  test("tells the parent what to do about a subagent that gave no answer", async () => {
    // Removal proof: fail an empty answer with a bare `createSixbError` again; the parent then
    // reads "Agent execution failed." and nothing it can act on.
    let childRunId = ""
    const parentCalls: LanguageModelRequest[] = []
    const childModel = new WorkerTestModel({
      providerId: "gateway",
      modelId: "zai/glm-5.3-flash",
      stream: async () => stream([{ type: "stream-start", warnings: [] }, finish("stop")]),
    })
    const parentModel = delegatingParentModel({
      childRunId: () => childRunId,
      childModel: { provider: childModel.providerId, modelId: childModel.modelId },
      onCall: (options) => parentCalls.push(options),
    })
    const sixb = buildSixb(parentModel, new InMemoryBroker(), new RecordingSandboxFactory(), {
      models: { language: [parentModel, childModel] },
    })
    attachSixbErrorReporter(sixb, () => {})
    const storage = agentStorageOf(sixb)
    const requested = await requestAgent(sixb, { text: "Delegate this research task." })
    childRunId = createSubagentRunId(requested.run.id, "research")
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      await waitForTerminalRun(storage, requested.run.id)
      const message =
        "Agent execution failed. The subagent finished without an answer. Spawn it again with a task that says what its answer must contain."
      expect(await storage.runs.getById({ projectId: PROJECT_ID, id: childRunId })).toMatchObject({
        status: "failed",
        error: { code: "agent.execution_failed", message },
      })
      expect(JSON.stringify(parentCalls[2]?.messages.at(-1))).toContain(
        JSON.stringify(message).slice(1, -1)
      )
    } finally {
      await worker.stop()
    }
  })

  test("rejects unconfigured subagent model pairs before admission with exact recovery choices", async () => {
    const invalidModels = [
      { provider: "gateway/deepseek", modelId: "deepseek-v4-flash-vision-exp" },
      { provider: "gateway", modelId: "missing-model" },
      { provider: "parent-provider", modelId: "deepseek/deepseek-v4-flash-vision-exp" },
    ]
    const childModel = new WorkerTestModel({
      providerId: "gateway",
      modelId: "deepseek/deepseek-v4-flash-vision-exp",
    })
    let call = 0
    const parentModel = new WorkerTestModel({
      providerId: "parent-provider",
      modelId: "parent-model",
      stream: async () => {
        call += 1
        if (call > 1) {
          return stream([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "Delegation failed." },
            { type: "text-end", id: "answer" },
            finish("stop"),
          ])
        }
        // Deliberately bypass the advertised schema: the runtime must still reject these pairs.
        return stream([
          { type: "stream-start", warnings: [] },
          ...invalidModels.map((model, index) => ({
            type: "tool-call" as const,
            toolCallId: `invalid-model-${index}`,
            toolName: "spawn_agent",
            input: JSON.stringify({ key: `invalid-${index}`, task: "Research a fact.", model }),
          })),
          finish("tool-calls"),
        ])
      },
    })
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(parentModel, new InMemoryBroker(), sandboxes, {
      models: { language: [parentModel, childModel] },
    })
    const storage = agentStorageOf(sixb)
    const requested = await requestAgent(sixb, { text: "Delegate this task." })
    const worker = new AgentWorker(sixb, workerOptions())

    await worker.start()
    try {
      await waitFor(
        async () => {
          const run = await storage.runs.getById({ projectId: PROJECT_ID, id: requested.run.id })
          return run?.status === "succeeded" ? run : null
        },
        { label: "parent handles rejected subagent models" }
      )
      const assistant = (await listMessages(storage, requested.run.threadId)).find(
        (message) => message.role === "assistant"
      )
      for (const [index, model] of invalidModels.entries()) {
        expect(assistant?.parts).toContainEqual(
          expect.objectContaining({
            type: "tool-call",
            toolCallId: `invalid-model-${index}`,
            state: "output-error",
            errorText: `[SixbAgentWorker] Language model ${JSON.stringify(model)} is not configured for this project. Use one of: {"provider":"parent-provider","modelId":"parent-model"}, {"provider":"gateway","modelId":"deepseek/deepseek-v4-flash-vision-exp"}. Omit model to use the project default.`,
          })
        )
        await expect(
          storage.runs.getById({
            projectId: PROJECT_ID,
            id: createSubagentRunId(requested.run.id, `invalid-${index}`),
          })
        ).resolves.toBeNull()
      }
      expect(sandboxes.sandboxes).toHaveLength(1)
    } finally {
      await worker.stop()
    }
  })

  test("cancels a running child when its parent finishes", async () => {
    let markChildStarted!: () => void
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve
    })
    const childModel = new WorkerTestModel({
      providerId: "child-provider",
      modelId: "blocking-child",
      stream: async (options) => ({
        stream: new ReadableStream<WorkerTestStreamEvent>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            markChildStarted()
            const abort = () => controller.error(new DOMException("Aborted", "AbortError"))
            if (options.signal?.aborted) abort()
            else options.signal?.addEventListener("abort", abort, { once: true })
          },
        }),
      }),
    })
    let parentCall = 0
    const parentModel = new WorkerTestModel({
      providerId: "parent-provider",
      modelId: "finishing-parent",
      stream: async () => {
        parentCall += 1
        if (parentCall === 1) {
          return stream([
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "spawn-blocking-child",
              toolName: "spawn_agent",
              input: JSON.stringify({
                key: "background-work",
                task: "Keep researching until cancelled.",
                model: { provider: childModel.providerId, modelId: childModel.modelId },
              }),
            },
            finish("tool-calls"),
          ])
        }
        await childStarted
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "parent-answer" },
          { type: "text-delta", id: "parent-answer", delta: "No longer needed" },
          { type: "text-end", id: "parent-answer" },
          finish("stop"),
        ])
      },
    })
    const sixb = buildSixb(parentModel, new InMemoryBroker(), new RecordingSandboxFactory(), {
      models: { language: [parentModel, childModel] },
    })
    const storage = agentStorageOf(sixb)
    const requested = await requestAgent(sixb, {
      text: "Start background work, then finish.",
    })
    const childRunId = createSubagentRunId(requested.run.id, "background-work")
    const worker = new AgentWorker(sixb, workerOptions({ concurrency: 1 }))

    await worker.start()
    try {
      const [parent, child] = await Promise.all([
        waitFor(
          async () => {
            const current = await storage.runs.getById({
              projectId: PROJECT_ID,
              id: requested.run.id,
            })
            return current?.status === "succeeded" ? current : null
          },
          { label: "finished parent run" }
        ),
        waitFor(
          async () => {
            const current = await storage.runs.getById({ projectId: PROJECT_ID, id: childRunId })
            return current?.status === "cancelled" ? current : null
          },
          { label: "cancelled child run" }
        ),
      ])

      expect(parent.status).toBe("succeeded")
      expect(child).toMatchObject({
        kind: "subagent",
        parentRunId: parent.id,
        status: "cancelled",
        error: { code: "runtime.cancelled" },
      })
      expect(
        (
          await storage.runs.list({
            projectId: PROJECT_ID,
            kinds: ["subagent"],
            parentRunId: parent.id,
            statuses: ["queued", "running"],
          })
        ).runs
      ).toHaveLength(0)
    } finally {
      await worker.stop()
    }
  })

  // Regression proof: resolve authority before reserving the run; a revoked run stays queued.
  test.each([
    "active",
    "revoked-before-start",
    "revoked-after-takeover",
  ] as const)("revalidates a user's session before running the project Agent: %s", async (scenario) => {
    const model = answerModel()
    const sixb = buildSixb(model, new InMemoryBroker(), new RecordingSandboxFactory(), {
      models: { language: [model] },
    })
    const auth = authStorageOf(sixb)
    const sessionId = "session-agent"
    await auth.users.create({
      id: REQUESTER.id,
      projectId: PROJECT_ID,
      email: "requester@example.com",
    })
    await auth.sessions.create({
      id: sessionId,
      projectId: PROJECT_ID,
      userId: REQUESTER.id,
      strategyId: "test",
      tokenHash: "not-used-after-admission",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const grants = { ...emptyGrantIndex(), "run:agent": true }
    const scoped = bindRequestExecution(sixb, {
      request: new Request("https://sixb.test/api/agent-threads/thread-1/messages"),
      authorization: {
        type: "principal",
        context: {
          principal: REQUESTER,
          sessionId,
          groupIds: [],
          roleIds: [],
          grants,
        },
        credential: { type: "session", id: sessionId },
      },
    })
    const requested = await scoped.agent.runs.request({ text: "hello" })
    const storage = agentStorageOf(sixb)
    const modelCalls = spyOn(model, "stream")
    const currentSession = auth.sessions.getById.bind(auth.sessions)
    let takeoverToken: string | undefined
    if (scenario !== "active") {
      await auth.sessions.revoke({ projectId: PROJECT_ID, id: sessionId, revokedAt: new Date() })
    }
    const sessionLookup: typeof currentSession = async (params) => {
      if (scenario === "revoked-after-takeover" && !takeoverToken) {
        // Another delivery takes over while this worker is still resolving the revoked session.
        const execution = freshTestExecution()
        takeoverToken = execution.token
        await storage.runs.reclaim({ projectId: PROJECT_ID, id: requested.run.id, execution })
      }
      return currentSession(params)
    }
    const workerHost = withStorage(
      sixb,
      new Proxy(sixb.storage, {
        get: (target, property, receiver) =>
          property === "auth"
            ? { ...auth, sessions: { ...auth.sessions, getById: sessionLookup } }
            : Reflect.get(target, property, receiver),
      })
    )
    const worker = new AgentWorker(workerHost, workerOptions())

    const completion = observeQueueSettlement(sixb.queues.agents)
    await worker.start()
    try {
      const run = await waitFor(
        async () => {
          const current = await agentStorageOf(sixb).runs.getById({
            projectId: PROJECT_ID,
            id: requested.run.id,
          })
          return current &&
            (scenario === "revoked-after-takeover"
              ? current.execution?.token === takeoverToken && takeoverToken !== undefined
              : current.status !== "queued" && current.status !== "running")
            ? current
            : null
        },
        { label: "authenticated conversation Agent run terminal" }
      )
      await completion.wait()
      if (scenario === "active") {
        expect(run.status).toBe("succeeded")
      } else if (scenario === "revoked-before-start") {
        expect(run).toMatchObject({ status: "failed", attempt: 1 })
        expect(run.execution).toBeUndefined()
        expect(modelCalls).not.toHaveBeenCalled()
        expect(
          await storage.threads.getById({ projectId: PROJECT_ID, id: requested.run.threadId })
        ).toMatchObject({ activeRunId: null })
      } else {
        await worker.stop()
        expect(
          await storage.runs.getById({ projectId: PROJECT_ID, id: requested.run.id })
        ).toMatchObject({ status: "running", execution: { token: takeoverToken } })
        expect(
          await storage.threads.getById({ projectId: PROJECT_ID, id: requested.run.threadId })
        ).toMatchObject({ activeRunId: requested.run.id })
        expect(modelCalls).not.toHaveBeenCalled()
      }
      const execution = await sixb.storage.executions.getById({
        projectId: PROJECT_ID,
        id: run.executionId,
      })
      expect(execution?.authorizationRef).toEqual({
        type: "principal",
        principal: REQUESTER,
        credential: { type: "session", id: sessionId },
      })
    } finally {
      await worker.stop()
      modelCalls.mockRestore()
      completion.restore()
    }
  })

  test("keeps completed-call usage when durable response projection fails", async () => {
    const sixb = buildSixb(invalidMetadataAnswerModel())
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const request = await requestAgent(sixb, { text: "echo hi" })
      const run = await waitForTerminalRun(storage, request.run.id)

      expect(run.status).toBe("failed")
      await expect(
        aiUsageStorageOf(sixb).summarizeExecution({
          projectId: PROJECT_ID,
          executionId: run.executionId,
        })
      ).resolves.toMatchObject({
        modelCallCount: 1,
        usage: {
          inputTokens: 10,
          outputTokens: 7,
          totalTokens: 17,
          reportingStatus: "complete",
        },
      })
    } finally {
      await worker.stop()
    }
  })

  test("hands a failed usage append to the queue and fails closed before another provider call", async () => {
    let modelCalls = 0
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async () => {
        modelCalls += 1
        if (modelCalls === 1) {
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
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "should not run" },
          { type: "text-end", id: "answer" },
          finish("stop"),
        ])
      },
    })
    const sixb = buildSixbWithEchoTool(model)
    const storage = agentStorageOf(sixb)
    const aiUsage = aiUsageStorageOf(sixb)
    const queue = sixb.queues.agents
    const enqueue = queue.enqueue.bind(queue)
    let storageAvailable = false
    let appendAttempts = 0
    let recoveryJobs = 0
    const workerHost = withStorage(
      sixb,
      withAiUsageRecordInterceptor(sixb.storage, async (_input, record) => {
        if (storageAvailable) return record()
        appendAttempts += 1
        throw new Error("usage storage unavailable")
      })
    )
    queue.enqueue = async (params) => {
      const jobs = await enqueue(params)
      const handedOff = params.jobs.filter(
        (job) => job.type === "agent.ai-usage.record.requested"
      ).length
      if (handedOff > 0) {
        recoveryJobs += handedOff
        storageAvailable = true
      }
      return jobs
    }

    // Fake timers stand in for the recorder's storage retry backoff.
    jest.useFakeTimers()
    const start = Date.now()
    const worker = new AgentWorker(workerHost, workerOptions())
    try {
      await worker.start()
      const request = await requestAgent(sixb, { text: "echo hi" })
      const run = await underFakeTime(
        () => terminalRun(storage, request.run.id),
        "usage recovery run terminal"
      )
      // The recorder's storage retries: 50 + 200 + 600ms.
      expectBackoffSpent(start, 850)

      expect(run.status).toBe("failed")
      expect(run.error).toMatchObject({
        code: "agent.execution_failed",
        message: "Agent execution failed.",
        retryable: false,
        details: {
          runId: request.run.id,
          threadId: request.run.threadId,
        },
      })
      const summary = await underFakeTime(async () => {
        const value = await aiUsage.summarizeExecution({
          projectId: PROJECT_ID,
          executionId: run.executionId,
        })
        return value.modelCallCount === 1 ? value : null
      }, "queued AI usage recovery")
      expect(summary.modelCallCount).toBe(1)
      expect(modelCalls).toBe(1)
      expect(appendAttempts).toBe(4)
      expect(recoveryJobs).toBe(1)
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test("redelivers a recovery job until its idempotent ledger append succeeds", async () => {
    // A project without Agent work recovers accounting with no sandbox or agent API origin.
    // Removal proof: restore the eager agent context in AgentWorker's constructor; it throws.
    const storage = new InMemoryStorage()
    let appendAttempts = 0
    const host = new SixbHost({
      id: PROJECT_ID,
      ontology: [],
      storage: withAiUsageRecordInterceptor(storage, async (_input, record) => {
        appendAttempts += 1
        if (appendAttempts === 1) throw new Error("temporary usage storage failure")
        return record()
      }),
      broker: new InMemoryBroker(),
      queues: new InMemoryQueues(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
    })
    const executionId = await createTestAgentExecution(storage, {
      projectId: PROJECT_ID,
      runId: "usage-recovery",
    })
    const queue = host.queues.agents
    const retry = queue.retry.bind(queue)
    const deferredByMs: number[] = []
    queue.retry = async (params) => {
      deferredByMs.push(Date.parse(params.availableAt ?? "") - Date.now())
      return retry({ ...params, availableAt: new Date(0).toISOString() })
    }
    await enqueueAiModelCallRecovery(queue, {
      usage: {
        id: "usage_recovery_1",
        projectId: PROJECT_ID,
        executionId,
        attempt: 1,
        callId: "call_recovery_1",
        requesterGroupIds: ["support"],
        providerId: "gateway",
        requestedModelId: "mock-model",
        responseId: "response_recovery_1",
        usage: { inputTokens: 12, outputTokens: 8 },
        occurredAt: new Date("2026-07-01T12:00:00.000Z"),
      },
      cost: { status: "unpriceable", reason: "missing-rate-card" },
      ratedAt: new Date("2026-07-01T12:00:00.000Z"),
    })

    const worker = new AgentWorker(host, {})
    await worker.start()
    try {
      const summary = await waitFor(
        async () => {
          const value = await storage.aiUsage.summarizeExecution({
            projectId: PROJECT_ID,
            executionId,
          })
          return value.modelCallCount === 1 ? value : null
        },
        { label: "redelivered AI usage recovery" }
      )
      expect(summary.usage.inputTokens).toBe(12)
      expect(appendAttempts).toBe(2)
      expect(deferredByMs).toHaveLength(1)
      expect(deferredByMs[0]).toBeGreaterThan(0)
    } finally {
      await worker.stop()
    }
  })

  // Queue leases run on fake time: renewals and redelivery happen when the test moves the clock.
  test("keeps a turn that outlives its initial queue lease and projects each renewal", async () => {
    // Regression proof: stop projecting renewals in AgentWorker.execute (onLeaseRenewed); the
    // run's queueLeaseExpiresAt keeps its claim-time value and the projection wait times out.
    const controlled = controlledBlockingAnswerModel()
    const sixb = buildSixb(controlled.model)
    const storage = agentStorageOf(sixb)
    const queue = sixb.queues.agents
    const renew = queue.renewLease?.bind(queue)
    if (!renew) throw new Error("expected queue lease renewal")
    const renewedUntil: number[] = []
    queue.renewLease = async (params) => {
      const renewed = await renew(params)
      if (renewed) renewedUntil.push(Date.parse(renewed.leaseExpiresAt))
      return renewed
    }
    jest.useFakeTimers()
    const worker = new AgentWorker(sixb, workerOptions({ leaseMs: 90 }))
    try {
      await worker.start()
      const request = await requestAgent(sixb, { text: "keep owning" })
      await underFakeTime(() => controlled.startedCount() === 1, "model stream started", 0)
      const claimedUntil = (
        await storage.runs.getById({ projectId: PROJECT_ID, id: request.run.id })
      )?.execution?.queueLeaseExpiresAt.getTime()
      if (claimedUntil === undefined) throw new Error("Expected the claim's lease projection.")
      await underFakeTime(
        async () => {
          const latest = renewedUntil.at(-1)
          if (latest === undefined || Date.now() <= claimedUntil) return null
          const run = await storage.runs.getById({ projectId: PROJECT_ID, id: request.run.id })
          return (run?.execution?.queueLeaseExpiresAt.getTime() ?? 0) >= latest
        },
        "renewed lease projected past the claim's lease",
        10
      )

      controlled.releaseAll()
      expect(
        await underFakeTime(() => terminalRun(storage, request.run.id), "outliving run terminal")
      ).toMatchObject({ status: "succeeded", attempt: 1 })
    } finally {
      controlled.releaseAll()
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test("ends the turn as interrupted without reporting when queue ownership is lost", async () => {
    const sixb = buildSixb(hangingModel())
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

    const originalConsoleError = console.error
    console.error = () => {}
    jest.useFakeTimers()
    const worker = new AgentWorker(sixb, workerOptions({ leaseMs: 45 }))
    try {
      await worker.start()
      const request = await requestAgent(sixb, { text: "recover" })
      const finalRun = await underFakeTime(
        () => terminalRun(storage, request.run.id),
        "redelivered run terminal",
        5
      )

      expect(finalRun).toMatchObject({
        status: "cancelled",
        finishReason: "interrupted",
        attempt: 2,
      })
      const assistants = (await listMessages(storage, request.run.threadId)).filter(
        (message) => message.role === "assistant"
      )
      expect(assistants).toHaveLength(0)
      await reporter.flush()
      expect(reportCount).toBe(0)
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
      console.error = originalConsoleError
    }
  })

  test("reports a step limit reached before an answer as a diagnostic, not transcript text", async () => {
    const sixb = buildSixbWithEchoTool(toolOnlyModel())
    const storage = agentStorageOf(sixb)

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const {
        run: { threadId, id: runId },
      } = await requestAgent(sixb, {
        text: "use tools forever",
      })

      const run = await waitForTerminalRun(storage, runId)

      expect(run.status).toBe("succeeded")
      expect(run.finishReason).toBe("tool-calls")
      // Chats render the code in the reader's language; the message is for developers.
      expect(run.diagnostics).toEqual([
        {
          code: "step_limit_reached",
          severity: "warning",
          scope: "run",
          message: "The Agent reached its 4-step limit before producing a final answer.",
        },
      ])

      const messages = await listMessages(storage, threadId)
      const assistant = messages.find((message) => message.role === "assistant")
      const parts = assistant?.parts ?? []
      expect(parts.filter((part) => part.type === "tool-call")).toHaveLength(4)
      expect(parts.some((part) => part.type === "text")).toBe(false)
    } finally {
      await worker.stop()
    }
  })

  // Removal proof: drop `outputLimitDiagnostic` from runAgentTurn and the diagnostic is missing;
  // drop `withoutLocalToolCalls` from runModelLoop and the cut-short tool call fails the run; drop
  // `settleTruncatedParts` from the stream accumulator and spans left open fail it; drop the
  // trailing-reasoning loop from responsesInput and the next turn replays a lone reasoning item.
  test.each([
    {
      name: "reasoning only",
      cutShort: [],
      replayed: ["system", "user", "user"],
    },
    {
      name: "partial text",
      cutShort: [
        { type: "response.output_text.delta", item_id: "message", delta: "Partial" },
        { type: "response.output_text.done", item_id: "message", text: "Partial" },
      ],
      replayed: ["system", "user", "reasoning", "assistant", "user"],
    },
    {
      name: "a cut-short tool call",
      cutShort: [
        {
          type: "response.output_item.added",
          item: { id: "fc", type: "function_call", call_id: "call", name: "echo", arguments: "" },
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc",
          arguments: '{"value":"x"}',
        },
      ],
      replayed: ["system", "user", "user"],
    },
    {
      name: "spans left open",
      cutShort: [
        { type: "response.output_text.delta", item_id: "message", delta: "Partial" },
        {
          type: "response.output_item.added",
          item: { id: "fc", type: "function_call", call_id: "call", name: "echo", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", item_id: "fc", delta: '{"value":' },
      ],
      replayed: ["system", "user", "reasoning", "assistant", "user"],
    },
  ])("keeps an answer the output limit cut short ($name) and replays it safely", async ({
    cutShort,
    replayed,
  }) => {
    const requests: {
      readonly input: readonly { readonly role?: string; readonly type?: string }[]
    }[] = []
    const gateway = createVercelGateway({
      fetch: async (url, init) => {
        if (String(url).endsWith("/models")) {
          return Response.json({
            data: [{ id: "zai/glm-5.3-flash", type: "language", context_window: 64_000 }],
          })
        }
        requests.push(JSON.parse(String(init?.body)))
        const events =
          requests.length === 1
            ? [
                {
                  type: "response.output_item.done",
                  item: {
                    type: "reasoning",
                    id: "rs",
                    summary: [{ type: "summary_text", text: "Thinking" }],
                    encrypted_content: "opaque",
                  },
                },
                ...cutShort,
                {
                  type: "response.incomplete",
                  response: {
                    status: "incomplete",
                    incomplete_details: { reason: "max_output_tokens" },
                    usage: { input_tokens: 10, output_tokens: 7 },
                  },
                },
              ]
            : [
                { type: "response.output_text.done", item_id: "answer", text: "Done" },
                {
                  type: "response.completed",
                  response: { status: "completed", usage: { input_tokens: 10, output_tokens: 1 } },
                },
              ]
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
      },
    })
    let executed = 0
    const echo = defineAgentTool("echo")
      .description("Echo a value back.")
      .input({ value: "string" })
      .run(({ input }) => {
        executed += 1
        return { echoed: input.value }
      })
    const sixb = buildSixb(gateway("zai/glm-5.3-flash"), new InMemoryBroker(), undefined, {
      agentTools: [echo],
    })
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const first = await requestAgent(sixb, { text: "Think hard" })
      const finished = (id: string) =>
        waitFor(
          async () => {
            const run = await storage.runs.getById({ projectId: PROJECT_ID, id })
            return run && run.status !== "queued" && run.status !== "running" ? run : null
          },
          { label: "cut-short run terminal" }
        )
      expect(await finished(first.run.id)).toMatchObject({
        status: "succeeded",
        finishReason: "length",
        diagnostics: [
          {
            code: "output_limit_reached",
            severity: "warning",
            scope: "run",
            message: "The model reached its output limit before finishing the answer.",
          },
        ],
      })
      expect(executed).toBe(0)
      const [, assistant] = await listMessages(storage, first.run.threadId)
      expect(assistant?.parts.some((part) => part.type === "tool-call")).toBe(false)

      const next = await requestAgent(sixb, { threadId: first.run.threadId, text: "Again" })
      const answered = await finished(next.run.id)
      expect(answered).toMatchObject({ status: "succeeded", finishReason: "stop" })
      expect(answered.diagnostics).toBeUndefined()
      expect(requests[1]?.input.map((item) => item.role ?? item.type)).toEqual([...replayed])
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
        run: { threadId, id: runId },
      } = await requestAgent(sixb, {
        text: "run bash",
      })

      const run = await waitForTerminalRun(storage, runId)

      expect(run.status).toBe("succeeded")
      const createOptions = sandboxes.createOptions[0]
      // Regression proof: omit environment: {} in provisionSandbox; this assertion fails.
      expect(createOptions?.environment).toEqual({})
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

  test("views an image created by bash without attaching it to the answer", async () => {
    let viewedPrompt: unknown
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(
      bashImageThenViewModel((prompt) => {
        viewedPrompt = prompt
      }),
      new InMemoryBroker(),
      sandboxes
    )
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions())

    await worker.start()
    try {
      const request = await requestAgent(sixb, {
        text: "create and inspect an image",
      })
      const run = await waitForTerminalRun(storage, request.run.id)

      expect(run.status).toBe("succeeded")
      const assistant = (await listMessages(storage, request.run.threadId)).find(
        (message) => message.role === "assistant"
      )
      const viewCall = assistant?.parts.find(
        (part) => part.type === "tool-call" && part.toolName === "view_file"
      )
      const viewed =
        viewCall?.type === "tool-call" && viewCall.state === "output-available"
          ? viewCall.output
          : undefined
      if (!isAgentToolResult(viewed) || viewed.content[1]?.type !== "file") {
        throw new Error("Expected the viewed image in the view_file result.")
      }
      expect(
        new Uint8Array(
          await new Response(
            await sixb.blobStorage.open(viewed.content[1].fileRef.blobId)
          ).arrayBuffer()
        )
      ).toEqual(TEST_PNG_BYTES)
      expect(viewCall).toMatchObject({
        state: "output-available",
        output: {
          kind: "agentToolResult",
          content: [
            { type: "text", text: expect.stringContaining("Prepared image") },
            {
              type: "file",
              fileRef: { fileName: "bash-image.png", mediaType: "image/png" },
            },
          ],
        },
      })
      // Viewing is work, not a deliverable: the image stays in the trace only.
      expect(assistant?.parts.some((part) => part.type === "file")).toBe(false)
      expect(
        sandboxes.sandboxes[0]?.writtenFiles.some((file) =>
          file.path.includes(".sixb/agent/tool-files/")
        )
      ).toBe(true)
      if (typeof Bun.Image === "function") {
        expect(JSON.stringify(viewedPrompt)).toContain(
          Buffer.from(TEST_PNG_BYTES).toString("base64")
        )
      }
    } finally {
      await worker.stop()
    }
  })

  // Guard proofs: pass the thread's owner as `author` in createConversationAgentEnvironment's
  // publishing, and Bob's versions name Alice; give the publish tools the owner's view as
  // `reader` (or read storage in updatableArtifact), and Bob's turn revises Alice's private notes.
  test("a participant's turn publishes as them and reaches only what the thread shares", async () => {
    const sandboxes = new RecordingSandboxFactory()
    const alice = { type: "user", id: "usr_alice" } as const
    const bob = { type: "user", id: "usr_bob" } as const
    const ids: { shared?: string; notes?: string } = {}
    const outputs: unknown[] = []
    let call = 0
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async (request) => {
        const last = request.messages.at(-1)
        if (last?.role === "tool") outputs.push(last.content)
        call += 1
        if (call === 1) return toolCallStream("bob-1", "bash", { command: "write-q3-review" })
        if (call === 2) {
          return toolCallStream("bob-2", "publish_artifact_version", {
            id: ids.notes,
            path: "work/q3-review",
            title: "Taken over",
          })
        }
        if (call === 3) {
          return toolCallStream("bob-3", "publish_artifact_version", {
            id: ids.shared,
            path: "work/q3-review",
            title: "Q3 review, Bob's",
          })
        }
        if (call === 4) {
          return toolCallStream("bob-4", "publish_artifact", {
            path: "work/q3-review",
            kind: "document",
            title: "Bob's own",
          })
        }
        return answerStream("Done.")
      },
    })
    const chatters = defineGroup("chatters")
    const sixb = buildSixb(model, new InMemoryBroker(), sandboxes, {
      security: {
        ontology: [],
        groups: [AGENT_RUNTIME_GROUP, chatters],
        roles: [defineRole("chat.users", { grantedTo: [chatters], grants: [can.run(agent)] })],
      },
    })
    const storage = agentStorageOf(sixb)
    const artifacts = artifactStorageOf(sixb)
    const auth = authStorageOf(sixb)
    for (const user of [alice, bob]) {
      await auth.users.create({ projectId: PROJECT_ID, id: user.id, email: `${user.id}@acme.com` })
      await auth.groupMemberships.upsert({
        projectId: PROJECT_ID,
        userId: user.id,
        groupId: chatters.id,
        source: "manual",
      })
    }

    // Alice's thread shares one artifact; her notes stay hers.
    const thread = await storage.threads.create({
      projectId: PROJECT_ID,
      id: "thr_shared",
      ownerPrincipal: alice,
    })
    const file = await sixb.blobStorage.put({
      body: new TextEncoder().encode("# Shared\n"),
      fileName: "document.md",
      mediaType: "text/markdown",
    })
    const version = {
      title: "Shared",
      entry: "document.md",
      files: [{ path: "document.md", file }],
      outline: { kind: "document" as const, headings: [] },
      references: [],
      author: alice,
      createdAt: new Date(),
    }
    ids.shared = (
      await artifacts.create({
        projectId: PROJECT_ID,
        id: "art_0000000001",
        kind: "document",
        owner: alice,
        version: { ...version, origin: { threadId: thread.id, runId: "run_earlier" } },
      })
    ).artifact.id
    ids.notes = (
      await artifacts.create({
        projectId: PROJECT_ID,
        id: "art_0000000002",
        kind: "document",
        owner: alice,
        version: { ...version, title: "Notes" },
      })
    ).artifact.id
    await storage.threads.addParticipants({
      projectId: PROJECT_ID,
      threadId: thread.id,
      principals: [bob],
      addedBy: alice,
      maxParticipants: 50,
    })

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const turn = await requestAgentAs(sixb, bob, { text: "Revise it", threadId: thread.id })
      expect((await waitForTerminalRun(storage, turn.run.id)).status).toBe("succeeded")

      const manifest = sandboxes.sandboxes[0]?.writtenFiles.find((written) =>
        written.path.endsWith("/.sixb/agent/context/artifacts.json")
      )
      expect(String(manifest?.contents)).toContain(ids.shared)
      expect(String(manifest?.contents)).not.toContain(ids.notes)

      expect(JSON.stringify(outputs[1])).toContain(`there is no artifact '${ids.notes}'`)
      expect((await artifacts.get({ projectId: PROJECT_ID, id: ids.notes }))?.latestVersion).toBe(1)

      const revised = await artifacts.getVersion({
        projectId: PROJECT_ID,
        artifactId: ids.shared,
        version: 2,
      })
      expect(revised).toMatchObject({ author: bob, title: "Q3 review, Bob's" })

      const { artifacts: created } = await artifacts.list({
        projectId: PROJECT_ID,
        threadId: thread.id,
      })
      const own = created.find((artifact) => artifact.title === "Bob's own")
      expect(own?.owner).toEqual(alice)
      const first =
        own &&
        (await artifacts.getVersion({ projectId: PROJECT_ID, artifactId: own.id, version: 1 }))
      expect(first?.author).toEqual(bob)
    } finally {
      await worker.stop()
    }
  })

  // Regression check: restore assistant fileText projection in core/src/agents/adapters.ts.
  // The second turn's assistant-history assertion must fail even though retrieval still works.
  test("publishes an artifact mid-turn and edits it from storage the next turn", async () => {
    const sandboxes = new RecordingSandboxFactory()
    const host: { sixb?: TestSixb } = {}
    let call = 0
    let duringTurn: { readonly runStatus?: string; readonly originRunId?: string } = {}
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async () => {
        call += 1
        if (call === 1) return toolCallStream("publish-1", "bash", { command: "write-q3-review" })
        if (call === 2) {
          return toolCallStream("publish-2", "publish_artifact", {
            path: "work/q3-review",
            kind: "document",
            title: "Q3 review",
          })
        }
        if (call === 3) {
          // The version exists while the turn is still running.
          const artifact = await onlyArtifact(host.sixb)
          const version = await artifactStorageOf(host.sixb).getVersion({
            projectId: PROJECT_ID,
            artifactId: artifact.id,
            version: 1,
          })
          if (!host.sixb) throw new Error("Expected the host.")
          const runs = await agentStorageOf(host.sixb).runs.list({ projectId: PROJECT_ID })
          duringTurn = {
            runStatus: runs.runs.find((run) => run.id === version?.origin?.runId)?.status,
            originRunId: version?.origin?.runId,
          }
          return answerStream("I published the Q3 review.")
        }
        if (call === 4) {
          // The next turn starts from what was published, installed in its sandbox.
          const artifact = await onlyArtifact(host.sixb)
          return toolCallStream("publish-4", "publish_artifact_version", {
            id: artifact.id,
            path: `.sixb/agent/artifacts/${artifact.id}`,
            title: "Q3 review, final",
          })
        }
        return answerStream("I published the final review.")
      },
    })
    const sixb = buildSixb(model, new InMemoryBroker(), sandboxes)
    host.sixb = sixb
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const first = await requestAgent(sixb, { text: "Write the Q3 review" })
      const firstRun = await waitForTerminalRun(storage, first.run.id)
      expect(firstRun.status).toBe("succeeded")
      expect(duringTurn).toEqual({ runStatus: "running", originRunId: first.run.id })

      const artifact = await onlyArtifact(sixb)
      const thread = await storage.threads.getById({
        projectId: PROJECT_ID,
        id: first.run.threadId,
      })
      const v1 = await artifactStorageOf(sixb).getVersion({
        projectId: PROJECT_ID,
        artifactId: artifact.id,
        version: 1,
      })
      if (!thread) throw new Error("Expected the thread.")
      expect(artifact.owner).toEqual(thread.ownerPrincipal)
      // The draft's notes start with a dot and stay in the sandbox.
      expect(v1?.files.map((file) => file.path)).toEqual(["document.md"])
      expect(v1?.origin).toEqual({ threadId: first.run.threadId, runId: first.run.id })

      const messages = await listMessages(storage, first.run.threadId)
      const assistant = messages.find((message) => message.role === "assistant")
      expect(assistant?.parts.some((part) => part.type === "file")).toBe(false)
      expect(
        assistant?.parts.find(
          (part) => part.type === "tool-call" && part.toolName === "publish_artifact"
        )
      ).toMatchObject({
        state: "output-available",
        output: { artifactId: artifact.id, version: 1, kind: "document", title: "Q3 review" },
      })

      const second = await requestAgent(sixb, {
        threadId: first.run.threadId,
        text: "Call it final",
      })
      expect((await waitForTerminalRun(storage, second.run.id)).status).toBe("succeeded")
      const secondSandbox = sandboxes.sandboxes.at(-1)
      if (!secondSandbox) throw new Error("Expected the second turn's sandbox.")
      const installed = join(
        secondSandbox.workingDirectory,
        ".sixb/agent/artifacts",
        artifact.id,
        "document.md"
      )
      expect(secondSandbox.readFileContents(installed)).toBe(Q3_REVIEW_MARKDOWN)
      const manifest = secondSandbox.writtenFiles.find((file) =>
        file.path.endsWith("/.sixb/agent/context/artifacts.json")
      )
      expect(JSON.parse(String(manifest?.contents))).toEqual({
        artifacts: [
          {
            id: artifact.id,
            kind: "document",
            title: "Q3 review",
            version: 1,
            address: `artifact:${artifact.id}`,
            pinned: `artifact:${artifact.id}@1`,
            parts: [
              {
                address: `artifact:${artifact.id}#q3-review`,
                pinned: `artifact:${artifact.id}@1#q3-review`,
                name: "Q3 review",
              },
              {
                address: `artifact:${artifact.id}#regions`,
                pinned: `artifact:${artifact.id}@1#regions`,
                name: "Regions",
              },
            ],
            directory: `.sixb/agent/artifacts/${artifact.id}`,
            files: ["document.md"],
          },
        ],
      })
      expect(await onlyArtifact(sixb)).toMatchObject({
        latestVersion: 2,
        title: "Q3 review, final",
      })
      expect(
        (
          await artifactStorageOf(sixb).getVersion({
            projectId: PROJECT_ID,
            artifactId: artifact.id,
            version: 2,
          })
        )?.origin
      ).toEqual({ threadId: first.run.threadId, runId: second.run.id })
    } finally {
      await worker.stop()
    }
  })

  test("a cancelled run keeps what it published", async () => {
    let call = 0
    let blocked: (() => void) | undefined
    const blockedStarted = new Promise<void>((resolve) => {
      blocked = resolve
    })
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async (options) => {
        call += 1
        if (call === 1) return toolCallStream("cancel-1", "bash", { command: "write-q3-review" })
        if (call === 2) {
          return toolCallStream("cancel-2", "publish_artifact", {
            path: "work/q3-review",
            kind: "document",
            title: "Q3 review",
          })
        }
        // Hang until the user cancels.
        return {
          stream: new ReadableStream<WorkerTestStreamEvent>({
            start(controller) {
              blocked?.()
              const abort = () => controller.error(new DOMException("Aborted", "AbortError"))
              if (options.signal.aborted) abort()
              else options.signal.addEventListener("abort", abort, { once: true })
            },
          }),
        }
      },
    })
    const sixb = buildSixb(model, new InMemoryBroker(), new RecordingSandboxFactory())
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const request = await requestAgent(sixb, { text: "Write the Q3 review" })
      await blockedStarted
      await publishAgentRunCancel(sixb.broker, { projectId: PROJECT_ID, runId: request.run.id })
      expect((await waitForTerminalRun(storage, request.run.id)).status).toBe("cancelled")
      expect(await onlyArtifact(sixb)).toMatchObject({ latestVersion: 1, title: "Q3 review" })
    } finally {
      await worker.stop()
    }
  })

  test("retrying a failed run removes what it published", async () => {
    let call = 0
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async () => {
        call += 1
        if (call === 1) return toolCallStream("retry-1", "bash", { command: "write-q3-review" })
        if (call === 2) {
          return toolCallStream("retry-2", "publish_artifact", {
            path: "work/q3-review",
            kind: "document",
            title: "Q3 review",
          })
        }
        if (call === 3) {
          throw createSixbError("agent.execution_failed", "[test] The provider failed mid-turn.")
        }
        return answerStream("Retried.")
      },
    })
    const sixb = buildSixb(model, new InMemoryBroker(), new RecordingSandboxFactory())
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const request = await requestAgent(sixb, { text: "Write the Q3 review" })
      expect((await waitForTerminalRun(storage, request.run.id)).status).toBe("failed")
      const artifact = await onlyArtifact(sixb)

      // What the failed turn published goes with what it said.
      // Reproduce by dropping `deleteVersionsByOrigin` from `retryAgentRun`.
      await createTestSixb(sixb).agent.runs.retry(request.run.id)
      expect(
        await artifactStorageOf(sixb).get({ projectId: PROJECT_ID, id: artifact.id })
      ).toBeNull()
    } finally {
      await worker.stop()
    }
  })

  test("counts the conversation's ontology index in its context budget", async () => {
    // Reproduce: drop `ontologyIndex` from the estimate in prepareAgentConversationContext; the
    // oversized prompt then passes preflight.
    // Below the index's condensation threshold, so every file is listed.
    const types = Array.from({ length: 140 }, (_, index) =>
      defineObjectType({
        id: `Type${index}`,
        name: `Type ${index}`,
        description: `A long description of type ${index} that fills the ontology index. `.repeat(
          3
        ),
        properties: [prop("id", "string", { required: true, primary: true })],
      })
    )
    const prepare = async (ontology: readonly ObjectTypeWithPropertyTokens[]) => {
      const host = buildSixb(answerModel(), new InMemoryBroker(), new RecordingSandboxFactory(), {
        ontology,
      })
      const run = await reserveRequestedRun(host, await requestAgent(host, { text: "Work" }))
      const context = await buildAgentWorkerContext(host)
      const execution = await context.storage.executions.getById({
        projectId: PROJECT_ID,
        id: run.executionId,
      })
      if (!execution) throw new Error("Expected the run's execution.")
      const runtime = createAgentTurnRuntime({
        context,
        run,
        signal: new AbortController().signal,
        execution,
      })
      try {
        return await conversationPreparation.prepareAgentConversationContext({
          context,
          plan: executionPlanFor(host),
          ontologyIndex: renderOntologyDocs({
            catalog: host.definitions.agent.ontologyDocs,
            objectTypes: context.sixb.objects.listTypes(),
            valueTypesById: context.sixb.objects.getValueTypesById(),
            actionsFor: () => [],
          }).index,
          budget: {
            windowTokens: 8_000,
            inputBudgetTokens: 4_000,
            reserveTokens: 2_000,
            keepRecentTokens: 1_000,
            source: "model",
          },
          run,
          runtime,
        })
      } finally {
        runtime.dispose()
      }
    }

    expect(await prepare([])).toBeDefined()
    expect(await prepare(types).catch((error: unknown) => error)).toMatchObject({
      code: "context_limit_exceeded",
    })
  })

  test("advertises and materializes project Agent Skills, instructions, and ontology docs", async () => {
    const acmeStyle: AgentSkillDefinition = {
      name: "acme-style",
      description: "Use when drafting Acme customer-facing messages.",
      files: [
        {
          path: "SKILL.md",
          contents: [
            "---",
            "name: acme-style",
            "description: Use when drafting Acme customer-facing messages.",
            "---",
            "",
            "# Acme Style",
          ].join("\n"),
        },
        { path: "references/examples.md", contents: "Prefer concise, operational summaries." },
        { path: "scripts/check.sh", contents: "#!/bin/sh\n", mode: 0o755 },
      ],
    }

    let capturedSystem: string | undefined
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(
      apiBashThenAnswerModel((system) => {
        capturedSystem = system
      }),
      new InMemoryBroker(),
      sandboxes,
      {
        skills: [acmeStyle],
        projectInstructions: "Always answer in French.",
        ontology: [MeetingRoom],
        ontologyDocs: {
          modules: [{ path: "rooms/meeting-room.ts", objectTypeIds: ["MeetingRoom"] }],
          docs: [{ path: "rooms/meeting-room.md", contents: "Rooms are booked by the hour." }],
          scripts: [],
        },
      }
    )
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const {
        run: { id: runId },
      } = await requestAgent(sixb, {
        text: "draft a note",
      })
      const run = await waitForTerminalRun(storage, runId)
      expect(run.status).toBe("succeeded")
      expect(capturedSystem).toContain("Path: .sixb/agent/skills/acme-style/SKILL.md")
      expect(capturedSystem).toContain("Use when drafting Acme customer-facing messages.")
      expect(capturedSystem).toContain(
        "<agent_instructions>\nAlways answer in French.\n</agent_instructions>"
      )
      expect(capturedSystem).toContain(
        [
          ".sixb/agent/ontology/",
          "└── rooms/",
          "    └── meeting-room.md  MeetingRoom: A bookable meeting room.",
        ].join("\n")
      )

      const command = sandboxes.sandboxes[0]?.commands.find(
        (candidate) => candidate.args.at(-1) === "print-sixb-env"
      )
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
      expect(
        sandbox.writtenFiles.find(
          (file) => file.path === join(skillsDir, "acme-style", "scripts", "check.sh")
        )?.mode
      ).toBe(0o755)
      expect(sandbox.writtenFiles.some((file) => file.path.includes("/skills/sixb/"))).toBe(false)
      const ontologyDir = command?.options.env?.SIXB_ONTOLOGY_DIR
      if (!ontologyDir) throw new Error("Expected the ontology docs sandbox env.")
      const roomDoc = sandbox.readFileContents(join(ontologyDir, "rooms", "meeting-room.md"))
      expect(roomDoc).toStartWith("# MeetingRoom — Meeting room\n")
      expect(roomDoc).toContain("## Project notes\n\nRooms are booked by the hour.")
    } finally {
      await worker.stop()
    }
  })

  // Guard proof: drop `assertRequesterTakesPart` from prepareConversationTurn; Bob's turn then
  // reaches the model after he was removed.
  test("cancels a queued turn whose requester left the shared thread, without the model", async () => {
    let calls = 0
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async () => {
        calls += 1
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "Done" },
          { type: "text-end", id: "answer" },
          finish("stop"),
        ])
      },
    })
    const sixb = buildSixb(model)
    const storage = agentStorageOf(sixb)
    const alice = { type: "user", id: "usr_alice" } as const
    const bob = { type: "user", id: "usr_bob" } as const

    const first = await requestAgentAs(sixb, alice, { text: "Which deals slipped?" })
    const threadId = first.run.threadId
    await storage.runs.finishQueued({ projectId: PROJECT_ID, id: first.run.id, status: "failed" })
    await storage.threads.addParticipants({
      projectId: PROJECT_ID,
      threadId,
      principals: [bob],
      addedBy: alice,
      maxParticipants: 50,
    })
    const asked = await requestAgentAs(sixb, bob, { text: "Why did Acme slip?", threadId })
    await storage.threads.removeParticipant({ projectId: PROJECT_ID, threadId, principal: bob })

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const run = await waitFor(
        async () => {
          const found = await storage.runs.getById({ projectId: PROJECT_ID, id: asked.run.id })
          return found && found.status !== "queued" && found.status !== "running" ? found : null
        },
        { label: "removed requester's run terminal" }
      )

      expect(run).toMatchObject({ status: "cancelled", error: { code: "runtime.cancelled" } })
      expect(calls).toBe(0)
      expect(await storage.threads.getById({ projectId: PROJECT_ID, id: threadId })).toMatchObject({
        activeRunId: null,
      })
    } finally {
      await worker.stop()
    }
  })

  test("tells the conversation who it works for", async () => {
    // Proven by removal: drop `requester` from createAgentExecutionContext.
    let capturedSystem: string | undefined
    const sixb = buildSixb(
      answerModel(undefined, (system) => {
        capturedSystem = system
      })
    )
    await sixb.storage.auth?.users.create({
      id: REQUESTER.id,
      projectId: PROJECT_ID,
      email: `${REQUESTER.id}@example.com`,
      displayName: "Rachel Quinn",
    })
    const storage = agentStorageOf(sixb)

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const request = await requestAgentAs(sixb, REQUESTER, { text: "Assign this to me." })
      const run = await waitForTerminalRun(storage, request.run.id)

      expect(run.status).toBe("succeeded")
      expect(capturedSystem).toContain(
        'This request comes from "Rachel Quinn", a project member. When they refer to themselves ("I", "me", "my"), they mean the user {"type":"user","id":"usr_requester"}.'
      )
    } finally {
      await worker.stop()
    }
  })

  test("replays a byte-identical prefix and dates every user message from storage", async () => {
    // Proven by removal: date messages with `new Date()` in loadUserMessageTimes; the replayed
    // first message then differs between the two runs. The clock jumps an hour between them,
    // since the rendered time is minute-precise.
    const requests: LanguageModelRequest[] = []
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async (request) => {
        requests.push(request)
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "Done" },
          { type: "text-end", id: "answer" },
          finish("stop"),
        ])
      },
    })
    const sixb = buildSixb(model)
    const storage = agentStorageOf(sixb)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const first = await requestAgent(sixb, { text: "first", timeZone: "Asia/Kolkata" })
      await waitForTerminalRun(storage, first.run.id)
      setSystemTime(new Date(Date.now() + 3_600_000))
      const threadId = first.run.threadId
      const second = await requestAgent(sixb, {
        text: "second",
        threadId,
        timeZone: "Asia/Kolkata",
      })
      await waitForTerminalRun(storage, second.run.id)
      const third = await requestAgent(sixb, { text: "third", threadId })
      await waitForTerminalRun(storage, third.run.id)

      const [firstRequest, secondRequest, thirdRequest] = requests
      if (!firstRequest || !secondRequest || !thirdRequest) {
        throw new Error("Expected three model requests.")
      }
      expect(secondRequest.messages.slice(0, firstRequest.messages.length)).toEqual([
        ...firstRequest.messages,
      ])
      // The third run uses the project time zone, so only its system prompt differs.
      expect(thirdRequest.messages.slice(1, secondRequest.messages.length)).toEqual(
        secondRequest.messages.slice(1)
      )

      // Each message keeps the zone of the run that answered it.
      const sent = (await listMessages(storage, threadId)).filter(
        (message) => message.role === "user"
      )
      const users = thirdRequest.messages.filter((message) => message.role === "user")
      const sentAt = (index: number, timeZone: string) => ({
        type: "text" as const,
        text: `\n\n${renderCurrentTime(sent[index]!.createdAt, timeZone)}`,
      })
      expect(users.map((message) => message.content.at(-1))).toEqual([
        sentAt(0, "Asia/Kolkata"),
        sentAt(1, "Asia/Kolkata"),
        sentAt(2, "UTC"),
      ])
    } finally {
      setSystemTime()
      await worker.stop()
    }
  })

  // Guard proof: drop the section or the authors from userMessageSuffix in runAgentTurn; the
  // shared turn then cannot tell who takes part or who wrote what.
  test("tells the model who wrote each message of a shared thread, and stores none of it", async () => {
    const requests: LanguageModelRequest[] = []
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async (request) => {
        requests.push(request)
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "Done" },
          { type: "text-end", id: "answer" },
          finish("stop"),
        ])
      },
    })
    // Bob reads the thread through a role, so the model is told he takes part.
    const chatters = defineGroup("chatters")
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(model, new InMemoryBroker(), sandboxes, {
      security: {
        ontology: [],
        groups: [AGENT_RUNTIME_GROUP, chatters],
        roles: [defineRole("chat.users", { grantedTo: [chatters], grants: [can.run(agent)] })],
      },
    })
    const storage = agentStorageOf(sixb)
    const alice = { type: "user", id: "usr_alice" } as const
    const bob = { type: "user", id: "usr_bob" } as const
    // Each remembers something of their own, saved before the thread starts.
    for (const [repoId, author, contents] of [
      [`user:${alice.id}`, alice, "# Memory\n- Alice prefers tables\n"],
      [`user:${bob.id}`, bob, "# Memory\n- Bob prefers charts\n"],
      ["project", alice, "# Memory\n- Churn is 60 days without renewal\n"],
    ] as const) {
      await storage.memory.save({
        projectId: PROJECT_ID,
        repoId,
        baseRevision: 0,
        message: "Remember",
        author,
        changes: [{ path: "MEMORY.md", contents }],
        createdAt: new Date(Date.now() - 60_000),
      })
    }
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const terminal = (runId: string) =>
        waitFor(
          async () => {
            const run = await storage.runs.getById({ projectId: PROJECT_ID, id: runId })
            return run && run.status !== "queued" && run.status !== "running" ? run : null
          },
          { label: "shared run terminal" }
        )

      const first = await requestAgentAs(sixb, alice, { text: "Which deals slipped?" })
      await terminal(first.run.id)
      const threadId = first.run.threadId

      await authStorageOf(sixb).users.create({
        projectId: PROJECT_ID,
        id: bob.id,
        email: "usr_bob@example.com",
      })
      // Both run the agent through the role, so each turn reads the project's memory alike.
      for (const member of [alice, bob]) {
        await authStorageOf(sixb).groupMemberships.upsert({
          projectId: PROJECT_ID,
          userId: member.id,
          groupId: chatters.id,
          source: "manual",
        })
      }
      await storage.threads.addParticipants({
        projectId: PROJECT_ID,
        threadId,
        principals: [bob],
        addedBy: alice,
        maxParticipants: 50,
      })
      const second = await requestAgentAs(sixb, bob, { text: "Why did Acme slip?", threadId })
      await terminal(second.run.id)

      const alone = requests[0]
      const shared = requests.at(-1)
      if (!alone || !shared) throw new Error("Expected the model to be called.")

      const text = (request: LanguageModelRequest) => JSON.stringify(request.messages)
      expect(text(alone)).not.toContain("sixb_author")
      expect(text(alone)).not.toContain("sixb_conversation")
      // Alone in the thread, Alice's own memory is shown next to the project's.
      expect(systemPromptOf(alone.messages)).toContain("- Alice prefers tables")

      // Names are data: a shared thread's system prompt is the same whoever sends the turn.
      // Guard proof: drop `shared` from createAgentExecutionContext; each prompt names its sender.
      const third = await requestAgentAs(sixb, alice, { text: "And Globex?", threadId })
      await terminal(third.run.id)
      expect(requests.at(-1)?.messages[0]).toEqual(shared.messages[0])
      expect(JSON.stringify(shared.messages[0])).not.toContain("usr_bob")

      // So is its memory: the project's alone, never the sender's own.
      // Guard proof: pass `shared: false` to loadConversationMemory; Bob's turn shows his memory.
      const system = systemPromptOf(shared.messages)
      expect(system).toContain("- Churn is 60 days without renewal")
      expect(system).not.toContain("prefers")
      expect(system).not.toContain("user/")
      expect(system).toContain("This conversation is shared, so no one's own memory is loaded")
      // Nor is it installed for the turn to read. Alice's first turn, alone and before the role
      // lets her run the agent, installs her own memory alone.
      const manifests = sandboxes.sandboxes.flatMap((sandbox) =>
        sandbox.writtenFiles
          .filter((file) => file.path.endsWith("/context/memory.json"))
          .map((file) => Object.keys(JSON.parse(sandbox.readFileContents(file.path)).repos))
      )
      expect(manifests).toEqual([["user"], ["project"], ["project"]])

      const closings = shared.messages
        .filter((message) => message.role === "user")
        .map((message) => {
          const last = message.content.at(-1)
          return last?.type === "text" ? last.text : ""
        })
      expect(closings[0]).not.toContain("sixb_conversation")
      expect(closings[0]).toEndWith('<sixb_author id="usr_alice">usr_alice</sixb_author>')

      // The newest message carries who takes part, then when it was sent, then who sent it.
      expect(closings[1]).toMatch(
        /^\n\n<sixb_conversation>\nThis conversation is shared\. Its owner: usr_alice\.\nAlso taking part: usr_bob\.[\s\S]*<\/sixb_conversation>\n<sixb_current_time>[^<]*<\/sixb_current_time>\n<sixb_author id="usr_bob">usr_bob<\/sixb_author>$/
      )

      const stored = JSON.stringify(await listMessages(storage, threadId))
      expect(stored).not.toContain("sixb_author")
    } finally {
      await worker.stop()
    }
  })

  test("pairs the canonical conversation prompt with the provisioned CLI runtime and gateway env", async () => {
    let capturedSystem: string | undefined
    const sandboxes = new RecordingSandboxFactory()
    const sixb = buildSixb(
      apiBashThenAnswerModel((system) => {
        capturedSystem = system
      }),
      new InMemoryBroker(),
      sandboxes
    )
    const storage = agentStorageOf(sixb)
    const auth = authStorageOf(sixb)

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const {
        run: { threadId, id: runId },
      } = await requestAgent(sixb, {
        text: "inspect sixb api context",
        timeZone: "Asia/Kolkata",
        locale: "fr-fr",
      })

      const run = await waitForTerminalRun(storage, runId)

      expect(run.status).toBe("succeeded")
      // The requester's settings, frozen on the run, win over the project's (UTC, en).
      // Proven by removal: drop timeZone/locale from resolveAgentExecutionPlan.
      expect(capturedSystem).toContain("Time zone: Asia/Kolkata. Locale: fr-FR.")
      expect(capturedSystem).toContain("<sixb_mode_rules>")
      expect(capturedSystem).toContain("<sixb_runtime_context>")
      expect(capturedSystem).toContain("inside a live Sixb project modeled as an ontology")
      expect(capturedSystem).toContain(
        "Use the `sixb` CLI only for the live project data or capability needed by the task"
      )
      expect(capturedSystem).toContain("Do not run `sixb --help`")
      expect(capturedSystem).toContain("Sixb agent CLI")
      expect(capturedSystem).not.toContain("<agent_instructions>")
      expect(capturedSystem).toContain("Available Agent Skills:\n- sixb-artifacts: ")
      const createOptions = sandboxes.createOptions[0]
      expect(createOptions?.network).toMatchObject({
        mode: "restricted",
        allow: [{ name: "sixb-api" }],
      })
      if (createOptions?.network?.mode !== "restricted") {
        throw new Error("Expected restricted sandbox network.")
      }
      expect(createOptions.network.allow[0]?.origin).toBe("http://localhost:3002")

      const command = sandboxes.sandboxes[0]?.commands.find(
        (candidate) => candidate.args.at(-1) === "print-sixb-env"
      )
      expect(command?.command).toBe("bash")
      expect(command?.args).toEqual(["-lc", "print-sixb-env"])
      const env = command?.options.env
      expect(env?.SIXB_API_BASE_URL).toStartWith(
        `http://localhost:3002/__sixb/agent-api/${encodeURIComponent(runId)}/`
      )
      expect(env?.SIXB_PROJECT_ID).toBe(PROJECT_ID)
      expect(env?.SIXB_ACTOR_ID).toBeUndefined()
      expect(env?.SIXB_THREAD_ID).toBe(threadId)
      expect(env?.SIXB_RUN_ID).toBe(runId)
      expect(env?.SIXB_CONTEXT_DIR).toContain("/.sixb/agent")
      expect(env?.SIXB_SKILLS_DIR).toContain("/.sixb/agent/skills")
      expect(env?.SIXB_BIN_DIR).toContain("/.sixb/agent/bin")
      expect(env?.SIXB_AGENT_RUNTIME_PROFILE).toBe(AGENT_RUNTIME_PROFILE)
      expect(env?.SIXB_RUNTIME_PROBE_FILE).toContain("/.sixb/agent/runtime/read-probe.txt")
      expect(env?.BASH_ENV).toContain("/.sixb/agent/context/bash-env")
      expect(env?.SIXB_RUN_CONTEXT).toContain("/.sixb/agent/context/run.json")
      expect(env?.SIXB_ATTACHMENTS).toContain("/.sixb/agent/context/attachments.json")
      expect(env?.SIXB_ATTACHMENT_DIR).toContain("/.sixb/agent/attachments")
      expect(env?.SIXB_ARTIFACTS).toContain("/.sixb/agent/context/artifacts.json")
      expect(env?.SIXB_ARTIFACTS_DIR).toContain("/.sixb/agent/artifacts")
      expect(env?.SIXB_OUTPUT_DIR).toBeUndefined()
      expect(env?.SIXB_API_GUIDE).toBeUndefined()
      expect(env?.SIXB_ACCESS_TOKEN).toBeUndefined()

      if (!env?.SIXB_SKILLS_DIR || !env.SIXB_BIN_DIR || !env.BASH_ENV || !env.SIXB_RUN_CONTEXT) {
        throw new Error("Expected sandbox API env.")
      }

      // Skills + run context are materialized through sandbox.writeFiles (not the host fs), so read
      // them back from the sandbox's captured records the way a guest command would.
      const sandbox = sandboxes.sandboxes[0]
      if (!sandbox) {
        throw new Error("Expected a provisioned sandbox.")
      }

      expect(
        sandbox.writtenFiles
          .filter((file) => file.path.endsWith("/SKILL.md"))
          .map((file) => file.path.slice(file.path.indexOf("/.sixb/")))
      ).toEqual([
        "/.sixb/agent/skills/sixb-artifacts/SKILL.md",
        // Installed with the conversation's memory.
        "/.sixb/agent/skills/sixb-memory/SKILL.md",
      ])

      const sixbCli = sandbox.readFileContents(join(env.SIXB_BIN_DIR, "sixb"))
      expect(sixbCli).toContain("../lib/sixb.mjs")
      expect(sixbCli).toContain("command -v bun")
      expect(sixbCli).toContain("command -v node")
      expect(sixbCli).not.toContain("SIXB_ACCESS_TOKEN")

      const runContext = JSON.parse(sandbox.readFileContents(env.SIXB_RUN_CONTEXT)) as unknown
      expect(runContext).toMatchObject({
        projectId: PROJECT_ID,
        threadId,
        runId,
        apiBaseUrl: env.SIXB_API_BASE_URL,
        artifactsManifestPath: env.SIXB_ARTIFACTS,
        artifactsDir: env.SIXB_ARTIFACTS_DIR,
      })
      if (!env.SIXB_ARTIFACTS) throw new Error("Expected the artifacts manifest env.")
      expect(JSON.parse(sandbox.readFileContents(env.SIXB_ARTIFACTS))).toEqual({ artifacts: [] })

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
      expect(stdout).toContain(`artifacts=${env.SIXB_ARTIFACTS}`)
      expect(stdout).toContain(`artifactsDir=${env.SIXB_ARTIFACTS_DIR}`)
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
        subject: { type: "serviceAccount", id: "svc_agent_assistant" },
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

    const firstRequest = await requestAgent(sixb, { text: "first" })

    const worker = new AgentWorker(sixb, workerOptions({ concurrency: 2 }))
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

      const secondRequest = await requestAgent(sixb, { text: "second" })

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
        waitForTerminalRun(storage, firstRequest.run.id),
        waitForTerminalRun(storage, secondRequest.run.id),
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

    const request = await requestAgent(sixb, { text: "go" })

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      await waitFor(() => (controlled.startedCount() >= 1 ? true : null), {
        label: "model stream started",
      })

      // Exactly what POST /api/agent-threads/:threadId/cancel publishes.
      await publishAgentRunCancel(sixb.broker, { projectId: PROJECT_ID, runId: request.run.id })

      const run = await waitForTerminalRun(storage, request.run.id)
      expect(run.status).toBe("cancelled")
      // A user's own stop is not an interruption: nothing is offered to resume it.
      expect(run.finishReason).toBeUndefined()

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
    const request = await requestAgent(sixb, { text: "wait" })
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      await started.promise
      await publishAgentRunCancel(sixb.broker, {
        projectId: PROJECT_ID,
        runId: request.run.id,
      })

      const run = await waitForTerminalRun(storage, request.run.id)
      expect(run.status).toBe("cancelled")
      expect(handlerWasCancelled).toBe(true)
    } finally {
      await worker.stop()
    }
  })

  test("persists completed tool progress when preparation is cancelled", async () => {
    // Regression proof: let prepareStep abort errors escape runModelLoop without its completed steps.
    const sixb = buildSixbWithEchoTool(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    const request = await requestAgent(sixb, { text: "go" })
    const run = await storage.runs.start({
      projectId: PROJECT_ID,
      id: request.run.id,
      execution: freshTestExecution(),
    })
    const abort = new AbortController()
    const result = await runAgentTurn({
      context: {
        id: PROJECT_ID,
        authorPrincipal: AGENT_PRINCIPAL,
        storage: workerStorageOf(sixb.storage),
        blobStorage: sixb.blobStorage,
        tools: echoTool,
        systemPrompt: "Test system prompt.",
        projectTimeZone: "UTC",
        streamSink: NOOP_STREAM_SINK,
        recoverAiModelCall: recoverAiModelCall(sixb),
        turnTimeoutMs: 60_000,
        prepareStep: async ({ stepIndex, signal }): Promise<undefined> => {
          if (stepIndex !== 1) return
          abort.abort()
          signal.throwIfAborted()
        },
      },
      plan: executionPlanFor(sixb),
      run: requireConversationRun(run),
      signal: abort.signal,
    })
    expect(result.status).toBe("cancelled")
    const messages = await listMessages(storage, request.run.threadId)
    expect(messages.find((message) => message.role === "assistant")?.parts).toContainEqual({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "echo",
      input: { value: "hi" },
      state: "output-available",
      output: { echoed: "hi" },
    })
    await expect(
      storage.threads.getById({ projectId: PROJECT_ID, id: request.run.threadId })
    ).resolves.toMatchObject({ activeRunId: null })
  })

  test("persists the partial assistant message when a mid-response run is cancelled", async () => {
    const partial = "Let me start by checking the pipeline logs"
    const controlled = partialTextThenBlockingModel(partial)
    const sixb = buildSixb(controlled.model, new InMemoryBroker(), new RecordingSandboxFactory())
    const storage = agentStorageOf(sixb)

    const request = await requestAgent(sixb, { text: "go" })

    const worker = new AgentWorker(sixb, workerOptions())
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

      const run = await waitForTerminalRun(storage, request.run.id)
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

  test("keeps the partial answer of a turn interrupted by a worker stop, ready to resume", async () => {
    // Regression proof: drop `stopSignal` from the worker's runAgentTurn call, or record the raw
    // error instead of AgentTurnInterruptedError in AgentWorker.execute; the run ends with no
    // finish reason, like a user's own stop.
    const partial = "Let me start by checking the pipeline logs"
    const controlled = partialTextThenBlockingModel(partial)
    const sixb = buildSixb(controlled.model, new InMemoryBroker(), new RecordingSandboxFactory())
    const storage = agentStorageOf(sixb)
    const request = await requestAgent(sixb, { text: "go" })

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    await controlled.waitForStarted()
    await waitFor(
      async () => {
        const records = await listRunStreamRecords(sixb.broker, request.run.id)
        return JSON.stringify(records).includes(partial) ? true : null
      },
      { label: "partial text streamed" }
    )
    await worker.stop()

    expect(await storage.runs.getById({ projectId: PROJECT_ID, id: request.run.id })).toMatchObject(
      { status: "cancelled", finishReason: "interrupted" }
    )
    const assistant = (await listMessages(storage, request.run.threadId)).find(
      (message) => message.role === "assistant"
    )
    expect(assistant?.parts).toContainEqual({ type: "text", text: partial })
    expect(
      (await listRunStreamRecords(sixb.broker, request.run.id)).find(
        (record) => record.name === "agent.run.finished"
      )?.payload
    ).toMatchObject({ status: "cancelled", finishReason: "interrupted", attempt: 1 })
    expect(
      await storage.threads.getById({ projectId: PROJECT_ID, id: request.run.threadId })
    ).toMatchObject({ activeRunId: null })
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
    const workerSixb = withStorage(sixb, observedStorage)

    const worker = new AgentWorker(workerSixb, workerOptions())
    await worker.start()
    try {
      const {
        run: { id: runId },
      } = await requestAgent(sixb, { text: "echo hi" })
      await waitForTerminalRun(storage, runId)

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
        run: { threadId, id: runId },
      } = await requestAgent(sixb, { text: "echo hi" })
      const run = await waitForTerminalRun(storage, runId)

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
          async publishCompactionStarted() {
            throw new Error("sink down")
          },
          async publishCompactionCompleted() {
            throw new Error("sink down")
          },
          async publishCompactionFailed() {
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
        run: { threadId, id: runId },
      } = await requestAgent(sixb, { text: "echo hi" })
      const run = await waitForTerminalRun(storage, runId)

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
    const request = await requestAgent(sixb, { text: "echo hi" })
    const run = await storage.runs.start({
      id: request.run.id,
      projectId: PROJECT_ID,
      execution: freshTestExecution(),
    })

    const circular: Record<string, unknown> = {}
    circular.self = circular
    const output = circular as JsonValue
    const originalConsoleError = console.error
    console.error = () => {}
    try {
      await createBrokerStreamSink({
        broker: sixb.broker,
        projectId: PROJECT_ID,
      }).publishUiChunk({
        run,
        chunkIndex: 0,
        chunk: { type: "tool-output-available", toolCallId: "call-1", toolName: "echo", output },
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

  test("ends a crashed turn as interrupted on redelivery without calling the model", async () => {
    // Regression proof: drop the running-run branch in AgentWorker.execute; the turn is replayed,
    // the model is called again, and the run succeeds on attempt 2.
    const model = toolThenAnswerModel()
    const sixb = buildSixbWithEchoTool(model)
    const storage = agentStorageOf(sixb)
    const modelCalls = spyOn(model, "stream")

    // Trigger normally, then simulate a worker that crashed after starting the durable run: its
    // projected lease has lapsed, as it has whenever the queue redelivers a dead delivery's job.
    const request = await requestAgent(sixb, { text: "echo hi" })
    const crashedExecution = {
      ...freshTestExecution(),
      queueLeaseExpiresAt: new Date(Date.now() - 1),
    }
    await storage.runs.start({
      id: request.run.id,
      projectId: PROJECT_ID,
      execution: crashedExecution,
    })

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const interrupted = await waitForTerminalRun(storage, request.run.id)
      expect(interrupted).toMatchObject({
        status: "cancelled",
        finishReason: "interrupted",
        attempt: 2,
        error: { code: "runtime.cancelled" },
      })
      expect(modelCalls).not.toHaveBeenCalled()
      expect(
        (await listMessages(storage, request.run.threadId)).filter((m) => m.role === "assistant")
      ).toHaveLength(0)
      expect(
        await storage.threads.getById({ projectId: PROJECT_ID, id: request.run.threadId })
      ).toMatchObject({ activeRunId: null })

      const streamRecords = await listRunStreamRecords(sixb.broker, request.run.id)
      expect(streamRecords.some((record) => record.name === "agent.run.started")).toBe(false)
      expect(
        streamRecords.find((record) => record.name === "agent.run.finished")?.payload
      ).toMatchObject({
        type: "agent.run.finished",
        status: "cancelled",
        finishReason: "interrupted",
        attempt: 2,
      })

      // The dead delivery's token was rotated before the run ended, so it can write nothing.
      await expect(
        storage.runs.finish({
          projectId: PROJECT_ID,
          id: request.run.id,
          executionToken: crashedExecution.token,
          status: "succeeded",
        })
      ).rejects.toBeInstanceOf(AgentStorageError)
    } finally {
      await worker.stop()
      modelCalls.mockRestore()
    }
  })

  test("leaves a turn whose delivery still holds its lease to that delivery", async () => {
    // Regression proof: drop the projected-lease check in AgentWorker.execute; the duplicate job
    // ends the live turn as interrupted.
    const sixb = buildSixb(answerModel())
    const storage = agentStorageOf(sixb)
    const request = await requestAgent(sixb, { text: "hello" })
    const [delivered] = await sixb.queues.agents.claim({
      projectId: PROJECT_ID,
      workerId: "live-owner",
      leaseMs: 60_000,
    })
    if (!delivered) throw new Error("Expected the request's job.")
    await sixb.queues.agents.complete({
      projectId: PROJECT_ID,
      jobId: delivered.job.id,
      leaseId: delivered.leaseId,
    })
    const ownerExecution = freshTestExecution()
    await storage.runs.start({
      id: request.run.id,
      projectId: PROJECT_ID,
      execution: ownerExecution,
    })
    await sixb.queues.agents.enqueue({
      projectId: PROJECT_ID,
      jobs: [{ type: "agent.run.requested", payload: { runId: request.run.id } }],
    })
    const retries: (string | undefined)[] = []
    const retry = sixb.queues.agents.retry.bind(sixb.queues.agents)
    const retried = spyOn(sixb.queues.agents, "retry").mockImplementation(async (input) => {
      retries.push(input.availableAt)
      await retry(input)
    })

    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      await waitFor(async () => (retries.length > 0 ? retries : null), {
        label: "duplicate job deferred",
      })
      expect(retries[0]).toBe(ownerExecution.queueLeaseExpiresAt.toISOString())
      expect(
        await storage.runs.getById({ projectId: PROJECT_ID, id: request.run.id })
      ).toMatchObject({ status: "running", attempt: 1, execution: { token: ownerExecution.token } })
    } finally {
      await worker.stop()
      retried.mockRestore()
    }
  })

  test("retries a turn's preparation in place instead of leaving it to a redelivery", async () => {
    // Regression proof: rethrow every failure from retryPreparationInPlace; the run fails on the
    // first storage blip.
    const sixb = buildSixb(answerModel())
    const storage = agentStorageOf(sixb)
    const { host, reads } = withFailingExecutionReads(sixb, (read) => read === 1)

    // Fake timers stand in for the in-place preparation backoff.
    jest.useFakeTimers()
    const start = Date.now()
    const worker = new AgentWorker(host, workerOptions())
    try {
      await worker.start()
      const request = await requestAgent(sixb, { text: "hello" })
      const run = await underFakeTime(
        () => terminalRun(storage, request.run.id),
        "run prepared after a storage blip"
      )
      // One in-place preparation retry: 250ms.
      expectBackoffSpent(start, 250)
      expect(run).toMatchObject({ status: "succeeded", attempt: 1 })
      expect(reads.count).toBeGreaterThanOrEqual(2)
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test("fails the turn in place once preparation retries reach the delivery cap", async () => {
    // Regression proof: rethrow preparation failures for a redelivery instead of recording them;
    // the job is retried and the thread stays locked.
    const sixb = buildSixb(answerModel())
    attachSixbErrorReporter(sixb, () => {})
    const storage = agentStorageOf(sixb)
    const { host, reads } = withFailingExecutionReads(sixb, () => true)
    const request = await requestAgent(sixb, { text: "hello" })
    // Spend earlier deliveries so this one starts one retry short of the cap.
    for (let attempt = 1; attempt < MAX_AGENT_DELIVERY_ATTEMPTS - 1; attempt += 1) {
      const [claimed] = await sixb.queues.agents.claim({ projectId: PROJECT_ID, workerId: "spent" })
      if (!claimed) throw new Error("Expected the request's job.")
      await sixb.queues.agents.retry({
        projectId: PROJECT_ID,
        jobId: claimed.job.id,
        leaseId: claimed.leaseId,
      })
    }
    const retried = spyOn(sixb.queues.agents, "retry")

    jest.useFakeTimers()
    const start = Date.now()
    const worker = new AgentWorker(host, workerOptions())
    try {
      await worker.start()
      const run = await underFakeTime(
        () => terminalRun(storage, request.run.id),
        "run failed after its last preparation retry"
      )
      // The last in-place preparation retry: 250ms.
      expectBackoffSpent(start, 250)
      expect(run).toMatchObject({ status: "failed", attempt: 1 })
      expect(reads.count).toBe(2)
      expect(
        await storage.threads.getById({ projectId: PROJECT_ID, id: request.run.threadId })
      ).toMatchObject({ activeRunId: null })
      expect(retried).not.toHaveBeenCalled()
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
      retried.mockRestore()
    }
  })

  test("ends a turn stopped during its preparation backoff as interrupted", async () => {
    // Regression proof: record the raw abort for a worker stop in AgentWorker.execute's catch;
    // the run has no finish reason and nothing to resume.
    const sixb = buildSixb(answerModel())
    const storage = agentStorageOf(sixb)
    const { host, reads } = withFailingExecutionReads(sixb, () => true)
    const request = await requestAgent(sixb, { text: "hello" })

    const worker = new AgentWorker(host, workerOptions())
    await worker.start()
    await waitFor(async () => (reads.count > 0 ? true : null), { label: "first blip" })
    await worker.stop()

    expect(await storage.runs.getById({ projectId: PROJECT_ID, id: request.run.id })).toMatchObject(
      { status: "cancelled", finishReason: "interrupted" }
    )
    expect(
      await storage.threads.getById({ projectId: PROJECT_ID, id: request.run.threadId })
    ).toMatchObject({ activeRunId: null })
  })

  test("keeps a deferred duplicate deferred, even during shutdown or under clock skew", async () => {
    // Regression proof: drop the AgentRunOwnedElsewhereError case from onAbortError; a duplicate
    // delivered during shutdown is failed and its live run is orphaned.
    const sixb = buildSixb(answerModel())
    const worker = new InspectableAgentWorker(sixb, workerOptions())
    const now = new Date().toISOString()
    const claimed: ClaimedQueueJob<AgentQueueJob> = {
      leaseId: "lease-1",
      claimedAt: now,
      leaseExpiresAt: now,
      job: {
        id: "job-1",
        projectId: PROJECT_ID,
        createdAt: now,
        availableAt: now,
        attempt: 2,
        type: "agent.run.requested",
        payload: { runId: "run-1" },
      },
    }
    const ownedUntil = new Date(Date.now() + 60_000)
    const owned = new AgentRunOwnedElsewhereError("run-1", ownedUntil)
    for (const decision of [
      await worker.decideExecutionError(claimed, owned),
      worker.decideAbortError(claimed, owned),
    ]) {
      expect(decision).toEqual({ kind: "retry", availableAt: ownedUntil.toISOString() })
    }

    // A lease that lapses in a moment, or by a skewed clock already has, still waits a second.
    const skewed = new AgentRunOwnedElsewhereError("run-1", new Date(Date.now() + 10))
    const decision = await worker.decideExecutionError(claimed, skewed)
    expect(decision.kind).toBe("retry")
    expect(
      Date.parse(decision.kind === "retry" ? (decision.availableAt ?? "") : "")
    ).toBeGreaterThanOrEqual(Date.now() + 900)
  })

  test("lets whichever stop fired first decide whether a turn was interrupted", () => {
    for (const first of ["user", "worker"] as const) {
      const user = new AbortController()
      const worker = new AbortController()
      const turn = AbortSignal.any([worker.signal, user.signal])
      for (const stop of first === "user" ? [user, worker] : [worker, user]) stop.abort()
      expect(stoppedByWorker(turn, worker.signal)).toBe(first === "worker")
    }
  })

  test("a stale worker records billable calls but cannot write the fenced run or message", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    const {
      run: { threadId, id: runId },
    } = await requestAgent(sixb, {
      text: "echo hi",
    })

    // This worker started the run, but another delivery rotated its execution token.
    const staleRun = requireConversationRun(
      await storage.runs.start({
        id: runId,
        projectId: PROJECT_ID,
        execution: freshTestExecution(),
      })
    )
    await storage.runs.reclaim({
      projectId: PROJECT_ID,
      id: runId,
      execution: freshTestExecution(),
    })

    const promise = runAgentTurn({
      context: {
        id: PROJECT_ID,
        authorPrincipal: AGENT_PRINCIPAL,
        storage: workerStorageOf(sixb.storage),
        blobStorage: sixb.blobStorage,
        tools: echoTool,
        systemPrompt: testSystemPrompt(),
        projectTimeZone: "UTC",
        streamSink: NOOP_STREAM_SINK,
        recoverAiModelCall: recoverAiModelCall(sixb),
        turnTimeoutMs: 60_000,
      },
      plan: executionPlanFor(sixb),
      run: staleRun,
      signal: new AbortController().signal,
    })
    expect(await promise.catch((error: unknown) => error)).toBeInstanceOf(AgentExecutionLostError)

    // No assistant message was written; the run is still owned by the reclaiming worker. Usage is
    // intentionally not fenced because the completed provider calls remain billable.
    const messages = await listMessages(storage, threadId)
    expect(messages.every((message) => message.role !== "assistant")).toBe(true)
    const run = await storage.runs.getById({ projectId: PROJECT_ID, id: runId })
    expect(run?.status).toBe("running")
    await expect(
      aiUsageStorageOf(sixb).summarizeExecution({
        projectId: PROJECT_ID,
        executionId: staleRun.executionId,
      })
    ).resolves.toMatchObject({
      modelCallCount: 2,
      usage: { inputTokens: 20, outputTokens: 14, totalTokens: 34 },
    })
  })

  test("executes the authoritative model instance from the project catalog", async () => {
    let declaredCalls = 0
    const declaredModel = new WorkerTestModel({
      modelId: "shared-model",
      stream: async () => {
        declaredCalls += 1
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Wrong binding" },
          { type: "text-end", id: "t" },
          finish("stop"),
        ])
      },
    })
    let catalogCalls = 0
    const catalogModel = new WorkerTestModel({
      modelId: "shared-model",
      stream: async (request) => {
        expect(request.maxOutputTokens).toBe(16_384)
        catalogCalls += 1
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Catalog binding" },
          { type: "text-end", id: "t" },
          finish("stop"),
        ])
      },
    })
    const sixb = buildSixb(declaredModel, new InMemoryBroker(), new RecordingSandboxFactory(), {
      models: { language: [catalogModel] },
    })
    const worker = new AgentWorker(sixb, workerOptions())

    await worker.start()
    try {
      const request = await requestAgent(sixb, { text: "hello" })
      const run = await waitFor(
        async () => {
          const current = await agentStorageOf(sixb).runs.getById({
            projectId: PROJECT_ID,
            id: request.run.id,
          })
          return current?.status === "succeeded" ? current : null
        },
        { label: "catalog-backed agent run" }
      )

      expect(run.modelId).toBe("shared-model")
      expect(declaredCalls).toBe(0)
      expect(catalogCalls).toBe(1)
    } finally {
      await worker.stop()
    }
  })

  test("reports a terminal model failure exactly once with the original error", async () => {
    const originalError = new Error("provider boom")
    const failingModel = new WorkerTestModel({
      modelId: "mock-model",
      stream: async () => ({
        stream: new ReadableStream<WorkerTestStreamEvent>({
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
        run: { threadId, id: runId },
      } = await requestAgent(sixb, { text: "hi" })
      const run = await waitForTerminalRun(storage, runId)
      expect(run.status).toBe("failed")
      expect(run.error).toMatchObject({
        code: "agent.execution_failed",
        message: "Agent execution failed.",
        retryable: false,
        details: { runId: run.id, threadId },
      })
      expect(run.error?.at).toBe(run.completedAt?.toISOString())
      await reporter.flush()
      expect(reports).toHaveLength(1)
      expect(reports[0]?.error).toBe(originalError)
      expect(reports[0]?.context).toMatchObject({
        type: "run.failed",
        notificationId: `project:${PROJECT_ID}:run:agent:${run.id}:failed:${run.error?.at}`,
        projectId: PROJECT_ID,
        attempt: 1,
        runKind: "agent",
        run: { runId: run.id, threadId },
        failure: run.error,
      })
      expect(reports[0]?.context.occurredAt).toBe(run.error?.at ?? "")
      expect(
        (await listRunStreamRecords(sixb.broker, run.id)).find(
          (record) => record.name === "agent.run.finished"
        )?.payload
      ).toMatchObject({
        type: "agent.run.finished",
        status: "failed",
        runId: run.id,
        attempt: 1,
        error: run.error,
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
    const answerModel = new WorkerTestModel({
      modelId: "mock-model",
      stream: async () =>
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
        run: { threadId, id: runId },
      } = await requestAgent(sixb, { text: "hi" })
      const run = await waitForTerminalRun(storage, runId)
      expect(run.status).toBe("failed")
      expect(run.error).toMatchObject({
        code: "agent.execution_failed",
        message: "Agent execution failed.",
        retryable: false,
        details: { runId: run.id, threadId },
      })

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

  test("absorbs a transient finalize blip in place: one run, one message, no lock", async () => {
    const sixb = buildSixbWithEchoTool(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    // The worker sees a storage whose `finish` fails twice before succeeding; the trigger keeps using
    // the real storage (both delegate to the same underlying state).
    const workerSixb = withStorage(sixb, withFlakyAgentFinishStorage(sixb.storage, 2))

    // Fake timers stand in for the in-place finalization backoff.
    jest.useFakeTimers()
    const start = Date.now()
    const worker = new AgentWorker(workerSixb, workerOptions())
    try {
      await worker.start()
      const {
        run: { threadId, id: runId },
      } = await requestAgent(sixb, { text: "echo hi" })
      const run = await underFakeTime(() => terminalRun(storage, runId), "run finalized after blip")
      // Two finalization retries: 50 + 200ms.
      expectBackoffSpent(start, 250)

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
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test("rolls back the assistant message when finalization fails before redelivery", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    const request = await requestAgent(sixb, { text: "echo hi" })
    const run = requireConversationRun(
      await storage.runs.start({
        id: request.run.id,
        projectId: PROJECT_ID,
        execution: freshTestExecution(),
      })
    )

    const failingStorage = withAlwaysFailingTransactionalFinish(sixb.storage)
    // Fake timers stand in for the in-place finalization backoff the failure exhausts.
    jest.useFakeTimers()
    const start = Date.now()
    try {
      const turn = runAgentTurn({
        context: {
          id: PROJECT_ID,
          authorPrincipal: AGENT_PRINCIPAL,
          storage: workerStorageOf(failingStorage),
          blobStorage: sixb.blobStorage,
          tools: echoTool,
          systemPrompt: testSystemPrompt(),
          projectTimeZone: "UTC",
          streamSink: createBrokerStreamSink({
            broker: sixb.broker,
            projectId: PROJECT_ID,
          }),
          recoverAiModelCall: recoverAiModelCall(sixb),
          turnTimeoutMs: 60_000,
        },
        plan: executionPlanFor(sixb),
        run,
        signal: new AbortController().signal,
      })
      const error = await settleUnderFakeTime(turn, "finalization retries").catch(
        (caught: unknown) => caught
      )
      expect(error).toBeInstanceOf(AgentFinalizationError)
      // Every finalization retry: 50 + 200 + 600ms.
      expectBackoffSpent(start, 850)
    } finally {
      jest.useRealTimers()
    }

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

    const reclaimed = requireConversationRun(
      await storage.runs.reclaim({
        projectId: PROJECT_ID,
        id: request.run.id,
        execution: freshTestExecution(),
      })
    )
    await runAgentTurn({
      context: {
        id: PROJECT_ID,
        authorPrincipal: AGENT_PRINCIPAL,
        storage: workerStorageOf(sixb.storage),
        blobStorage: sixb.blobStorage,
        tools: echoTool,
        systemPrompt: testSystemPrompt(),
        projectTimeZone: "UTC",
        streamSink: createBrokerStreamSink({
          broker: sixb.broker,
          projectId: PROJECT_ID,
        }),
        recoverAiModelCall: recoverAiModelCall(sixb),
        turnTimeoutMs: 60_000,
      },
      plan: executionPlanFor(sixb),
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

  test("persists partial progress when a turn exceeds its wall-clock budget", async () => {
    const partial = "I found the relevant deployment and started checking its logs"
    const controlled = partialTextThenBlockingModel(partial)
    const sixb = buildSixb(controlled.model, new InMemoryBroker(), new RecordingSandboxFactory())
    const storage = agentStorageOf(sixb)
    let reportCount = 0
    const reporter = attachSixbErrorReporter(sixb, () => {
      reportCount += 1
    })

    // The turn's budget elapses on fake time, once the partial answer has streamed.
    jest.useFakeTimers()
    const worker = new AgentWorker(sixb, workerOptions({ turnTimeoutMs: 100 }))
    try {
      await worker.start()
      const request = await requestAgent(sixb, { text: "investigate" })
      await underFakeTime(
        async () => {
          const records = await listRunStreamRecords(sixb.broker, request.run.id)
          return JSON.stringify(records).includes(partial)
        },
        "partial text streamed before timeout",
        0
      )
      jest.advanceTimersByTime(100)
      const run = await underFakeTime(
        () => terminalRun(storage, request.run.id),
        "partial run timed out",
        0
      )

      expect(run.status).toBe("failed")
      // Regression proof: routing this timeout through generic finalization omits both the
      // stable finish reason and duration that distinguish it from an ordinary failure.
      expect(run.finishReason).toBe("timeout")
      expect(run.error).toMatchObject({
        code: "agent.execution_failed",
        details: { timeoutMs: "100" },
      })

      const messages = await listMessages(storage, request.run.threadId)
      const assistant = messages.find((message) => message.role === "assistant")
      expect(assistant?.parts).toContainEqual({ type: "text", text: partial })

      const streamNames = (await listRunStreamRecords(sixb.broker, request.run.id)).map(
        (record) => record.name
      )
      expect(streamNames.indexOf("agent.message.finalized")).toBeGreaterThan(-1)
      expect(streamNames.indexOf("agent.message.finalized")).toBeLessThan(
        streamNames.indexOf("agent.run.finished")
      )

      const thread = await storage.threads.getById({
        projectId: PROJECT_ID,
        id: request.run.threadId,
      })
      expect(thread?.activeRunId).toBeNull()
      await reporter.flush()
      expect(reportCount).toBe(0)
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test("fails without an assistant message when a turn times out before producing content", async () => {
    let modelStarted = false
    const sixb = buildSixb(
      hangingModel(() => {
        modelStarted = true
      })
    )
    const storage = agentStorageOf(sixb)

    jest.useFakeTimers()
    const worker = new AgentWorker(sixb, workerOptions({ turnTimeoutMs: 50 }))
    try {
      await worker.start()
      const {
        run: { threadId, id: runId },
      } = await requestAgent(sixb, { text: "hang" })
      await underFakeTime(() => modelStarted, "model stream started", 0)
      jest.advanceTimersByTime(50)
      const run = await underFakeTime(() => terminalRun(storage, runId), "run timed out", 0)

      expect(run.status).toBe("failed")
      expect(run.error).toMatchObject({
        code: "agent.execution_failed",
        message: "Agent execution failed.",
        retryable: false,
        details: { runId: run.id, threadId, timeoutMs: "50" },
      })
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
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test("records a timeout finish reason when preflight compaction exceeds the turn budget", async () => {
    let summaryStarted = false
    const sixb = buildSixb(
      hangingCompactionModel(() => {
        summaryStarted = true
      })
    )
    const storage = agentStorageOf(sixb)
    let reportCount = 0
    const reporter = attachSixbErrorReporter(sixb, () => {
      reportCount += 1
    })
    const threadId = "preflight_compaction_timeout_thread"
    await storage.threads.create({
      id: threadId,
      projectId: PROJECT_ID,
      ownerPrincipal: REQUESTER,
    })
    await seedCompletedConversationTurn({
      sixb,
      threadId,
      index: 0,
      text: "Summarize the historical investigation.",
      assistantText: `historical-result ${"x".repeat(460_000)}`,
    })

    jest.useFakeTimers()
    const worker = new AgentWorker(sixb, workerOptions({ turnTimeoutMs: 50 }))
    try {
      await worker.start()
      const request = await requestAgentAs(sixb, REQUESTER, {
        threadId,
        text: "Continue after compacting the thread.",
      })
      await underFakeTime(() => summaryStarted, "summary request started", 0)
      jest.advanceTimersByTime(50)
      const run = await underFakeTime(
        () => terminalRun(storage, request.run.id),
        "preflight compaction timeout",
        0
      )

      expect(run.status).toBe("failed")
      expect(run.finishReason).toBe("timeout")
      expect(run.error).toMatchObject({
        code: "agent.execution_failed",
        details: { timeoutMs: "50" },
      })
      await expect(
        storage.checkpoints.getLatest({ projectId: PROJECT_ID, threadId })
      ).resolves.toBeNull()
      expect(
        (await listRunStreamRecords(sixb.broker, run.id)).map((record) => record.name)
      ).toContain("agent.compaction.started")
      await reporter.flush()
      expect(reportCount).toBe(0)
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  test("terminalizes a queued run whose model is unavailable", async () => {
    // Regression proof: immediately failing permanent delivery errors leaves the main run queued.
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
    const executionId = await createTestAgentExecution(sixb.storage, {
      projectId: PROJECT_ID,
      runId,
      requesterGroupIds: ["engineering"],
    })
    await storage.runs.create({
      id: runId,
      projectId: PROJECT_ID,
      executionId,
      threadId,
      triggerMessageId,
      spec: { model: { provider: "test", modelId: "test-model" } },
    })
    // The run's own job id, as a request enqueues it, so the worker's dispatch scan cannot add a
    // second job for the same run.
    await sixb.queues.agents.enqueue({
      projectId: PROJECT_ID,
      jobs: [
        {
          id: agentRunQueueJobId(runId),
          type: "agent.run.requested",
          payload: { runId },
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
      expect(failed).toMatchObject({
        status: "failed",
        attempt: 1,
        error: {
          code: "agent.execution_failed",
          retryable: false,
          message: "Agent execution failed.",
        },
      })
      await reporter.flush()
      expect(reports).toHaveLength(1)
      expect(reports[0]?.error).toMatchObject({
        code: "agent.execution_failed",
        retryable: false,
        message:
          "[SixbAgentWorker] The conversation's language model is not available in models.language.",
      })
      expect(reports[0]?.context).toMatchObject({
        projectId: PROJECT_ID,
        attempt: 1,
        runKind: "agent",
        run: { runId, threadId },
        failure: failed.error,
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
    } = await requestAgent(sixb, {
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
          payload: { runId: createAgentRunId() },
        },
      ],
    })

    const completion = observeQueueSettlement(sixb.queues.agents)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      // The worker settles the orphan job. The active run must be untouched: not reclaimed, no
      // second run created, and no assistant message written.
      await completion.wait()
      expect(completion.outcome()).toBe("fail")

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
      completion.restore()
    }
  })
})

describe("agent tools act as the requester", () => {
  const financial = defineMarking("financial")
  const Customer = defineObjectType({
    id: "customer",
    name: "Customer",
    properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
  })
  const Invoice = defineObjectType({
    id: "invoice",
    name: "Invoice",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("title", "string"),
      prop("amount", "double", { markings: [financial] }),
    ],
  })
  const finance = defineGroup("finance")
  const sales = defineGroup("sales")
  const FINANCE_USER = { type: "user", id: "usr_finance" } as const
  const SALES_USER = { type: "user", id: "usr_sales" } as const

  const readInvoice = defineAgentTool("read_invoice")
    .description("Read an invoice and its customer.")
    .input({ invoiceId: "string" })
    .run(async ({ input, sixb }) => {
      const invoice = await sixb.objects(Invoice).get(input.invoiceId)
      const customer = await sixb
        .objects(Customer)
        .get("c1")
        .then((row) => row?.properties.name ?? null, deniedOrThrow)
      return {
        invoice: invoice?.properties ?? null,
        redactions: invoice?.redactions ?? null,
        customer,
      }
    })

  function deniedOrThrow(error: unknown): "denied" {
    if (error instanceof AuthorizationError) return "denied"
    throw error
  }

  const SUMMARY_PROMPT = "Summarize invoice inv-1."
  // Passes no signal of its own: only the run can cancel its model call.
  const summarizeInvoice = defineAgentTool("summarize_invoice")
    .description("Summarize an invoice with the project's model.")
    .input({})
    .run(async ({ sixb }) => {
      const { output } = await sixb.models.language.generate({ prompt: SUMMARY_PROMPT })
      return { summary: output }
    })

  /** Call one tool, then answer once the conversation holds a reply; answer tools directly. */
  function toolCallThenAnswerModel(
    toolName: string,
    input: Readonly<Record<string, string>>,
    options: {
      readonly onAgentCall?: () => void
      readonly onToolCall?: (request: LanguageModelRequest) => Promise<never>
    } = {}
  ): WorkerTestModel {
    const text = (value: string) => ({
      content: [{ type: "text" as const, text: value }],
      finishReason: "stop" as const,
      usage: USAGE,
    })
    return new WorkerTestModel({
      modelId: "mock-model",
      generate: async (request) => {
        const { messages } = request
        const [first] = messages
        const fromTool =
          first?.role === "user" &&
          first.content.some((part) => part.type === "text" && part.text === SUMMARY_PROMPT)
        if (fromTool) return options.onToolCall?.(request) ?? text("Paid in full.")
        options.onAgentCall?.()
        if (messages.some((message) => message.role !== "system" && message.role !== "user")) {
          return text(JSON.stringify({ answer: "Done.", confidence: 1 }))
        }
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `call-${toolName}`,
              toolName,
              input: JSON.stringify(input),
            },
          ],
          finishReason: "tool-calls",
          usage: USAGE,
        }
      },
    })
  }

  async function seedInvoice(host: TestSixb): Promise<void> {
    const trusted = createTestSixb(host)
    await trusted.objects(Customer).upsert({ properties: { id: "c1", name: "Acme" } })
    await trusted.objects(Invoice).upsert({
      properties: { id: "inv-1", title: "Alpha", amount: 120 },
    })
  }

  async function seedMember(
    host: TestSixb,
    user: TestUser,
    groupIds: readonly string[]
  ): Promise<void> {
    await seedRequesterUser(host.storage, user)
    for (const groupId of groupIds) {
      await authStorageOf(host).groupMemberships.upsert({
        projectId: PROJECT_ID,
        userId: user.id,
        groupId,
        source: "manual",
      })
    }
  }

  function toolOutput(parts: readonly AgentMessagePart[], toolName: string): unknown {
    const call = parts.find((part) => part.type === "tool-call" && part.toolName === toolName)
    if (call?.type !== "tool-call" || call.state !== "output-available") {
      throw new Error(`Expected a '${toolName}' result.`)
    }
    return call.output
  }

  async function chatToolOutput(host: TestSixb, user: TestUser, toolName: string) {
    const request = await requestAgentAs(host, user, { text: "Read invoice inv-1." })
    const run = await waitForTerminalRun(agentStorageOf(host), request.run.id)
    expect(run.status).toBe("succeeded")
    const messages = await listMessages(agentStorageOf(host), request.run.threadId)
    return toolOutput(
      messages.flatMap((message) => message.parts),
      toolName
    )
  }

  // Regression proof: hand tools an unrestricted SDK in run-environment.ts instead of the run's
  // `context.sixb`; the sales user then reads the amount and the customer.
  test("a chat tool sees exactly what the requesting user sees", async () => {
    const sixb = buildSixb(
      toolCallThenAnswerModel(readInvoice.name, { invoiceId: "inv-1" }),
      new InMemoryBroker(),
      new RecordingSandboxFactory(),
      {
        projectTools: [readInvoice],
        security: {
          ontology: [Customer, Invoice],
          markings: [financial],
          groups: [finance, sales],
          roles: [
            defineRole("invoice-readers", {
              grantedTo: [finance, sales],
              grants: [can.run(agent), can.view(Invoice)],
            }),
            defineRole("finance-access", {
              grantedTo: [finance],
              grants: [can.view(Customer)],
              clearances: [financial],
            }),
          ],
        },
      }
    )
    await seedInvoice(sixb)
    await seedMember(sixb, FINANCE_USER, [finance.id])
    await seedMember(sixb, SALES_USER, [sales.id])
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      await expect(chatToolOutput(sixb, FINANCE_USER, readInvoice.name)).resolves.toEqual({
        invoice: { id: "inv-1", title: "Alpha", amount: 120 },
        redactions: null,
        customer: "Acme",
      })
      await expect(chatToolOutput(sixb, SALES_USER, readInvoice.name)).resolves.toEqual({
        invoice: { id: "inv-1", title: "Alpha" },
        redactions: { amount: { reason: "missing_clearance" } },
        customer: "denied",
      })
    } finally {
      await worker.stop()
    }
  })

  // Regression proof: same as above, the step's service account then reads the amount and the
  // customer its groups do not grant.
  test("a workflow tool sees what the step's groups grant", async () => {
    const billing = defineGroup("billing-agents")
    const { sixb, runs, workflow, agentStep, nodeRunId } = await queueWorkflowAgentNode({
      model: toolCallThenAnswerModel(readInvoice.name, { invoiceId: "inv-1" }),
      tools: [readInvoice],
      runId: "workflow-tool-authority",
      requesterGroupIds: [finance.id],
      security: {
        ontology: [Customer, Invoice],
        markings: [financial],
        groups: [billing],
        roles: [
          defineRole("billing-invoices", { grantedTo: [billing], grants: [can.view(Invoice)] }),
        ],
      },
    })
    // The workflow worker provisions the step's identity before it queues the node.
    await ensureManagedAgentExecutionIdentity({
      auth: sixb.storage.auth,
      projectId: PROJECT_ID,
      actorId: workflowAgentStepActorId(workflow.id, agentStep.id),
      name: "Billing step",
      description: "Workflow task",
      groupIds: [billing.id],
    })
    await seedInvoice(sixb)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const node = await waitFor(() => terminalAgentNode(runs, nodeRunId), {
        label: "workflow tool node terminal",
      })
      expect(node.status).toBe("succeeded")
      expect(toolOutput(node.trace ?? [], readInvoice.name)).toEqual({
        invoice: { id: "inv-1", title: "Alpha" },
        redactions: { amount: { reason: "missing_clearance" } },
        customer: "denied",
      })
    } finally {
      await worker.stop()
    }
  })

  const readAttachment = defineAgentTool("read_attachment")
    .description("Read a file attached to the run.")
    .input({ key: "string" })
    .run(async ({ input, attachments }) => {
      const file = await attachments.open(input.key)
      if (!file) return null
      return { fileName: file.fileRef.fileName ?? null, text: await new Response(file.body).text() }
    })

  async function putQuote(host: TestSixb) {
    return host.blobStorage.put({
      body: new TextEncoder().encode("Quote 42"),
      fileName: "quote.txt",
      mediaType: "text/plain",
    })
  }

  // Regression proof: give conversations a child's handedToolAttachments in run-environment.ts;
  // the tool then cannot open the chat's file.
  test("lets a chat tool open the chat's attachment by the key the Agent sees", async () => {
    const sixb = buildSixb(
      toolCallThenAnswerModel(readAttachment.name, { key: "msg-quote:1" }),
      new InMemoryBroker(),
      new RecordingSandboxFactory(),
      { projectTools: [readAttachment] }
    )
    const quote = await putQuote(sixb)
    const worker = new AgentWorker(sixb, workerOptions())
    await worker.start()
    try {
      const request = await requestAgentAs(sixb, REQUESTER, {
        text: "Extract the attached quote.",
        attachments: [quote],
        messageId: "msg-quote",
      })
      const run = await waitForTerminalRun(agentStorageOf(sixb), request.run.id)
      expect(run.status).toBe("succeeded")
      const messages = await listMessages(agentStorageOf(sixb), request.run.threadId)
      expect(
        toolOutput(
          messages.flatMap((message) => message.parts),
          readAttachment.name
        )
      ).toEqual({ fileName: "quote.txt", text: "Quote 42" })
    } finally {
      await worker.stop()
    }
  })

  // Regression proofs: swap the subagent's and the workflow task's `toolAttachments` in
  // run-environment.ts; the child opens the input file and the task cannot. Give the child
  // nothing to open, and it cannot open the quote its parent handed it.
  test("gives a workflow task's tools its input files and a child's those its parent handed", async () => {
    const sixb = buildSixb(answerModel(), new InMemoryBroker(), new RecordingSandboxFactory(), {
      projectTools: [readAttachment],
    })
    const quote = await putQuote(sixb)
    const context = await buildAgentWorkerContext(sixb)
    const plan = executionPlanFor(sixb)
    const execution = freshTestExecution()
    const task = await createWorkflowAgentNodeEnvironment({
      context,
      plan,
      run: {
        projectId: PROJECT_ID,
        nodeRunId: "task-run:node:0",
        executionId: "task-execution",
        actorId: "task-actor",
        status: "running",
        prompt: "Read the quote.",
        attempt: 1,
        execution,
        createdAt: new Date(),
      },
      workflowId: "quotes",
      stepId: "read-quote",
      nodeInput: { quote: JSON.parse(JSON.stringify(quote)) },
      errorDetails: { workflowId: "quotes", agentStepId: "read-quote", runId: "task-run:node:0" },
    })
    // The environment reads only the run's identity, execution token and handed files, and its
    // thread's.
    const childRun = {
      id: "child-run",
      parentRunId: "parent-run",
      execution,
      spec: { files: [{ path: "inputs/quote.txt", fileRef: quote }] },
    } as unknown as SubagentRunRecord
    const childThread = {
      id: "child-thread",
      parent: { threadId: "parent-thread", spawnedBy: "parent-run", key: "quote" },
      createdAt: new Date(),
    } as unknown as AgentThreadRecord
    const child = await createSubagentEnvironment({
      context,
      plan,
      run: childRun,
      thread: childThread,
    })
    const openQuote = (environment: typeof task, key: string) => {
      const tool = environment.turnContext.tools.find(({ name }) => name === readAttachment.name)
      return tool?.execute(
        { key },
        { signal: new AbortController().signal, callId: "call", toolCallId: "call" }
      )
    }
    try {
      expect(JSON.parse(task.turnContext.attachmentContext?.manifestJson ?? "{}")).toMatchObject({
        attachments: [{ key: "input.quote", path: "input.quote" }],
      })
      expect(JSON.parse(child.turnContext.attachmentContext?.manifestJson ?? "{}")).toMatchObject({
        attachments: [{ key: "inputs/quote.txt", sandboxPath: "inputs/quote.txt" }],
      })
      const quoted = { fileName: "quote.txt", text: "Quote 42" }
      await expect(openQuote(task, "input.quote")).resolves.toEqual(quoted)
      await expect(openQuote(child, "inputs/quote.txt")).resolves.toEqual(quoted)
      await expect(openQuote(child, "input.quote")).rejects.toThrow(AgentToolPublicError)
      await expect(openQuote(task, "inputs/quote.txt")).rejects.toThrow(AgentToolPublicError)
    } finally {
      await Promise.all([task.dispose(), child.dispose()])
    }
  })

  function recordUsage(host: TestSixb) {
    const recorded: { readonly executionId: string; readonly attempt: number }[] = []
    const workerHost = withStorage(
      host,
      withAiUsageRecordInterceptor(host.storage, async ({ executionId, attempt }, record) => {
        recorded.push({ executionId, attempt })
        return record()
      })
    )
    return { workerHost, recorded }
  }

  // Regression proof: remove the bindAgentModelExecution call after the turn runtime in
  // worker.ts; the tool's generate() then fails without a bound execution attempt.
  test("accounts a tool's model call to the chat run like the Agent's own", async () => {
    const sixb = buildSixb(
      toolCallThenAnswerModel(summarizeInvoice.name, {}),
      new InMemoryBroker(),
      new RecordingSandboxFactory(),
      { projectTools: [summarizeInvoice] }
    )
    const request = await requestAgentAs(sixb, REQUESTER, { text: "Summarize inv-1." })
    const { workerHost, recorded } = recordUsage(sixb)
    const worker = new AgentWorker(workerHost, workerOptions())
    await worker.start()
    try {
      const run = await waitForTerminalRun(agentStorageOf(sixb), request.run.id)
      expect(run).toMatchObject({ status: "succeeded", attempt: 1 })
      const messages = await listMessages(agentStorageOf(sixb), request.run.threadId)
      expect(
        toolOutput(
          messages.flatMap((message) => message.parts),
          summarizeInvoice.name
        )
      ).toEqual({ summary: "Paid in full." })
      // The Agent's tool call, the tool's own call, then the Agent's answer.
      expect(recorded).toEqual(
        Array.from({ length: 3 }, () => ({ executionId: run.executionId, attempt: 1 }))
      )
    } finally {
      await worker.stop()
    }
  })

  // Regression proof: remove the bindAgentModelExecution call in workflow-node-execution.ts; the
  // tool's call fails, so only the node's own three calls are recorded.
  test("accounts a tool's model call to a workflow node like the node's own", async () => {
    const model = toolCallThenAnswerModel(summarizeInvoice.name, {})
    const { sixb, runs, nodeRunId, agentExecutionId } = await queueWorkflowAgentNode({
      model,
      models: { language: [model] },
      tools: [summarizeInvoice],
      runId: "workflow-tool-model-call",
    })
    const { workerHost, recorded } = recordUsage(sixb)
    const worker = new AgentWorker(workerHost, workerOptions())
    await worker.start()
    try {
      const node = await waitFor(() => terminalAgentNode(runs, nodeRunId), {
        label: "workflow tool model call node terminal",
      })
      expect(node.status).toBe("succeeded")
      expect(toolOutput(node.trace ?? [], summarizeInvoice.name)).toEqual({
        summary: "Paid in full.",
      })
      // The tool call, the tool's own call, the research answer, then the structured output.
      expect(recorded).toEqual(
        Array.from({ length: 4 }, () => ({ executionId: agentExecutionId, attempt: 1 }))
      )
    } finally {
      await worker.stop()
    }
  })

  // Regression proof: bind `turnSignal` instead of the node's deadline in
  // workflow-node-execution.ts; the tool's call then outlives the deadline and the test times out.
  test("cancels a tool's model call at the workflow node's deadline", async () => {
    let toolCallStarted = false
    let toolCallCancelled = false
    const model = toolCallThenAnswerModel(
      summarizeInvoice.name,
      {},
      {
        onToolCall: ({ signal }) =>
          new Promise((_, reject) => {
            toolCallStarted = true
            signal.addEventListener("abort", () => {
              toolCallCancelled = true
              reject(signal.reason)
            })
          }),
      }
    )
    const { sixb, runs, nodeRunId } = await queueWorkflowAgentNode({
      model,
      models: { language: [model] },
      tools: [summarizeInvoice],
      runId: "workflow-tool-deadline",
    })
    // The node's deadline passes on fake time, once the tool's call is in flight.
    jest.useFakeTimers()
    const worker = new AgentWorker(sixb, workerOptions({ turnTimeoutMs: 200 }))
    try {
      await worker.start()
      await underFakeTime(() => toolCallStarted, "tool's model call started", 0)
      jest.advanceTimersByTime(200)
      const node = await underFakeTime(
        () => terminalAgentNode(runs, nodeRunId),
        "workflow tool deadline node terminal",
        0
      )
      expect(node.status).not.toBe("succeeded")
      expect(toolCallCancelled).toBe(true)
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
    }
  })

  // Regression proof: stop passing `accounting` to bindAgentModelExecution, so the tool's calls
  // open their own recorder; the Agent then answers after the unrecorded call and the run succeeds.
  test("stops the run when a tool's model call cannot be accounted", async () => {
    let agentCalls = 0
    const sixb = buildSixb(
      toolCallThenAnswerModel(
        summarizeInvoice.name,
        {},
        {
          onAgentCall: () => {
            agentCalls += 1
          },
        }
      ),
      new InMemoryBroker(),
      new RecordingSandboxFactory(),
      { projectTools: [summarizeInvoice] }
    )
    const callIds: string[] = []
    const workerHost = withStorage(
      sixb,
      withAiUsageRecordInterceptor(sixb.storage, async (usage, record) => {
        if (!callIds.includes(usage.callId)) callIds.push(usage.callId)
        // The second call is the tool's: neither the ledger nor its durable recovery takes it.
        if (usage.callId === callIds[1]) throw new Error("usage storage unavailable")
        return record()
      })
    )
    const queue = sixb.queues.agents
    const enqueue = queue.enqueue.bind(queue)
    queue.enqueue = async (params) => {
      if (params.jobs.some((job) => job.type === "agent.ai-usage.record.requested")) {
        throw new Error("agent queue unavailable")
      }
      return enqueue(params)
    }
    // Fake timers stand in for the recorder's storage and recovery retry backoff.
    jest.useFakeTimers()
    const start = Date.now()
    const worker = new AgentWorker(workerHost, workerOptions())
    try {
      await worker.start()
      const request = await requestAgentAs(sixb, REQUESTER, { text: "Summarize inv-1." })
      const run = await underFakeTime(
        () => terminalRun(agentStorageOf(sixb), request.run.id),
        "unaccounted tool call run terminal"
      )
      // The recorder's storage retries, then its recovery retries: 2 × (50 + 200 + 600)ms.
      expectBackoffSpent(start, 1_700)
      expect(run.status).toBe("failed")
      expect(run.error?.code).toBe("agent.execution_failed")
      expect(callIds).toHaveLength(2)
      expect(agentCalls).toBe(1)
    } finally {
      await stopUnderFakeTime(worker)
      jest.useRealTimers()
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
    let attempts = 0
    const storage = finishingStorage(() => {
      attempts += 1
      return Promise.reject(new Error("db down"))
    })
    // Fake timers stand in for the in-place backoff between attempts.
    jest.useFakeTimers()
    const start = Date.now()
    try {
      const error = await settleUnderFakeTime(
        finishRunOrThrow(storage, succeededInput),
        "finalization retries"
      ).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(AgentFinalizationError)
      // Every finalization retry: 50 + 200 + 600ms.
      expectBackoffSpent(start, 850)
    } finally {
      jest.useRealTimers()
    }
    expect(attempts).toBe(4)
  })

  test("raises AgentExecutionLostError when the run is no longer ours", async () => {
    const storage = finishingStorage(() =>
      Promise.reject(new AgentStorageError("execution_lost", "gone"))
    )
    expect(
      await finishRunOrThrow(storage, succeededInput).catch((error: unknown) => error)
    ).toBeInstanceOf(AgentExecutionLostError)
  })
})
