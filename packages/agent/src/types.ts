import type { AuthorizablePrincipal, Sixb, SixbDefinitions, ValueType } from "@sixb/core"
import type { AgentRunFileStore, RunModelLoopInput } from "@sixb/core/internal/agents"
import type { LoggingService } from "@sixb/core/internal/logging"
import type { ModelTool } from "@sixb/core/models"
import type { PreparedAgentAttachmentContext } from "./attachments"
import type { AgentRequester } from "./requester"
import type { BeforeFinalizeOptions } from "./run-sandbox"
import type { AgentSandboxHandle } from "./sandbox-handle"
import type { AgentFileBudget } from "./tools/tool-files"

/**
 * What every run of a project shares, whichever runner runs it: its settings and catalogs. A run
 * reaches shared state through its session, never through storage.
 */
export interface AgentRunSettings {
  /** The project id. */
  readonly id: string
  readonly logging?: LoggingService
  readonly valueTypesById: ReadonlyMap<string, ValueType>
  /** The Sixb API origin the run's commands call, through their environment's credentialed address. */
  readonly apiBaseUrl: string
  /** How many children one conversation turn may have queued or running at once. */
  readonly subagentConcurrencyPerRun: number
  /** Whether a child keeps its workspace between runs: its environment can be resumed. */
  readonly keepsChildWorkspaces: boolean
  /** Project locale and time zone, for runs that do not carry the requester's own. */
  readonly locale: string
  readonly timeZone: string
}

/** The project's catalogs a turn offers its children: their models and tools. */
export interface AgentProjectCatalogs {
  readonly definitions: Pick<SixbDefinitions, "models" | "tools">
}

/** Provider ports activated only after an Agent execution scope is bound. */
export interface AgentExecutionContext extends AgentRunSettings {
  readonly sixb: Sixb
  readonly authorPrincipal?: AuthorizablePrincipal
  /**
   * Who the run works for; absent when no principal started its chain of executions, or in a
   * shared thread, where each user message names its author instead.
   */
  readonly requester?: AgentRequester
  readonly blobStorage: AgentRunFileStore
}

export interface AgentTurnContext {
  /** Environment-owned failure (for example lost source credentials), not user cancellation. */
  readonly environmentFailureSignal?: AbortSignal
  /** Persistent environments must confirm cleanup/save before any terminal write. */
  readonly beforeFinalize?: (options?: BeforeFinalizeOptions) => Promise<void>
  readonly id: string
  readonly authorPrincipal?: AuthorizablePrincipal
  readonly blobStorage: AgentRunFileStore
  /** The Sixb API the run's commands call, when this turn was created through a run environment. */
  readonly apiBaseUrl?: string
  readonly tools: readonly ModelTool[]
  readonly prepareStep?: RunModelLoopInput["prepareStep"]
  /** Complete worker-owned system prompt, derived from the mode and provisioned runtime. */
  readonly systemPrompt: string
  /** Time zone of runs that captured none, used to date their user messages. */
  readonly projectTimeZone: string
  /** Prepared by the run's environment, which materializes the files in its context directory. */
  readonly attachmentContext?: PreparedAgentAttachmentContext
  /**
   * The concurrently provisioning sandbox, exposed so the turn can fail if it rejects. Resolved
   * value is irrelevant here (the sandbox tools consume the handle); only its rejection matters.
   */
  readonly sandboxReady?: Promise<AgentSandboxHandle>
}

/**
 * A run's sandbox and its stored files, as its framework tools use them: a parent hands files to
 * its children and gets theirs back, a child returns what it wrote.
 */
export interface AgentRunFiles {
  sandbox(): Promise<AgentSandboxHandle>
  readonly blobStorage: AgentRunFileStore
  /** Shared with every other file the run stores. */
  readonly budget: AgentFileBudget
  /**
   * Install the latest version of each artifact these runs published in the thread in the run's
   * `$SIXB_ARTIFACTS`; nothing for a run that installs no artifacts. Throws, naming them, when
   * some could not be installed.
   */
  installArtifactsFrom(runIds: readonly string[], signal: AbortSignal): Promise<void>
}
