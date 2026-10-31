import type { SandboxRequestCredential } from "@sixb/core"
import { createAgentRunnerToken, createAgentRunToken } from "@sixb/core/internal/agents"

/** The token the run's commands call the API with, valid while this execution owns the run. */
export function runTokenFor(input: {
  readonly projectId: string
  readonly runId: string
  readonly executionToken?: string
}): string {
  if (!input.executionToken) {
    throw new Error(
      `[SixbAgent] Agent execution '${input.runId}' must hold an execution token before it gets a run token.`
    )
  }
  return createAgentRunToken({
    projectId: input.projectId,
    runId: input.runId,
    executionToken: input.executionToken,
  })
}

/**
 * The token a runner over HTTP reaches its run's session with. It is the runner's alone: the run's
 * commands get the run token, which the session refuses.
 */
export function runnerTokenFor(input: {
  readonly projectId: string
  readonly runId: string
  readonly executionToken?: string
}): string {
  if (!input.executionToken) {
    throw new Error(
      `[SixbAgent] Agent execution '${input.runId}' must hold an execution token before it gets a runner token.`
    )
  }
  return createAgentRunnerToken({
    projectId: input.projectId,
    runId: input.runId,
    executionToken: input.executionToken,
  })
}

/**
 * The run token as a request credential: on a provider that adds credentials outside the guest,
 * every call to the API under `apiBaseUrl` gets it, and the run's commands never hold it.
 */
export function runApiCredential(apiBaseUrl: string, runToken: string): SandboxRequestCredential {
  const url = new URL(apiBaseUrl)
  return {
    origin: url.origin,
    path: { prefix: `${url.pathname.replace(/\/+$/, "")}/api/` },
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    headers: { Authorization: `Bearer ${runToken}` },
  }
}
