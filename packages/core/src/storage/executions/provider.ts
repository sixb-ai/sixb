import type { TrustedPrimitiveKind } from "../../execution/types"
import type { CreateExecutionInput, ExecutionRecord } from "./types"
import { normalizeExecutionRecord } from "./validation"

export {
  type ExecutionValidationLookup,
  normalizeExecutionRecord,
  validateExecutionRecordReferences,
} from "./validation"

/** Provider-neutral flattened representation used by the SQL adapters. */
export interface ExecutionStorageRow {
  readonly projectId: string
  readonly id: string
  readonly executorKind: "agent" | "kernel" | "request" | TrustedPrimitiveKind
  readonly executorId: string
  readonly sourceKind: "event" | "execution" | "http" | "schedule" | "webhook"
  readonly sourceId: string
  readonly requestedByUserId: string | null
  readonly requestedByServiceAccountId: string | null
  readonly correlationId: string
  readonly parentExecutionId: string | null
  readonly authorityKind: "disabled" | "kernel" | "principal" | "sharedAccess" | "trustedPrimitive"
  readonly authorityUserId: string | null
  readonly authorityServiceAccountId: string | null
  readonly authoritySessionId: string | null
  readonly authorityAccessTokenId: string | null
  readonly authorityPrimitiveKind: TrustedPrimitiveKind | null
  readonly authorityPrimitiveId: string | null
  readonly authorityKernelOperation: "ontology.recover" | null
  readonly authoritySharedGrantId: string | null
  readonly authoritySharedSessionId: string | null
  readonly createdAt: Date
}

export function executionRecordToStorageRow(record: ExecutionRecord): ExecutionStorageRow {
  const executor = flattenExecutor(record)
  const source = flattenSource(record)
  const authority = flattenAuthority(record)
  return {
    projectId: record.projectId,
    id: record.id,
    ...executor,
    ...source,
    requestedByUserId: record.requestedBy?.type === "user" ? record.requestedBy.id : null,
    requestedByServiceAccountId:
      record.requestedBy?.type === "serviceAccount" ? record.requestedBy.id : null,
    correlationId: record.correlationId,
    parentExecutionId: record.parentExecutionId ?? null,
    ...authority,
    createdAt: new Date(record.createdAt),
  }
}

export function executionRecordFromStorageRow(row: ExecutionStorageRow): ExecutionRecord {
  const executor = inflateExecutor(row)
  const source = inflateSource(row)
  const authorizationRef = inflateAuthority(row)
  const requestedBy = row.requestedByUserId
    ? ({ type: "user", id: row.requestedByUserId } as const)
    : row.requestedByServiceAccountId
      ? ({ type: "serviceAccount", id: row.requestedByServiceAccountId } as const)
      : undefined

  return normalizeExecutionRecord(
    {
      id: row.id,
      projectId: row.projectId,
      ...(requestedBy === undefined ? {} : { requestedBy }),
      executor,
      source,
      correlationId: row.correlationId,
      ...(row.parentExecutionId === null ? {} : { parentExecutionId: row.parentExecutionId }),
      authorizationRef,
    },
    row.createdAt
  )
}

function flattenExecutor(
  record: ExecutionRecord
): Pick<ExecutionStorageRow, "executorId" | "executorKind"> {
  switch (record.executor.type) {
    case "request":
      return { executorKind: "request", executorId: record.executor.requestId }
    case "primitive":
      return { executorKind: record.executor.kind, executorId: record.executor.runId }
    case "agent":
      return { executorKind: "agent", executorId: record.executor.runId }
    case "kernel":
      return { executorKind: "kernel", executorId: record.executor.operation.recoveryId }
  }
}

function flattenSource(
  record: ExecutionRecord
): Pick<ExecutionStorageRow, "sourceId" | "sourceKind"> {
  switch (record.source.type) {
    case "http":
      return { sourceKind: "http", sourceId: record.source.requestId }
    case "webhook":
      return { sourceKind: "webhook", sourceId: record.source.deliveryId }
    case "schedule":
    case "event":
      return { sourceKind: record.source.type, sourceId: record.source.eventId }
    case "execution":
      return { sourceKind: "execution", sourceId: record.source.executionId }
  }
}

function flattenAuthority(
  record: ExecutionRecord
): Pick<
  ExecutionStorageRow,
  | "authorityAccessTokenId"
  | "authorityKernelOperation"
  | "authorityKind"
  | "authorityPrimitiveId"
  | "authorityPrimitiveKind"
  | "authorityServiceAccountId"
  | "authoritySharedGrantId"
  | "authoritySharedSessionId"
  | "authoritySessionId"
  | "authorityUserId"
> {
  const empty = {
    authorityUserId: null,
    authorityServiceAccountId: null,
    authoritySessionId: null,
    authorityAccessTokenId: null,
    authorityPrimitiveKind: null,
    authorityPrimitiveId: null,
    authorityKernelOperation: null,
    authoritySharedGrantId: null,
    authoritySharedSessionId: null,
  }

  switch (record.authorizationRef.type) {
    case "principal":
      return {
        ...empty,
        authorityKind: "principal",
        authorityUserId:
          record.authorizationRef.principal.type === "user"
            ? record.authorizationRef.principal.id
            : null,
        authorityServiceAccountId:
          record.authorizationRef.principal.type === "serviceAccount"
            ? record.authorizationRef.principal.id
            : null,
        authoritySessionId:
          record.authorizationRef.credential?.type === "session"
            ? record.authorizationRef.credential.id
            : null,
        authorityAccessTokenId:
          record.authorizationRef.credential?.type === "accessToken"
            ? record.authorizationRef.credential.id
            : null,
      }
    case "trustedPrimitive":
      return {
        ...empty,
        authorityKind: "trustedPrimitive",
        authorityPrimitiveKind: record.authorizationRef.primitive.kind,
        authorityPrimitiveId: record.authorizationRef.primitive.id,
      }
    case "sharedAccess":
      return {
        ...empty,
        authorityKind: "sharedAccess",
        authoritySharedGrantId: record.authorizationRef.grantId,
        authoritySharedSessionId: record.authorizationRef.sessionId,
      }
    case "kernel":
      return {
        ...empty,
        authorityKind: "kernel",
        authorityKernelOperation: record.authorizationRef.operation.type,
      }
    case "disabled":
      return { ...empty, authorityKind: "disabled" }
  }
}

function inflateExecutor(row: ExecutionStorageRow): CreateExecutionInput["executor"] {
  switch (row.executorKind) {
    case "request":
      return { type: "request", requestId: row.executorId }
    case "agent":
      return { type: "agent", runId: row.executorId }
    case "kernel":
      return {
        type: "kernel",
        operation: {
          type: requireValue(row.authorityKernelOperation, "authority kernel operation"),
          recoveryId: row.executorId,
        },
      }
    default:
      return { type: "primitive", kind: row.executorKind, runId: row.executorId }
  }
}

function inflateSource(row: ExecutionStorageRow): CreateExecutionInput["source"] {
  switch (row.sourceKind) {
    case "http":
      return { type: "http", requestId: row.sourceId }
    case "webhook":
      return { type: "webhook", deliveryId: row.sourceId }
    case "schedule":
    case "event":
      return { type: row.sourceKind, eventId: row.sourceId }
    case "execution":
      return { type: "execution", executionId: row.sourceId }
  }
}

function inflateAuthority(row: ExecutionStorageRow): CreateExecutionInput["authorizationRef"] {
  switch (row.authorityKind) {
    case "principal": {
      const principal = row.authorityUserId
        ? ({ type: "user", id: row.authorityUserId } as const)
        : ({
            type: "serviceAccount",
            id: requireValue(row.authorityServiceAccountId, "authority service account id"),
          } as const)
      const credential = row.authoritySessionId
        ? ({ type: "session", id: row.authoritySessionId } as const)
        : row.authorityAccessTokenId
          ? ({ type: "accessToken", id: row.authorityAccessTokenId } as const)
          : undefined
      return {
        type: "principal",
        principal,
        ...(credential === undefined ? {} : { credential }),
      }
    }
    case "trustedPrimitive":
      return {
        type: "trustedPrimitive",
        primitive: {
          kind: requireValue(row.authorityPrimitiveKind, "authority primitive kind"),
          id: requireValue(row.authorityPrimitiveId, "authority primitive id"),
          runId: row.executorId,
        },
      }
    case "sharedAccess":
      return {
        type: "sharedAccess",
        grantId: requireValue(row.authoritySharedGrantId, "shared access authority grant id"),
        sessionId: requireValue(row.authoritySharedSessionId, "shared access authority session id"),
      }
    case "kernel":
      return {
        type: "kernel",
        operation: {
          type: requireValue(row.authorityKernelOperation, "authority kernel operation"),
          recoveryId: row.executorId,
        },
      }
    case "disabled":
      return { type: "disabled" }
  }
}

function requireValue<T>(value: T | null, label: string): T {
  if (value === null) {
    throw new Error(`[Sixb] Stored execution is missing ${label}.`)
  }
  return value
}
