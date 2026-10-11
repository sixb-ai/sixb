import type { JsonValue } from "../../json"
import { cloneJsonValue, getInvalidJsonValueReason, stableJsonStringify } from "../../json"
import type { ObjectRef } from "../../ontology/refs"
import { AgentRequestError } from "../errors"

export type AgentContextInput =
  | {
      readonly kind: "object"
      readonly ref: ObjectRef
      /**
       * What the chat shows for this object instead of its title. Display only: it is not part of
       * the context's identity and is never sent to the model.
       */
      readonly label?: string
    }
  | {
      readonly kind: "app-state"
      readonly id: string
      readonly label: string
      readonly description: string
      readonly value: JsonValue
    }

export type AgentContextOrigin = "ambient" | "explicit"

export interface AgentContextEntryInput {
  readonly context: AgentContextInput
  readonly origin: AgentContextOrigin
}

/** Durable user-message part. Origin is display provenance, never an authorization grant. */
export interface AgentContextPart extends AgentContextEntryInput {
  readonly type: "context"
}

export const MAX_AGENT_CONTEXT_ENTRIES = 12
export const MAX_AGENT_APP_STATE_ENTRY_BYTES = 16 * 1024
export const MAX_AGENT_APP_STATE_TOTAL_BYTES = 64 * 1024
export const MAX_AGENT_CONTEXT_LABEL_LENGTH = 200

/** Typed constructors for context values shared by custom apps and agent clients. */
export const agentContext = {
  object<const TObjectTypeId extends string>(
    objectType: { readonly id: TObjectTypeId },
    primaryId: string,
    options: { readonly label?: string } = {}
  ) {
    const label =
      options.label === undefined
        ? undefined
        : objectContextLabel(options.label, "agentContext.object() label", (message) => {
            throw new TypeError(`[Sixb] ${message}.`)
          })
    return {
      kind: "object" as const,
      ref: { objectTypeId: objectType.id, primaryId },
      ...(label === undefined ? {} : { label }),
    }
  },

  appState<const TValue extends JsonValue>(
    id: string,
    input: {
      readonly label: string
      readonly description: string
      readonly value: TValue
    }
  ) {
    return { kind: "app-state" as const, id, ...input }
  },
}

/** Stable identity shared by core deduplication and context-aware clients. */
export function agentContextIdentity(context: AgentContextInput): string {
  return context.kind === "object"
    ? `object:${encodeURIComponent(context.ref.objectTypeId)}:${encodeURIComponent(context.ref.primaryId)}`
    : `app-state:${encodeURIComponent(context.id)}`
}

/** Stable semantic key for client-side comparisons. */
export function agentContextFingerprint(context: AgentContextInput): string {
  return stableJsonStringify(context)
}

/**
 * Validate transport-independent context rules and clone mutable app state before it can become
 * durable. Object existence and visibility are resolved separately because they require a runtime.
 */
export function normalizeAgentContextEntries(
  input: readonly AgentContextEntryInput[] | undefined
): readonly AgentContextEntryInput[] {
  if (input === undefined) return []
  if (!Array.isArray(input)) invalidContext("context must be an array")
  if (input.length > MAX_AGENT_CONTEXT_ENTRIES) {
    invalidContext(`context cannot contain more than ${MAX_AGENT_CONTEXT_ENTRIES} entries`)
  }

  const entries: AgentContextEntryInput[] = []
  const byIdentity = new Map<string, string>()
  let totalAppStateBytes = 0

  for (const [index, rawEntry] of input.entries()) {
    const entry = normalizeEntry(rawEntry, index)
    const identity = agentContextIdentity(entry.context)
    // A label is display only, so two entries that differ only by label are the same entry; the
    // first one's label is kept.
    const serialized = stableJsonStringify(
      entry.context.kind === "object"
        ? { ...entry, context: { kind: "object", ref: entry.context.ref } }
        : entry
    )
    const existing = byIdentity.get(identity)

    if (existing !== undefined) {
      if (existing === serialized) continue
      invalidContext(`context contains conflicting entries for '${identity}'`)
    }

    if (entry.context.kind === "app-state") {
      const bytes = utf8ByteLength(serialized)
      if (bytes > MAX_AGENT_APP_STATE_ENTRY_BYTES) {
        invalidContext(
          `context entry '${identity}' exceeds the ${MAX_AGENT_APP_STATE_ENTRY_BYTES}-byte limit`
        )
      }
      totalAppStateBytes += bytes
      if (totalAppStateBytes > MAX_AGENT_APP_STATE_TOTAL_BYTES) {
        invalidContext(
          `app-state context exceeds the ${MAX_AGENT_APP_STATE_TOTAL_BYTES}-byte message limit`
        )
      }
    }

    byIdentity.set(identity, serialized)
    entries.push(entry)
  }

  return entries
}

function normalizeEntry(rawEntry: unknown, index: number): AgentContextEntryInput {
  if (!isRecord(rawEntry)) invalidContext(`context[${index}] must be an object`)
  if (rawEntry.origin !== "ambient" && rawEntry.origin !== "explicit") {
    invalidContext(`context[${index}].origin must be 'ambient' or 'explicit'`)
  }
  if (!isRecord(rawEntry.context)) invalidContext(`context[${index}].context must be an object`)

  const context = rawEntry.context
  if (context.kind === "object") {
    if (!isRecord(context.ref)) invalidContext(`context[${index}].context.ref must be an object`)
    const objectTypeId = requireNonEmptyString(
      context.ref.objectTypeId,
      `context[${index}].context.ref.objectTypeId`
    )
    const primaryId = requireNonEmptyString(
      context.ref.primaryId,
      `context[${index}].context.ref.primaryId`
    )
    const label =
      context.label === undefined
        ? undefined
        : objectContextLabel(context.label, `context[${index}].context.label`, invalidContext)
    return {
      context: {
        kind: "object",
        ref: { objectTypeId, primaryId },
        ...(label === undefined ? {} : { label }),
      },
      origin: rawEntry.origin,
    }
  }

  if (context.kind === "app-state") {
    const id = requireNonEmptyString(context.id, `context[${index}].context.id`)
    const label = requireNonEmptyString(context.label, `context[${index}].context.label`)
    const description = requireNonEmptyString(
      context.description,
      `context[${index}].context.description`
    )
    const reason = getInvalidJsonValueReason(context.value, `context[${index}].context.value`)
    if (reason) {
      invalidContext(`context[${index}].context.value must be a JSON value; ${reason}`)
    }
    return {
      context: {
        kind: "app-state",
        id,
        label,
        description,
        value: cloneJsonValue(context.value as JsonValue),
      },
      origin: rawEntry.origin,
    }
  }

  invalidContext(`context[${index}].context.kind must be 'object' or 'app-state'`)
}

function objectContextLabel(
  value: unknown,
  label: string,
  fail: (message: string) => never
): string {
  const trimmed = typeof value === "string" ? value.trim() : ""
  if (!trimmed) fail(`${label} must be a non-empty string`)
  if (trimmed.length > MAX_AGENT_CONTEXT_LABEL_LENGTH) {
    fail(`${label} must be at most ${MAX_AGENT_CONTEXT_LABEL_LENGTH} characters`)
  }
  return trimmed
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidContext(`${label} must be a non-empty string`)
  }
  return value
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidContext(message: string): never {
  throw new AgentRequestError("invalid_context", `[Sixb] Invalid agent context: ${message}.`)
}
