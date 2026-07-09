import type { DatasetDefinition } from "../datasets"
import { isDatasetDefinition } from "../datasets"
import type {
  DatasetRow,
  DatasetVersion,
  DatasetWriteMode,
  ReadDatasetRowsInput,
} from "../lake-storage"
import {
  isSqlDialect,
  type SqlDialect,
  type SqlTransformBody,
} from "../lake-storage/sql-transforms"
import type { Logger } from "../logging"
import type { ScheduleDefinition } from "../schedules"
import type { RunTrigger } from "../triggers"
import { isRunTrigger } from "../triggers"

// ── Step execution ─────────────────────────────────────────

export type PipelineStepExecutor =
  | {
      readonly kind: "sql"
      readonly dialect: SqlDialect
      readonly sql: SqlTransformBody<SqlDialect>
    }
  | {
      readonly kind: "run"
      readonly handler: PipelineStepRunHandler
    }

export interface PipelineStepInput {
  readonly dataset: DatasetDefinition
  readonly version: DatasetVersion
  readRows(input?: Omit<ReadDatasetRowsInput, "datasetId" | "versionId">): AsyncIterable<DatasetRow>
}

export interface PipelineStepOutput {
  writeRows(rows: Iterable<DatasetRow> | AsyncIterable<DatasetRow>): Promise<void>
}

export interface PipelineStepRunContext<
  TInputs extends Record<string, DatasetDefinition> = Record<string, DatasetDefinition>,
> {
  readonly projectId: string
  readonly pipelineId: string
  readonly stepId: string
  readonly runId: string
  readonly signal: AbortSignal
  readonly inputs: { readonly [K in keyof TInputs]: PipelineStepInput }
  readonly output: PipelineStepOutput
  readonly logger: Logger
}

export type PipelineStepRunHandler<
  TInputs extends Record<string, DatasetDefinition> = Record<string, DatasetDefinition>,
> = (ctx: PipelineStepRunContext<TInputs>) => Promise<void> | void

// ── Step definition ────────────────────────────────────────

export interface PipelineStepDefinition<
  TId extends string = string,
  TInputs extends Record<string, DatasetDefinition> = Record<string, DatasetDefinition>,
> {
  readonly kind: "pipeline.step"
  readonly id: TId
  readonly inputs: Readonly<TInputs>
  readonly output: DatasetDefinition
  readonly mode: DatasetWriteMode
  readonly executor: PipelineStepExecutor
}

// ── Pipeline definition ────────────────────────────────────

export interface PipelineStepNode {
  readonly kind: "step"
  readonly step: PipelineStepDefinition
}

export interface PipelineSequenceGraph {
  readonly kind: "sequence"
  readonly nodes: readonly PipelineStepNode[]
}

export type PipelineGraph = PipelineSequenceGraph

/**
 * Inert pipeline definition registered with Sixb.
 *
 * V1 executes a single sequential graph. The graph shape leaves room for
 * parallel nodes later without changing step definitions.
 */
export interface PipelineDefinition<TId extends string = string> {
  readonly kind: "pipeline"
  readonly id: TId
  readonly triggers: readonly RunTrigger[]
  readonly graph: PipelineGraph
}

// ── Builder interfaces ─────────────────────────────────────

export interface PipelineStepInputBuilder<TId extends string = string> {
  inputs<TInputs extends Record<string, DatasetDefinition>>(
    inputs: TInputs
  ): PipelineStepOutputBuilder<TId, TInputs>
}

export interface PipelineStepOutputBuilder<
  TId extends string = string,
  TInputs extends Record<string, DatasetDefinition> = Record<string, DatasetDefinition>,
> {
  output(
    dataset: DatasetDefinition,
    options?: PipelineStepOutputOptions
  ): PipelineStepExecutorBuilder<TId, TInputs>
}

export interface PipelineStepExecutorBuilder<
  TId extends string = string,
  TInputs extends Record<string, DatasetDefinition> = Record<string, DatasetDefinition>,
> {
  run(handler: PipelineStepRunHandler<TInputs>): PipelineStepDefinition<TId, TInputs>
  sql(sql: SqlTransformBody<SqlDialect>): PipelineStepDefinition<TId, TInputs>
}

export interface PipelineStepOutputOptions {
  readonly mode?: DatasetWriteMode
}

export interface PipelineBuilder<TId extends string = string> extends PipelineDefinition<TId> {
  when(trigger: ScheduleDefinition | RunTrigger): PipelineBuilder<TId>
  then(step: PipelineStepDefinition): PipelineBuilder<TId>
}

// ── Type guards ────────────────────────────────────────────

/** Runtime type guard for values discovered from `pipelines/` modules. */
export function isPipelineDefinition(value: unknown): value is PipelineDefinition {
  if (!isRecord(value)) return false
  return (
    value.kind === "pipeline" &&
    typeof value.id === "string" &&
    Array.isArray(value.triggers) &&
    value.triggers.every(isRunTrigger) &&
    isPipelineGraph(value.graph)
  )
}

export function isPipelineStepDefinition(value: unknown): value is PipelineStepDefinition {
  return (
    isRecord(value) &&
    value.kind === "pipeline.step" &&
    typeof value.id === "string" &&
    isInputsRecord(value.inputs) &&
    isDatasetDefinition(value.output) &&
    isDatasetWriteMode(value.mode) &&
    isPipelineStepExecutor(value.executor)
  )
}

function isPipelineGraph(value: unknown): value is PipelineGraph {
  return (
    isRecord(value) &&
    value.kind === "sequence" &&
    Array.isArray(value.nodes) &&
    value.nodes.every(
      (node) => isRecord(node) && node.kind === "step" && isPipelineStepDefinition(node.step)
    )
  )
}

function isPipelineStepExecutor(value: unknown): value is PipelineStepExecutor {
  if (!isRecord(value)) return false

  switch (value.kind) {
    case "sql":
      return isSqlDialect(value.dialect) && typeof value.sql === "function"
    case "run":
      return typeof value.handler === "function"
    default:
      return false
  }
}

function isInputsRecord(value: unknown): value is Readonly<Record<string, DatasetDefinition>> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, dataset]) => key.trim().length > 0 && isDatasetDefinition(dataset)
    )
  )
}

function isDatasetWriteMode(value: unknown): value is DatasetWriteMode {
  return value === "snapshot" || value === "append"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
