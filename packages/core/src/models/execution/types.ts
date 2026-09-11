import type {
  AiCostStorage,
  AiLimitStorage,
  AiUsageStorage,
  RecordAiModelCallInput,
  Storage,
} from "../../storage"
import type { ModelRoute } from "../events"
import type { ModelCallCost, ModelCostEstimate } from "../pricing"

/** Only the stores and transaction boundary needed by model-call accounting. */
export interface ModelCallAccountingStorage extends Pick<Storage, "transaction"> {
  readonly aiUsage: AiUsageStorage
  readonly aiCosts: AiCostStorage
  readonly aiLimits: AiLimitStorage
}

export interface RecoverAiModelCallInput {
  readonly usage: RecordAiModelCallInput
  readonly cost: ModelCallCost
  readonly estimate?: ModelCostEstimate
  readonly route?: ModelRoute
  readonly ratedAt: Date
  /** True only when admission created an aggregate-budget reservation for this provider attempt. */
  readonly reconcileLimitReservation?: boolean
}

export type RecoverAiModelCall = (input: RecoverAiModelCallInput) => Promise<void>

/** JSON-safe ledger input shared by durable recovery transports. */
export type AiModelCallRecordPayload = Omit<
  RecordAiModelCallInput,
  "projectId" | "usage" | "occurredAt" | "recordedAt"
> & {
  readonly usage: {
    readonly [Field in keyof RecordAiModelCallInput["usage"]]: RecordAiModelCallInput["usage"][Field]
  }
  readonly occurredAt: string
}

export interface AiModelCallAccountingPayload {
  readonly estimate?: ModelCostEstimate
  readonly cost: ModelCallCost
  readonly route?: ModelRoute
  readonly ratedAt: string
  /** Absent on pre-limit jobs; those model calls did not create a reservation. */
  readonly reconcileLimitReservation?: boolean
}

/** Transport identity is used only for recovery diagnostics, not accounting identity. */
export interface AiModelCallRecoveryRecord {
  readonly id: string
  readonly projectId: string
  readonly payload: {
    readonly record: AiModelCallRecordPayload
    /** Absent only on legacy jobs that predate atomic valuation recovery. */
    readonly accounting?: AiModelCallAccountingPayload
  }
}
