import type { Sixb } from "../runtime/sixb"
import type { OntologySource } from "../runtime/types"

// ── Context ──────────────────────────────────────────────────

export interface FunctionMetadata {
  id: string
  trigger: CronTriggerDefinition | IntervalTriggerDefinition
}

export interface FunctionContext {
  sixb: Sixb<readonly OntologySource[]>
  fn: FunctionMetadata
}

// ── Handlers ─────────────────────────────────────────────────

export type CronHandler = (ctx: FunctionContext) => Promise<void> | void

export type IntervalHandler = (ctx: FunctionContext) => Promise<void> | void

// ── Trigger Definitions ──────────────────────────────────────

export interface CronTriggerDefinition {
  type: "cron"
  expression: string
  handler: CronHandler
}

export interface IntervalTriggerDefinition {
  type: "interval"
  intervalMs: number
  handler: IntervalHandler
}

export type TriggerDefinition = CronTriggerDefinition | IntervalTriggerDefinition

// ── Function Definition ──────────────────────────────────────

export interface FunctionDefinition {
  id: string
  trigger: TriggerDefinition
}

// ── Builders ─────────────────────────────────────────────────

export interface CronFunctionBuilder {
  run(handler: CronHandler): FunctionDefinition
}

export interface IntervalFunctionBuilder {
  run(handler: IntervalHandler): FunctionDefinition
}

export interface FunctionBuilder {
  cron(expression: string): CronFunctionBuilder
  interval(ms: number): IntervalFunctionBuilder
}
