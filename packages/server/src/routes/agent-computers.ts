import { AgentRequestError, principalsEqual, type SixbHostView } from "@sixb/core"
import { type AgentRunSessionHost, dispatchQueuedAgentRuns } from "@sixb/core/internal/agents"
import { publishAgentComputerActivity } from "@sixb/core/internal/agents/streams"
import {
  type AgentComputerSessionRecord,
  type AgentStorage,
  AgentStorageError,
  type AgentThreadComputer,
  type ConversationAgentRunRecord,
  type Principal,
} from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { z } from "zod"
import { requestActor, requireRequestSixb } from "../auth/scope"
import { SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  AgentComputerSessionParamsSchema,
  AgentRequestErrorResponseSchema,
  AgentThreadComputerInputSchema,
  AgentThreadParamsSchema,
  AgentThreadSchema,
  HoldAgentComputerSessionBodySchema,
  HoldAgentComputerSessionResponseSchema,
  MoveAgentThreadToComputerBodySchema,
} from "../schemas/agents"
import { ErrorResponseSchema } from "../schemas/common"
import { unconfiguredStorageResponse } from "../utils/http"
import { handleAgentRouteError, serializeThread } from "./agents"

// A computer's thread runs on one of its owner's computers, in one folder there: only `sixb` open
// in that folder claims its turns. Each open `sixb` holds a session, a lease it renews, so the
// thread reads as online while one is live, and its owner can send from anywhere. Moving it to
// another folder, or to the cloud, is its owner's call.

/** How long a session stays live without a renewal; `sixb` renews it three times as often. */
const SESSION_MS = 60_000

/**
 * Why a computer's turn is not this computer's to claim, or null when it is: its thread runs on
 * the claiming computer, in the folder it names.
 */
export async function refuseOtherComputer(
  sessions: AgentRunSessionHost,
  run: ConversationAgentRunRecord,
  body: unknown
): Promise<{ readonly status: 400 | 403; readonly error: Record<string, string> } | null> {
  const claimed = AgentThreadComputerInputSchema.safeParse(
    (body as { readonly computer?: unknown } | null)?.computer
  )
  if (!claimed.success) {
    return {
      status: 400,
      error: {
        kind: "Error",
        message:
          "[SixbServer] A claim of a computer's turn names the computer and folder it comes from.",
      },
    }
  }

  const thread = await sessions.storage.agents.threads.getById({
    projectId: run.projectId,
    id: run.threadId,
  })
  const place = thread?.computer
  if (place?.id === claimed.data.id && place.folder === claimed.data.folder) return null
  return {
    status: 403,
    error: {
      kind: "AgentRunRefusedError",
      message: !place
        ? `[SixbServer] Agent thread '${run.threadId}' has no folder yet: move it to this one to run its turns here.`
        : place.id === claimed.data.id
          ? `[SixbServer] Agent thread '${run.threadId}' works in ${place.folder}: open sixb there, or move it to this folder.`
          : `[SixbServer] Agent thread '${run.threadId}' runs on ${place.name}: move it to this computer to run its turns here.`,
    },
  }
}

/** End the sessions no `sixb` renewed, and say so for each folder left with none. */
export async function endLapsedComputerSessions(host: SixbHostView): Promise<void> {
  const agents = host.storage.agents
  if (!agents) return
  const lapsed = await agents.computers.removeLapsed({ projectId: host.id, now: new Date() })
  await announceOffline(host, agents, lapsed)
}

export function registerAgentComputerRoutes(app: Elysia, host: SixbHostView) {
  return app
    .post(
      "/api/agent-threads/:threadId/computer",
      async (context) => {
        const { params, body, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const agents = host.storage.agents
          if (!agents) return unconfiguredStorageResponse(set, "Agent storage")

          const { computer } = MoveAgentThreadToComputerBodySchema.parse(body)
          const actor = requestActor(sixb)
          const thread = await ownedComputerThread(sixb, params.threadId, actor, "moves it")
          const moved = await agents.threads.assignComputer({
            projectId: host.id,
            id: params.threadId,
            computer,
          })
          return serializeThread(host, { ...moved, participants: thread.participants }, actor)
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        body: MoveAgentThreadToComputerBodySchema,
        response: {
          200: AgentThreadSchema,
          400: AgentRequestErrorResponseSchema,
          403: AgentRequestErrorResponseSchema,
          404: AgentRequestErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Move a thread to one of your computers, in a folder there",
          description:
            "A thread that runs on its owner's computer runs there alone, in one folder: only `sixb` open in that folder claims its turns. Its owner moves it to another folder or computer.",
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "moveAgentThreadToComputer",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .delete(
      "/api/agent-threads/:threadId/computer",
      async (context) => {
        const { params, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const agents = host.storage.agents
          if (!agents) return unconfiguredStorageResponse(set, "Agent storage")

          const actor = requestActor(sixb)
          const thread = await ownedComputerThread(sixb, params.threadId, actor, "moves it")
          const moved = await agents.threads
            .moveToCloud({ projectId: host.id, id: thread.id })
            .catch((error: unknown) => {
              throw error instanceof AgentStorageError && error.code === "active_run_exists"
                ? new AgentRequestError(
                    "active_run_exists",
                    "[SixbServer] A turn is running on the computer: stop it, or let it end, first."
                  )
                : error
            })
          if (moved.queued) {
            const dispatch = await dispatchQueuedAgentRuns({
              projectId: host.id,
              storage: agents,
              queue: host.queues.agents,
              runIds: [moved.queued.id],
            })
            // The queued run is the dispatch intent: the worker's reconciliation picks it up.
            for (const failure of dispatch.failures) {
              console.error(
                `[SixbServer] Could not dispatch agent run '${failure.runId}' after its thread moved to the cloud; it is retried.`,
                failure.error
              )
            }
          }
          return serializeThread(
            host,
            { ...moved.thread, participants: thread.participants },
            actor
          )
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        response: {
          200: AgentThreadSchema,
          400: AgentRequestErrorResponseSchema,
          403: AgentRequestErrorResponseSchema,
          404: AgentRequestErrorResponseSchema,
          409: AgentRequestErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Move a thread from your computer to the cloud",
          description:
            "Its turns run in the cloud from now on, starting with the one waiting for the computer, if any. The files it worked on stay on the computer. Refused while a turn runs there.",
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "moveAgentThreadToCloud",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .put(
      "/api/agent-computers/sessions/:sessionId",
      async (context) => {
        const { params, body, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const agents = host.storage.agents
          if (!agents) return unconfiguredStorageResponse(set, "Agent storage")

          const { computer } = HoldAgentComputerSessionBodySchema.parse(body)
          const ownerPrincipal = requestActor(sixb)
          const now = new Date()
          const before = await agents.computers.listLive({
            projectId: host.id,
            ownerPrincipal,
            now,
          })
          const expiresAt = new Date(now.getTime() + SESSION_MS)
          await agents.computers.hold({
            projectId: host.id,
            id: params.sessionId,
            ownerPrincipal,
            computer,
            expiresAt,
          })
          if (!before.some((session) => sameFolder(session.computer, computer))) {
            await announce(host, ownerPrincipal, computer, true)
          }
          return HoldAgentComputerSessionResponseSchema.parse({
            expiresAt: expiresAt.toISOString(),
            waiting: await waitingTurns(host, agents, ownerPrincipal, computer),
          })
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentComputerSessionParamsSchema,
        body: HoldAgentComputerSessionBodySchema,
        response: {
          200: HoldAgentComputerSessionResponseSchema,
          400: AgentRequestErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Open or renew a computer session",
          description:
            "`sixb` holds one while it is open: your threads on this computer, in this folder, read as online, and you can continue them from anywhere. It lapses a minute after its last renewal. The answer lists the turns waiting for it.",
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "holdAgentComputerSession",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .delete(
      "/api/agent-computers/sessions/:sessionId",
      async (context) => {
        const { params, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const agents = host.storage.agents
          if (!agents) return unconfiguredStorageResponse(set, "Agent storage")

          const released = await agents.computers.release({
            projectId: host.id,
            id: params.sessionId,
            ownerPrincipal: requestActor(sixb),
          })
          if (released) await announceOffline(host, agents, [released])
          set.status = 204
          return
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentComputerSessionParamsSchema,
        response: {
          204: z.void(),
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Close a computer session",
          description: "`sixb` closes its session when it quits.",
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "releaseAgentComputerSession",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
}

/** A computer's thread the actor owns: refused for anyone else, and for a cloud thread. */
async function ownedComputerThread(
  sixb: ReturnType<typeof requireRequestSixb>,
  threadId: string,
  actor: Principal,
  what: string
) {
  const thread = await sixb.agent.threads.getById(threadId)
  if (!thread) {
    throw new AgentRequestError(
      "thread_not_found",
      `[SixbServer] Agent thread '${threadId}' not found.`
    )
  }
  if (!principalsEqual(thread.ownerPrincipal, actor)) {
    throw new AgentRequestError(
      "not_thread_owner",
      `[SixbServer] Only the owner of Agent thread '${threadId}' ${what}.`
    )
  }
  if (thread.runsOn !== "computer") {
    throw new AgentRequestError(
      "invalid_message",
      `[SixbServer] Agent thread '${threadId}' runs in the cloud, on no computer.`
    )
  }
  return thread
}

/** The owner's queued turns that wait for this computer, in this folder. */
async function waitingTurns(
  host: SixbHostView,
  agents: AgentStorage,
  ownerPrincipal: Principal,
  computer: AgentThreadComputer
): Promise<string[]> {
  const { runs } = await agents.runs.list({
    projectId: host.id,
    kinds: ["conversation"],
    statuses: ["queued"],
    order: "asc",
    limit: 100,
  })
  const queued = runs.filter(
    (run) => run.kind === "conversation" && run.spec?.runsOn === "computer"
  )
  if (queued.length === 0) return []
  const threads = await agents.threads.getByIds({
    projectId: host.id,
    ids: queued.map((run) => run.threadId),
  })
  const here = new Set(
    threads
      .filter(
        (thread) =>
          principalsEqual(thread.ownerPrincipal, ownerPrincipal) &&
          thread.computer !== undefined &&
          sameFolder(thread.computer, computer)
      )
      .map((thread) => thread.activeRunId)
  )
  return queued.filter((run) => here.has(run.id)).map((run) => run.id)
}

/** For each folder these sessions held, say it went offline when no other session holds it. */
async function announceOffline(
  host: SixbHostView,
  agents: AgentStorage,
  ended: readonly AgentComputerSessionRecord[]
): Promise<void> {
  const now = new Date()
  const announced = new Set<string>()
  for (const session of ended) {
    const key = JSON.stringify([
      session.ownerPrincipal,
      session.computer.id,
      session.computer.folder,
    ])
    if (announced.has(key)) continue
    announced.add(key)
    const live = await agents.computers.listLive({
      projectId: host.id,
      ownerPrincipal: session.ownerPrincipal,
      now,
    })
    if (!live.some((other) => sameFolder(other.computer, session.computer))) {
      await announce(host, session.ownerPrincipal, session.computer, false)
    }
  }
}

/** Presence is a hint the web follows: a lost announcement only delays its badge. */
async function announce(
  host: SixbHostView,
  ownerPrincipal: Principal,
  computer: AgentThreadComputer,
  online: boolean
): Promise<void> {
  await publishAgentComputerActivity(host.broker, {
    projectId: host.id,
    ownerPrincipal,
    computerId: computer.id,
    folder: computer.folder,
    online,
  }).catch((error: unknown) => {
    console.error("[SixbServer] Could not announce a computer session.", error)
  })
}

function sameFolder(a: AgentThreadComputer, b: AgentThreadComputer): boolean {
  return a.id === b.id && a.folder === b.folder
}
