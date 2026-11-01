import type { SixbHostView } from "@sixb/core"
import { sameComputerPlace } from "@sixb/core/internal/agent-run-storage-provider"
import type { AgentRunSessionHost } from "@sixb/core/internal/agents"
import { publishAgentComputerActivity } from "@sixb/core/internal/agents/streams"
import type {
  AgentComputerSessionRecord,
  AgentStorage,
  AgentThreadComputer,
  ConversationAgentRunRecord,
  Principal,
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
import { handleAgentRouteError, principalKey, serializeThreadRead } from "./agents"

// A computer's thread runs on one of its owner's computers, in one folder there: only `sixb` open
// in that folder claims its turns. Each open `sixb` holds a session, a lease it renews, so the
// thread reads as online while one is live, and its owner can send from anywhere. Moving it to
// another folder, or to the cloud, is its owner's call.

/** How long a session stays live without a renewal; `sixb` renews it three times as often. */
const SESSION_MS = 60_000
/** How many sessions one person holds at once: one per open `sixb`, a terminal each. */
const MAX_SESSIONS = 20

type ComputerClaim =
  | { readonly computer: AgentThreadComputer }
  | {
      readonly refused: {
        readonly status: 400 | 403
        readonly error: Record<string, string>
      }
    }

/**
 * The computer and folder claiming a computer's turn, or why the turn is not theirs: its thread
 * runs on the claiming computer, in the folder it names. It reads as of now, for a refusal that
 * says why; the run's start is what decides, should the thread move right after.
 */
export async function computerClaiming(
  sessions: AgentRunSessionHost,
  run: ConversationAgentRunRecord,
  body: unknown
): Promise<ComputerClaim> {
  const claimed = AgentThreadComputerInputSchema.safeParse(
    (body as { readonly computer?: unknown } | null)?.computer
  )
  if (!claimed.success) {
    return {
      refused: {
        status: 400,
        error: {
          kind: "Error",
          message:
            "[SixbServer] A claim of a computer's turn names the computer and folder it comes from.",
        },
      },
    }
  }

  const thread = await sessions.storage.agents.threads.getById({
    projectId: run.projectId,
    id: run.threadId,
  })
  const place = thread?.computer
  if (place && sameComputerPlace(place, claimed.data)) return { computer: claimed.data }
  return {
    refused: {
      status: 403,
      error: {
        kind: "AgentRunRefusedError",
        message: !place
          ? `[SixbServer] Agent thread '${run.threadId}' has no folder yet: move it to this one to run its turns here.`
          : place.id === claimed.data.id
            ? `[SixbServer] Agent thread '${run.threadId}' works in ${place.folder}: open sixb there, or move it to this folder.`
            : `[SixbServer] Agent thread '${run.threadId}' runs on ${place.name}: move it to this computer to run its turns here.`,
      },
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
          if (!host.storage.agents) return unconfiguredStorageResponse(set, "Agent storage")

          const { computer } = MoveAgentThreadToComputerBodySchema.parse(body)
          const moved = await sixb.agent.threads.moveToComputer(params.threadId, computer)
          return await serializeThreadRead(host, sixb, moved)
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
          if (!host.storage.agents) return unconfiguredStorageResponse(set, "Agent storage")

          const moved = await sixb.agent.threads.moveToCloud(params.threadId)
          return await serializeThreadRead(host, sixb, moved)
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
          if (!before.some((session) => sameComputerPlace(session.computer, computer))) {
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
    activeOnComputer: computer,
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
    const key = principalKey(session.ownerPrincipal)
    const sessions = byOwner.get(key)
    if (sessions) sessions.push(session)
    else byOwner.set(key, [session])
  }
  for (const [first, ...rest] of byOwner.values()) {
    if (!first) continue
    const { ownerPrincipal } = first
    const live = await agents.computers.listLive({ projectId: host.id, ownerPrincipal, now })
    const announced: AgentThreadComputer[] = []
    for (const { computer } of [first, ...rest]) {
      const stillHeld = [...live.map((other) => other.computer), ...announced]
      if (stillHeld.some((other) => sameComputerPlace(other, computer))) continue
      announced.push(computer)
      await announce(host, ownerPrincipal, computer, false)
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
