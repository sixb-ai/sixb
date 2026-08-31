import type { AgentDefinition, Sandbox } from "@sixb/core"
import { resolveLoggingService } from "@sixb/core/internal/logging"
import type { WorkflowIOSnapshot } from "@sixb/core/internal/workflows"
import type { AgentRunRecord, WorkflowAgentNodeRunRecord } from "@sixb/core/storage"
import { type AgentExecutionMode, renderAgentSkillCatalog } from "./agent-skills"
import { createAgentApiGatewayBaseUrl } from "./api-url"
import {
  modelSupportsInlineImages,
  type PreparedAgentAttachmentContext,
  prepareAgentAttachments,
} from "./attachments"
import { type BashSandboxHandle, createBashTool } from "./bash-tool"
import { modelToolsFromAgentDefinitions } from "./model-adapters"
import { prepareAgentSandboxApiContext } from "./sandbox-api-context"
import type { AgentExecutionContext, AgentTurnContext, AgentWorkerContext } from "./types"
import { prepareWorkflowInputAttachments } from "./workflow-input-attachments"

export interface AgentExecutionEnvironment {
  readonly turnContext: AgentTurnContext
  dispose(): Promise<void>
}

interface CreateAgentEnvironmentInput {
  readonly context: AgentExecutionContext
  readonly agent: AgentDefinition
  /**
   * Sink for a sandbox teardown that outlives dispose() (the model answered before the boot
   * finished, so dispose returns without stalling on it). The worker registers these so a graceful
   * stop() can drain them instead of leaving orphaned machines being torn down.
   */
  readonly onDetachedTeardown?: (teardown: Promise<void>) => void
}

export interface CreateConversationAgentEnvironmentInput extends CreateAgentEnvironmentInput {
  readonly run: AgentRunRecord
}

export interface CreateWorkflowAgentNodeEnvironmentInput extends CreateAgentEnvironmentInput {
  readonly run: WorkflowAgentNodeRunRecord
  readonly nodeInput: WorkflowIOSnapshot
}

/** Prepare conversation history and attachments, then start the shared agent environment. */
export async function createConversationAgentEnvironment(
  input: CreateConversationAgentEnvironmentInput
): Promise<AgentExecutionEnvironment> {
  const { context, agent, run } = input

  const apiBaseUrl = createAgentApiGatewayBaseUrl({
    apiBaseUrl: context.apiBaseUrl,
    projectId: context.id,
    runId: run.id,
    executionToken: run.execution?.token,
  })
  const [skills, history, inlineImages] = await Promise.all([
    context.agentSkills,
    context.storage.agents.messages.list({
      projectId: context.id,
      threadId: run.threadId,
      order: "asc",
    }),
    modelSupportsInlineImages(agent.model),
  ])
  const attachmentContext = await prepareAgentAttachments({
    projectId: context.id,
    threadId: run.threadId,
    messages: history.messages,
    blobStorage: context.blobStorage,
    apiBaseUrl,
    inlineImages,
  })

  return startAgentEnvironment({
    mode: "conversation",
    context,
    agent,
    runId: run.id,
    threadId: run.threadId,
    apiBaseUrl,
    attachmentContext,
    skills,
    onDetachedTeardown: input.onDetachedTeardown,
  })
}

/** Build the same tool/sandbox environment for a fresh, headless workflow task. */
export async function createWorkflowAgentNodeEnvironment(
  input: CreateWorkflowAgentNodeEnvironmentInput
): Promise<AgentExecutionEnvironment> {
  const { context, agent, run } = input
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
    }),
  ])

  return startAgentEnvironment({
    mode: "workflow-task",
    context,
    agent,
    runId: run.nodeRunId,
    apiBaseUrl: createAgentApiGatewayBaseUrl({
      apiBaseUrl: context.apiBaseUrl,
      projectId: context.id,
      runId: run.nodeRunId,
      executionToken: execution.token,
    }),
    attachmentContext,
    skills,
    onDetachedTeardown: input.onDetachedTeardown,
  })
}

interface AgentEnvironmentSetup extends CreateAgentEnvironmentInput {
  readonly mode: AgentExecutionMode
  readonly runId: string
  readonly threadId?: string
  readonly apiBaseUrl: string
  readonly attachmentContext: PreparedAgentAttachmentContext
  readonly skills: Awaited<AgentWorkerContext["agentSkills"]>
}

/**
 * Start the shared tools, sandbox, and teardown lifecycle after source-specific preparation.
 * Sandbox boot stays concurrent with the model call; the bash tool awaits it only when used.
 */
function startAgentEnvironment(input: AgentEnvironmentSetup): AgentExecutionEnvironment {
  const { mode, context, agent, runId, threadId, apiBaseUrl, attachmentContext, skills } = input

  const logSession = resolveLoggingService(context.id, context.logging).startExecution({
    kind: "agent",
    id: runId,
  })
  const logger = logSession.logger.child({
    agentId: agent.id,
    ...(threadId ? { threadId } : {}),
  })
  const selectedTools = modelToolsFromAgentDefinitions({
    definitions: agent.tools,
    valueTypesById: context.valueTypesById,
    run: { id: runId, agentId: agent.id, ...(threadId ? { threadId } : {}) },
    connector: context.connector,
    logger,
    errorDetails:
      mode === "conversation"
        ? { agentId: agent.id, runId }
        : { agentId: agent.id, nodeRunId: runId },
  })

  let sandboxWasUsed = false
  let ready: Promise<BashSandboxHandle>
  const bash = createBashTool(() => {
    sandboxWasUsed = true
    return ready
  })
  const tools = [...selectedTools, bash]

  ready = provisionSandbox({
    context,
    agent,
    run: { id: runId, ...(threadId ? { threadId } : {}) },
    apiBaseUrl,
    apiOrigin: new URL(apiBaseUrl).origin,
    attachmentContext,
    skills,
  })
  // Creation failure is surfaced where it is awaited (turn / bash tool / dispose); attach a no-op
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
      agentPrincipal: context.agentPrincipal,
      storage: context.storage,
      blobStorage: context.blobStorage,
      apiBaseUrl,
      attachmentContext,
      tools,
      systemAddendum: renderAgentSkillCatalog(skills, mode),
      sandboxReady: ready,
      sandboxWasUsed: () => sandboxWasUsed,
      streamSink: context.streamSink,
      recoverAiModelCall: context.recoverAiModelCall,
      defaultMaxSteps: context.defaultMaxSteps,
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

interface ProvisionSandboxInput {
  readonly context: AgentExecutionContext
  readonly agent: AgentDefinition
  readonly run: { readonly id: string; readonly threadId?: string }
  readonly apiBaseUrl: string
  readonly apiOrigin: string
  readonly attachmentContext: PreparedAgentAttachmentContext
  readonly skills: Awaited<AgentWorkerContext["agentSkills"]>
}

async function provisionSandbox(input: ProvisionSandboxInput): Promise<BashSandboxHandle> {
  const { context, agent, run, apiBaseUrl, apiOrigin, skills } = input
  let sandbox: Sandbox | null = null
  try {
    sandbox = await context.sandboxes.create({
      network: { mode: "restricted", allow: [{ name: "sixb-api", origin: apiOrigin }] },
    })
    const apiContext = await prepareAgentSandboxApiContext({
      sandbox,
      apiBaseUrl,
      projectId: context.id,
      agentId: agent.id,
      ...(run.threadId ? { threadId: run.threadId } : {}),
      runId: run.id,
      attachments: input.attachmentContext,
      skills,
    })
    return { sandbox, env: apiContext.env }
  } catch (error) {
    // Reclaim a half-created sandbox before propagating to the awaiter.
    await sandbox?.destroy().catch(() => {})
    throw error
  }
}

function disposeEnvironment(
  ready: Promise<BashSandboxHandle>,
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
