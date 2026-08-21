import type {
  AuthorizablePrincipal,
  AuthorizationRef,
  KernelOperation,
  TrustedPrimitiveKind,
} from "../../execution/types"

/** Executor identity stored independently from the primitive definition owned by its run. */
export type DurableExecutionExecutor =
  | { readonly type: "request"; readonly requestId: string }
  | { readonly type: "primitive"; readonly kind: TrustedPrimitiveKind; readonly runId: string }
  | { readonly type: "agent"; readonly runId: string }
  | { readonly type: "kernel"; readonly operation: KernelOperation }

/**
 * Durable trigger provenance. An `execution` source is the single logical parent; queue delivery
 * is attempt transport and is never persisted here.
 */
export type DurableExecutionSource =
  | { readonly type: "http"; readonly requestId: string }
  | { readonly type: "webhook"; readonly deliveryId: string }
  | { readonly type: "schedule"; readonly eventId: string }
  | { readonly type: "event"; readonly eventId: string }
  | { readonly type: "datasetVersion"; readonly datasetId: string; readonly versionId: string }
  | { readonly type: "execution"; readonly executionId: string }

/** Immutable execution provenance and the reference required to restore its runtime authority. */
export interface ExecutionRecord {
  readonly id: string
  readonly projectId: string
  readonly requestedBy?: AuthorizablePrincipal
  readonly executor: DurableExecutionExecutor
  readonly source: DurableExecutionSource
  readonly correlationId: string
  readonly authorizationRef: AuthorizationRef
  readonly createdAt: Date
}

/** Creation input; the storage boundary assigns the immutable creation timestamp. */
export type CreateExecutionInput = Omit<ExecutionRecord, "createdAt">

/** Immutable execution ledger. Records can be created and read, never updated or deleted. */
export interface ExecutionStorage {
  create(input: CreateExecutionInput): Promise<ExecutionRecord>
  getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<ExecutionRecord | null>
}
