import {
  type AgentDefinition,
  type AgentMessageRecord,
  AgentRequestError,
  type AgentRunRecord,
  type AgentStorage,
  AgentStorageError,
  type AgentThreadRecord,
  type AuthorizationContext,
  agentRunStreamId,
  createAgentThreadId,
  type OntologySource,
  type Principal,
  publishAgentRunCancel,
  type ScopedSixb,
  type Sixb,
  SYSTEM_PRINCIPAL,
} from "@sixb/core"
import type { Elysia } from "elysia"
import { requestAuthState } from "../auth/scope"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import {
  AgentCatalogItemSchema,
  AgentIdParamsSchema,
  AgentMessageListResponseSchema,
  AgentMessageSchema,
  AgentMessagesQuerySchema,
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
} from "../schemas/agents"
import { ErrorResponseSchema } from "../schemas/common"
import { handleRouteError, parseOptionalInt, toIsoString } from "../utils/http"

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
  message: AgentMessageRecord
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
    metadata: message.metadata,
    contentVersion: message.contentVersion,
    createdAt: toIsoString(message.createdAt),
    completedAt: message.completedAt ? toIsoString(message.completedAt) : undefined,
  })
}

function serializeRun(run: AgentRunRecord): ReturnType<typeof AgentRunSchema.parse> {
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

function principalForRequest(authz: AuthorizationContext | null): Principal {
  return authz?.principal ?? SYSTEM_PRINCIPAL
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
        set.status = 400
        break
    }
    return { error: error.message }
  }

  return handleRouteError(error, set)
}

function missingAgentStorageResponse(set: { status?: number | string }): { error: string } {
  set.status = 400
  return { error: "Agent storage is not configured" }
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
          tags: ["Agents"],
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
          tags: ["Agents"],
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
        response: { 200: AgentThreadListResponseSchema, 400: ErrorResponseSchema },
        detail: {
          summary: "List agent threads",
          tags: ["Agents"],
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
        },
        detail: {
          summary: "Create an agent thread",
          tags: ["Agents"],
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
        response: { 200: AgentThreadSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get agent thread",
          tags: ["Agents"],
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

          return AgentMessageListResponseSchema.parse({
            messages: result.messages.map(serializeMessage),
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
        },
        detail: {
          summary: "List agent thread messages",
          tags: ["Agents"],
          operationId: "listAgentThreadMessages",
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
            messageId: parsed.messageId,
            principal: principalForRequest(authz),
          }
          const result = await (scoped
            ? scoped.requestAgentRun(requestInput)
            : sixb.agents.request(requestInput))

          set.status = 202
          return PostAgentMessageResponseSchema.parse({
            ...result,
            streamId: agentRunStreamId(result.runId),
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
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
        detail: {
          summary: "Post an agent thread message",
          tags: ["Agents"],
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
          // A run row exists only once the worker has reserved it. When it does, fence the cancel to
          // this thread and reject an already-finished run; a run still queued (no row yet) is
          // accepted — the worker sees the retained cancel signal when it picks the job up.
          const run = await storage.runs.getById({ projectId: sixb.id, id: parsed.runId })
          if (run && run.threadId !== thread.id) {
            set.status = 404
            return { error: "Agent run not found" }
          }
          if (run && run.status !== "running") {
            set.status = 409
            return { error: "Agent run is not running" }
          }

          await publishAgentRunCancel(sixb.broker, { projectId: sixb.id, runId: parsed.runId })

          set.status = 202
          return CancelAgentRunResponseSchema.parse({ runId: parsed.runId })
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
        },
        detail: {
          summary: "Cancel an agent thread's active run",
          tags: ["Agents"],
          operationId: "cancelAgentRun",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
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

          return serializeRun(run)
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentRunParamsSchema,
        response: { 200: AgentRunSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get agent run",
          tags: ["Agents"],
          operationId: "getAgentRun",
        },
      }
    )
}
