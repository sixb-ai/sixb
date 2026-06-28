import type { AgentDefinition, AgentRunRecord, Sandbox } from "@sixb/core"
import { createAgentApiGatewayBaseUrl } from "./api-url"
import { createBashTool } from "./bash-tool"
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
}

export async function createAgentRunEnvironment(
  input: CreateAgentRunEnvironmentInput
): Promise<AgentRunEnvironment> {
  const { context, agent, run } = input
  let sandbox: Sandbox | null = null

  try {
    const apiBaseUrl = createAgentApiGatewayBaseUrl({
      apiBaseUrl: context.apiBaseUrl,
      projectId: context.id,
      run,
    })
    const apiOrigin = new URL(apiBaseUrl).origin

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

    return {
      turnContext: {
        id: context.id,
        storage: context.storage,
        tools: {
          ...context.baseTools,
          bash: createBashTool(sandbox, { env: apiContext.env }),
        },
        systemAddendum: apiContext.systemAddendum,
        streamSink: context.streamSink,
        leaseMs: context.leaseMs,
        heartbeatMs: context.heartbeatMs,
        defaultMaxSteps: context.defaultMaxSteps,
        turnTimeoutMs: context.turnTimeoutMs,
      },
      dispose: () => disposeEnvironment({ sandbox }),
    }
  } catch (error) {
    await disposeEnvironment({ sandbox })
    throw error
  }
}

async function disposeEnvironment(input: { readonly sandbox: Sandbox | null }): Promise<void> {
  await input.sandbox?.destroy().catch((error) => {
    console.error("[SixbAgentWorker] Could not destroy agent run sandbox:", error)
  })
}
