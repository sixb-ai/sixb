import type { AgentDefinition, AgentToolDefinition } from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import type { AgentMessageRecord, AgentRunRecord } from "@sixb/core/storage"
import type {
  AgentConversationCapability,
  AgentConversationToolProvision,
  AgentWorkerContext,
} from "./types"

export const EMPTY_CONVERSATION_TOOL_PROVISION: AgentConversationToolProvision = Object.freeze({
  tools: Object.freeze([]),
  capabilities: Object.freeze([]),
})

/** Resolve host-owned tools against the exact user message that triggered this run. */
export async function resolveConversationToolProvision(input: {
  readonly context: AgentWorkerContext
  readonly agent: AgentDefinition
  readonly run: AgentRunRecord
  readonly messages: readonly AgentMessageRecord[]
  readonly signal: AbortSignal
}): Promise<AgentConversationToolProvision> {
  const provider = input.context.conversationToolProvider
  if (!provider) return EMPTY_CONVERSATION_TOOL_PROVISION

  const triggerMessage = input.messages.find(
    (message) => message.id === input.run.triggerMessageId && message.role === "user"
  )
  if (!triggerMessage) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Agent run '${input.run.id}' is missing its triggering user message.`,
      { details: { agentId: input.agent.id, runId: input.run.id } }
    )
  }

  input.signal.throwIfAborted()
  const provision = await resolveBeforeAbort(
    provider({
      projectId: input.context.id,
      agentId: input.agent.id,
      runId: input.run.id,
      threadId: input.run.threadId,
      triggerMessageId: input.run.triggerMessageId,
      triggerMessage,
      signal: input.signal,
    }),
    input.signal
  )
  input.signal.throwIfAborted()
  if (!isConversationToolProvision(provision)) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] The conversational tool provider must return a tool provision.`,
      { details: { agentId: input.agent.id, runId: input.run.id } }
    )
  }
  validateCapabilities(provision.capabilities ?? [], input)
  validateToolDefinitions(provision.tools, input)
  return Object.freeze({
    tools: Object.freeze([...provision.tools]),
    capabilities: Object.freeze([...(provision.capabilities ?? [])]),
  })
}

export function combineAgentTools(
  declared: readonly AgentToolDefinition[],
  provided: readonly AgentToolDefinition[]
): readonly AgentToolDefinition[] {
  const combined = provided.length === 0 ? declared : [...declared, ...provided]
  const names = new Set<string>()
  for (const tool of combined) {
    if (names.has(tool.name)) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Agent tools contain duplicate name '${tool.name}'.`
      )
    }
    names.add(tool.name)
  }
  return combined
}

function isConversationToolProvision(value: unknown): value is AgentConversationToolProvision {
  return typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "tools"))
}

async function resolveBeforeAbort<T>(value: T | Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try {
        signal.throwIfAborted()
      } catch (error) {
        reject(error)
      }
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([Promise.resolve(value), aborted])
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

function validateToolDefinitions(
  tools: readonly AgentToolDefinition[],
  input: { readonly agent: AgentDefinition; readonly run: AgentRunRecord }
): void {
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null || typeof tool.name !== "string" || !tool.name) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] The conversational tool provider returned an invalid tool definition.`,
        { details: { agentId: input.agent.id, runId: input.run.id } }
      )
    }
  }
}

function validateCapabilities(
  capabilities: readonly AgentConversationCapability[],
  input: { readonly agent: AgentDefinition; readonly run: AgentRunRecord }
): void {
  for (const capability of capabilities) {
    if (capability !== "application-surface") {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] The conversational tool provider returned unknown capability '${String(capability)}'.`,
        { details: { agentId: input.agent.id, runId: input.run.id } }
      )
    }
  }
}
