import {
  type AgentDefinition,
  type AgentMessageRecord,
  AgentRequestError,
  type AgentRunRecord,
  type AgentStorage,
  type AgentThreadRecord,
  type AuthorizationContext,
  agentRunStreamId,
  assertAuthorized,
  createAgentThreadId,
  isAllowed,
  type OntologySource,
  type Principal,
  type Sixb,
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
  CreateAgentThreadBodySchema,
  CreateAgentThreadResponseSchema,
  PostAgentMessageBodySchema,
  PostAgentMessageResponseSchema,
} from "../schemas/agents"
import { ErrorResponseSchema } from "../schemas/common"
import { handleRouteError, parseOptionalInt, toIsoString } from "../utils/http"

const SYSTEM_PRINCIPAL: Principal = { type: "system", id: "system" }

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

function principalsEqual(left: Principal, right: Principal): boolean {
  return left.type === right.type && left.id === right.id
}

function canRunAgent(authz: AuthorizationContext | null, agentId: string): boolean {
  return !authz || isAllowed(authz, { kind: "agent.run", agentId })
}

function canAccessThread(authz: AuthorizationContext | null, thread: AgentThreadRecord): boolean {
  return (
    !authz ||
    (principalsEqual(authz.principal, thread.ownerPrincipal) && canRunAgent(authz, thread.agentId))
  )
}

async function getAccessibleThread(params: {
  readonly storage: AgentStorage
  readonly projectId: string
  readonly threadId: string
  readonly authz: AuthorizationContext | null
}): Promise<AgentThreadRecord | null> {
  const thread = await params.storage.threads.getById({
    projectId: params.projectId,
    id: params.threadId,
  })

  return thread && canAccessThread(params.authz, thread) ? thread : null
}

function principalForRequest(authz: AuthorizationContext | null): Principal {
  return authz?.principal ?? SYSTEM_PRINCIPAL
}

function handleAgentRouteError(
  error: unknown,
  set: { status?: number | string }
): { error: string } {
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
        const { authz } = requestAuthState(context)
        try {
          const storage = sixb.storage.agents
          if (!storage) {
            return { threads: [], hasMore: false, total: 0 }
          }

          const parsed = AgentThreadListQuerySchema.parse(query)
          const limit = parseOptionalInt(parsed.limit)
          const offset = parseOptionalInt(parsed.offset)
          const result = await storage.threads.list({
            projectId: sixb.id,
            agentId: parsed.agentId,
            agentIds: authz ? [...authz.grants["run:agent"]] : undefined,
            statuses: parsed.status ? [parsed.status] : undefined,
            ownerPrincipal: authz?.principal,
            limit,
            offset,
            order: parsed.order,
          })

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
        const { authz } = requestAuthState(context)
        try {
          const parsed = CreateAgentThreadBodySchema.parse(body)
          const agent = sixb.agents.getById(parsed.agentId)
          if (!agent) {
            set.status = 404
            return { error: "Agent not found" }
          }
          assertAuthorized(
            { authorization: authz ?? undefined },
            { kind: "agent.run", agentId: agent.id }
          )

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
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
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
        const { authz } = requestAuthState(context)
        try {
          const storage = sixb.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const thread = await getAccessibleThread({
            storage,
            projectId: sixb.id,
            threadId: params.threadId,
            authz,
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
        const { authz } = requestAuthState(context)
        try {
          const storage = sixb.storage.agents
          if (!storage) {
            return missingAgentStorageResponse(set)
          }

          const thread = await getAccessibleThread({
            storage,
            projectId: sixb.id,
            threadId: params.threadId,
            authz,
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
            storage,
            projectId: sixb.id,
            threadId: params.threadId,
            authz,
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
    .get(
      "/api/agent-runs/:runId",
      async (context) => {
        const { params, set } = context
        const { authz } = requestAuthState(context)
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
            storage,
            projectId: sixb.id,
            threadId: run.threadId,
            authz,
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
