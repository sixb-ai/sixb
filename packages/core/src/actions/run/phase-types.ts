import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import type { ActionRunRecord, ObjectRow } from "../../storage"
import type { ActionDefinition, ActionTargetObject } from "../types"
import type { RunActionJobInput } from "./types"

export type LoadedObjectTarget = {
  readonly subjectObjectType: ObjectTypeWithPropertyTokens
  readonly snapshot: ActionTargetObject
  /** The exact row the subject was loaded from, recorded as a commit-time read dependency. */
  readonly row: ObjectRow
}

export type PhaseExecutionBase = {
  readonly runtime: RunActionJobInput["runtime"]
  readonly action: ActionDefinition
  readonly signal: AbortSignal
}

export type RuntimePhaseHandler = (ctx: unknown) => unknown

export type UpdateActiveRun = (run: ActionRunRecord) => void
