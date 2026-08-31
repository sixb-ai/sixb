import type {
  AuthorizablePrincipal,
  AuthorizationRef,
  KernelOperation,
} from "../../execution/types"
import type { AuthStorage } from "../auth"
import { ExecutionStorageError } from "./errors"
import type {
  CreateExecutionInput,
  DurableExecutionExecutor,
  DurableExecutionSource,
  ExecutionRecord,
} from "./types"

export interface ExecutionValidationLookup {
  readonly auth: AuthStorage
  getExecution(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<ExecutionRecord | null>
}

export function normalizeExecutionRecord(
  input: CreateExecutionInput,
  createdAt: Date = new Date()
): ExecutionRecord {
  const record: ExecutionRecord = {
    id: input.id,
    projectId: input.projectId,
    ...(input.requestedBy === undefined ? {} : { requestedBy: structuredClone(input.requestedBy) }),
    executor: structuredClone(input.executor),
    source: structuredClone(input.source),
    correlationId: input.correlationId,
    authorizationRef: structuredClone(input.authorizationRef),
    createdAt: new Date(createdAt),
  }

  assertRecordShape(record)
  assertExecutorAuthority(record)
  return record
}

export async function validateExecutionRecordReferences(
  record: ExecutionRecord,
  lookup: ExecutionValidationLookup
): Promise<void> {
  await validatePrincipal(record.requestedBy, record.projectId, "Requested-by principal", lookup)

  if (record.authorizationRef.type === "principal") {
    await validatePrincipal(
      record.authorizationRef.principal,
      record.projectId,
      "Authority principal",
      lookup
    )
    await validateCredential(record, lookup)
  }

  await validateParent(record, lookup)
}

export function cloneExecutionRecord(record: ExecutionRecord): ExecutionRecord {
  return structuredClone(record)
}

function assertRecordShape(record: ExecutionRecord): void {
  assertNonBlank(record.id, "Execution id")
  assertNonBlank(record.projectId, "Execution project id")
  assertNonBlank(record.correlationId, "Execution correlation id")
  assertValidDate(record.createdAt, "Execution createdAt")

  if (record.requestedBy) {
    assertPrincipal(record.requestedBy, "Requested-by principal")
  }

  assertExecutor(record.executor)
  assertSource(record.source)
  assertAuthorizationRef(record.authorizationRef)
}

function assertExecutor(executor: DurableExecutionExecutor): void {
  switch (executor.type) {
    case "request":
      assertNonBlank(executor.requestId, "Executor request id")
      return
    case "primitive":
      assertTrustedPrimitiveKind(executor.kind, "Executor primitive kind")
      assertNonBlank(executor.runId, "Executor primitive run id")
      return
    case "agent":
      assertNonBlank(executor.runId, "Executor agent run id")
      return
    case "kernel":
      assertKernelOperation(executor.operation, "Executor kernel operation")
      return
    default:
      invalid(`Unknown execution executor type '${String((executor as { type?: unknown }).type)}'.`)
  }
}

function assertSource(source: DurableExecutionSource): void {
  switch (source.type) {
    case "http":
      assertNonBlank(source.requestId, "Execution source request id")
      return
    case "webhook":
      assertNonBlank(source.deliveryId, "Execution source delivery id")
      return
    case "schedule":
    case "event":
      assertNonBlank(source.eventId, "Execution source event id")
      return
    case "datasetVersion":
      assertNonBlank(source.datasetId, "Execution source dataset id")
      assertNonBlank(source.versionId, "Execution source dataset version id")
      return
    case "execution":
      assertNonBlank(source.executionId, "Execution source execution id")
      return
    default:
      invalid(
        `Execution source type '${String((source as { type?: unknown }).type)}' is not durable.`
      )
  }
}

function assertAuthorizationRef(ref: AuthorizationRef): void {
  switch (ref.type) {
    case "principal":
      assertPrincipal(ref.principal, "Authority principal")
      if (ref.credential) {
        if (ref.credential.type !== "session" && ref.credential.type !== "accessToken") {
          invalid(
            `Unknown authority credential type '${String(
              (ref.credential as { type?: unknown }).type
            )}'.`
          )
        }
        assertNonBlank(ref.credential.id, "Authority credential id")
      }
      return
    case "trustedPrimitive":
      assertTrustedPrimitiveKind(ref.primitive.kind, "Authority primitive kind")
      assertNonBlank(ref.primitive.id, "Authority primitive id")
      assertNonBlank(ref.primitive.runId, "Authority primitive run id")
      return
    case "kernel":
      assertKernelOperation(ref.operation, "Authority kernel operation")
      return
    case "disabled":
      return
    default:
      invalid(`Unknown authorization reference type '${String((ref as { type?: unknown }).type)}'.`)
  }
}

function assertExecutorAuthority(record: ExecutionRecord): void {
  const { executor, authorizationRef, requestedBy, source } = record

  switch (executor.type) {
    case "request": {
      if (source.type !== "http" || source.requestId !== executor.requestId) {
        invalid("Request executions require a matching HTTP source request id.")
      }
      if (authorizationRef.type === "principal") {
        if (!principalsEqual(requestedBy, authorizationRef.principal)) {
          invalid("Request authority must match its requested-by principal.")
        }
        return
      }
      if (authorizationRef.type === "disabled") {
        if (requestedBy !== undefined) {
          invalid("Auth-disabled request executions cannot have a requested-by principal.")
        }
        return
      }
      invalid("Request executions require principal or explicitly disabled authority.")
      break
    }
    case "primitive": {
      if (authorizationRef.type !== "trustedPrimitive") {
        invalid("Primitive executions require trusted primitive authority.")
      }
      if (
        authorizationRef.primitive.kind !== executor.kind ||
        authorizationRef.primitive.runId !== executor.runId
      ) {
        invalid("Trusted primitive authority must match the executor kind and run id.")
      }
      return
    }
    case "agent": {
      if (
        authorizationRef.type !== "principal" ||
        authorizationRef.principal.type !== "serviceAccount"
      ) {
        invalid("Agent executions require service-account authority.")
      }
      if (authorizationRef.credential !== undefined) {
        invalid("Agent execution authority cannot carry an external credential.")
      }
      return
    }
    case "kernel": {
      if (
        authorizationRef.type !== "kernel" ||
        !kernelOperationsEqual(authorizationRef.operation, executor.operation)
      ) {
        invalid("Kernel authority must match the executor operation.")
      }
      if (requestedBy !== undefined) {
        invalid("Kernel executions cannot have a requested-by principal.")
      }
      return
    }
  }
}

async function validatePrincipal(
  principal: AuthorizablePrincipal | undefined,
  projectId: string,
  label: string,
  lookup: ExecutionValidationLookup
): Promise<void> {
  if (!principal) return

  const record =
    principal.type === "user"
      ? await lookup.auth.users.getById({ projectId, id: principal.id })
      : await lookup.auth.serviceAccounts.getById({ projectId, id: principal.id })
  if (!record) {
    throw new ExecutionStorageError(
      "missing_principal",
      `[Sixb] ${label} '${principal.id}' does not exist in project '${projectId}'.`
    )
  }
}

async function validateCredential(
  record: ExecutionRecord,
  lookup: ExecutionValidationLookup
): Promise<void> {
  if (record.authorizationRef.type !== "principal" || !record.authorizationRef.credential) return

  const { principal, credential } = record.authorizationRef
  if (credential.type === "session") {
    const session = await lookup.auth.sessions.getById({
      projectId: record.projectId,
      id: credential.id,
    })
    if (!session) {
      throw new ExecutionStorageError(
        "missing_credential",
        `[Sixb] Authority session '${credential.id}' does not exist in project '${record.projectId}'.`
      )
    }
    if (principal.type !== "user" || session.userId !== principal.id) {
      throw new ExecutionStorageError(
        "invalid_credential",
        `[Sixb] Authority session '${credential.id}' does not belong to principal '${principal.id}'.`
      )
    }
    return
  }

  const token = await lookup.auth.accessTokens.getById({
    projectId: record.projectId,
    id: credential.id,
  })
  if (!token) {
    throw new ExecutionStorageError(
      "missing_credential",
      `[Sixb] Authority access token '${credential.id}' does not exist in project '${record.projectId}'.`
    )
  }
  if (token.subjectType !== principal.type || token.subjectId !== principal.id) {
    throw new ExecutionStorageError(
      "invalid_credential",
      `[Sixb] Authority access token '${credential.id}' does not belong to principal '${principal.id}'.`
    )
  }
}

async function validateParent(
  record: ExecutionRecord,
  lookup: ExecutionValidationLookup
): Promise<void> {
  if (record.source.type !== "execution") return
  const parentExecutionId = record.source.executionId

  const parent = await lookup.getExecution({
    projectId: record.projectId,
    id: parentExecutionId,
  })
  if (!parent) {
    throw new ExecutionStorageError(
      "missing_parent_execution",
      `[Sixb] Parent execution '${parentExecutionId}' does not exist in project '${record.projectId}'.`
    )
  }
  if (parent.correlationId !== record.correlationId) {
    throw new ExecutionStorageError(
      "invalid_parent_execution",
      `[Sixb] Child execution '${record.id}' must preserve its parent correlation id.`
    )
  }
  if (!principalsEqual(parent.requestedBy, record.requestedBy)) {
    throw new ExecutionStorageError(
      "invalid_parent_execution",
      `[Sixb] Child execution '${record.id}' must preserve its parent requested-by principal.`
    )
  }
}

function assertPrincipal(principal: AuthorizablePrincipal, label: string): void {
  if (principal.type !== "user" && principal.type !== "serviceAccount") {
    invalid(`${label} has unsupported type '${String((principal as { type?: unknown }).type)}'.`)
  }
  assertNonBlank(principal.id, `${label} id`)
}

function assertKernelOperation(operation: KernelOperation, label: string): void {
  if (operation.type !== "ontology.recover") {
    invalid(`${label} has unsupported type '${String((operation as { type?: unknown }).type)}'.`)
  }
  assertNonBlank(operation.recoveryId, `${label} recovery id`)
}

function assertTrustedPrimitiveKind(value: string, label: string): void {
  if (!TRUSTED_PRIMITIVE_KINDS.has(value)) {
    invalid(`${label} '${value}' is not supported.`)
  }
}

function assertNonBlank(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    invalid(`${label} must be a non-empty string.`)
  }
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    invalid(`${label} must be a valid date.`)
  }
}

function principalsEqual(
  left: AuthorizablePrincipal | undefined,
  right: AuthorizablePrincipal | undefined
): boolean {
  return left?.type === right?.type && left?.id === right?.id
}

function kernelOperationsEqual(left: KernelOperation, right: KernelOperation): boolean {
  return left.type === right.type && left.recoveryId === right.recoveryId
}

function invalid(message: string): never {
  throw new ExecutionStorageError("invalid_input", `[Sixb] ${message}`)
}

const TRUSTED_PRIMITIVE_KINDS = new Set([
  "action",
  "pipeline",
  "projection",
  "rule",
  "sync",
  "webhook",
  "workflow",
])
