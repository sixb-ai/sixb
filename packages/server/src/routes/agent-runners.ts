import { principalsEqual, type SixbHostView, SYSTEM_PRINCIPAL } from "@sixb/core"
import {
  AgentRunRefusedError,
  type AgentRunSessionHost,
  afterAgentRunFinished,
  claimAgentRunForRunner,
  createBrokerStreamSink,
  encodeWireError,
  encodeWireValue,
  endLapsedAgentRuns,
  isAgentRunnerToken,
  isolateStreamSink,
  serveAgentRunSession,
  withAgentActivityStream,
} from "@sixb/core/internal/agents"
import { enqueueAiModelCallRecovery } from "@sixb/core/internal/model-execution"
import type { Elysia } from "elysia"
import { requestActor, requireRequestSixb } from "../auth/scope"
import { refuseOtherComputer } from "./agent-computers"

// A runner outside the worker, such as one on a person's computer, runs a turn through the API:
// it claims the turn as the person who asked for it, then reaches the turn's session with the
// runner token the claim returns (see serveAgentRunSession). Neither route is part of the public
// API.

/** The session host the API opens a run's session against: the worker's, without the worker. */
export function agentRunSessionHost(host: SixbHostView): AgentRunSessionHost | null {
  const { storage } = host
  if (!storage.agents || !storage.auth || !storage.aiUsage || !storage.aiCosts) return null
  const sessions: AgentRunSessionHost = {
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
    // A turn a runner finished here stops its children and resumes on calls already decided.
    afterFinish: (run) => afterAgentRunFinished(sessions, run),
  }
  return sessions
}

/** How often the API ends the runs no runner renews any more. */
const SWEEP_INTERVAL_MS = 30_000
/** How long the claim that ends a lapsed run holds it: as long as recording the end takes. */
const SWEEP_CLAIM_MS = 60_000

/**
 * End the runs whose runner stopped renewing them, as the worker's repair pass does: a runner on
 * a computer has no worker behind it. Several API servers may sweep at once: each run is ended
 * once, by whichever takes it over. Returns the stop.
 */
export function startLapsedRunSweeper(host: SixbHostView): () => void {
  const sessions = agentRunSessionHost(host)
  if (!sessions) return () => {}
  const sweep = () => {
    void endLapsedAgentRuns(sessions, { leaseMs: SWEEP_CLAIM_MS }).catch((error: unknown) => {
      console.error("[SixbServer] Could not end lapsed agent runs; retrying.", error)
    })
  }
  sweep()
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS)
  return () => clearInterval(timer)
}

/**
 * Answer a runner's session request before the API parses it: its runner token speaks only for its
 * run's session, and any other route refuses it. Null for any other request.
 */
export function agentRunSessionHandler(
  host: SixbHostView
): (request: Request) => Promise<Response | null> {
  let sessions: AgentRunSessionHost | null | undefined
  return async (request) => {
    sessions ??= agentRunSessionHost(host)
    const served = sessions ? await serveAgentRunSession(sessions, request) : null
    if (served) return served

    // It carries the runner's authority over its run, not anyone's over the project.
    const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1]
    if (token === undefined || !isAgentRunnerToken(token)) return null
    const { pathname } = new URL(request.url)
    return Response.json(
      {
        error: `[SixbServer] A runner token cannot call ${request.method} ${pathname}: it reaches only its run's session.`,
      },
      { status: 403 }
    )
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
        // With sign-in off, no one asked for a turn: the system did, as such a request acts.
        if (
          run?.kind !== "conversation" ||
          !execution ||
          !principalsEqual(execution.requestedBy ?? SYSTEM_PRINCIPAL, requestActor(sixb))
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
        // A cloud turn is the agent worker's: a runner here would race it, and skip the sandbox
        // the thread chose.
        if (run.spec?.runsOn !== "computer") {
          return answer(
            {
              error: {
                kind: "AgentRunRefusedError",
                message: `[SixbServer] Agent run '${runId}' runs in the cloud: only a computer's turns are claimed here.`,
              },
            },
            403
          )
        }
        const elsewhere = await refuseOtherComputer(sessions, run, context.body)
        if (elsewhere) return answer({ error: elsewhere.error }, elsewhere.status)
        return answer({ result: await claimAgentRunForRunner(sessions, { run, leaseExpiresAt }) })
      } catch (error) {
        // A turn whose runner stopped ends interrupted rather than being claimed again.
        return answer(
          { error: encodeWireError(error) },
          error instanceof AgentRunRefusedError ? 409 : 400
        )
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
