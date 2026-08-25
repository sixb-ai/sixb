import type { AgentDefinition, AuthorizationContext } from "@sixb/core"
import { AgentToolPublicError, isAllowed } from "@sixb/core"
import { requestSubAgentRun, resolveAgentExecutionAuthorization } from "@sixb/core/internal/agents"
import type { AgentRunRecord, ExecutionRecord } from "@sixb/core/storage"
import { jsonSchema, type Tool, tool } from "ai"
import { AgentExecutionLostError, AgentFinalizationError } from "./errors"
import { createAgentExecutionContext } from "./execution-context"
import { recordAgentRunFate } from "./finalize"
import { runAgentTurn } from "./run-agent-turn"
import { createConversationAgentEnvironment } from "./run-environment"
import type { AgentExecutionContext, AgentWorkerHost } from "./types"

/** Characters of a sub-agent answer handed back to the delegating model. */
const MAX_SUB_AGENT_OUTPUT_CHARS = 20_000

interface SubAgentToolInput {
  readonly agent: string
  readonly task: string
}

export interface SubAgentToolOutput {
  readonly agent: string
  readonly runId: string
  readonly executionId: string
  readonly status: AgentRunRecord["status"]
  readonly result: string
  /** Set when `result` was cut, so the model does not treat a partial answer as complete. */
  readonly resultTruncated: boolean
}

export interface CreateSubAgentToolInput {
  /** The delegating run's execution context; the child rebinds it to its own service account. */
  readonly context: AgentExecutionContext
  readonly host: AgentWorkerHost
  readonly parentRun: AgentRunRecord
  readonly parentExecution: ExecutionRecord
  /**
   * The delegating turn's abort sources. A child must never outlive its parent: it would keep the
   * worker's claim slot past the parent's own turn budget, which is the starvation this design
   * exists to prevent.
   */
  readonly parentSignal: AbortSignal
  /** The requester's rebuilt authority; also decides which agents the model is shown. */
  readonly requesterAuthorization: AuthorizationContext | null
  /** Keeps the child's execution ownership renewing alongside the delegating run's queue lease. */
  readonly trackChildOwnership: (child: {
    readonly runId: string
    readonly executionToken: string
  }) => () => void
  readonly onDetachedTeardown?: (teardown: Promise<void>) => void
}

/** Agents this run may delegate to: never itself, and only what the requester could run directly. */
export function resolveSubAgentTargets(input: {
  readonly host: AgentWorkerHost
  readonly agentId: string
  readonly requesterAuthorization: AuthorizationContext | null
}): readonly AgentDefinition[] {
  if (!input.requesterAuthorization) return []
  return input.host.definitions.agents
    .list()
    .filter(
      (target) =>
        target.id !== input.agentId &&
        isAllowed(input.requesterAuthorization, { kind: "agent.run", agentId: target.id })
    )
}

export interface SubAgentTool {
  readonly tool: Tool<SubAgentToolInput, SubAgentToolOutput>
  /**
   * Rethrow a child finalization failure the AI SDK swallowed.
   *
   * A thrown tool error becomes tool-result *text* (`agentToolErrorText`), so a child whose work
   * was recorded but whose finalize was not would otherwise be reported to the model as a plain
   * failure and the delegating turn would finalize `succeeded`. The turn calls this before it
   * interprets the stream, mirroring `AiModelCallRecorder.assertHealthy`.
   */
  assertHealthy(): void
}

/**
 * Build the `sub_agent` tool for one delegating turn.
 *
 * The child runs **in the delegating run's worker slot** rather than through the agent queue. The
 * queue is a single lane with a claim limit, so a parent blocked on a queued child holds the slot
 * that child needs; enough concurrent parents and nothing is left to claim. Running in-process
 * cannot starve, and the child still gets its own execution, run, service account, sandbox and
 * usage rows.
 *
 * Calls are serialized. Every execution provisions a sandbox eagerly, so a parallel fan-out would
 * boot one machine per child at once; one-at-a-time bounds that to two. Revisit if delegation
 * latency ever matters more than sandbox headroom.
 */
export function createSubAgentTool(input: CreateSubAgentToolInput): SubAgentTool {
  const targets = resolveSubAgentTargets({
    host: input.host,
    agentId: input.parentRun.agentId,
    requesterAuthorization: input.requesterAuthorization,
  })
  let gate: Promise<unknown> = Promise.resolve()
  let finalizationError: unknown

  const subAgentTool = tool({
    description: [
      "Delegate a self-contained task to a specialist agent and wait for its answer.",
      "The agent starts with no history, so `task` must carry every detail it needs.",
      "Available agents:",
      ...targets.map((target) =>
        target.description
          ? `- ${target.id}: ${target.name} — ${target.description}`
          : `- ${target.id}: ${target.name}`
      ),
    ].join("\n"),
    inputSchema: jsonSchema<SubAgentToolInput>({
      type: "object",
      properties: {
        agent: { type: "string", enum: targets.map((target) => target.id) },
        task: { type: "string" },
      },
      required: ["agent", "task"],
      additionalProperties: false,
    }),
    execute(toolInput, { abortSignal }): Promise<SubAgentToolOutput> {
      const signal = AbortSignal.any([input.parentSignal, ...(abortSignal ? [abortSignal] : [])])
      const run = () =>
        runSubAgent(input, toolInput, signal).catch((error) => {
          if (error instanceof AgentFinalizationError) {
            finalizationError ??= error
          }
          throw error
        })
      const next = gate.then(run, run)
      // Registered whole, not just the failure path, so a graceful stop() drains a child that is
      // still finalizing after the delegating turn has already returned.
      input.onDetachedTeardown?.(
        next.then(
          () => undefined,
          () => undefined
        )
      )
      gate = next.catch(() => undefined)
      return next
    },
  })

  return {
    tool: subAgentTool,
    assertHealthy() {
      if (finalizationError !== undefined) {
        throw finalizationError
      }
    },
  }
}

async function runSubAgent(
  deps: CreateSubAgentToolInput,
  toolInput: SubAgentToolInput,
  signal: AbortSignal
): Promise<SubAgentToolOutput> {
  // Re-checked *after* the gate, not before it: a queued call must not mint a durable execution,
  // thread and running run for work that can no longer happen.
  if (signal.aborted) {
    throw new AgentToolPublicError("Delegation was cancelled.")
  }

  const { context, host } = deps
  const agent = host.definitions.agents.getById(toolInput.agent)
  if (!agent || !deps.requesterAuthorization) {
    throw new AgentToolPublicError(`Unknown agent '${toolInput.agent}'.`)
  }

  const admitted = await requestSubAgentRun({
    storage: context.storage,
    projectId: context.id,
    security: host.definitions.security,
    agent,
    parentExecution: deps.parentExecution,
    parentRun: deps.parentRun,
    prompt: toolInput.task,
    // Mirrors the delegating run's queue lease: the child lives inside the parent's turn, so the
    // parent's ownership window is the child's too.
    queueLeaseExpiresAt: requireParentLease(deps.parentRun),
  })

  const executionToken = admitted.run.execution?.token
  if (!executionToken) {
    throw new AgentToolPublicError(`Agent '${agent.id}' run could not be started.`)
  }

  const resolved = await resolveAgentExecutionAuthorization({
    auth: context.storage.auth,
    projectId: context.id,
    agentId: agent.id,
    authorizationRef: admitted.execution.authorizationRef,
    security: host.definitions.security,
  })
  const childContext = createAgentExecutionContext({
    context,
    host,
    execution: admitted.execution,
    agentId: agent.id,
    runId: admitted.run.id,
    authorization: resolved.context,
    agentPrincipal: resolved.identity.principal,
  })

  let environment: Awaited<ReturnType<typeof createConversationAgentEnvironment>> | null = null
  // The child's lease starts as a copy of the parent's current one; this keeps the two moving
  // together for as long as the child runs.
  const untrackOwnership = deps.trackChildOwnership({
    runId: admitted.run.id,
    executionToken,
  })
  try {
    await context.streamSink.publishStarted(admitted.run)
    environment = await createConversationAgentEnvironment({
      context: childContext,
      agent,
      run: admitted.run,
      ...(deps.onDetachedTeardown ? { onDetachedTeardown: deps.onDetachedTeardown } : {}),
    })
    await runAgentTurn({
      context: environment.turnContext,
      agent,
      run: admitted.run,
      signal,
    })
  } catch (error) {
    // The child's work was recorded but its finalize could not be. Propagating keeps the delegating
    // turn from reporting a lost child as an answer; the parent's own job is then redelivered.
    if (error instanceof AgentFinalizationError) {
      throw error
    }
    if (!(error instanceof AgentExecutionLostError)) {
      await recordAgentRunFate({
        storage: context.storage.agents,
        projectId: context.id,
        run: admitted.run,
        executionToken,
        status: signal.aborted ? "cancelled" : "failed",
        error,
      })
    }
    throw new AgentToolPublicError(`Agent '${agent.id}' could not complete the task.`)
  } finally {
    untrackOwnership()
    await environment?.dispose()
  }

  return readSubAgentOutcome(context, agent, admitted.run.id, admitted.threadId)
}

async function readSubAgentOutcome(
  context: AgentExecutionContext,
  agent: AgentDefinition,
  runId: string,
  threadId: string
): Promise<SubAgentToolOutput> {
  const finished = await context.storage.agents.runs.getById({ projectId: context.id, id: runId })
  const answers = await context.storage.agents.messages.list({
    projectId: context.id,
    threadId,
    roles: ["assistant"],
    order: "desc",
    limit: 1,
  })
  const text = (answers.messages[0]?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()

  const truncated = text.length > MAX_SUB_AGENT_OUTPUT_CHARS
  return {
    agent: agent.id,
    runId,
    executionId: finished?.executionId ?? "",
    status: finished?.status ?? "failed",
    result: truncated ? text.slice(0, MAX_SUB_AGENT_OUTPUT_CHARS) : text,
    resultTruncated: truncated,
  }
}

function requireParentLease(parentRun: AgentRunRecord): Date {
  const lease = parentRun.execution?.queueLeaseExpiresAt
  if (!lease) {
    throw new AgentToolPublicError("Delegation is unavailable for this run.")
  }
  return lease
}
