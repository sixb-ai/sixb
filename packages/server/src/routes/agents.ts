import {
  AgentRequestError,
  type AgentRequestErrorCode,
  type AgentRunView,
  type AgentThreadView,
  type FileRef,
  type SixbHostView,
} from "@sixb/core"
import { assertConversationThread, isRetryableAgentRun } from "@sixb/core/internal/agents"
import { agentRunStreamId } from "@sixb/core/internal/agents/streams"
import { resolveFileRefAtPath } from "@sixb/core/internal/blob-storage"
import {
  type AgentContextCheckpointRecord,
  type AgentMessageRecord,
  type AgentRunDiagnostic,
  type AgentStorage,
  AgentStorageError,
  type AgentThreadRecord,
  type Principal,
} from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { ZodError, z } from "zod"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { type RequestAuthState, requestAuthState, requireRequestSixb } from "../auth/scope"
import {
  createFileContentResponse,
  fileContentGetResponses,
  fileContentHeadResponses,
} from "../files/content"
import { SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  AddAgentThreadParticipantsBodySchema,
  AgentDescriptorSchema,
  AgentMessageFileContentParamsSchema,
  AgentMessageListResponseSchema,
  AgentMessageSchema,
  AgentMessagesQuerySchema,
  AgentRequestErrorResponseSchema,
  AgentRunListQuerySchema,
  AgentRunListResponseSchema,
  AgentRunParamsSchema,
  AgentRunSchema,
  AgentThreadListQuerySchema,
  AgentThreadListResponseSchema,
  AgentThreadParamsSchema,
  AgentThreadParticipantParamsSchema,
  AgentThreadSchema,
  CancelAgentRunBodySchema,
  CancelAgentRunResponseSchema,
  CreateAgentThreadBodySchema,
  CreateAgentThreadResponseSchema,
  PostAgentMessageBodySchema,
  PostAgentMessageResponseSchema,
  RetryAgentRunResponseSchema,
} from "../schemas/agents"
import { AiUsageLimitErrorResponseSchema, ErrorResponseSchema } from "../schemas/common"
import { FileContentQuerySchema } from "../schemas/files"
import {
  handleRouteError,
  parseOptionalInt,
  toIsoString,
  unconfiguredStorageResponse,
} from "../utils/http"

const AgentMessageFileContentQuerySchema = FileContentQuerySchema.extend({
  path: z
    .string()
    .min(1)
    .regex(/^\/parts(?:\/|$)/, "Agent message file content paths must start with /parts/"),
})

const SHARING =
  "Only the thread's owner adds participants: active users of the project, by id or by email. They read the whole conversation, its files and its live stream, and send messages that run with their own rights; a thread that runs on its owner's computer they only read. Nothing checks what they may see: the conversation holds what the Agent read with the rights of whoever asked."

/** Threads as the API returns them, their owner and participants named by their accounts. */
export async function serializeThreads(
  host: SixbHostView,
  threads: readonly AgentThreadView[]
): Promise<ReturnType<typeof AgentThreadSchema.parse>[]> {
  const people = await namePrincipals(
    host,
    threads.flatMap((thread) => [
      thread.ownerPrincipal,
      ...thread.participants.map((participant) => participant.principal),
    ])
  )
  const named = (principal: Principal) => people.get(principalKey(principal)) ?? principal

  return threads.map((thread) =>
    AgentThreadSchema.parse({
      id: thread.id,
      projectId: thread.projectId,
      kind: thread.kind,
      parent: thread.parent,
      ownerPrincipal: thread.ownerPrincipal,
      owner: named(thread.ownerPrincipal),
      participants: thread.participants.map((participant) => ({
        principal: named(participant.principal),
        addedAt: toIsoString(participant.addedAt),
        addedBy: participant.addedBy,
      })),
      title: thread.title,
      sandboxParams: thread.sandboxParams,
      runsOn: thread.runsOn,
      computerId: thread.computerId,
      sandboxState: thread.sandboxState && {
        name: thread.sandboxState.name,
        status: thread.sandboxState.status,
        initialized: thread.sandboxState.initialized,
      },
      status: thread.status,
      activeRunId: thread.activeRunId,
      lastMessageAt: thread.lastMessageAt ? toIsoString(thread.lastMessageAt) : undefined,
      messageCount: thread.messageCount,
      createdAt: toIsoString(thread.createdAt),
      updatedAt: toIsoString(thread.updatedAt),
    })
  )
}

export async function serializeThread(
  host: SixbHostView,
  thread: AgentThreadView
): Promise<ReturnType<typeof AgentThreadSchema.parse>> {
  const [serialized] = await serializeThreads(host, [thread])
  if (!serialized) throw new Error(`[SixbServer] Could not serialize Agent thread '${thread.id}'.`)
  return serialized
}

function serializeMessage(
  message: AgentMessageRecord,
  annotations: readonly AgentRunDiagnostic[] = [],
  checkpoint?: AgentContextCheckpointRecord
): ReturnType<typeof AgentMessageSchema.parse> {
  return AgentMessageSchema.parse({
    id: message.id,
    projectId: message.projectId,
    threadId: message.threadId,
    runId: message.runId,
    role: message.role,
    authorPrincipal: message.authorPrincipal,
    seq: message.seq,
    parts: message.parts,
    annotations,
    compaction: checkpoint
      ? {
          checkpointId: checkpoint.id,
          summary: checkpoint.summary,
          createdAt: toIsoString(checkpoint.createdAt),
        }
      : undefined,
    metadata: message.metadata,
    contentVersion: message.contentVersion,
    createdAt: toIsoString(message.createdAt),
    completedAt: message.completedAt ? toIsoString(message.completedAt) : undefined,
  })
}

export function serializeAgentRun(run: AgentRunView): ReturnType<typeof AgentRunSchema.parse> {
  return AgentRunSchema.parse({
    id: run.id,
    projectId: run.projectId,
    kind: run.kind,
    threadId: run.threadId,
    triggerMessageId: run.triggerMessageId,
    parentRunId: run.kind === "subagent" ? run.parentRunId : undefined,
    requestedBy: run.requestedBy,
    status: run.status,
    model: run.spec?.model,
    tier: run.spec?.tier,
    reasoning: run.spec?.reasoning,
    approvalMode: run.spec?.approvalMode,
    runsOn: run.kind === "conversation" ? run.spec?.runsOn : undefined,
    modelId: run.modelId,
    finishReason: run.finishReason,
    usage: run.usage,
    cost: run.cost,
    diagnostics: run.diagnostics,
    error: run.error,
    attempt: run.attempt,
    streamId: agentRunStreamId(run.id),
    createdAt: toIsoString(run.createdAt),
    startedAt: run.startedAt ? toIsoString(run.startedAt) : undefined,
    completedAt: run.completedAt ? toIsoString(run.completedAt) : undefined,
  })
}

async function getAgentMessageFileContentThread(params: {
  readonly authState: RequestAuthState
  readonly storage: AgentStorage
  readonly projectId: string
  readonly threadId: string
}): Promise<Pick<AgentThreadRecord, "id"> | null> {
  const { agentRun } = params.authState
  if (agentRun) {
    if (agentRun.projectId !== params.projectId || agentRun.threadId !== params.threadId) {
      return null
    }
    return params.storage.threads.getById({ projectId: params.projectId, id: params.threadId })
  }

  if (!params.authState.sixb) {
    throw new Error("[SixbServer] Execution scope is not available for this route.")
  }
  return params.authState.sixb.agent.threads.getById(params.threadId)
}

export function handleAgentRouteError(
  error: unknown,
  set: { status?: number | string; headers?: unknown }
):
  | ReturnType<typeof handleRouteError>
  | { readonly error: string; readonly code: AgentRequestErrorCode } {
  // A duplicate id is a conflict, not a bad request. Map it to a generic 409 rather than echoing the
  // provider's raw message (which leaks the id, project, and storage prefix).
  if (error instanceof AgentStorageError && error.code === "duplicate_id") {
    set.status = 409
    return { error: "Agent thread already exists" }
  }
  if (error instanceof AgentStorageError && error.code === "active_run_exists") {
    set.status = 409
    return { error: "This conversation already has a response in progress" }
  }
  if (error instanceof AgentStorageError && error.code === "thread_not_conversation") {
    set.status = 409
    return { error: "Only a conversation takes this change", code: error.code }
  }

  if (error instanceof AgentRequestError) {
    // Core performs visibility checks before workspace state transitions.
    switch (error.code) {
      case "agent_not_found":
      case "run_not_found":
      case "thread_not_found":
      case "approval_not_found":
        set.status = 404
        break
      case "active_run_exists":
      case "thread_not_conversation":
      case "run_not_retryable":
      case "run_not_active":
      case "sandbox_execution_unavailable":
      case "approval_not_pending":
      case "approval_expired":
        set.status = 409
        break
      case "authority_not_inheritable":
      case "not_thread_owner":
      case "not_run_requester":
        set.status = 403
        break
      case "storage_unavailable":
      case "sandbox_not_configured":
      case "invalid_sandbox_params":
      case "agent_selector_removed":
      case "invalid_context":
      case "invalid_attachment":
      case "invalid_model_selection":
      case "invalid_locale":
      case "invalid_message":
      case "invalid_participant":
      case "invalid_approval_mode":
      case "model_not_found":
        set.status = 400
        break
    }
    // The code lets clients react without parsing the English message.
    return { error: error.message, code: error.code }
  }

  return handleRouteError(error, set)
}

function missingAgentStorageResponse(set: { status?: number | string }): { error: string } {
  return unconfiguredStorageResponse(set, "Agent storage")
}

export async function agentMessageFileContentResponse(
  host: SixbHostView,
  context: {
    readonly params: { readonly threadId: string; readonly messageId: string }
    readonly query: unknown
    readonly request: Request
    readonly set: { status?: number | string }
  },
  options: {
    readonly head?: boolean
    /** Who may read the thread. Default: its owner, or the Agent run working in it. */
    readonly readThread?: () => Promise<Pick<AgentThreadRecord, "id"> | null>
  } = {}
) {
  const authState = requestAuthState(context)

  try {
    const storage = host.storage.agents
    if (!storage) {
      return missingAgentStorageResponse(context.set)
    }

    const parsed = AgentMessageFileContentQuerySchema.parse(context.query)
    const thread = options.readThread
      ? await options.readThread()
      : await getAgentMessageFileContentThread({
          authState,
          storage,
          projectId: host.id,
          threadId: context.params.threadId,
        })
    if (!thread) {
      context.set.status = 404
      return { error: "File not found" }
    }

    const message = await storage.messages.getById({
      projectId: host.id,
      id: context.params.messageId,
    })
    if (!message || message.threadId !== thread.id) {
      context.set.status = 404
      return { error: "File not found" }
    }

    const fileRef = resolveFileRefAtPath(serializeMessage(message), parsed.path)
    if (!fileRef) {
      context.set.status = 404
      return { error: "File not found" }
    }

    const response = await createFileContentResponse({
      blobStorage: host.blobStorage,
      fileRef,
      disposition: parsed.disposition,
      head: options.head,
      request: context.request,
    })
    if (!response) {
      context.set.status = 404
      return { error: "File not found" }
    }

    return response
  } catch (error) {
    if (error instanceof ZodError) {
      context.set.status = 400
      return { error: "Invalid file content query" }
    }

    throw error
  }
}

/** A page of a thread's messages, with their runs' diagnostics and compactions, and authors. */
export async function readThreadMessages(
  host: SixbHostView,
  storage: AgentStorage,
  thread: AgentThreadRecord,
  query: z.infer<typeof AgentMessagesQuerySchema>
) {
  const projectId = host.id
  const result = await storage.messages.list({
    projectId,
    threadId: thread.id,
    roles: query.role ? [query.role] : undefined,
    limit: parseOptionalInt(query.limit),
    offset: parseOptionalInt(query.offset),
    order: query.order,
  })
  const runIds = result.messages.flatMap((message) =>
    message.runId === null ? [] : [message.runId]
  )
  const [runs, checkpoints] = await Promise.all([
    storage.runs.getByIds({ projectId, ids: runIds }),
    storage.checkpoints.getByRunIds({ projectId, threadId: thread.id, runIds }),
  ])
  // A message's run is written by the store, never by a client: a message a fork copied keeps
  // the run that produced it, in the source thread, and shows that run's diagnostics. In a
  // sub-agent's thread, they are its runs'.
  const diagnosticsByRunId = new Map(runs.map((run) => [run.id, run.diagnostics ?? []] as const))
  const checkpointsByRunId = new Map(
    checkpoints.map((checkpoint) => [checkpoint.createdByRunId, checkpoint] as const)
  )

  return {
    messages: result.messages.map((message) =>
      serializeMessage(
        message,
        message.runId === null ? [] : (diagnosticsByRunId.get(message.runId) ?? []),
        message.runId === null ? undefined : checkpointsByRunId.get(message.runId)
      )
    ),
    authors: await readAuthors(host, result.messages),
    hasMore: result.hasMore,
    total: result.total,
  }
}

/** The page's distinct authors, in the order they first wrote. */
async function readAuthors(
  host: SixbHostView,
  messages: readonly Pick<AgentMessageRecord, "authorPrincipal">[]
) {
  const authors = messages.flatMap(({ authorPrincipal }) =>
    authorPrincipal ? [authorPrincipal] : []
  )
  const people = await namePrincipals(host, authors)
  return [...people.values()]
}

/**
 * Distinct principals with their account's display name, in first-occurrence order. An account
 * adds its display name and nothing else of its profile: never an email.
 */
async function namePrincipals(
  host: SixbHostView,
  principals: readonly Principal[]
): Promise<ReadonlyMap<string, Principal & { readonly displayName?: string }>> {
  const unique = new Map(principals.map((principal) => [principalKey(principal), principal]))

  const named = await Promise.all(
    [...unique.entries()].map(async ([key, principal]) => {
      const user =
        principal.type === "user"
          ? await host.storage.auth?.users.getById({ projectId: host.id, id: principal.id })
          : null

      const person = {
        ...principal,
        ...(user?.displayName ? { displayName: user.displayName } : {}),
      }
      return [key, person] as const
    })
  )
  return new Map(named)
}

function principalKey(principal: Principal): string {
  return `${principal.type}:${principal.id}`
}

export function registerAgentRoutes(app: Elysia, host: SixbHostView) {
  return app
    .get(
      "/api/agent",
      (context) => {
        const agent = requireRequestSixb(context).agent.get()
        if (!agent) {
          context.set.status = 404
          return { error: "Agent unavailable" }
        }
        return AgentDescriptorSchema.parse(agent)
      },
      {
        response: { 200: AgentDescriptorSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get the project Agent",
          tags: [OPENAPI_TAGS.agents.name],
          operationId: "getAgent",
        },
      }
    )
    .get(
      "/api/agent-threads",
      async (context) => {
        const { query, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const storage = host.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const parsed = AgentThreadListQuerySchema.parse(query)
          const listInput = {
            sharedWithMe: parsed.sharedWithMe === "true",
            statuses: parsed.status ? [parsed.status] : undefined,
            limit: parseOptionalInt(parsed.limit),
            offset: parseOptionalInt(parsed.offset),
            order: parsed.order,
          }
          const result = await sixb.agent.threads.list(listInput)

          return AgentThreadListResponseSchema.parse({
            threads: await serializeThreads(host, result.threads),
            hasMore: result.hasMore,
            total: result.total,
          })
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        query: AgentThreadListQuerySchema,
        response: {
          200: AgentThreadListResponseSchema,
          400: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "List agent threads",
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "listAgentThreads",
        },
      }
    )
    .post(
      "/api/agent-threads",
      async (context) => {
        const { body, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const parsed = CreateAgentThreadBodySchema.parse(body)
          const storage = host.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const thread = await sixb.agent.threads.create({
            ...(parsed.threadId === undefined ? {} : { id: parsed.threadId }),
            ...(parsed.title === undefined ? {} : { title: parsed.title }),
            ...(parsed.sandbox === undefined ? {} : { sandbox: parsed.sandbox }),
            ...(parsed.runsOn === undefined ? {} : { runsOn: parsed.runsOn }),
          })

          set.status = 201
          return CreateAgentThreadResponseSchema.parse({
            thread: await serializeThread(host, thread),
          })
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        body: CreateAgentThreadBodySchema,
        response: {
          201: CreateAgentThreadResponseSchema,
          400: ErrorResponseSchema,
          // Match the descriptor endpoint: an unavailable or forbidden Agent returns 404.
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Create an agent thread",
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "createAgentThread",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .get(
      "/api/agent-threads/:threadId",
      async (context) => {
        const { params, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const storage = host.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const thread = await sixb.agent.threads.getById(params.threadId)
          if (!thread) {
            set.status = 404
            return { error: "Agent thread not found" }
          }

          const approvalMode = await sixb.agent.threads.getApprovalMode(thread.id)
          return { ...(await serializeThread(host, thread)), ...approvalMode }
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        response: {
          200: AgentThreadSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Get agent thread",
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "getAgentThread",
        },
      }
    )
    .post(
      "/api/agent-threads/:threadId/participants",
      async (context) => {
        const { params, body, set } = context
        const sixb = requireRequestSixb(context)
        try {
          if (!host.storage.agents) {
            return missingAgentStorageResponse(set)
          }

          const parsed = AddAgentThreadParticipantsBodySchema.parse(body)
          const thread = await sixb.agent.threads.participants.add(params.threadId, parsed.users)

          return serializeThread(host, thread)
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        body: AddAgentThreadParticipantsBodySchema,
        response: {
          200: AgentThreadSchema,
          400: AgentRequestErrorResponseSchema,
          403: AgentRequestErrorResponseSchema,
          404: ErrorResponseSchema,
          409: AgentRequestErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Add participants to an agent thread",
          description: SHARING,
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "addAgentThreadParticipants",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .delete(
      "/api/agent-threads/:threadId/participants/:userId",
      async (context) => {
        const { params, set } = context
        const sixb = requireRequestSixb(context)
        try {
          if (!host.storage.agents) {
            return missingAgentStorageResponse(set)
          }

          await sixb.agent.threads.participants.remove(params.threadId, {
            type: "user",
            id: params.userId,
          })

          set.status = 204
          return
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentThreadParticipantParamsSchema,
        response: {
          204: z.void(),
          400: AgentRequestErrorResponseSchema,
          403: AgentRequestErrorResponseSchema,
          404: ErrorResponseSchema,
          409: AgentRequestErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Remove a participant from an agent thread",
          description:
            "The thread's owner removes anyone; a participant removes only themself, to leave. Removing someone who does not take part changes nothing.",
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "removeAgentThreadParticipant",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/agent-threads/:threadId/fork",
      async (context) => {
        const { params, set } = context
        const sixb = requireRequestSixb(context)
        try {
          if (!host.storage.agents) {
            return missingAgentStorageResponse(set)
          }

          const thread = await sixb.agent.threads.fork(params.threadId)

          set.status = 201
          return CreateAgentThreadResponseSchema.parse({
            thread: await serializeThread(host, thread),
          })
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        response: {
          201: CreateAgentThreadResponseSchema,
          // Coded: the source's sandbox params may not suit the current sandbox configuration.
          400: AgentRequestErrorResponseSchema,
          404: ErrorResponseSchema,
          409: AgentRequestErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Continue an agent thread in a new one the caller owns",
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "forkAgentThread",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/agent-threads/:threadId/sandbox/recreate",
      async (context) => {
        try {
          const sixb = requireRequestSixb(context)
          const thread = await sixb.agent.threads.recreateSandbox(
            context.params.threadId,
            context.body
          )
          return serializeThread(host, thread)
        } catch (error) {
          if (error instanceof AgentStorageError && error.code === "invalid_state") {
            context.set.status = 409
            return { error: "Sandbox state changed or a run is active. Reload and try again." }
          }
          return handleAgentRouteError(error, context.set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        body: z.object({ expectedSandboxName: z.string().min(1) }).strict(),
        response: {
          200: AgentThreadSchema,
          400: ErrorResponseSchema,
          403: AgentRequestErrorResponseSchema,
          404: ErrorResponseSchema,
          409: AgentRequestErrorResponseSchema,
        },
        detail: {
          summary:
            "Explicitly recreate an unavailable or uncertain workspace without deleting its previous state",
          operationId: "recreateAgentThreadSandbox",
          tags: [OPENAPI_TAGS.agentThreads.name],
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .get(
      "/api/agent-threads/:threadId/messages",
      async (context) => {
        const { params, query, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const storage = host.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const thread = await sixb.agent.threads.getById(params.threadId)
          if (!thread) {
            set.status = 404
            return { error: "Agent thread not found" }
          }

          const parsed = AgentMessagesQuerySchema.parse(query)
          return AgentMessageListResponseSchema.parse(
            await readThreadMessages(host, storage, thread, parsed)
          )
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        query: AgentMessagesQuerySchema,
        response: {
          200: AgentMessageListResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "List agent thread messages",
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "listAgentThreadMessages",
        },
      }
    )
    .get(
      "/api/agent-threads/:threadId/messages/:messageId/files/content",
      async (context) => agentMessageFileContentResponse(host, context),
      {
        params: AgentMessageFileContentParamsSchema,
        // Keep framework validation loose so invalid roots return the compact route-level 400 body.
        query: FileContentQuerySchema,
        detail: {
          summary: "Get agent message file content",
          tags: ["Agents"],
          operationId: "getAgentMessageFileContent",
          security: accessTokenSecurityRequirement("getAgentMessageFileContent"),
          responses: fileContentGetResponses({ optionalStorage: true }),
        },
      }
    )
    .head(
      "/api/agent-threads/:threadId/messages/:messageId/files/content",
      async (context) => agentMessageFileContentResponse(host, context, { head: true }),
      {
        params: AgentMessageFileContentParamsSchema,
        query: FileContentQuerySchema,
        detail: {
          summary: "Head agent message file content",
          tags: ["Agents"],
          operationId: "headAgentMessageFileContent",
          security: accessTokenSecurityRequirement("headAgentMessageFileContent"),
          responses: fileContentHeadResponses({ optionalStorage: true }),
        },
      }
    )
    .post(
      "/api/agent-threads/:threadId/messages",
      async (context) => {
        const { params, body, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const storage = host.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const thread = await sixb.agent.threads.getById(params.threadId)
          if (!thread) {
            set.status = 404
            return { error: "Agent thread not found" }
          }

          const parsed = PostAgentMessageBodySchema.parse(body)
          const requestInput = {
            threadId: thread.id,
            text: parsed.text,
            continue: parsed.continue,
            model: parsed.model,
            reasoning: parsed.reasoning,
            timeZone: parsed.timeZone,
            locale: parsed.locale,
            approvalMode: parsed.approvalMode,
            attachments: parsed.attachments as readonly FileRef[] | undefined,
            context: parsed.context,
            messageId: parsed.messageId,
          }
          const result = await sixb.agent.runs.request(requestInput)

          set.status = 202
          return PostAgentMessageResponseSchema.parse({
            run: serializeAgentRun(result.run),
          })
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        body: PostAgentMessageBodySchema,
        response: {
          202: PostAgentMessageResponseSchema,
          400: AgentRequestErrorResponseSchema,
          // Coded: `not_thread_owner` when the thread runs on its owner's computer.
          403: AgentRequestErrorResponseSchema,
          404: ErrorResponseSchema,
          409: AgentRequestErrorResponseSchema,
          429: AiUsageLimitErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Post an agent thread message",
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "postAgentThreadMessage",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/agent-threads/:threadId/cancel",
      async (context) => {
        const { params, body, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const storage = host.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const thread = await sixb.agent.threads.getById(params.threadId)
          if (!thread) {
            set.status = 404
            return { error: "Agent thread not found" }
          }

          assertConversationThread(thread)
          const parsed = CancelAgentRunBodySchema.parse(body)
          const run = await sixb.agent.runs.getById(parsed.runId)
          if (!run || run.threadId !== thread.id) {
            set.status = 404
            return { error: "Agent run not found" }
          }

          const current = await sixb.agent.runs.cancel(run.id)

          set.status = 202
          return CancelAgentRunResponseSchema.parse({ run: serializeAgentRun(current) })
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        body: CancelAgentRunBodySchema,
        response: {
          202: CancelAgentRunResponseSchema,
          400: AgentRequestErrorResponseSchema,
          403: AgentRequestErrorResponseSchema,
          404: ErrorResponseSchema,
          409: AgentRequestErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Cancel an agent thread's active run",
          description: "Whoever asked for the run, or the thread's owner, can cancel it.",
          tags: [OPENAPI_TAGS.agentRuns.name],
          operationId: "cancelAgentRun",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/agent-threads/:threadId/runs/:runId/retry",
      async (context) => {
        const { params, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const storage = host.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const thread = await sixb.agent.threads.getById(params.threadId)
          if (!thread) {
            set.status = 404
            return { error: "Agent thread not found" }
          }

          assertConversationThread(thread)
          const failedRun = await sixb.agent.runs.getById(params.runId)
          if (!failedRun || failedRun.threadId !== thread.id) {
            set.status = 404
            return { error: "Agent run not found" }
          }
          if (!isRetryableAgentRun(failedRun)) {
            set.status = 409
            return { error: "Only failed or interrupted agent runs can be retried" }
          }

          const { run } = await sixb.agent.runs.retry(failedRun.id)

          set.status = 202
          return RetryAgentRunResponseSchema.parse({
            run: serializeAgentRun(run),
          })
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentRunParamsSchema.extend({ threadId: z.string().trim().min(1) }),
        response: {
          202: RetryAgentRunResponseSchema,
          400: AgentRequestErrorResponseSchema,
          403: AgentRequestErrorResponseSchema,
          404: ErrorResponseSchema,
          409: AgentRequestErrorResponseSchema,
          429: AiUsageLimitErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Retry a failed or interrupted agent run",
          description:
            "Only whoever asked for the run can retry it: it runs again with their rights.",
          tags: [OPENAPI_TAGS.agentRuns.name],
          operationId: "retryAgentRun",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .get(
      "/api/agent-threads/:threadId/runs",
      async (context) => {
        const { params, query, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const storage = host.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const parsed = AgentRunListQuerySchema.parse(query)
          const result = await sixb.agent.runs.listForThread(params.threadId, {
            statuses: parsed.status ? [parsed.status] : undefined,
            limit: parseOptionalInt(parsed.limit),
            offset: parseOptionalInt(parsed.offset),
            order: parsed.order,
          })
          if (!result) {
            set.status = 404
            return { error: "Agent thread not found" }
          }

          return AgentRunListResponseSchema.parse({
            runs: result.runs.map(serializeAgentRun),
            hasMore: result.hasMore,
            total: result.total,
          })
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        query: AgentRunListQuerySchema,
        response: {
          200: AgentRunListResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "List an agent thread's runs",
          tags: [OPENAPI_TAGS.agentRuns.name],
          operationId: "listAgentThreadRuns",
        },
      }
    )
    .get(
      "/api/agent-runs/:runId",
      async (context) => {
        const { params, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const storage = host.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const run = await sixb.agent.runs.getById(params.runId)
          if (!run) {
            set.status = 404
            return { error: "Agent run not found" }
          }

          return serializeAgentRun(run)
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentRunParamsSchema,
        response: {
          200: AgentRunSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Get agent run",
          description:
            "A conversation's turn, or a sub-agent's run (`kind: \"subagent\"`), read through its thread: a sub-agent's run is visible exactly when its conversation is.",
          tags: [OPENAPI_TAGS.agentRuns.name],
          operationId: "getAgentRun",
        },
      }
    )
    .post(
      "/api/agent-runs/:runId/cancel",
      async (context) => {
        const { params, set } = context
        const sixb = requireRequestSixb(context)
        try {
          if (!host.storage.agents) {
            return missingAgentStorageResponse(set)
          }

          const current = await sixb.agent.runs.cancel(params.runId)

          set.status = 202
          return CancelAgentRunResponseSchema.parse({ run: serializeAgentRun(current) })
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentRunParamsSchema,
        response: {
          202: CancelAgentRunResponseSchema,
          400: AgentRequestErrorResponseSchema,
          403: AgentRequestErrorResponseSchema,
          404: ErrorResponseSchema,
          409: AgentRequestErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Stop an agent run",
          description:
            "A turn, or a sub-agent's run. Whoever asked for the turn, or the conversation's owner, can stop it, and a sub-agent's run as its turn. A queued run is cancelled at once; a running one is still running in the response, with the stop signal sent. A sub-agent's parent reads that it was stopped.",
          tags: [OPENAPI_TAGS.agentRuns.name],
          operationId: "cancelAgentRunById",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
}
