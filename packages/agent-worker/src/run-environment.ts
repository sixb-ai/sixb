import type { AgentDefinition, AgentRunRecord, Sandbox } from "@sixb/core"
import { type AgentApiProxy, startAgentApiProxy } from "./api-proxy"
import { createBashTool } from "./bash-tool"
import {
  type AgentRunAccessToken,
  mintAgentRunAccessToken,
  revokeAgentRunAccessToken,
} from "./identity"
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
  let accessToken: AgentRunAccessToken | null = null
  let apiProxy: AgentApiProxy | null = null
  let sandbox: Sandbox | null = null

  try {
    accessToken = await mintAgentRunAccessToken({
      storage: context.storage,
      projectId: context.id,
      agent,
      run,
      turnTimeoutMs: context.turnTimeoutMs,
    })
    apiProxy = startAgentApiProxy({
      apiBaseUrl: context.apiBaseUrl,
      accessToken: accessToken.tokenValue,
      runId: run.id,
    })

    sandbox = await context.sandboxes.create({
      network: { mode: "restricted", allow: [{ name: "sixb-api", origin: apiProxy.baseUrl }] },
    })

    const apiContext = await prepareAgentSandboxApiContext({
      sandbox,
      apiBaseUrl: apiProxy.baseUrl,
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
      dispose: () => disposeEnvironment({ accessToken, apiProxy, context, sandbox }),
    }
  } catch (error) {
    await disposeEnvironment({ accessToken, apiProxy, context, sandbox })
    throw error
  }
}

async function disposeEnvironment(input: {
  readonly accessToken: AgentRunAccessToken | null
  readonly apiProxy: AgentApiProxy | null
  readonly context: AgentWorkerContext
  readonly sandbox: Sandbox | null
}): Promise<void> {
  await input.apiProxy?.stop().catch((error) => {
    console.error("[SixbAgentWorker] Could not stop agent API proxy:", error)
  })
  await input.sandbox?.destroy().catch((error) => {
    console.error("[SixbAgentWorker] Could not destroy agent run sandbox:", error)
  })
  if (input.accessToken) {
    await revokeAgentRunAccessToken({
      storage: input.context.storage,
      projectId: input.context.id,
      tokenId: input.accessToken.accessToken.id,
    }).catch((error) => {
      console.error("[SixbAgentWorker] Could not revoke agent run token:", error)
    })
  }
}
