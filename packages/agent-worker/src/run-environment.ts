import { posix } from "node:path"
import type {
  AgentToolAttachments,
  AgentToolRunInfo,
  OntologyDocsCatalog,
  Principal,
  SandboxDefinition,
  SandboxFactory,
} from "@sixb/core"
import {
  type AgentRunSession,
  conversationThreadId,
  staticSandboxRecipe,
} from "@sixb/core/internal/agents"
import { resolveLoggingService } from "@sixb/core/internal/logging"
import { type RenderedOntologyDocs, renderOntologyDocs } from "@sixb/core/internal/ontology"
import type { WorkflowIOSnapshot } from "@sixb/core/internal/workflows"
import type { ModelTool } from "@sixb/core/models"
import type {
  AgentMessageRecord,
  AgentThreadRecord,
  ConversationAgentRunRecord,
  SubagentRunRecord,
  WorkflowAgentNodeRunRecord,
} from "@sixb/core/storage"
import { NEVER_ABORTED_SIGNAL, waitForAbort } from "./abort"
import { type AgentExecutionMode, agentRuntimeFacts, renderAgentSystemPrompt } from "./agent-prompt"
import { assertAgentRuntimeProfile } from "./agent-runtime/preflight"
import { runApiCredential, runTokenFor } from "./api-url"
import {
  type InstalledArtifacts,
  installArtifactsPublishedBy,
  type MaterializedArtifacts,
  materializeThreadArtifacts,
} from "./artifacts/materialize"
import { createPublishArtifactTools } from "./artifacts/publish-tool"
import {
  modelSupportsInlineImages,
  type PreparedAgentAttachmentContext,
  prepareAgentAttachments,
} from "./attachments"
import { prepareHandedFiles } from "./child-files"
import type { AgentContextBudget } from "./context-budget"
import { type LoadConversationMemory, prepareAgentConversationContext } from "./context-compaction"
import { type ConversationMemory, loadConversationMemory } from "./conversation-memory"
import { ephemeralRunSandbox } from "./ephemeral-run-sandbox"
import { assertExecutionOwned, isLostExecution } from "./errors"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import type { ConversationReaders } from "./message-authors"
import { type AgentErrorDetails, modelToolsFromAgentDefinitions } from "./model-adapters"
import { keepsSubagentWorkspace, persistentRunSandbox } from "./persistent-run-sandbox"
import type { AcquiredRunSandbox, BeforeFinalizeOptions, RunSandbox } from "./run-sandbox"
import {
  AGENT_ARTIFACTS_DIRECTORY,
  AGENT_ARTIFACTS_MANIFEST,
  type PrepareAgentSandboxApiContextInput,
  prepareAgentSandboxApiContext,
} from "./sandbox-api-context"
import { AgentSandboxFileRegistry } from "./sandbox-file-registry"
import type { AgentSandboxHandle } from "./sandbox-handle"
import { MEMORY_SKILL } from "./skills/built-in"
import { type SubagentHistory, subagentSandboxFiles } from "./subagent-continuation"
import type { LoadedAgentThreadModelContext } from "./thread-context"
import {
  handedToolAttachments,
  threadToolAttachments,
  workflowInputToolAttachments,
} from "./tools/attachments"
import { createBashTool } from "./tools/bash"
import { createReadTool } from "./tools/read"
import { AgentToolResultMediaBridge } from "./tools/result-media"
import { AgentFileBudget, createAgentToolFiles } from "./tools/tool-files"
import { createViewFileTool } from "./tools/view-file"
import type { AgentTurnRuntime } from "./turn-runtime"
import type { AgentExecutionContext, AgentRunFiles, AgentTurnContext } from "./types"
import { prepareWorkflowInputAttachments } from "./workflow-input-attachments"

export interface AgentExecutionEnvironment {
  readonly turnContext: AgentTurnContext
  /** The run's sandbox and file budget, for the files a parent and its children hand each other. */
  readonly runFiles: AgentRunFiles
  /** Confirm preservation before recording success, cancellation or failure. Idempotent. */
  beforeFinalize(options?: BeforeFinalizeOptions): Promise<void>
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
  /** The turn's session: its workspace, conversation and checkpoint go through it. */
  readonly session: AgentRunSession
  readonly thread?: AgentThreadRecord | null
  /** Who asked for the turn: what it publishes is theirs, in an artifact the thread's owner owns. */
  readonly requestedBy?: Principal
  /** Who can read the thread now: in a shared one, who wrote what counts toward the estimate. */
  readonly conversation?: ConversationReaders
  /** Others were added to the thread, so it reaches the project's memory alone. */
  readonly shared?: boolean
  readonly sandboxDefinition?: SandboxDefinition
  /** Run preflight only after current sandbox access has been resolved. */
  readonly preflight?: { readonly budget: AgentContextBudget; readonly runtime: AgentTurnRuntime }
  readonly run: ConversationAgentRunRecord
  /** Retained model tail selected by preflight. Falls back to storage for direct callers. */
  readonly messages?: readonly AgentMessageRecord[]
  /** Framework-owned tools of the conversational Agent: delegation. */
  readonly frameworkTools?: readonly ModelTool[]
}

export interface CreateSubagentEnvironmentInput extends CreateAgentEnvironmentInput {
  /** The child's session: its workspace goes through it. */
  readonly session: AgentRunSession
  readonly run: SubagentRunRecord
  /** The child's own thread: memory is read as of its creation. */
  readonly thread: AgentThreadRecord
  /** The conversation: what the child publishes lands there. Absent, it publishes nothing. */
  readonly conversation?: AgentThreadRecord | null
  /** Who asked for the parent turn: what the child publishes is theirs. */
  readonly requestedBy?: Principal
  /** Its thread's messages, whose files are projected again, and the paused run it continues. */
  readonly history: SubagentHistory
  /** Framework-owned tools of a child: `ask_parent`. */
  readonly frameworkTools?: readonly ModelTool[]
}

export interface CreateWorkflowAgentNodeEnvironmentInput extends CreateAgentEnvironmentInput {
  readonly run: WorkflowAgentNodeRunRecord
  readonly workflowId: string
  readonly stepId: string
  readonly nodeInput: WorkflowIOSnapshot
  readonly errorDetails: AgentErrorDetails
  /** The step's own sandbox factory. Without one, the node gets the project's blank sandbox. */
  readonly stepSandbox?: SandboxFactory
}

/** Prepare conversation history and attachments, then start the shared agent environment. */
export async function createConversationAgentEnvironment(
  input: CreateConversationAgentEnvironmentInput
): Promise<ConversationAgentExecutionEnvironment> {
  const { context, plan, run, preflight } = input
  const { apiBaseUrl } = context
  const runToken = runTokenFor({
    projectId: context.id,
    runId: run.id,
    executionToken: run.execution?.token,
  })
  const apiCredential = runApiCredential(apiBaseUrl, runToken)
  const failure = new AbortController()
  const sandboxSignal = input.signal
    ? AbortSignal.any([input.signal, failure.signal])
    : failure.signal
  const sandbox = input.thread?.sandboxParams
    ? await persistentRunSandbox({
        context,
        session: input.session,
        definition: input.sandboxDefinition,
        thread: input.thread,
        run,
        signal: sandboxSignal,
        apiCredential,
        onAuthFailure: (error) => failure.abort(error),
      })
    : ephemeralRunSandbox({ context, apiCredential })
  let environment: AgentExecutionEnvironment | undefined
  // The prompt shows memory as of the thread's start or its latest compaction (see
  // loadConversationMemory).
  const threadCreatedAt = input.thread?.createdAt ?? run.createdAt
  const loadMemory: LoadConversationMemory = (checkpoint) =>
    loadConversationMemory({
      sixb: context.sixb,
      asOf: checkpoint?.createdAt ?? threadCreatedAt,
      shared: input.shared ?? false,
    })
  try {
    const ontologyDocs = renderRunOntologyDocs(context)
    // Resolve application access before any compaction model call. Once acquired, this
    // environment owns preservation even if history, attachments or runtime preparation fail.
    const prepared = preflight
      ? await prepareAgentConversationContext({
          context,
          session: input.session,
          plan,
          ontologyIndex: ontologyDocs.index,
          contextDirectory: sandbox.contextDirectory,
          run,
          ...(input.conversation === undefined ? {} : { conversation: input.conversation }),
          budget: preflight.budget,
          runtime: {
            ...preflight.runtime,
            signal: sandboxSignal,
            assertCanContinue() {
              preflight.runtime.assertCanContinue()
              failure.signal.throwIfAborted()
            },
          },
          frameworkTools: input.frameworkTools,
          loadMemory,
        })
      : undefined
    const [messages, inlineImages, memory] = await Promise.all([
      prepared?.threadContext.retainedMessages ??
        input.messages ??
        input.session.conversation
          .messages({ threadId: run.threadId, order: "asc" })
          .then((history) => history.messages),
      modelSupportsInlineImages(plan.model),
      prepared
        ? prepared.memory
        : input.session.conversation.latestCheckpoint(run.threadId).then(loadMemory),
    ])
    const attachmentContext = await prepareAgentAttachments({
      projectId: context.id,
      threadId: run.threadId,
      messages,
      blobStorage: context.blobStorage,
      apiBaseUrl,
      contextDirectory: sandbox.contextDirectory,
      inlineImages,
      signal: sandboxSignal,
    })
    environment = await startAgentEnvironment({
      mode: "conversation",
      sandbox,
      sandboxSignal,
      failureSignal: failure.signal,
      context,
      plan,
      runId: run.id,
      threadId: run.threadId,
      toolRun: { kind: "conversation", id: run.id, threadId: run.threadId },
      ...(input.thread && run.execution
        ? {
            publishing: {
              threadId: input.thread.id,
              owner: input.thread.ownerPrincipal,
              author: input.requestedBy ?? input.thread.ownerPrincipal,
              executionToken: run.execution.token,
            },
          }
        : {}),
      toolAttachments: threadToolAttachments({
        storage: context.storage.agents,
        projectId: context.id,
        threadId: run.threadId,
        blobStorage: context.blobStorage,
      }),
      apiBaseUrl,
      attachmentContext,
      ontologyDocs,
      frameworkTools: input.frameworkTools,
      ...(memory ? { memory } : {}),
      onDetachedTeardown: input.onDetachedTeardown,
    })
    return { ...environment, threadContext: prepared?.threadContext }
  } catch (error) {
    // Preparation can fail before the worker receives this environment. Preserve here, before
    // the worker records the run's terminal outcome; a lost execution must touch nothing.
    try {
      if (!isLostExecution(error, input.signal)) await sandbox.beforeFinalize?.()
    } finally {
      await environment?.dispose()
    }
    throw error
  }
}

/**
 * Build an isolated environment for one headless child Agent. It knows the project as its parent
 * does (ontology docs, memory to read), holds the files its parent handed over at their paths, and
 * publishes into its conversation, as its own run.
 *
 * On a provider that resumes sandboxes, its thread keeps its workspace while it pauses: the run
 * that continues it finds every file where it was. Elsewhere, or once those files were lost, it
 * starts blank, with the handed files and what the paused run left in `out/` given back.
 */
export async function createSubagentEnvironment(
  input: CreateSubagentEnvironmentInput
): Promise<AgentExecutionEnvironment> {
  const { context, run } = input
  const execution = run.execution
  if (!execution) {
    throw new Error(`[SixbAgentWorker] Subagent run '${run.id}' must hold an execution token.`)
  }
  const runToken = runTokenFor({
    projectId: context.id,
    runId: run.id,
    executionToken: execution.token,
  })
  const apiCredential = runApiCredential(context.apiBaseUrl, runToken)

  const workspace = keepsSubagentWorkspace(context.sandboxes)
    ? await persistentRunSandbox({
        context,
        session: input.session,
        thread: input.thread,
        run,
        signal: input.signal ?? NEVER_ABORTED_SIGNAL,
        apiCredential,
        // A blank workspace issues no source credentials.
        onAuthFailure: () => {},
      })
    : undefined
  const sandbox = workspace ?? ephemeralRunSandbox({ context, apiCredential })

  try {
    return await startSubagentEnvironment({
      ...input,
      execution,
      sandbox,
      resumed: workspace?.resumed ?? false,
    })
  } catch (error) {
    // Preparation failed before the worker got this environment: the child ends here, so its
    // workspace goes, as the worker's failure path would destroy it. A lost execution must touch
    // nothing.
    if (!isLostExecution(error, input.signal)) await sandbox.beforeFinalize?.({ discard: true })
    throw error
  }
}

async function startSubagentEnvironment(
  input: CreateSubagentEnvironmentInput & {
    readonly execution: NonNullable<SubagentRunRecord["execution"]>
    readonly sandbox: RunSandbox
    /** Whether the sandbox is the workspace the paused run left: it holds its files already. */
    readonly resumed: boolean
  }
): Promise<AgentExecutionEnvironment> {
  const { context, plan, run, conversation, execution, sandbox, resumed } = input
  // Still listed, as handed over, but never copied over what the child made of them.
  const files = resumed ? (run.spec.files ?? []) : subagentSandboxFiles(run, input.history.paused)
  const history = input.history.messages
  const [memory, handedContext, historyContext] = await Promise.all([
    // As of the thread's start, as a conversation's: each run of the child reads the same memory.
    loadConversationMemory({ sixb: context.sixb, asOf: input.thread.createdAt }),
    files.length
      ? prepareHandedFiles({
          projectId: context.id,
          parentRunId: run.parentRunId,
          files,
          inSandbox: resumed,
          contextDirectory: sandbox.contextDirectory,
          blobStorage: context.blobStorage,
          signal: input.signal,
        })
      : emptyAttachmentContext(context.id),
    history.length && context.apiBaseUrl
      ? prepareAgentAttachments({
          projectId: context.id,
          // Its messages are its thread's, so their files are read there.
          threadId: input.thread.id,
          messages: history,
          blobStorage: context.blobStorage,
          apiBaseUrl: context.apiBaseUrl,
          contextDirectory: sandbox.contextDirectory,
          inlineImages: modelSupportsInlineImages(plan.model),
          signal: input.signal,
        })
      : undefined,
  ])
  const attachmentContext = historyContext
    ? mergeAttachmentContexts(handedContext, historyContext)
    : handedContext

  return startAgentEnvironment({
    mode: "subagent",
    sandbox,
    sandboxSignal: input.signal,
    context,
    plan,
    runId: run.id,
    parentRunId: run.parentRunId,
    threadId: conversationThreadId(input.thread),
    toolRun: { kind: "subagent", id: run.id, parentRunId: run.parentRunId },
    ...(conversation
      ? {
          publishing: {
            threadId: conversation.id,
            owner: conversation.ownerPrincipal,
            author: input.requestedBy ?? conversation.ownerPrincipal,
            executionToken: execution.token,
          },
        }
      : {}),
    toolAttachments: handedToolAttachments({
      files,
      blobStorage: context.blobStorage,
    }),
    apiBaseUrl: context.apiBaseUrl,
    attachmentContext,
    ontologyDocs: renderRunOntologyDocs(context),
    ...(memory ? { memory } : {}),
    frameworkTools: input.frameworkTools,
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
  const runToken = runTokenFor({
    projectId: context.id,
    runId: run.nodeRunId,
    executionToken: execution.token,
  })
  const apiCredential = runApiCredential(context.apiBaseUrl, runToken)
  // Cancellation, lost ownership, worker shutdown or the node deadline stop provisioning. A
  // step's lost source credentials end the node through `failure`.
  const failure = new AbortController()
  const sandboxSignal = input.signal
    ? AbortSignal.any([input.signal, failure.signal])
    : failure.signal

  // A step with its own factory works in a workspace from that factory's static recipe; any
  // other node in a blank sandbox from the project factory.
  const { stepSandbox } = input
  const sandbox = stepSandbox
    ? ephemeralRunSandbox({
        context,
        signal: sandboxSignal,
        apiCredential,
        workspace: {
          runId: run.nodeRunId,
          factory: stepSandbox,
          recipe: staticSandboxRecipe(stepSandbox.configuration ?? {}),
          auth: stepSandbox.configuration?.auth,
          assertOwner: () => assertNodeRunOwned(context, run.nodeRunId, execution.token),
          onAuthFailure: (error) => failure.abort(error),
        },
      })
    : ephemeralRunSandbox({ context, signal: input.signal, apiCredential })
  const attachmentContext = await prepareWorkflowInputAttachments({
    input: input.nodeInput,
    blobStorage: context.blobStorage,
    contextDirectory: sandbox.contextDirectory,
    signal: input.signal,
  })

  try {
    return await startAgentEnvironment({
      mode: "workflow-task",
      sandbox,
      sandboxSignal,
      failureSignal: failure.signal,
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
      toolAttachments: workflowInputToolAttachments({
        input: input.nodeInput,
        blobStorage: context.blobStorage,
      }),
      apiBaseUrl: context.apiBaseUrl,
      attachmentContext,
      ontologyDocs: renderRunOntologyDocs(context),
      errorDetails: input.errorDetails,
      onDetachedTeardown: input.onDetachedTeardown,
    })
  } catch (error) {
    // Provisioning can fail, or be abandoned, before the node receives this environment. Confirm
    // the step's credentials are closed before the node records its fate; a lost execution must
    // touch nothing.
    if (!isLostExecution(error, input.signal)) await sandbox.beforeFinalize?.()
    throw error
  }
}

/** Throw unless this execution still owns the node run; read before each provider action. */
async function assertNodeRunOwned(
  context: AgentExecutionContext,
  nodeRunId: string,
  executionToken: string
): Promise<void> {
  const current = await context.storage.workflowRuns?.agentNodes.getByNodeRunId({
    projectId: context.id,
    nodeRunId,
  })

  assertExecutionOwned({ current, executionToken, runId: nodeRunId })
}

interface AgentEnvironmentSetup extends Omit<CreateAgentEnvironmentInput, "signal"> {
  readonly sandbox: RunSandbox
  /**
   * Run end or environment failure: stops waiting for a sandbox the first model call needs, and
   * stops reading the artifacts it installs.
   */
  readonly sandboxSignal?: AbortSignal
  /** Environment-owned failure, such as lost source credentials. */
  readonly failureSignal?: AbortSignal
  readonly toolRun: AgentToolRunInfo
  readonly toolAttachments: AgentToolAttachments
  readonly actorId?: string
  readonly parentRunId?: string
  readonly mode: AgentExecutionMode
  readonly runId: string
  readonly threadId?: string
  readonly apiBaseUrl: string
  readonly attachmentContext: PreparedAgentAttachmentContext
  /** Installed under `$SIXB_ONTOLOGY_DIR`; a workflow step's prompt does not list them. */
  readonly ontologyDocs?: RenderedOntologyDocs
  readonly errorDetails?: AgentErrorDetails
  readonly frameworkTools?: readonly ModelTool[]
  /**
   * A conversation, or a child of one, publishes artifacts into the thread as the thread's owner
   * and edits them from storage; other runs return text.
   */
  readonly publishing?: {
    readonly threadId: string
    readonly owner: Principal
    readonly author: Principal
    readonly executionToken: string
  }
  /** A conversation's memory, or a child's to read: installed in the sandbox and in the prompt. */
  readonly memory?: ConversationMemory
}

/**
 * Start the shared tools, sandbox, and teardown lifecycle after source-specific preparation.
 * A blank sandbox boots concurrently with the model call and tools await it only when used; a
 * workspace (a thread's or a step's) is ready first, so the system prompt describes the one the
 * run got.
 */
async function startAgentEnvironment(
  input: AgentEnvironmentSetup
): Promise<AgentExecutionEnvironment> {
  const { mode, sandbox, context, actorId, plan, runId, threadId, apiBaseUrl, attachmentContext } =
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
  let ready: Promise<ProvisionedRunSandbox>
  const fileRegistry = new AgentSandboxFileRegistry()
  const fileBudget = new AgentFileBudget()
  const mediaBridge = new AgentToolResultMediaBridge({
    blobStorage: context.blobStorage,
    sandboxPathForFileRef: (fileRef) => fileRegistry.pathFor(fileRef),
  })
  const filesForToolCall = (input: {
    readonly toolName: string
    readonly toolCallId: string
    readonly signal: AbortSignal
  }) =>
    createAgentToolFiles({
      ...input,
      blobStorage: context.blobStorage,
      budget: fileBudget,
      resolveSandbox: () => ready,
      onPublished: (file) => fileRegistry.register(file.sandboxPath, file.fileRef),
    })
  const tools = [
    ...modelToolsFromAgentDefinitions({
      definitions: plan.tools,
      valueTypesById: context.valueTypesById,
      run: input.toolRun,
      sixb: context.sixb,
      attachments: input.toolAttachments,
      logger,
      filesForToolCall,
      toolResultToModelOutput: (output) => mediaBridge.toModelOutput(output),
      errorDetails: input.errorDetails,
    }),
  ]

  appendBuiltInTool(
    tools,
    createViewFileTool({
      resolveSandbox: () => ready,
      attachments: attachmentContext,
      registry: fileRegistry,
      filesForToolCall: ({ toolCallId, signal }) =>
        filesForToolCall({ toolName: "view_file", toolCallId, signal }),
      toolResultToModelOutput: (output) => mediaBridge.toModelOutput(output),
    })
  )
  const resolveSandbox = () => ready
  appendBuiltInTool(tools, createReadTool(resolveSandbox))
  appendBuiltInTool(tools, createBashTool(resolveSandbox))
  const artifactStorage = context.storage.artifacts
  let installedArtifacts: Promise<InstalledArtifacts> | undefined
  const { publishing } = input
  if (publishing && artifactStorage) {
    // Read concurrently with sandbox creation; both run while the model starts.
    installedArtifacts = materializeThreadArtifacts({
      threadId: publishing.threadId,
      // As the requester: the turn installs nothing they could not read themselves.
      artifacts: context.sixb.artifacts,
      blobStorage: context.blobStorage,
      directory: posix.join(sandbox.contextDirectory, AGENT_ARTIFACTS_DIRECTORY),
      manifestPath: posix.join(sandbox.contextDirectory, AGENT_ARTIFACTS_MANIFEST),
      signal: input.sandboxSignal,
    })
    // Surfaced where provisioning awaits it.
    installedArtifacts.catch(() => {})
    const publishTools = createPublishArtifactTools({
      projectId: context.id,
      storage: context.storage,
      artifacts: artifactStorage,
      reader: context.sixb.artifacts,
      blobStorage: context.blobStorage,
      run: {
        id: runId,
        threadId: publishing.threadId,
        executionToken: publishing.executionToken,
        ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
      },
      owner: publishing.owner,
      author: publishing.author,
      budget: fileBudget,
      resolveSandbox,
      installed: installedArtifacts,
    })
    for (const tool of publishTools) appendBuiltInTool(tools, tool)
  }
  for (const frameworkTool of input.frameworkTools ?? []) appendBuiltInTool(tools, frameworkTool)

  ready = provisionSandbox({
    sandbox,
    context,
    actorId,
    run: { id: runId, ...(threadId ? { threadId } : {}) },
    apiBaseUrl,
    attachmentContext,
    // A conversation's memory section names the memory skill; other runs never see it.
    skills: input.memory && mode === "conversation" ? [...plan.skills, MEMORY_SKILL] : plan.skills,
    ontologyFiles: input.ontologyDocs?.files ?? [],
    ...(installedArtifacts ? { artifacts: installedArtifacts } : {}),
    ...(input.memory ? { memory: input.memory.repos } : {}),
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

  const dispose = async () => {
    await Promise.all([
      disposeEnvironment(ready, () => settled, sandbox, input.onDetachedTeardown),
      logSession.flush(),
    ])
  }

  let systemPrompt: string
  try {
    const workspace = sandbox.waitBeforeModel
      ? await waitForAbort(ready, input.sandboxSignal)
      : undefined

    systemPrompt = renderAgentSystemPrompt({
      mode,
      contextDirectory: sandbox.contextDirectory,
      instructions: plan.instructions,
      skills: plan.skills,
      // Workflow prompts are kept lean: their steps get the files without the index.
      ...(mode !== "workflow-task" && input.ontologyDocs
        ? { ontologyIndex: input.ontologyDocs.index }
        : {}),
      sandboxResetAt: workspace?.resetAt,
      workspace: workspace?.promptContext,
      facts: agentRuntimeFacts({
        settings: plan,
        project: context,
        requester: context.requester,
      }),
      ...(plan.sandboxModels ? { sandboxModels: plan.sandboxModels } : {}),
      ...(input.memory ? { memory: input.memory.prompt } : {}),
    })
  } catch (error) {
    // Provisioning has started: give back what it acquires, or the sandbox outlives the run.
    await dispose()
    throw error
  }

  const beforeFinalize = (options?: BeforeFinalizeOptions) =>
    sandbox.beforeFinalize?.(options) ?? Promise.resolve()
  const artifacts =
    publishing && installedArtifacts
      ? { threadId: publishing.threadId, installed: installedArtifacts }
      : undefined
  const runFiles: AgentRunFiles = {
    sandbox: resolveSandbox,
    blobStorage: context.blobStorage,
    budget: fileBudget,
    async installArtifactsFrom(runIds, signal) {
      if (!artifacts) return

      await installArtifactsPublishedBy({
        installed: await artifacts.installed,
        threadId: artifacts.threadId,
        artifacts: context.sixb.artifacts,
        blobStorage: context.blobStorage,
        sandbox: (await ready).sandbox,
        runIds,
        signal,
      })
    },
  }
  return {
    beforeFinalize,
    runFiles,
    turnContext: {
      environmentFailureSignal: input.failureSignal,
      ...(sandbox.beforeFinalize ? { beforeFinalize } : {}),
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
      systemPrompt,
      projectTimeZone: context.timeZone,
      sandboxReady: ready,
      turnTimeoutMs: context.turnTimeoutMs,
    },
    dispose,
  }
}

/** Requesters with the same view share rendered docs; a project has few distinct views. */
const renderedOntologyDocs = new WeakMap<OntologyDocsCatalog, Map<string, RenderedOntologyDocs>>()
const MAX_RENDERED_ONTOLOGY_VIEWS = 16

/** Reference docs for the object types this run's requester can see, from its own view. */
function renderRunOntologyDocs(context: AgentExecutionContext): RenderedOntologyDocs {
  const { sixb, propertyClearance, ontologyDocs: catalog } = context
  const objectTypes = sixb.objects.listTypes()
  const actionsByType = new Map(
    objectTypes.map((objectType) => [objectType.id, sixb.actions.listForType(objectType)])
  )
  // Definitions are immutable, so the visible types, restricted properties, and requestable actions
  // determine the output.
  const key = JSON.stringify(
    objectTypes.map((objectType) => [
      objectType.id,
      [...(propertyClearance?.hiddenProperties(objectType.id)?.ids ?? [])],
      actionsByType.get(objectType.id)?.map((action) => action.id),
    ])
  )
  const views = renderedOntologyDocs.get(catalog) ?? new Map<string, RenderedOntologyDocs>()
  renderedOntologyDocs.set(catalog, views)
  const cached = views.get(key)
  if (cached) return cached

  const rendered = renderOntologyDocs({
    catalog,
    objectTypes,
    valueTypesById: sixb.objects.getValueTypesById(),
    actionsFor: (objectType) => actionsByType.get(objectType.id) ?? [],
    ...(propertyClearance === undefined
      ? {}
      : {
          restrictedPropertyIds: (objectTypeId) =>
            propertyClearance.hiddenProperties(objectTypeId)?.ids,
        }),
  })
  views.set(key, rendered)
  const oldest = views.keys().next().value
  if (views.size > MAX_RENDERED_ONTOLOGY_VIEWS && oldest !== undefined) views.delete(oldest)
  return rendered
}

/** The handed files' context, with what a continuation's history showed its tools. */
function mergeAttachmentContexts(
  handed: PreparedAgentAttachmentContext,
  history: PreparedAgentAttachmentContext
): PreparedAgentAttachmentContext {
  const manifest = (json: string) => JSON.parse(json) as { readonly attachments?: unknown[] }
  const handedManifest = manifest(handed.manifestJson)
  return {
    entries: [...handed.entries, ...history.entries],
    promptTextByPartKey: new Map([...handed.promptTextByPartKey, ...history.promptTextByPartKey]),
    modelFileDataByPartKey: new Map([
      ...handed.modelFileDataByPartKey,
      ...history.modelFileDataByPartKey,
    ]),
    sandboxFiles: [...handed.sandboxFiles, ...history.sandboxFiles],
    manifestJson: JSON.stringify(
      {
        ...handedManifest,
        attachments: [
          ...(handedManifest.attachments ?? []),
          ...(manifest(history.manifestJson).attachments ?? []),
        ],
      },
      null,
      2
    ),
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
  readonly sandbox: RunSandbox
  readonly context: AgentExecutionContext
  readonly actorId?: string
  readonly run: { readonly id: string; readonly threadId?: string }
  readonly apiBaseUrl: string
  readonly attachmentContext: PreparedAgentAttachmentContext
  readonly skills: ResolvedAgentExecutionPlan["skills"]
  readonly ontologyFiles: RenderedOntologyDocs["files"]
  /** The conversation's artifacts, read while the sandbox starts. */
  readonly artifacts?: Promise<MaterializedArtifacts>
  readonly memory?: PrepareAgentSandboxApiContextInput["memory"]
}

/** A sandbox acquired for the run, with the run's files installed in its context directory. */
type ProvisionedRunSandbox = AcquiredRunSandbox & AgentSandboxHandle

async function provisionSandbox(input: ProvisionSandboxInput): Promise<ProvisionedRunSandbox> {
  const { context, actorId, run, apiBaseUrl, skills, ontologyFiles } = input
  const acquired = await input.sandbox.acquire()
  const { sandbox } = acquired
  const { contextDirectory } = input.sandbox
  try {
    const apiContext = await prepareAgentSandboxApiContext({
      sandbox,
      contextDirectory,
      apiBaseUrl,
      projectId: context.id,
      ...(actorId === undefined ? {} : { actorId }),
      ...(run.threadId ? { threadId: run.threadId } : {}),
      runId: run.id,
      attachments: input.attachmentContext,
      skills,
      ontologyFiles,
      ...(input.artifacts ? { artifacts: await input.artifacts } : {}),
      ...(input.memory ? { memory: input.memory } : {}),
    })
    await assertAgentRuntimeProfile({
      sandbox,
      env: apiContext.env,
      projectId: context.id,
    })
    return { ...acquired, contextDirectory, env: { ...acquired.env, ...apiContext.env } }
  } catch (error) {
    // Give back a half-provisioned sandbox before propagating to the awaiter.
    await input.sandbox.release?.(acquired).catch(() => {})
    throw error
  }
}

function disposeEnvironment(
  ready: Promise<AcquiredRunSandbox>,
  isSettled: () => boolean,
  sandbox: RunSandbox,
  onDetachedTeardown?: (teardown: Promise<void>) => void
): Promise<void> {
  // Nothing to give back: teardown, and a worker's stop(), must not wait on provisioning.
  const release = sandbox.release?.bind(sandbox)
  if (!release) return Promise.resolve()

  // Release the sandbox once provisioning settles. A rejection means provisionSandbox already
  // released whatever it acquired, so there is nothing left to give back.
  const teardown = ready
    .then(release, () => undefined)
    .catch((error) => {
      console.error("[SixbAgentWorker] Could not release agent run sandbox:", error)
    })
  // Once provisioning has settled, await the release so cleanup completes inline.
  if (isSettled()) {
    return teardown
  }
  // Boot still in flight (the model answered before it finished and never used bash): don't stall
  // run teardown on it. Hand the chained release to the worker so a graceful stop() can drain it
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
