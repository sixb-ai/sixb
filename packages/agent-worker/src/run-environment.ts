import type { AgentToolRunInfo, Sandbox, SandboxDefinition } from "@sixb/core"
import { resolveLoggingService } from "@sixb/core/internal/logging"
import { QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"
import type { WorkflowIOSnapshot } from "@sixb/core/internal/workflows"
import type { ModelTool } from "@sixb/core/models"
import type {
  AgentMessageRecord,
  AgentThreadRecord,
  ConversationAgentRunRecord,
  SubagentRunRecord,
  WorkflowAgentNodeRunRecord,
} from "@sixb/core/storage"
import { waitForAbort } from "./abort"
import { type AgentExecutionMode, renderAgentSystemPrompt } from "./agent-prompt"
import { assertAgentRuntimeProfile } from "./agent-runtime/preflight"
import type { AgentSkill } from "./agent-skills"
import { createAgentApiGatewayBaseUrl } from "./api-url"
import {
  modelSupportsInlineImages,
  type PreparedAgentAttachmentContext,
  prepareAgentAttachments,
} from "./attachments"
import type { AgentContextBudget } from "./context-budget"
import { prepareAgentConversationContext } from "./context-compaction"
import { AgentExecutionLostError } from "./errors"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import { type AgentErrorDetails, modelToolsFromAgentDefinitions } from "./model-adapters"
import { prepareAgentSandboxApiContext } from "./sandbox-api-context"
import { AgentSandboxFileRegistry } from "./sandbox-file-registry"
import type { AgentSandboxHandle } from "./sandbox-handle"
import { type AgentSandboxLifecycle, openThreadSandbox } from "./sandbox-lifecycle"
import type { LoadedAgentThreadModelContext } from "./thread-context"
import { AgentToolArtifactBudget, createAgentToolArtifacts } from "./tools/artifacts"
import { createBashTool } from "./tools/bash"
import { createReadTool } from "./tools/read"
import { AgentToolResultMediaBridge } from "./tools/result-media"
import { createViewFileTool } from "./tools/view-file"
import type { AgentTurnRuntime } from "./turn-runtime"
import type { AgentExecutionContext, AgentTurnContext, AgentWorkerContext } from "./types"
import { prepareWorkflowInputAttachments } from "./workflow-input-attachments"

export interface AgentExecutionEnvironment {
  readonly turnContext: AgentTurnContext
  /** Confirm preservation before recording success, cancellation or failure. Idempotent. */
  beforeFinalize(): Promise<void>
  dispose(): Promise<void>
}

export interface ConversationAgentExecutionEnvironment extends AgentExecutionEnvironment {
  readonly threadContext?: LoadedAgentThreadModelContext
}

interface CreateAgentEnvironmentInput {
  readonly context: AgentExecutionContext
  readonly plan: ResolvedAgentExecutionPlan
  readonly signal?: AbortSignal
  /**
   * Sink for a sandbox teardown that outlives dispose() (the model answered before the boot
   * finished, so dispose returns without stalling on it). The worker registers these so a graceful
   * stop() can drain them instead of leaving orphaned machines being torn down.
   */
  readonly onDetachedTeardown?: (teardown: Promise<void>) => void
}

export interface CreateConversationAgentEnvironmentInput extends CreateAgentEnvironmentInput {
  readonly thread?: AgentThreadRecord | null
  readonly sandboxDefinition?: SandboxDefinition
  /** Run preflight only after current sandbox access has been resolved. */
  readonly preflight?: { readonly budget: AgentContextBudget; readonly runtime: AgentTurnRuntime }
  readonly run: ConversationAgentRunRecord
  /** Retained model tail selected by preflight. Falls back to storage for direct callers. */
  readonly messages?: readonly AgentMessageRecord[]
  /** Skills already loaded while estimating the request. */
  readonly skills?: readonly AgentSkill[]
  /** Framework-owned tools available only to the main conversational Agent. */
  readonly frameworkTools?: readonly ModelTool[]
}

export interface CreateSubagentEnvironmentInput extends CreateAgentEnvironmentInput {
  readonly run: SubagentRunRecord
}

export interface CreateWorkflowAgentNodeEnvironmentInput extends CreateAgentEnvironmentInput {
  readonly run: WorkflowAgentNodeRunRecord
  readonly workflowId: string
  readonly stepId: string
  readonly nodeInput: WorkflowIOSnapshot
  readonly errorDetails: AgentErrorDetails
}

/** Prepare conversation history and attachments, then start the shared agent environment. */
export async function createConversationAgentEnvironment(
  input: CreateConversationAgentEnvironmentInput
): Promise<ConversationAgentExecutionEnvironment> {
  const { context, plan, run, preflight } = input
  const apiBaseUrl = createAgentApiGatewayBaseUrl({
    apiBaseUrl: context.apiBaseUrl,
    projectId: context.id,
    runId: run.id,
    executionToken: run.execution?.token,
  })
  const persistentSandbox = input.thread?.sandboxParams
    ? await openThreadSandbox({
        context,
        definition: input.sandboxDefinition,
        thread: input.thread,
        run,
        signal: input.signal ?? new AbortController().signal,
      })
    : undefined
  let environment: AgentExecutionEnvironment | undefined
  try {
    // Resolve application access before any compaction model call. Once acquired, this
    // environment owns preservation even if history, attachments or runtime preparation fail.
    const prepared = preflight
      ? await prepareAgentConversationContext({
          context,
          plan,
          run,
          budget: preflight.budget,
          runtime: preflight.runtime,
          frameworkTools: input.frameworkTools,
        })
      : undefined
    const [skills, messages, inlineImages] = await Promise.all([
      prepared?.skills ?? input.skills ?? context.agentSkills,
      prepared?.threadContext.retainedMessages ??
        input.messages ??
        context.storage.agents.messages
          .list({ projectId: context.id, threadId: run.threadId, order: "asc" })
          .then((history) => history.messages),
      modelSupportsInlineImages(plan.model),
    ])
    const attachmentContext = await prepareAgentAttachments({
      projectId: context.id,
      threadId: run.threadId,
      messages,
      blobStorage: context.blobStorage,
      apiBaseUrl,
      inlineImages,
      signal: input.signal,
    })
    environment = startAgentEnvironment({
      mode: "conversation",
      persistentSandbox,
      context,
      plan,
      runId: run.id,
      threadId: run.threadId,
      toolRun: { kind: "conversation", id: run.id, threadId: run.threadId },
      apiBaseUrl,
      attachmentContext,
      skills,
      frameworkTools: input.frameworkTools,
      onDetachedTeardown: input.onDetachedTeardown,
    })
    if (persistentSandbox) {
      const ready = environment.turnContext.sandboxReady
      if (ready) await waitForAbort(ready, input.signal)
    }
    return { ...environment, threadContext: prepared?.threadContext }
  } catch (error) {
    // Preparation can fail before the worker receives this environment. Preserve here, before
    // the worker records the run's terminal outcome; a lost execution must touch nothing.
    try {
      if (
        !(error instanceof AgentExecutionLostError) &&
        !(error instanceof QueueDeliveryLeaseLostError) &&
        !(input.signal?.reason instanceof QueueDeliveryLeaseLostError)
      )
        await persistentSandbox?.save()
    } finally {
      await environment?.dispose()
    }
    throw error
  }
}

/** Build an isolated environment for one fresh, headless child Agent. */
export async function createSubagentEnvironment(
  input: CreateSubagentEnvironmentInput
): Promise<AgentExecutionEnvironment> {
  const { context, plan, run } = input
  const execution = run.execution
  if (!execution) {
    throw new Error(`[SixbAgentWorker] Subagent run '${run.id}' must hold an execution token.`)
  }

  return startAgentEnvironment({
    mode: "subagent",
    context,
    plan,
    runId: run.id,
    parentRunId: run.parentRunId,
    toolRun: { kind: "subagent", id: run.id, parentRunId: run.parentRunId },
    apiBaseUrl: createAgentApiGatewayBaseUrl({
      apiBaseUrl: context.apiBaseUrl,
      projectId: context.id,
      runId: run.id,
      executionToken: execution.token,
    }),
    attachmentContext: emptyAttachmentContext(context.id),
    skills: await context.agentSkills,
    errorDetails: { parentRunId: run.parentRunId, runId: run.id },
    onDetachedTeardown: input.onDetachedTeardown,
  })
}

/** Build the same tool/sandbox environment for a fresh, headless workflow task. */
export async function createWorkflowAgentNodeEnvironment(
  input: CreateWorkflowAgentNodeEnvironmentInput
): Promise<AgentExecutionEnvironment> {
  const { context, plan, run } = input
  const execution = run.execution
  if (!execution) {
    throw new Error(
      `[SixbAgentWorker] Agent workflow node run '${run.nodeRunId}' must hold an execution token.`
    )
  }
  const [skills, attachmentContext] = await Promise.all([
    context.agentSkills,
    prepareWorkflowInputAttachments({
      input: input.nodeInput,
      blobStorage: context.blobStorage,
      signal: input.signal,
    }),
  ])

  return startAgentEnvironment({
    mode: "workflow-task",
    context,
    actorId: run.actorId,
    plan,
    runId: run.nodeRunId,
    toolRun: {
      kind: "workflow",
      id: run.nodeRunId,
      workflowId: input.workflowId,
      stepId: input.stepId,
    },
    apiBaseUrl: createAgentApiGatewayBaseUrl({
      apiBaseUrl: context.apiBaseUrl,
      projectId: context.id,
      runId: run.nodeRunId,
      executionToken: execution.token,
    }),
    attachmentContext,
    skills,
    errorDetails: input.errorDetails,
    onDetachedTeardown: input.onDetachedTeardown,
  })
}

interface AgentEnvironmentSetup extends CreateAgentEnvironmentInput {
  readonly persistentSandbox?: AgentSandboxLifecycle
  readonly toolRun: AgentToolRunInfo
  readonly actorId?: string
  readonly parentRunId?: string
  readonly mode: AgentExecutionMode
  readonly runId: string
  readonly threadId?: string
  readonly apiBaseUrl: string
  readonly attachmentContext: PreparedAgentAttachmentContext
  readonly skills: Awaited<AgentWorkerContext["agentSkills"]>
  readonly errorDetails?: AgentErrorDetails
  readonly frameworkTools?: readonly ModelTool[]
}

/**
 * Start the shared tools, sandbox, and teardown lifecycle after source-specific preparation.
 * Sandbox boot stays concurrent with the model call; sandbox tools await it only when used.
 */
function startAgentEnvironment(input: AgentEnvironmentSetup): AgentExecutionEnvironment {
  const { mode, context, actorId, plan, runId, threadId, apiBaseUrl, attachmentContext, skills } =
    input

  const logSession = resolveLoggingService(context.id, context.logging).startExecution({
    kind: "agent",
    id: runId,
  })
  const logger = logSession.logger.child({
    ...(actorId === undefined ? {} : { actorId }),
    ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
    ...(threadId ? { threadId } : {}),
  })
  let ready: Promise<AgentSandboxHandle>
  const fileRegistry = new AgentSandboxFileRegistry()
  const artifactBudget = new AgentToolArtifactBudget()
  const mediaBridge = new AgentToolResultMediaBridge({
    blobStorage: context.blobStorage,
    sandboxPathForFileRef: (fileRef) => fileRegistry.pathFor(fileRef),
  })
  const artifactsForToolCall = (input: {
    readonly toolName: string
    readonly toolCallId: string
    readonly signal: AbortSignal
  }) =>
    createAgentToolArtifacts({
      ...input,
      blobStorage: context.blobStorage,
      budget: artifactBudget,
      resolveSandbox: () => ready,
      onPublished: (artifact) => fileRegistry.register(artifact.sandboxPath, artifact.fileRef),
    })
  const tools = [
    ...modelToolsFromAgentDefinitions({
      definitions: plan.tools,
      valueTypesById: context.valueTypesById,
      run: input.toolRun,
      connector: context.connector,
      logger,
      artifactsForToolCall,
      toolResultToModelOutput: (output) => mediaBridge.toModelOutput(output),
      errorDetails: input.errorDetails,
    }),
  ]

  let sandboxWasUsed = false
  appendBuiltInTool(
    tools,
    createViewFileTool({
      resolveSandbox: () => ready,
      attachments: attachmentContext,
      registry: fileRegistry,
      artifactsForToolCall: ({ toolCallId, signal }) =>
        artifactsForToolCall({ toolName: "view_file", toolCallId, signal }),
      toolResultToModelOutput: (output) => mediaBridge.toModelOutput(output),
    })
  )
  const resolveSandbox = () => {
    sandboxWasUsed = true
    return ready
  }
  appendBuiltInTool(tools, createReadTool(resolveSandbox))
  appendBuiltInTool(tools, createBashTool(resolveSandbox))
  for (const frameworkTool of input.frameworkTools ?? []) appendBuiltInTool(tools, frameworkTool)

  ready = provisionSandbox({
    persistentSandbox: input.persistentSandbox,
    context,
    actorId,
    run: { id: runId, ...(threadId ? { threadId } : {}) },
    apiBaseUrl,
    apiOrigin: new URL(apiBaseUrl).origin,
    attachmentContext,
    skills,
  })
  // Creation failure is surfaced where it is awaited (turn / sandbox tool / dispose); attach a no-op
  // catch so a rejection observed by none of them is not reported as unhandled.
  ready.catch(() => {})
  // Track settlement so dispose() can avoid blocking teardown on a boot still in flight.
  let settled = false
  const markSettled = () => {
    settled = true
  }
  ready.then(markSettled, markSettled)

  const beforeFinalize = () => input.persistentSandbox?.save() ?? Promise.resolve()
  return {
    beforeFinalize,
    turnContext: {
      ...(input.persistentSandbox ? { beforeFinalize } : {}),
      id: context.id,
      ...(context.authorPrincipal === undefined
        ? {}
        : { authorPrincipal: context.authorPrincipal }),
      storage: context.storage,
      blobStorage: context.blobStorage,
      apiBaseUrl,
      attachmentContext,
      tools,
      prepareStep: mediaBridge.prepareStep,
      systemPrompt: renderAgentSystemPrompt({
        mode,
        instructions: plan.instructions,
        skills,
        sandboxResetAt: input.persistentSandbox?.resetAt,
      }),
      sandboxReady: ready,
      sandboxWasUsed: () => sandboxWasUsed,
      streamSink: context.streamSink,
      recoverAiModelCall: context.recoverAiModelCall,
      turnTimeoutMs: context.turnTimeoutMs,
    },
    async dispose() {
      await Promise.all([
        input.persistentSandbox
          ? Promise.resolve()
          : disposeEnvironment(ready, () => settled, input.onDetachedTeardown),
        logSession.flush(),
      ])
    },
  }
}

function emptyAttachmentContext(projectId: string): PreparedAgentAttachmentContext {
  return {
    entries: [],
    promptTextByPartKey: new Map(),
    modelFileDataByPartKey: new Map(),
    sandboxFiles: [],
    manifestJson: JSON.stringify({ projectId, attachments: [] }, null, 2),
  }
}

interface ProvisionSandboxInput {
  readonly persistentSandbox?: AgentSandboxLifecycle
  readonly context: AgentExecutionContext
  readonly actorId?: string
  readonly run: { readonly id: string; readonly threadId?: string }
  readonly apiBaseUrl: string
  readonly apiOrigin: string
  readonly attachmentContext: PreparedAgentAttachmentContext
  readonly skills: Awaited<AgentWorkerContext["agentSkills"]>
}

async function provisionSandbox(input: ProvisionSandboxInput): Promise<AgentSandboxHandle> {
  const { context, actorId, run, apiBaseUrl, apiOrigin, skills } = input
  let sandbox: Sandbox | null = null
  try {
    sandbox =
      input.persistentSandbox?.sandbox ??
      (await context.sandboxes.create({
        environment: {},
        network: { mode: "restricted", allow: [{ name: "sixb-api", origin: apiOrigin }] },
      }))
    const apiContext = await prepareAgentSandboxApiContext({
      sandbox,
      apiBaseUrl,
      projectId: context.id,
      ...(actorId === undefined ? {} : { actorId }),
      ...(run.threadId ? { threadId: run.threadId } : {}),
      runId: run.id,
      attachments: input.attachmentContext,
      skills,
    })
    await assertAgentRuntimeProfile({
      sandbox,
      env: apiContext.env,
      projectId: context.id,
    })
    return { sandbox, env: { ...input.persistentSandbox?.env, ...apiContext.env } }
  } catch (error) {
    // Reclaim a half-created sandbox before propagating to the awaiter.
    if (!input.persistentSandbox) await sandbox?.destroy().catch(() => {})
    throw error
  }
}

function disposeEnvironment(
  ready: Promise<AgentSandboxHandle>,
  isSettled: () => boolean,
  onDetachedTeardown?: (teardown: Promise<void>) => void
): Promise<void> {
  // Destroy the sandbox once provisioning settles. A rejection means provisionSandbox already
  // reclaimed whatever it half-created, so there is nothing left to destroy.
  const teardown = ready
    .then(
      (handle) => handle.sandbox.destroy(),
      () => undefined
    )
    .catch((error) => {
      console.error("[SixbAgentWorker] Could not destroy agent run sandbox:", error)
    })
  // Once provisioning has settled, await the (now-fast) destroy so cleanup completes inline.
  if (isSettled()) {
    return teardown
  }
  // Boot still in flight (the model answered before it finished and never used bash): don't stall
  // run teardown on it. Hand the chained destroy to the worker so a graceful stop() can drain it
  // rather than orphaning a machine that is still being torn down.
  onDetachedTeardown?.(teardown)
  return Promise.resolve()
}

function appendBuiltInTool(tools: ModelTool[], tool: ModelTool): void {
  if (tools.some((candidate) => candidate.name === tool.name)) {
    throw new Error(
      `[SixbAgentWorker] Agent tool name '${tool.name}' is reserved by the worker runtime.`
    )
  }
  tools.push(tool)
}
