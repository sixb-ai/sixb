import { principalsEqual, type SixbHostView } from "@sixb/core"
import {
  type AgentRunSessionHost,
  claimAgentRunForRunner,
  createBrokerStreamSink,
  encodeWireError,
  encodeWireValue,
  isolateStreamSink,
  serveAgentRunSession,
  withAgentActivityStream,
} from "@sixb/core/internal/agents"
import { enqueueAiModelCallRecovery } from "@sixb/core/internal/model-execution"
import type { Elysia } from "elysia"
import { requestActor, requireRequestSixb } from "../auth/scope"

// A runner outside the worker, such as one on a person's computer, runs a turn through the API:
// it claims the turn as the person who asked for it, then reaches the turn's session with the run
// token the claim returns (see serveAgentRunSession). Neither route is part of the public API.

/** The session host the API opens a run's session against: the worker's, without the worker. */
export function agentRunSessionHost(host: SixbHostView): AgentRunSessionHost | null {
  const { storage } = host
  if (!storage.agents || !storage.auth || !storage.aiUsage || !storage.aiCosts) return null
  return {
    projectId: host.id,
    storage: storage as AgentRunSessionHost["storage"],
    broker: host.broker,
    recoverAiModelCall: (input) => enqueueAiModelCallRecovery(host.queues.agents, input),
    events: isolateStreamSink(
      withAgentActivityStream(
        createBrokerStreamSink({ broker: host.broker, projectId: host.id }),
        host.broker
      )
    ),
    security: host.definitions.security,
    sdk: host,
    definitions: host.definitions,
    logging: host.logging,
  }
}

/**
 * Answer a runner's session request before the API parses it: its run token speaks only for its
 * run's session. Null for any other request.
 */
export function agentRunSessionHandler(
  host: SixbHostView
): (request: Request) => Promise<Response | null> {
  let sessions: AgentRunSessionHost | null | undefined
  return async (request) => {
    sessions ??= agentRunSessionHost(host)
    if (!sessions) return null
    return serveAgentRunSession(sessions, request)
  }
}

export function registerAgentRunnerRoutes(app: Elysia, host: SixbHostView) {
  return app.post(
    "/api/agent-runs/:runId/claim",
    async (context) => {
      const sessions = agentRunSessionHost(host)
      if (!sessions) return answer({ error: notAvailable() }, 501)
      try {
        const sixb = requireRequestSixb(context)
        const runId = (context.params as { readonly runId: string }).runId
        // Elysia parsed it already: a lease is a plain string, nothing the wire tags.
        const { leaseExpiresAt } = (context.body ?? {}) as { readonly leaseExpiresAt?: string }
        if (typeof leaseExpiresAt !== "string") {
          return answer(
            { error: { kind: "Error", message: "[SixbServer] A claim names its lease." } },
            400
          )
        }
        // As its reader: a run the caller cannot read is none of theirs.
        const visible = await sixb.agent.runs.getById(runId)
        const run = visible
          ? await sessions.storage.agents.runs.getById({ projectId: host.id, id: runId })
          : null
        const execution =
          run &&
          (await sessions.storage.executions.getById({ projectId: host.id, id: run.executionId }))
        if (
          run?.kind !== "conversation" ||
          !execution?.requestedBy ||
          !principalsEqual(execution.requestedBy, requestActor(sixb))
        ) {
          return answer(
            {
              error: {
                kind: "AgentRunRefusedError",
                message: `[SixbServer] Only the person who asked for agent run '${runId}' runs it.`,
              },
            },
            403
          )
        }
        return answer({ result: await claimAgentRunForRunner(sessions, { run, leaseExpiresAt }) })
      } catch (error) {
        return answer({ error: encodeWireError(error) }, 400)
      }
    },
    { detail: { hide: true } }
  )
}

function notAvailable() {
  return {
    kind: "Error",
    message: "[SixbServer] Agent runs are not available: this runtime stores none.",
  }
}

function answer(body: unknown, status = 200): Response {
  return new Response(encodeWireValue(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}
