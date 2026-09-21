import type { SixbFailure } from "../../errors/types"
import type { OntologyObjectRef } from "../../materialization/model"
import type { MaterializationSession } from "./materializations"

export const VECTOR_INDEXING_FAILURE_CODES = [
  "vector.model_unavailable",
  "vector.response_invalid",
  "vector.outcome_unknown",
  "internal.unexpected",
] as const

export type VectorIndexingFailureCode = (typeof VECTOR_INDEXING_FAILURE_CODES)[number]

/** Latest desired representation; replacing its id fences every older delivery. */
export interface VectorIndexingRequest {
  readonly id: string
  readonly ref: OntologyObjectRef
  readonly profile: string
  readonly configuration: string
  readonly sourceFingerprint: string
  readonly sourceCommitId: string
}

export interface VectorIndexingWork extends VectorIndexingRequest {
  readonly status: "pending" | "running" | "ready" | "failed"
  readonly availableAt: string
  readonly values?: readonly number[]
  readonly error?: SixbFailure<VectorIndexingFailureCode>
}

/** Durable intent belongs to ontology storage; delivery leases belong to Queues. */
export interface OntologyVectorIndexingStorage {
  /** Called inside the transaction that changes the effective object. */
  schedule(input: {
    projectId: string
    session: MaterializationSession
    requests: readonly VectorIndexingRequest[]
    deleted: readonly OntologyObjectRef[]
    availableAt: string
  }): Promise<void>
  /** Clear matching intent atomically with a successful automatic or explicit vector write. */
  complete(input: {
    projectId: string
    session: MaterializationSession
    ref: OntologyObjectRef
    profile: string
    configuration: string
    sourceFingerprint: string
  }): Promise<void>
  dispatched(input: {
    projectId: string
    ids: readonly string[]
    nextDispatchAt: string
  }): Promise<void>
  get(input: { projectId: string; id: string }): Promise<VectorIndexingWork | null>
  /** Bounded fair redispatch scan. Never scans objects or backfills existing data. */
  listDue(input: {
    projectId: string
    now: string
    limit: number
  }): Promise<readonly VectorIndexingWork[]>
  /** CAS also fences concurrent deliveries and source changes. */
  update(input: {
    projectId: string
    id: string
    expectedStatus: VectorIndexingWork["status"]
    status: VectorIndexingWork["status"]
    availableAt: string
    values?: readonly number[]
    error?: SixbFailure<VectorIndexingFailureCode>
  }): Promise<boolean>
  remove(input: { projectId: string; id: string }): Promise<void>
}
