import {
  type AgentDefinition,
  AgentRequestError,
  type AuthorizationContext,
  type FileRef,
  type OntologySource,
  type Principal,
  type ScopedSixb,
  type Sixb,
  SYSTEM_PRINCIPAL,
} from "@sixb/core"
import { agentRunStreamId } from "@sixb/core/agents/streams"
import {
  createAgentRunId,
  createAgentThreadId,
  dispatchQueuedAgentRuns,
  publishAgentRunCancel,
  publishAgentRunFinished,
} from "@sixb/core/internal/agents"
import {
  type AgentMessageRecord,
  type AgentRunDiagnostic,
  type AgentRunRecord,
  type AgentStorage,
  AgentStorageError,
  type AgentThreadRecord,
} from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { ZodError, z } from "zod"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { type RequestAuthState, requestAuthState } from "../auth/scope"
import {
  createFileContentResponse,
  fileContentGetResponses,
  fileContentHeadResponses,
  resolveFileRefAtPath,
} from "../files/content"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  AgentCatalogItemSchema,
  AgentIdParamsSchema,
  AgentMessageFileContentParamsSchema,
  AgentMessageListResponseSchema,
  AgentMessageSchema,
  AgentMessagesQuerySchema,
  AgentRunListQuerySchema,
  AgentRunListResponseSchema,
  AgentRunParamsSchema,
  AgentRunSchema,
  AgentThreadListQuerySchema,
  AgentThreadListResponseSchema,
  AgentThreadParamsSchema,
  AgentThreadSchema,
  CancelAgentRunBodySchema,
  CancelAgentRunResponseSchema,
  CreateAgentThreadBodySchema,
  CreateAgentThreadResponseSchema,
  PostAgentMessageBodySchema,
  PostAgentMessageResponseSchema,
  RetryAgentRunResponseSchema,
} from "../schemas/agents"
import { ErrorResponseSchema } from "../schemas/common"
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

function serializeAgent(agent: AgentDefinition): ReturnType<typeof AgentCatalogItemSchema.parse> {
  return AgentCatalogItemSchema.parse({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    modelId: agent.model.modelId,
    reasoning: agent.reasoning,
    groupIds: agent.groupIds,
    loop: agent.loop,
  })
}

function serializeThread(thread: AgentThreadRecord): ReturnType<typeof AgentThreadSchema.parse> {
  return AgentThreadSchema.parse({
    id: thread.id,
    projectId: thread.projectId,
    agentId: thread.agentId,
    ownerPrincipal: thread.ownerPrincipal,
    title: thread.title,
    status: thread.status,
    activeRunId: thread.activeRunId,
    lastMessageAt: thread.lastMessageAt ? toIsoString(thread.lastMessageAt) : undefined,
    messageCount: thread.messageCount,
    createdAt: toIsoString(thread.createdAt),
    updatedAt: toIsoString(thread.updatedAt),
  })
}

function serializeMessage(
  message: AgentMessageRecord,
  annotations: readonly AgentRunDiagnostic[] = []
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
    metadata: message.metadata,
    contentVersion: message.contentVersion,
    createdAt: toIsoString(message.createdAt),
    completedAt: message.completedAt ? toIsoString(message.completedAt) : undefined,
  })
}

export function serializeAgentRun(run: AgentRunRecord): ReturnType<typeof AgentRunSchema.parse> {
  return AgentRunSchema.parse({
    id: run.id,
    projectId: run.projectId,
    threadId: run.threadId,
    agentId: run.agentId,
    triggerMessageId: run.triggerMessageId,
    requestedByPrincipal: run.requestedByPrincipal,
    executionPrincipal: run.executionPrincipal,
    status: run.status,
    modelId: run.modelId,
    finishReason: run.finishReason,
    usage: run.usage,
    diagnostics: run.diagnostics,
    error: run.error,
    attempt: run.attempt,
    streamId: agentRunStreamId(run.id),
    createdAt: toIsoString(run.createdAt),
    startedAt: run.startedAt ? toIsoString(run.startedAt) : undefined,
    completedAt: run.completedAt ? toIsoString(run.completedAt) : undefined,
  })
}

async function getAccessibleThread(params: {
  readonly scoped: ScopedSixb<readonly OntologySource[]> | null
  readonly storage: AgentStorage
  readonly projectId: string
  readonly threadId: string
}): Promise<AgentThreadRecord | null> {
  // A scoped principal reads through the core scoped surface, which applies the owner + run:agent
  // filter. When scoped is null the request is privileged (auth disabled), so nothing is filtered.
  if (params.scoped) {
    return params.scoped.getThread(params.threadId)
  }
  return params.storage.threads.getById({ projectId: params.projectId, id: params.threadId })
}

async function getAgentMessageFileContentThread(params: {
  readonly authState: RequestAuthState
  readonly storage: AgentStorage
  readonly projectId: string
  readonly threadId: string
}): Promise<AgentThreadRecord | null> {
  const { agentRun } = params.authState
  if (agentRun) {
    if (agentRun.projectId !== params.projectId || agentRun.threadId !== params.threadId) {
      return null
    }
    return params.storage.threads.getById({ projectId: params.projectId, id: params.threadId })
  }

  return getAccessibleThread({
    scoped: params.authState.scoped,
    storage: params.storage,
    projectId: params.projectId,
    threadId: params.threadId,
  })
}

function principalForRequest(authz: AuthorizationContext | null): Principal {
  return authz?.principal ?? SYSTEM_PRINCIPAL
}

/** Publish the terminal record core owns; stream delivery stays best-effort at this boundary. */
async function publishQueuedRunCancellation(
  sixb: Sixb<readonly OntologySource[]>,
  run: AgentRunRecord
): Promise<void> {
  try {
    await publishAgentRunFinished(sixb.broker, run)
  } catch (error) {
    console.error(`[SixbServer] Agent run '${run.id}' cancellation stream publish failed:`, error)
  }
}

function handleAgentRouteError(
  error: unknown,
  set: { status?: number | string }
): { error: string } {
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

  if (error instanceof AgentRequestError) {
    switch (error.code) {
      case "agent_not_found":
      case "thread_not_found":
        set.status = 404
        break
      case "active_run_exists":
        set.status = 409
        break
      case "storage_unavailable":
      case "thread_agent_mismatch":
      case "invalid_context":
        set.status = 400
        break
    }
    return { error: error.message }
  }

  return handleRouteError(error, set)
}

function missingAgentStorageResponse(set: { status?: number | string }): { error: string } {
  return unconfiguredStorageResponse(set, "Agent storage")
}

async function agentMessageFileContentResponse(
  sixb: Sixb<readonly OntologySource[]>,
  context: {
    readonly params: { readonly threadId: string; readonly messageId: string }
    readonly query: unknown
    readonly request: Request
    readonly set: { status?: number | string }
  },
  options: { readonly head?: boolean } = {}
) {
  const authState = requestAuthState(context)

  try {
    const storage = sixb.storage.agents
    if (!storage) {
      return missingAgentStorageResponse(context.set)
    }

    const parsed = AgentMessageFileContentQuerySchema.parse(context.query)
    const thread = await getAgentMessageFileContentThread({
      authState,
      storage,
      projectId: sixb.id,
      threadId: context.params.threadId,
    })
    if (!thread) {
      context.set.status = 404
      return { error: "File not found" }
    }

    const message = await storage.messages.getById({
      projectId: sixb.id,
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
      blobStorage: sixb.blobStorage,
      fileRef,
      disposition: parsed.disposition,
      head: options.head,
      rangeHeader: context.request.headers.get("range"),
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

export function registerAgentRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/agents",
      (context) => {
        const { scoped } = requestAuthState(context)
        const agents = scoped ? scoped.listAgents() : sixb.agents.list()
        return agents.map(serializeAgent)
      },
      {
        response: { 200: AgentCatalogItemSchema.array() },
        detail: {
          summary: "List registered agents",
          tags: [OPENAPI_TAGS.agents.name],
          operationId: "listAgents",
        },
      }
    )
    .get(
      "/api/agents/:agentId",
      (context) => {
        const { params, set } = context
        const { scoped } = requestAuthState(context)
        const agent = scoped
          ? scoped.getAgentById(params.agentId)
          : sixb.agents.getById(params.agentId)
        if (!agent) {
          set.status = 404
          return { error: "Agent not found" }
        }

        return serializeAgent(agent)
      },
      {
        params: AgentIdParamsSchema,
        response: { 200: AgentCatalogItemSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get agent metadata",
          tags: [OPENAPI_TAGS.agents.name],
          operationId: "getAgent",
        },
      }
    )
    .get(
      "/api/agent-threads",
      async (context) => {
        const { query, set } = context
        const { scoped } = requestAuthState(context)
        try {
          const storage = sixb.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const parsed = AgentThreadListQuerySchema.parse(query)
          const listInput = {
            agentId: parsed.agentId,
            statuses: parsed.status ? [parsed.status] : undefined,
            limit: parseOptionalInt(parsed.limit),
            offset: parseOptionalInt(parsed.offset),
            order: parsed.order,
          }
          // Scoped principals list through the core scoped surface (owner + run:agent filtered);
          // a null scope is privileged (auth disabled), so it lists unfiltered.
          const result = scoped
            ? await scoped.listThreads(listInput)
            : await storage.threads.list({ projectId: sixb.id, ...listInput })

          return AgentThreadListResponseSchema.parse({
            threads: result.threads.map(serializeThread),
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
        const { authz, scoped } = requestAuthState(context)
        try {
          const parsed = CreateAgentThreadBodySchema.parse(body)
          // scoped.getAgentById returns null for agents the principal cannot run, so an ungranted
          // agent 404s (not found) instead of 403 — the latter would disclose that the id exists.
          const agent = scoped
            ? scoped.getAgentById(parsed.agentId)
            : sixb.agents.getById(parsed.agentId)
          if (!agent) {
            set.status = 404
            return { error: "Agent not found" }
          }

          const storage = sixb.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const thread = await storage.threads.create({
            id: parsed.threadId ?? createAgentThreadId(),
            projectId: sixb.id,
            agentId: agent.id,
            ownerPrincipal: principalForRequest(authz),
            ...(parsed.title === undefined ? {} : { title: parsed.title }),
          })

          set.status = 201
          return CreateAgentThreadResponseSchema.parse({ thread: serializeThread(thread) })
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        body: CreateAgentThreadBodySchema,
        response: {
          201: CreateAgentThreadResponseSchema,
          400: ErrorResponseSchema,
          // No 403: an agent the caller cannot run is reported as 404 (see getAgentById above) so the
          // response never discloses that a forbidden id exists.
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Create an agent thread",
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "createAgentThread",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .get(
      "/api/agent-threads/:threadId",
      async (context) => {
        const { params, set } = context
        const { scoped } = requestAuthState(context)
        try {
          const storage = sixb.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const thread = await getAccessibleThread({
            scoped,
            storage,
            projectId: sixb.id,
            threadId: params.threadId,
          })
          if (!thread) {
            set.status = 404
            return { error: "Agent thread not found" }
          }

          return serializeThread(thread)
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
    .get(
      "/api/agent-threads/:threadId/messages",
      async (context) => {
        const { params, query, set } = context
        const { scoped } = requestAuthState(context)
        try {
          const storage = sixb.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const thread = await getAccessibleThread({
            scoped,
            storage,
            projectId: sixb.id,
            threadId: params.threadId,
          })
          if (!thread) {
            set.status = 404
            return { error: "Agent thread not found" }
          }

          const parsed = AgentMessagesQuerySchema.parse(query)
          const limit = parseOptionalInt(parsed.limit)
          const offset = parseOptionalInt(parsed.offset)
          const result = await storage.messages.list({
            projectId: sixb.id,
            threadId: thread.id,
            roles: parsed.role ? [parsed.role] : undefined,
            limit,
            offset,
            order: parsed.order,
          })
          const runIds = result.messages.flatMap((message) =>
            message.runId === null ? [] : [message.runId]
          )
          const runs = await storage.runs.getByIds({ projectId: sixb.id, ids: runIds })
          const diagnosticsByRunId = new Map(
            runs.map((run) => [run.id, run.diagnostics ?? []] as const)
          )

          return AgentMessageListResponseSchema.parse({
            messages: result.messages.map((message) =>
              serializeMessage(
                message,
                message.runId === null ? [] : (diagnosticsByRunId.get(message.runId) ?? [])
              )
            ),
            hasMore: result.hasMore,
            total: result.total,
          })
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
      async (context) => agentMessageFileContentResponse(sixb, context),
      {
        params: AgentMessageFileContentParamsSchema,
        // Keep framework validation loose so invalid roots return the compact route-level 400 body.
        query: FileContentQuerySchema,
        detail: {
          summary: "Get agent message file content",
          tags: ["Agents"],
          operationId: "getAgentMessageFileContent",
          security: bearerSecurityRequirement("getAgentMessageFileContent"),
          responses: fileContentGetResponses({ optionalStorage: true }),
        },
      }
    )
    .head(
      "/api/agent-threads/:threadId/messages/:messageId/files/content",
      async (context) => agentMessageFileContentResponse(sixb, context, { head: true }),
      {
        params: AgentMessageFileContentParamsSchema,
        query: FileContentQuerySchema,
        detail: {
          summary: "Head agent message file content",
          tags: ["Agents"],
          operationId: "headAgentMessageFileContent",
          security: bearerSecurityRequirement("headAgentMessageFileContent"),
          responses: fileContentHeadResponses({ optionalStorage: true }),
        },
      }
    )
    .post(
      "/api/agent-threads/:threadId/messages",
      async (context) => {
        const { params, body, set } = context
        const { authz, scoped } = requestAuthState(context)
        try {
          const storage = sixb.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const thread = await getAccessibleThread({
            scoped,
            storage,
            projectId: sixb.id,
            threadId: params.threadId,
          })
          if (!thread) {
            set.status = 404
            return { error: "Agent thread not found" }
          }

          const parsed = PostAgentMessageBodySchema.parse(body)
          const requestInput = {
            agentId: thread.agentId,
            threadId: thread.id,
            text: parsed.text,
            attachments: parsed.attachments as readonly FileRef[] | undefined,
            context: parsed.context,
            messageId: parsed.messageId,
            principal: principalForRequest(authz),
          }
          const result = await (scoped
            ? scoped.requestAgentRun(requestInput)
            : sixb.agents.request(requestInput))

          set.status = 202
          return PostAgentMessageResponseSchema.parse({ run: serializeAgentRun(result.run) })
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        body: PostAgentMessageBodySchema,
        response: {
          202: PostAgentMessageResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Post an agent thread message",
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "postAgentThreadMessage",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/agent-threads/:threadId/cancel",
      async (context) => {
        const { params, body, set } = context
        const { scoped } = requestAuthState(context)
        try {
          const storage = sixb.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const thread = await getAccessibleThread({
            scoped,
            storage,
            projectId: sixb.id,
            threadId: params.threadId,
          })
          if (!thread) {
            set.status = 404
            return { error: "Agent thread not found" }
          }

          const parsed = CancelAgentRunBodySchema.parse(body)
          const run = await storage.runs.getById({ projectId: sixb.id, id: parsed.runId })
          if (!run || run.threadId !== thread.id) {
            set.status = 404
            return { error: "Agent run not found" }
          }
          let current = run
          let cancelledWhileQueued = false
          if (current.status === "queued") {
            try {
              current = await storage.runs.finishQueued({
                projectId: sixb.id,
                id: current.id,
                status: "cancelled",
              })
              cancelledWhileQueued = true
            } catch (error) {
              if (!(error instanceof AgentStorageError) || error.code !== "invalid_state") {
                throw error
              }

              // The worker may have started the run after our read but before finishQueued locked
              // it. Re-read so that pickup race becomes a running-run cancellation instead of an
              // invalid-state response. A retained control record is safe even if the worker has
              // not attached its cancel subscription yet.
              const refreshed = await storage.runs.getById({ projectId: sixb.id, id: current.id })
              if (!refreshed || refreshed.threadId !== thread.id) {
                set.status = 404
                return { error: "Agent run not found" }
              }
              current = refreshed
            }
          }

          if (cancelledWhileQueued) {
            await publishQueuedRunCancellation(sixb, current)
          } else if (current.status === "running") {
            await publishAgentRunCancel(sixb.broker, { projectId: sixb.id, runId: current.id })
          } else {
            set.status = 409
            return { error: "Agent run is not active" }
          }

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
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Cancel an agent thread's active run",
          tags: [OPENAPI_TAGS.agentRuns.name],
          operationId: "cancelAgentRun",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/agent-threads/:threadId/runs/:runId/retry",
      async (context) => {
        const { params, set } = context
        const { authz, scoped } = requestAuthState(context)
        try {
          const storage = sixb.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const thread = await getAccessibleThread({
            scoped,
            storage,
            projectId: sixb.id,
            threadId: params.threadId,
          })
          if (!thread) {
            set.status = 404
            return { error: "Agent thread not found" }
          }

          const failedRun = await storage.runs.getById({ projectId: sixb.id, id: params.runId })
          if (!failedRun || failedRun.threadId !== thread.id) {
            set.status = 404
            return { error: "Agent run not found" }
          }
          if (failedRun.status !== "failed") {
            set.status = 409
            return { error: "Only failed agent runs can be retried" }
          }

          const run = await storage.runs.create({
            id: createAgentRunId(),
            projectId: sixb.id,
            threadId: thread.id,
            agentId: failedRun.agentId,
            triggerMessageId: failedRun.triggerMessageId,
            requestedByPrincipal: principalForRequest(authz),
          })

          // As with a new message, the durable queued run is the dispatch intent. A worker will
          // reconcile it if this best-effort publication cannot reach the queue right now.
          try {
            const dispatch = await dispatchQueuedAgentRuns({
              projectId: sixb.id,
              storage,
              queue: sixb.queues.agents,
              runIds: [run.id],
            })
            const failure = dispatch.failures[0]
            if (failure) {
              console.error(
                `[SixbServer] Could not dispatch retried agent run '${run.id}'; retrying later.`,
                failure.error
              )
            }
          } catch (error) {
            console.error(
              `[SixbServer] Could not dispatch retried agent run '${run.id}'; retrying later.`,
              error
            )
          }

          set.status = 202
          return RetryAgentRunResponseSchema.parse({ run: serializeAgentRun(run) })
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentRunParamsSchema.extend({ threadId: z.string().trim().min(1) }),
        response: {
          202: RetryAgentRunResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Retry a failed agent run",
          tags: [OPENAPI_TAGS.agentRuns.name],
          operationId: "retryAgentRun",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .get(
      "/api/agent-threads/:threadId/runs",
      async (context) => {
        const { params, query, set } = context
        const { scoped } = requestAuthState(context)
        try {
          const storage = sixb.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const thread = await getAccessibleThread({
            scoped,
            storage,
            projectId: sixb.id,
            threadId: params.threadId,
          })
          if (!thread) {
            set.status = 404
            return { error: "Agent thread not found" }
          }

          const parsed = AgentRunListQuerySchema.parse(query)
          const result = await storage.runs.list({
            projectId: sixb.id,
            threadId: thread.id,
            statuses: parsed.status ? [parsed.status] : undefined,
            limit: parseOptionalInt(parsed.limit),
            offset: parseOptionalInt(parsed.offset),
            order: parsed.order,
          })

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
        const { scoped } = requestAuthState(context)
        try {
          const storage = sixb.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const run = await storage.runs.getById({ projectId: sixb.id, id: params.runId })
          if (!run) {
            set.status = 404
            return { error: "Agent run not found" }
          }

          const thread = await getAccessibleThread({
            scoped,
            storage,
            projectId: sixb.id,
            threadId: run.threadId,
          })
          if (!thread) {
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
          tags: [OPENAPI_TAGS.agentRuns.name],
          operationId: "getAgentRun",
        },
      }
    )
}
