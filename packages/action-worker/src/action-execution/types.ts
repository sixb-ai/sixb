import type {
  ActionDefinition,
  ActionRunRecord,
  ActionTargetObject,
  ObjectTypeWithPropertyTokens,
} from "@sixb/core"
import type { RunActionJobInput } from "../types"

export type LoadedObjectTarget = {
  readonly subjectObjectType: ObjectTypeWithPropertyTokens
  readonly snapshot: ActionTargetObject
}

export type PhaseExecutionBase = {
  readonly runtime: RunActionJobInput["runtime"]
  readonly action: ActionDefinition
  readonly signal: AbortSignal
}

export type RuntimePhaseHandler = (ctx: unknown) => unknown

export type UpdateActiveRun = (run: ActionRunRecord) => void
