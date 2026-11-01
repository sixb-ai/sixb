import { AgentRequestError, principalsEqual, type SixbHostView } from "@sixb/core"
import {
  type AgentRunSessionHost,
  dispatchQueuedAgentRuns,
  threadHoldsPausedTurn,
} from "@sixb/core/internal/agents"
import {
  publishAgentComputerActivity,
  publishAgentThreadMoved,
} from "@sixb/core/internal/agents/streams"
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
/** How many sessions one person holds at once: one per open `sixb`, a terminal each. */
const MAX_SESSIONS = 20

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
          const stays = thread.computer && sameFolder(thread.computer, computer)
          if (!stays) await refuseHeldTurn(agents, thread)
          const moved = await agents.threads
            .assignComputer({ projectId: host.id, id: params.threadId, computer })
            .catch(refuseRunningTurn)
          if (!stays) await announceMove(host, thread)
          return movedThread(host, sixb, { ...moved, participants: thread.participants }, actor)
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
          409: AgentRequestErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Move a thread to one of your computers, in a folder there",
          description:
            "A thread that runs on its owner's computer runs there alone, in one folder: only `sixb` open in that folder claims its turns. Its owner moves it to another folder or computer. Refused while a turn runs or waits on approvals.",
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
          await refuseHeldTurn(agents, thread)
          const moved = await agents.threads
            .moveToCloud({ projectId: host.id, id: thread.id })
            .catch(refuseRunningTurn)
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
          await announceMove(host, thread)
          return movedThread(
            host,
            sixb,
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
            "Its turns run in the cloud from now on, starting with the one waiting for the computer, if any. The files it worked on stay on the computer. Refused while a turn runs there or waits on approvals.",
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
          if (
            before.length >= MAX_SESSIONS &&
            !before.some((session) => session.id === params.sessionId)
          ) {
            set.status = 429
            return {
              error: `[SixbServer] You have ${MAX_SESSIONS} sixb sessions open: quit one to open another.`,
            }
          }
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
          429: ErrorResponseSchema,
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
/** A turn's held calls were reviewed for where it runs: it moves once they are answered. */
async function refuseHeldTurn(
  agents: AgentStorage,
  thread: { readonly projectId: string; readonly id: string }
): Promise<void> {
  if (await threadHoldsPausedTurn(agents, thread)) {
    throw new AgentRequestError(
      "active_run_exists",
      "[SixbServer] A turn is waiting for your approval: answer or stop it first."
    )
  }
}

function refuseRunningTurn(error: unknown): never {
  throw error instanceof AgentStorageError && error.code === "active_run_exists"
    ? new AgentRequestError(
        "active_run_exists",
        "[SixbServer] A turn is running on the computer: stop it, or let it end, first."
      )
    : error
}

/** What a read of the thread answers, so its reader keeps the permission mode it shows. */
async function movedThread(
  host: SixbHostView,
  sixb: ReturnType<typeof requireRequestSixb>,
  thread: Parameters<typeof serializeThread>[1],
  actor: Principal
) {
  const approvalMode = await sixb.agent.threads.getApprovalMode(thread.id)
  return { ...(await serializeThread(host, thread, actor)), ...approvalMode }
}

/** A hint whatever has the thread open follows: a lost one is corrected by its next read. */
async function announceMove(
  host: SixbHostView,
  thread: { readonly id: string; readonly ownerPrincipal: Principal }
): Promise<void> {
  await publishAgentThreadMoved(host.broker, {
    projectId: host.id,
    ownerPrincipal: thread.ownerPrincipal,
    threadId: thread.id,
  }).catch((error: unknown) => {
    console.error("[SixbServer] Could not announce a thread's move.", error)
  })
}

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
  // Their own threads there with a turn active: nobody else's turns, however many, crowd them out.
  const { threads } = await agents.threads.list({
    projectId: host.id,
    ownerPrincipal,
    activeOnComputer: { computerId: computer.id, folder: computer.folder },
    limit: 100,
  })
  const active = threads.flatMap((thread) => (thread.activeRunId ? [thread.activeRunId] : []))
  if (active.length === 0) return []
  const runs = await agents.runs.getByIds({ projectId: host.id, ids: active })
  return runs
    .filter(
      (run) =>
        run.kind === "conversation" && run.status === "queued" && run.spec?.runsOn === "computer"
    )
    .map((run) => run.id)
}

/** For each folder these sessions held, say it went offline when no other session holds it. */
async function announceOffline(
  host: SixbHostView,
  agents: AgentStorage,
  ended: readonly AgentComputerSessionRecord[]
): Promise<void> {
  const now = new Date()
  const byOwner = new Map<string, AgentComputerSessionRecord[]>()
  for (const session of ended) {
    const key = `${session.ownerPrincipal.type}:${session.ownerPrincipal.id}`
    byOwner.set(key, [...(byOwner.get(key) ?? []), session])
  }
  for (const sessions of byOwner.values()) {
    const ownerPrincipal = sessions[0]?.ownerPrincipal
    if (!ownerPrincipal) continue
    const live = await agents.computers.listLive({ projectId: host.id, ownerPrincipal, now })
    const announced = new Set<string>()
    for (const session of sessions) {
      const key = `${session.computer.id}\u0000${session.computer.folder}`
      if (
        announced.has(key) ||
        live.some((other) => sameFolder(other.computer, session.computer))
      ) {
        continue
      }
      announced.add(key)
      await announce(host, ownerPrincipal, session.computer, false)
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
