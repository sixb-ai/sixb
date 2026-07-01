import type { AgentDefinition, AgentRunRecord, Sandbox } from "@sixb/core"
import { renderAgentSkillCatalog } from "./agent-skills"
import { createAgentApiGatewayBaseUrl } from "./api-url"
import { type BashSandboxHandle, createBashTool } from "./bash-tool"
import { prepareAgentSandboxApiContext } from "./sandbox-api-context"
import type { AgentTurnContext, AgentWorkerContext } from "./types"

export interface AgentRunEnvironment {
  readonly turnContext: AgentTurnContext
  dispose(): Promise<void>
}

export interface CreateAgentRunEnvironmentInput {
  readonly context: AgentWorkerContext
  readonly agent: AgentDefinition
  readonly run: AgentRunRecord
  /**
   * Sink for a sandbox teardown that outlives dispose() (the model answered before the boot
   * finished, so dispose returns without stalling on it). The worker registers these so a graceful
   * stop() can drain them instead of leaving orphaned machines being torn down.
   */
  readonly onDetachedTeardown?: (teardown: Promise<void>) => void
}

/**
 * Build the per-run turn context.
 *
 * Sandbox creation (boot + writing the run's API context) is the slow part, but
 * it is only needed once the bash tool first runs — not to start the turn. So we
 * kick it off here and return immediately: the system prompt (a static skill
 * catalog) and tool set are ready synchronously, and the ~boot latency overlaps
 * the model's first response instead of blocking it. The bash tool awaits the
 * sandbox on first use; dispose() awaits it before teardown.
 */
export async function createAgentRunEnvironment(
  input: CreateAgentRunEnvironmentInput
): Promise<AgentRunEnvironment> {
  const { context, agent, run } = input

  const apiBaseUrl = createAgentApiGatewayBaseUrl({
    apiBaseUrl: context.apiBaseUrl,
    projectId: context.id,
    run,
  })
  const apiOrigin = new URL(apiBaseUrl).origin

  // Provision concurrently; do NOT await. The bash tool, the turn, and dispose() await this.
  const ready = provisionSandbox({ context, agent, run, apiBaseUrl, apiOrigin })
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
      storage: context.storage,
      tools: {
        ...context.baseTools,
        bash: createBashTool(() => ready),
      },
      systemAddendum: renderAgentSkillCatalog(),
      sandboxReady: ready,
      streamSink: context.streamSink,
      leaseMs: context.leaseMs,
      heartbeatMs: context.heartbeatMs,
      defaultMaxSteps: context.defaultMaxSteps,
      turnTimeoutMs: context.turnTimeoutMs,
    },
    dispose: () => disposeEnvironment(ready, () => settled, input.onDetachedTeardown),
  }
}

interface ProvisionSandboxInput {
  readonly context: AgentWorkerContext
  readonly agent: AgentDefinition
  readonly run: AgentRunRecord
  readonly apiBaseUrl: string
  readonly apiOrigin: string
}

async function provisionSandbox(input: ProvisionSandboxInput): Promise<BashSandboxHandle> {
  const { context, agent, run, apiBaseUrl, apiOrigin } = input
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
      threadId: run.threadId,
      runId: run.id,
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
