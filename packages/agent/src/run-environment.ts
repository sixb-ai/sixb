import { posix } from "node:path"
import type { Principal } from "@sixb/core"
import {
  type AgentRunArtifacts,
  type AgentRunSession,
  type AgentTurnHistory,
  conversationThreadId,
  subagentSandboxFiles,
} from "@sixb/core/internal/agents"
import type { RenderedOntologyDocs } from "@sixb/core/internal/ontology"
import type { WorkflowIOSnapshot } from "@sixb/core/internal/workflows"
import type { ModelTool } from "@sixb/core/models"
import type {
  AgentThreadRecord,
  ConversationAgentRunRecord,
  SubagentRunRecord,
  WorkflowAgentNodeRunRecord,
} from "@sixb/core/storage"
import { NEVER_ABORTED_SIGNAL, waitForAbort } from "./abort"
import { type AgentExecutionMode, agentRuntimeFacts, renderAgentSystemPrompt } from "./agent-prompt"
import { assertAgentRuntimeProfile } from "./agent-runtime/preflight"
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
import { isLostExecution } from "./errors"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import { InlineImageBudget } from "./inline-images"
import type { ConversationReaders } from "./message-authors"
import { type AgentErrorDetails, type AgentToolCaller, projectModelTools } from "./model-adapters"
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
import type { SubagentHistory } from "./subagent-continuation"
import { agentThreadModelContext, type LoadedAgentThreadModelContext } from "./thread-context"
import { createBashTool } from "./tools/bash"
import { createReadTool } from "./tools/read"
import {
  AgentToolResultMediaBridge,
  allocateInlineImages,
  replayToolFiles,
  type SuppliesToolFiles,
} from "./tools/result-media"
import { AgentFileBudget, createAgentToolFiles, installAgentToolFiles } from "./tools/tool-files"
import { createViewFileTool, VIEW_FILE_TOOL_SPEC } from "./tools/view-file"
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
  /** The history the turn runs on: as it started, or as its compaction left it. */
  readonly threadContext: LoadedAgentThreadModelContext
}

/**
 * How a runner gives a run its environment: a cloud sandbox, or a folder on a computer. The runner
 * closes over whatever it opens it from (a factory, the thread's recipe, the run's credentials).
 */
export type OpenRunSandbox = (lifecycle: {
  /** Stops provisioning: cancellation, lost ownership, or shutdown. */
  readonly signal: AbortSignal
  /** Ends the run when its environment can no longer serve it, such as lost source credentials. */
  readonly onFailure: (error: Error) => void
}) => Promise<OpenedRunSandbox>

export interface OpenedRunSandbox {
  readonly sandbox: RunSandbox
  /** The workspace the run's paused attempt left: it holds that attempt's files already. */
  readonly resumed?: boolean
}

interface CreateAgentEnvironmentInput {
  readonly context: AgentExecutionContext
  readonly plan: ResolvedAgentExecutionPlan
  /** The run's environment, opened by its runner. */
  readonly openSandbox: OpenRunSandbox
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
  /** Run preflight only after current sandbox access has been resolved. */
  readonly preflight?: { readonly budget: AgentContextBudget; readonly runtime: AgentTurnRuntime }
  readonly run: ConversationAgentRunRecord
  /** The conversation's history as the turn started (`AgentTurnContext.history`). */
  readonly history: AgentTurnHistory
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
  /** How the step calls a project tool: it runs in the cloud, so in the worker's process. */
  readonly callTool: AgentToolCaller
}

/** Prepare conversation history and attachments, then start the shared agent environment. */
export async function createConversationAgentEnvironment(
  input: CreateConversationAgentEnvironmentInput
): Promise<ConversationAgentExecutionEnvironment> {
  const { context, plan, run, preflight } = input
  const { apiBaseUrl } = context
  const failure = new AbortController()
  const sandboxSignal = input.signal
    ? AbortSignal.any([input.signal, failure.signal])
    : failure.signal
  const { sandbox } = await input.openSandbox({
    signal: sandboxSignal,
    onFailure: (error) => failure.abort(error),
  })
  let environment: AgentExecutionEnvironment | undefined
  // The prompt shows memory as of the thread's start or its latest compaction (see
  // loadConversationMemory).
  const threadCreatedAt = input.thread?.createdAt ?? run.createdAt
  const loadMemory: LoadConversationMemory = (checkpoint) =>
    loadConversationMemory({
      session: input.session,
      asOf: checkpoint?.createdAt ?? threadCreatedAt,
    })
  try {
    const { ontologyDocs } = plan
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
          history: input.history,
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
    const threadContext = prepared?.threadContext ?? agentThreadModelContext(input.history)
    const messages = threadContext.retainedMessages
    const [inlineImages, memory] = await Promise.all([
      modelSupportsInlineImages(plan.model),
      prepared ? prepared.memory : loadMemory(threadContext.checkpoint),
    ])
    const attachments = await prepareAgentAttachments({
      projectId: context.id,
      threadId: run.threadId,
      messages,
      blobStorage: context.blobStorage,
      apiBaseUrl,
      contextDirectory: sandbox.contextDirectory,
      inlineImages,
      signal: sandboxSignal,
    })

    // The history takes the request's inline image budget first; the run's steps, what is left.
    const imageBudget = new InlineImageBudget()
    const attachmentContext = await allocateInlineImages({
      messages,
      attachments,
      toolFiles: replayToolFiles({
        messages,
        suppliesToolFiles: suppliesToolFiles(plan),
        supportsImages: inlineImages,
      }),
      budget: imageBudget,
      blobStorage: context.blobStorage,
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
      callTool: (call, options) => input.session.callTool(call, options),
      ...(input.thread && run.execution
        ? {
            publishing: {
              artifacts: input.session.artifacts,
              threadId: input.thread.id,
              owner: input.thread.ownerPrincipal,
            },
          }
        : {}),
      apiBaseUrl,
      attachmentContext,
      imageBudget,
      ontologyDocs,
      frameworkTools: input.frameworkTools,
      ...(memory ? { memory } : {}),
      onDetachedTeardown: input.onDetachedTeardown,
    })
    return { ...environment, threadContext }
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
  // A child's workspace is blank, so it has no source credentials to lose.
  const { sandbox, resumed = false } = await input.openSandbox({
    signal: input.signal ?? NEVER_ABORTED_SIGNAL,
    onFailure: () => {},
  })

  try {
    return await startSubagentEnvironment({ ...input, sandbox, resumed })
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
    readonly sandbox: RunSandbox
    /** Whether the sandbox is the workspace the paused run left: it holds its files already. */
    readonly resumed: boolean
  }
): Promise<AgentExecutionEnvironment> {
  const { context, plan, run, conversation, sandbox, resumed } = input
  // Still listed, as handed over, but never copied over what the child made of them.
  const files = resumed ? (run.spec.files ?? []) : subagentSandboxFiles(run, input.history.paused)
  const history = input.history.messages
  const inlineImages = modelSupportsInlineImages(plan.model)
  const [memory, handedContext, historyContext] = await Promise.all([
    // As of the thread's start, as a conversation's: each run of the child reads the same memory.
    loadConversationMemory({ session: input.session, asOf: input.thread.createdAt }),
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
          inlineImages,
          signal: input.signal,
        })
      : undefined,
  ])

  const imageBudget = new InlineImageBudget()
  const attachmentContext = await allocateInlineImages({
    messages: history,
    attachments: historyContext
      ? mergeAttachmentContexts(handedContext, historyContext)
      : handedContext,
    toolFiles: replayToolFiles({
      messages: history,
      suppliesToolFiles: suppliesToolFiles(plan),
      supportsImages: inlineImages,
    }),
    budget: imageBudget,
    blobStorage: context.blobStorage,
    signal: input.signal ?? NEVER_ABORTED_SIGNAL,
  })

  return startAgentEnvironment({
    mode: "subagent",
    sandbox,
    sandboxSignal: input.signal,
    context,
    plan,
    runId: run.id,
    parentRunId: run.parentRunId,
    threadId: conversationThreadId(input.thread),
    callTool: (call, options) => input.session.callTool(call, options),
    ...(conversation
      ? {
          publishing: {
            artifacts: input.session.artifacts,
            threadId: conversation.id,
            owner: conversation.ownerPrincipal,
          },
        }
      : {}),
    apiBaseUrl: context.apiBaseUrl,
    attachmentContext,
    imageBudget,
    ontologyDocs: plan.ontologyDocs,
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
      `[SixbAgent] Agent workflow node run '${run.nodeRunId}' must hold an execution token.`
    )
  }
  // Cancellation, lost ownership or worker shutdown stop provisioning. A step's lost source
  // credentials end the node through `failure`.
  const failure = new AbortController()
  const sandboxSignal = input.signal
    ? AbortSignal.any([input.signal, failure.signal])
    : failure.signal

  const { sandbox } = await input.openSandbox({
    signal: sandboxSignal,
    onFailure: (error) => failure.abort(error),
  })
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
      callTool: input.callTool,
      apiBaseUrl: context.apiBaseUrl,
      attachmentContext,
      // A step's inputs are files, never inline images: its own steps have the whole budget.
      imageBudget: new InlineImageBudget(),
      ontologyDocs: plan.ontologyDocs,
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

interface AgentEnvironmentSetup
  extends Omit<CreateAgentEnvironmentInput, "signal" | "openSandbox"> {
  readonly sandbox: RunSandbox
  /**
   * Run end or environment failure: stops waiting for a sandbox the first model call needs, and
   * stops reading the artifacts it installs.
   */
  readonly sandboxSignal?: AbortSignal
  /** Environment-owned failure, such as lost source credentials. */
  readonly failureSignal?: AbortSignal
  /** How the run calls a project tool. */
  readonly callTool: AgentToolCaller
  readonly actorId?: string
  readonly parentRunId?: string
  readonly mode: AgentExecutionMode
  readonly runId: string
  readonly threadId?: string
  readonly apiBaseUrl: string
  readonly attachmentContext: PreparedAgentAttachmentContext
  /** What the history left of the request's inline image budget, which the run's steps take. */
  readonly imageBudget: InlineImageBudget
  /** Installed under `$SIXB_ONTOLOGY_DIR`; a workflow step's prompt does not list them. */
  readonly ontologyDocs?: RenderedOntologyDocs
  readonly errorDetails?: AgentErrorDetails
  readonly frameworkTools?: readonly ModelTool[]
  /**
   * A conversation, or a child of one, publishes artifacts into its conversation, through its
   * session, and edits them from their installed copies; other runs return text.
   */
  readonly publishing?: {
    readonly artifacts: AgentRunArtifacts
    /** The conversation's thread, and its owner, who owns what the run creates. */
    readonly threadId: string
    readonly owner: Principal
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

  let ready: Promise<ProvisionedRunSandbox>
  const fileRegistry = new AgentSandboxFileRegistry()
  const fileBudget = new AgentFileBudget()
  const mediaBridge = new AgentToolResultMediaBridge({
    blobStorage: context.blobStorage,
    suppliesToolFiles: suppliesToolFiles(plan),
    inlineImages: input.imageBudget,
    // As the agent names it, so the output a later turn replays names the path that turn
    // materializes the file at, in its own sandbox.
    sandboxPathForFileRef: async (fileRef) => {
      const path = fileRegistry.pathFor(fileRef)
      return path === undefined ? undefined : agentSandboxPath(await ready, path)
    },
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
    ...projectModelTools({
      specs: plan.tools,
      runId,
      callTool: input.callTool,
      contextDirectory: sandbox.contextDirectory,
      fileBytesLeft: () => fileBudget.maxBytes - fileBudget.reservedBytes,
      installFiles: ({ toolName, files, signal }) =>
        installAgentToolFiles({
          toolName,
          files,
          blobStorage: context.blobStorage,
          resolveSandbox: () => ready,
          budget: fileBudget,
          signal,
          onPublished: (file) => fileRegistry.register(file.sandboxPath, file.fileRef),
        }),
      toolResultToModelOutput: (output) => mediaBridge.toModelOutput(output),
      ...(input.errorDetails === undefined ? {} : { errorDetails: input.errorDetails }),
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
  let installedArtifacts: Promise<InstalledArtifacts> | undefined
  const { publishing } = input
  if (publishing) {
    // Read concurrently with sandbox creation; both run while the model starts.
    installedArtifacts = materializeThreadArtifacts({
      threadId: publishing.threadId,
      // As the requester: the turn installs nothing they could not read themselves.
      artifacts: publishing.artifacts,
      blobStorage: context.blobStorage,
      directory: posix.join(sandbox.contextDirectory, AGENT_ARTIFACTS_DIRECTORY),
      manifestPath: posix.join(sandbox.contextDirectory, AGENT_ARTIFACTS_MANIFEST),
      signal: input.sandboxSignal,
    })
    // Surfaced where provisioning awaits it.
    installedArtifacts.catch(() => {})
    const publishTools = createPublishArtifactTools({
      artifacts: publishing.artifacts,
      threadId: publishing.threadId,
      owner: publishing.owner,
      blobStorage: context.blobStorage,
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

  const dispose = () => disposeEnvironment(ready, () => settled, sandbox, input.onDetachedTeardown)

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
      ? { reader: publishing.artifacts, installed: installedArtifacts }
      : undefined
  const runFiles: AgentRunFiles = {
    sandbox: resolveSandbox,
    blobStorage: context.blobStorage,
    budget: fileBudget,
    async installArtifactsFrom(runIds, signal) {
      if (!artifacts) return

      await installArtifactsPublishedBy({
        installed: await artifacts.installed,
        artifacts: artifacts.reader,
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
      blobStorage: context.blobStorage,
      apiBaseUrl,
      attachmentContext,
      tools,
      prepareStep: mediaBridge.prepareStep,
      systemPrompt,
      projectTimeZone: context.timeZone,
      sandboxReady: ready,
    },
    dispose,
  }
}

/** An absolute sandbox path relative to the working directory when it is inside it. */
function agentSandboxPath(handle: AgentSandboxHandle, path: string): string {
  const relative = posix.relative(handle.sandbox.workingDirectory, path)
  return relative && !relative.startsWith("../") && !posix.isAbsolute(relative) ? relative : path
}

/**
 * The tools whose images reach the model after their step: the project's and `view_file`, whose
 * outputs go through the run's media bridge. A replay asks the same of the stored trace.
 */
function suppliesToolFiles(plan: Pick<ResolvedAgentExecutionPlan, "tools">): SuppliesToolFiles {
  const names = new Set([...plan.tools.map((tool) => tool.name), VIEW_FILE_TOOL_SPEC.name])
  return (toolName) => names.has(toolName)
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
    ...(history.pendingImages === undefined ? {} : { pendingImages: history.pendingImages }),
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
      console.error("[SixbAgent] Could not release agent run sandbox:", error)
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
    throw new Error(`[SixbAgent] Agent tool name '${tool.name}' is reserved by the worker runtime.`)
  }
  tools.push(tool)
}
