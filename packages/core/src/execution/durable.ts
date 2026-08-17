import { isDeepStrictEqual } from "node:util"
import {
  type CreateExecutionInput,
  type ExecutionRecord,
  type ExecutionStorage,
  ExecutionStorageError,
} from "../storage/executions"
import { createTrustedPrimitiveRuntimeAuthorization, getAuthorizationRef } from "./authorization"
import type {
  ExecutionContext,
  ExecutionScope,
  RuntimeAuthorization,
  TrustedPrimitiveRef,
} from "./types"

/** Convert one currently bound execution to the immutable provider representation. */
export function executionRecordInputFromRuntime(input: {
  readonly execution: ExecutionContext
  readonly runtimeAuthorization: RuntimeAuthorization
}): CreateExecutionInput {
  const execution = input.execution
  return {
    id: execution.id,
    projectId: execution.projectId,
    ...(execution.requestedBy === undefined
      ? {}
      : { requestedBy: structuredClone(execution.requestedBy) }),
    executor: durableExecutor(execution),
    source: durableSource(execution),
    correlationId: execution.correlationId,
    authorizationRef: getAuthorizationRef(input.runtimeAuthorization),
  }
}

/**
 * Store a caller execution once. Repeated boundaries may observe the same immutable execution;
 * only an exact match is idempotent.
 */
export async function ensureExecutionRecord(
  storage: ExecutionStorage,
  input: CreateExecutionInput
): Promise<ExecutionRecord> {
  const existing = await storage.getById({ projectId: input.projectId, id: input.id })
  if (existing) {
    assertExecutionRecordMatches(existing, input)
    return existing
  }

  try {
    return await storage.create(input)
  } catch (error) {
    if (!(error instanceof ExecutionStorageError) || error.code !== "duplicate_execution") {
      throw error
    }

    const raced = await storage.getById({ projectId: input.projectId, id: input.id })
    if (!raced) throw error
    assertExecutionRecordMatches(raced, input)
    return raced
  }
}

type PrimitiveExecutionOrigin =
  | {
      readonly type: "execution"
      readonly parent: ExecutionRecord
    }
  | {
      readonly type: "automatic"
      readonly projectId: string
      readonly source: Extract<
        CreateExecutionInput["source"],
        { readonly type: "schedule" | "event" | "datasetVersion" | "webhook" }
      >
      readonly correlationId: string
      readonly requestedBy?: CreateExecutionInput["requestedBy"]
    }

/** Build an immutable primitive execution from its parent execution or automatic trigger. */
export function createPrimitiveExecutionRecord(input: {
  readonly id: string
  readonly primitive: TrustedPrimitiveRef
  readonly origin: PrimitiveExecutionOrigin
}): CreateExecutionInput {
  const provenance =
    input.origin.type === "execution"
      ? {
          projectId: input.origin.parent.projectId,
          ...(input.origin.parent.requestedBy === undefined
            ? {}
            : { requestedBy: structuredClone(input.origin.parent.requestedBy) }),
          source: { type: "execution" as const, executionId: input.origin.parent.id },
          correlationId: input.origin.parent.correlationId,
        }
      : {
          projectId: input.origin.projectId,
          ...(input.origin.requestedBy === undefined
            ? {}
            : { requestedBy: structuredClone(input.origin.requestedBy) }),
          source: structuredClone(input.origin.source),
          correlationId: input.origin.correlationId,
        }

  return {
    id: input.id,
    ...provenance,
    executor: {
      type: "primitive",
      kind: input.primitive.kind,
      runId: input.primitive.runId,
    },
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: structuredClone(input.primitive),
    },
  }
}

/** Restore the trusted scope of a provider-validated primitive execution record. */
export function restoreTrustedPrimitiveExecutionScope(input: {
  readonly execution: ExecutionRecord
  readonly primitive: TrustedPrimitiveRef
}): ExecutionScope {
  assertPrimitiveExecution(input.execution, input.primitive)
  const context: ExecutionContext = Object.freeze({
    id: input.execution.id,
    projectId: input.execution.projectId,
    ...(input.execution.requestedBy === undefined
      ? {}
      : { requestedBy: structuredClone(input.execution.requestedBy) }),
    executor: Object.freeze({ type: "primitive", ...structuredClone(input.primitive) }),
    source: Object.freeze(structuredClone(input.execution.source)),
    correlationId: input.execution.correlationId,
  })
  return Object.freeze({
    execution: context,
    authorization: createTrustedPrimitiveRuntimeAuthorization({
      projectId: input.execution.projectId,
      primitive: input.primitive,
    }),
  })
}

function durableExecutor(execution: ExecutionContext): CreateExecutionInput["executor"] {
  switch (execution.executor.type) {
    case "request":
      return { type: "request", requestId: execution.executor.requestId }
    case "primitive":
      return {
        type: "primitive",
        kind: execution.executor.kind,
        runId: execution.executor.runId,
      }
    case "agent":
      return { type: "agent", runId: execution.executor.runId }
    case "kernel":
      return { type: "kernel", operation: structuredClone(execution.executor.operation) }
  }
}

function durableSource(execution: ExecutionContext): CreateExecutionInput["source"] {
  if (execution.source.type === "queue") {
    throw new ExecutionStorageError(
      "invalid_input",
      `[Sixb] Execution '${execution.id}' has a transient queue source and cannot be persisted.`
    )
  }
  return structuredClone(execution.source)
}

function assertExecutionRecordMatches(
  existing: ExecutionRecord,
  input: CreateExecutionInput
): void {
  const { createdAt: _createdAt, ...stored } = existing
  if (!isDeepStrictEqual(stored, input)) {
    throw new ExecutionStorageError(
      "duplicate_execution",
      `[Sixb] Execution '${input.id}' already exists with different immutable provenance.`
    )
  }
}

function assertPrimitiveExecution(
  execution: ExecutionRecord,
  primitive: TrustedPrimitiveRef
): void {
  const authority = execution.authorizationRef
  if (
    execution.executor.type !== "primitive" ||
    execution.executor.kind !== primitive.kind ||
    execution.executor.runId !== primitive.runId ||
    authority.type !== "trustedPrimitive" ||
    authority.primitive.kind !== primitive.kind ||
    authority.primitive.id !== primitive.id ||
    authority.primitive.runId !== primitive.runId
  ) {
    throw new ExecutionStorageError(
      "invalid_input",
      `[Sixb] Execution '${execution.id}' does not authorize ${primitive.kind} run '${primitive.runId}'.`
    )
  }
}
