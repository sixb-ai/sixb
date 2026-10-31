import { type OpenRunSandbox, runApiCredential, runTokenFor } from "@sixb/agent"
import type { SandboxDefinition, SandboxFactory } from "@sixb/core"
import type { AgentRunSession, WorkflowAgentNodeSession } from "@sixb/core/internal/agents"
import { staticSandboxRecipe } from "@sixb/core/internal/agents"
import type {
  AgentThreadRecord,
  ConversationAgentRunRecord,
  SubagentRunRecord,
  WorkflowAgentNodeRunRecord,
} from "@sixb/core/storage"
import { ephemeralRunSandbox } from "./ephemeral-run-sandbox"
import { keepsSubagentWorkspace, persistentRunSandbox } from "./persistent-run-sandbox"
import type { AgentRunnerContext, AgentWorkerContext } from "./types"

/**
 * The cloud runner's environments: a sandbox from the project's factory, a thread's workspace, or a
 * workflow step's own. Each holds the run's token as a request credential, outside the sandbox.
 */
export function conversationSandbox(input: {
  readonly context: AgentRunnerContext
  readonly session: AgentRunSession
  readonly run: ConversationAgentRunRecord
  readonly thread?: AgentThreadRecord | null
  readonly definition?: SandboxDefinition
}): OpenRunSandbox {
  const { context, session, run, thread } = input
  const apiCredential = runCredential(context, run.id, run.execution?.token)
  return async ({ signal, onFailure }) => ({
    sandbox: thread?.sandboxParams
      ? await persistentRunSandbox({
          context,
          session,
          ...(input.definition === undefined ? {} : { definition: input.definition }),
          thread,
          run,
          signal,
          apiCredential,
          onAuthFailure: onFailure,
        })
      : ephemeralRunSandbox({ context, apiCredential }),
  })
}

/** A child's: its thread's workspace when the factory keeps workspaces, else a blank sandbox. */
export function childSandbox(input: {
  readonly context: AgentRunnerContext
  readonly session: AgentRunSession
  readonly run: SubagentRunRecord
  readonly thread: AgentThreadRecord
}): OpenRunSandbox {
  const { context, session, run, thread } = input
  const apiCredential = runCredential(context, run.id, run.execution?.token)
  return async ({ signal, onFailure }) => {
    if (!keepsSubagentWorkspace(context.sandboxes)) {
      return { sandbox: ephemeralRunSandbox({ context, apiCredential }) }
    }
    const workspace = await persistentRunSandbox({
      context,
      session,
      thread,
      run,
      signal,
      apiCredential,
      onAuthFailure: onFailure,
    })
    return { sandbox: workspace, resumed: workspace.resumed }
  }
}

/**
 * A workflow step's: a fresh workspace from the step's own factory and static recipe, or a blank
 * sandbox from the project's.
 */
export function workflowStepSandbox(input: {
  readonly context: Pick<AgentWorkerContext, "id" | "sandboxes" | "apiBaseUrl">
  readonly session: Pick<WorkflowAgentNodeSession, "assertOwned">
  readonly run: WorkflowAgentNodeRunRecord
  readonly stepSandbox?: SandboxFactory
}): OpenRunSandbox {
  const { context, session, run, stepSandbox } = input
  const apiCredential = runCredential(context, run.nodeRunId, run.execution?.token)
  return async ({ signal, onFailure }) => ({
    sandbox: stepSandbox
      ? ephemeralRunSandbox({
          context,
          signal,
          apiCredential,
          workspace: {
            runId: run.nodeRunId,
            factory: stepSandbox,
            recipe: staticSandboxRecipe(stepSandbox.configuration ?? {}),
            auth: stepSandbox.configuration?.auth,
            assertOwner: () => session.assertOwned(),
            onAuthFailure: onFailure,
          },
        })
      : ephemeralRunSandbox({ context, signal, apiCredential }),
  })
}

function runCredential(
  context: Pick<AgentWorkerContext, "id" | "apiBaseUrl">,
  runId: string,
  executionToken: string | undefined
) {
  return runApiCredential(
    context.apiBaseUrl,
    runTokenFor({ projectId: context.id, runId, executionToken })
  )
}
