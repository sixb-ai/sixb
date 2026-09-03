import type { AgentToolRunInfo, Sandbox } from "@sixb/core"
import { resolveLoggingService } from "@sixb/core/internal/logging"
import type { WorkflowIOSnapshot } from "@sixb/core/internal/workflows"
import type {
  AgentMessageRecord,
  ConversationAgentRunRecord,
  SubagentRunRecord,
  WorkflowAgentNodeRunRecord,
} from "@sixb/core/storage"
import type { ToolSet } from "ai"
import { type AgentExecutionMode, renderAgentSystemPrompt } from "./agent-prompt"
import { assertAgentRuntimeProfile } from "./agent-runtime/preflight"
import type { AgentSkill } from "./agent-skills"
import { type AgentErrorDetails, aiSdkToolsFromAgentDefinitions } from "./ai-sdk-adapters"
import { createAgentApiGatewayBaseUrl } from "./api-url"
import {
  modelSupportsInlineImages,
  type PreparedAgentAttachmentContext,
  prepareAgentAttachments,
} from "./attachments"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import { prepareAgentSandboxApiContext } from "./sandbox-api-context"
import { AgentSandboxFileRegistry } from "./sandbox-file-registry"
import type { AgentSandboxHandle } from "./sandbox-handle"
import { AgentToolArtifactBudget, createAgentToolArtifacts } from "./tools/artifacts"
import { BASH_TOOL_SPEC, createBashTool } from "./tools/bash"
import { createReadTool, READ_TOOL_SPEC } from "./tools/read"
import { AgentToolResultMediaBridge } from "./tools/result-media"
import { createViewFileTool, VIEW_FILE_TOOL_SPEC } from "./tools/view-file"
import type { AgentExecutionContext, AgentTurnContext, AgentWorkerContext } from "./types"
import { prepareWorkflowInputAttachments } from "./workflow-input-attachments"

export interface AgentExecutionEnvironment {
  readonly turnContext: AgentTurnContext
  dispose(): Promise<void>
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
  readonly run: ConversationAgentRunRecord
  /** Retained model tail selected by preflight. Falls back to storage for direct callers. */
  readonly messages?: readonly AgentMessageRecord[]
  /** Skills already loaded while estimating the request. */
  readonly skills?: readonly AgentSkill[]
  /** Framework-owned tools available only to the main conversational Agent. */
  readonly frameworkTools?: ToolSet
}

export interface CreateSubagentEnvironmentInput extends CreateAgentEnvironmentInput {
  readonly run: SubagentRunRecord
}

export interface CreateWorkflowAgentNodeEnvironmentInput extends CreateAgentEnvironmentInput {
  readonly run: WorkflowAgentNodeRunRecord
  readonly nodeInput: WorkflowIOSnapshot
  readonly errorDetails: AgentErrorDetails
}

/** Prepare conversation history and attachments, then start the shared agent environment. */
export async function createConversationAgentEnvironment(
  input: CreateConversationAgentEnvironmentInput
): Promise<AgentExecutionEnvironment> {
  const { context, plan, run } = input

  const apiBaseUrl = createAgentApiGatewayBaseUrl({
    apiBaseUrl: context.apiBaseUrl,
    projectId: context.id,
    runId: run.id,
    executionToken: run.execution?.token,
  })
  const [skills, messages, inlineImages] = await Promise.all([
    input.skills ?? context.agentSkills,
    input.messages ??
      context.storage.agents.messages
        .list({
          projectId: context.id,
          threadId: run.threadId,
          order: "asc",
        })
        .then((history) => history.messages),
    modelSupportsInlineImages(plan.model, input.signal),
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

  return startAgentEnvironment({
    mode: "conversation",
    context,
    agentId: run.agentId,
    plan,
    runId: run.id,
    threadId: run.threadId,
    apiBaseUrl,
    attachmentContext,
    skills,
    frameworkTools: input.frameworkTools,
    onDetachedTeardown: input.onDetachedTeardown,
  })
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
    agentId: run.agentId,
    plan,
    runId: run.nodeRunId,
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
  readonly agentId?: string
  readonly parentRunId?: string
  readonly mode: AgentExecutionMode
  readonly runId: string
  readonly threadId?: string
  readonly apiBaseUrl: string
  readonly attachmentContext: PreparedAgentAttachmentContext
  readonly skills: Awaited<AgentWorkerContext["agentSkills"]>
  readonly errorDetails?: AgentErrorDetails
  readonly frameworkTools?: ToolSet
}

/**
 * Start the shared tools, sandbox, and teardown lifecycle after source-specific preparation.
 * Sandbox boot stays concurrent with the model call; sandbox tools await it only when used.
 */
function startAgentEnvironment(input: AgentEnvironmentSetup): AgentExecutionEnvironment {
  const { mode, context, agentId, plan, runId, threadId, apiBaseUrl, attachmentContext, skills } =
    input

  const logSession = resolveLoggingService(context.id, context.logging).startExecution({
    kind: "agent",
    id: runId,
  })
  const logger = logSession.logger.child({
    ...(agentId === undefined ? {} : { agentId }),
    ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
    ...(threadId ? { threadId } : {}),
  })
  const toolRun = agentToolRunInfo({ runId, agentId, parentRunId: input.parentRunId, threadId })
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
  const tools = aiSdkToolsFromAgentDefinitions({
    definitions: plan.tools,
    valueTypesById: context.valueTypesById,
    run: toolRun,
    connector: context.connector,
    logger,
    artifactsForToolCall,
    toolResultToModelOutput: (output) => mediaBridge.toModelOutput(output),
    errorDetails:
      input.errorDetails ??
      (agentId === undefined
        ? { parentRunId: input.parentRunId ?? "unknown", runId }
        : { agentId, runId }),
  })

  let sandboxWasUsed = false
  tools[VIEW_FILE_TOOL_SPEC.name] = createViewFileTool({
    resolveSandbox: () => ready,
    attachments: attachmentContext,
    registry: fileRegistry,
    artifactsForToolCall: ({ toolCallId, signal }) =>
      artifactsForToolCall({ toolName: VIEW_FILE_TOOL_SPEC.name, toolCallId, signal }),
    toolResultToModelOutput: (output) => mediaBridge.toModelOutput(output),
  })
  const resolveSandbox = () => {
    sandboxWasUsed = true
    return ready
  }
  tools[READ_TOOL_SPEC.name] = createReadTool(resolveSandbox)
  tools[BASH_TOOL_SPEC.name] = createBashTool(resolveSandbox)
  for (const [name, frameworkTool] of Object.entries(input.frameworkTools ?? {})) {
    if (Object.hasOwn(tools, name)) {
      throw new Error(
        `[SixbAgentWorker] Framework tool '${name}' conflicts with another tool in Agent run '${runId}'.`
      )
    }
    tools[name] = frameworkTool
  }

  ready = provisionSandbox({
    context,
    agentId,
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

  return {
    turnContext: {
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
      systemPrompt: renderAgentSystemPrompt({ mode, instructions: plan.instructions, skills }),
      sandboxReady: ready,
      sandboxWasUsed: () => sandboxWasUsed,
      streamSink: context.streamSink,
      recoverAiModelCall: context.recoverAiModelCall,
      turnTimeoutMs: context.turnTimeoutMs,
    },
    async dispose() {
      await Promise.all([
        disposeEnvironment(ready, () => settled, input.onDetachedTeardown),
        logSession.flush(),
      ])
    },
  }
}

function agentToolRunInfo(input: {
  readonly runId: string
  readonly agentId?: string
  readonly parentRunId?: string
  readonly threadId?: string
}): AgentToolRunInfo {
  if (input.agentId !== undefined) {
    return {
      id: input.runId,
      agentId: input.agentId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    }
  }
  if (input.parentRunId !== undefined) {
    return { id: input.runId, parentRunId: input.parentRunId }
  }
  throw new Error(`[SixbAgentWorker] Agent run '${input.runId}' has no execution identity.`)
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
  readonly context: AgentExecutionContext
  readonly agentId?: string
  readonly run: { readonly id: string; readonly threadId?: string }
  readonly apiBaseUrl: string
  readonly apiOrigin: string
  readonly attachmentContext: PreparedAgentAttachmentContext
  readonly skills: Awaited<AgentWorkerContext["agentSkills"]>
}

async function provisionSandbox(input: ProvisionSandboxInput): Promise<AgentSandboxHandle> {
  const { context, agentId, run, apiBaseUrl, apiOrigin, skills } = input
  let sandbox: Sandbox | null = null
  try {
    sandbox = await context.sandboxes.create({
      network: { mode: "restricted", allow: [{ name: "sixb-api", origin: apiOrigin }] },
    })
    const apiContext = await prepareAgentSandboxApiContext({
      sandbox,
      apiBaseUrl,
      projectId: context.id,
      ...(agentId === undefined ? {} : { agentId }),
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
    return { sandbox, env: apiContext.env }
  } catch (error) {
    // Reclaim a half-created sandbox before propagating to the awaiter.
    await sandbox?.destroy().catch(() => {})
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
