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
  | { readonly type: "ontologyCommit"; readonly commitId: string }
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
  /** Requester memberships at admission, independent of current execution authority. */
  readonly requesterGroupIds: readonly string[]
  readonly executor: DurableExecutionExecutor
  readonly source: DurableExecutionSource
  readonly correlationId: string
  readonly authorizationRef: AuthorizationRef
  readonly createdAt: Date
}

/** Storage captures root memberships or inherits the parent's snapshot when omitted. */
export type CreateExecutionInput = Omit<ExecutionRecord, "createdAt" | "requesterGroupIds"> & {
  readonly requesterGroupIds?: readonly string[]
}

/**
 * The verified session a root execution came through: a signed-in user's `SessionRecord`, held as
 * its authority credential, or a shared link's session, held by its delegation.
 */
export type ExecutionSessionRef =
  | { readonly type: "user"; readonly id: string }
  | { readonly type: "share"; readonly id: string }

export interface ListSessionExecutionsInput {
  readonly projectId: string
  readonly session: ExecutionSessionRef
  /** Roots, executions without a parent, created in `[from, to)`. */
  readonly from: Date
  readonly to: Date
  /** Roots and descendants together. */
  readonly limit: number
}

export interface SessionExecutions {
  /** The roots and every descendant, whenever it was created, ordered by `createdAt` then id. */
  readonly executions: readonly ExecutionRecord[]
  /**
   * More than `limit` were found. Roots are kept before descendants, the earliest first; which
   * descendants are left out is otherwise unspecified.
   */
  readonly truncated: boolean
}

export interface ListExecutionDescendantsInput {
  readonly projectId: string
  readonly executionIds: readonly string[]
}

/** An execution below the ones asked about, and the execution that caused it. */
export interface ExecutionDescendant {
  readonly id: string
  readonly parentId: string
}

/** Immutable execution ledger. Records can be created and read, never updated or deleted. */
export interface ExecutionStorage {
  create(input: CreateExecutionInput): Promise<ExecutionRecord>
  getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<ExecutionRecord | null>
  /** What one session started: its roots in a window, and what they caused through `source`. */
  listBySession(input: ListSessionExecutionsInput): Promise<SessionExecutions>
  /**
   * Everything these executions caused through `source`, at any depth, each once and without the
   * executions asked about, ordered by id. Unbounded, as a sum over the tree needs all of it, so
   * each is only its id and its parent's.
   */
  listDescendants(input: ListExecutionDescendantsInput): Promise<readonly ExecutionDescendant[]>
}
