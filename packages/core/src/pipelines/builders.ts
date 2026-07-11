import type { DatasetDefinition } from "../datasets"
import type { DatasetWriteMode } from "../lake-storage"
import { SQL_DIALECT } from "../lake-storage/sql-transforms"
import type { ScheduleDefinition, ScheduleReference } from "../schedules"
import { isScheduleDefinition } from "../schedules"
import { PipelineError } from "./errors"
import type {
  PipelineBuilder,
  PipelineDefinition,
  PipelineGraph,
  PipelineStepDefinition,
  PipelineStepExecutorBuilder,
  PipelineStepInputBuilder,
  PipelineStepOutputBuilder,
  PipelineStepOutputOptions,
  PipelineStepRunHandler,
} from "./types"

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new PipelineError(`Pipeline ${field} must not be empty.`)
  }
}

function assertDataset(dataset: DatasetDefinition, field: string): void {
  assertNonEmpty(dataset.id, field)
}

function assertDatasetWriteMode(mode: DatasetWriteMode): void {
  if (mode !== "snapshot" && mode !== "append") {
    throw new PipelineError(`Pipeline step output mode '${mode}' is not supported.`)
  }
}

function assertInputs(inputs: Readonly<Record<string, DatasetDefinition>>): void {
  const entries = Object.entries(inputs)
  if (entries.length === 0) {
    throw new PipelineError("Pipeline step input dataset must contain at least one entry.")
  }

  for (const [name, dataset] of entries) {
    assertNonEmpty(name, "step input name")
    assertDataset(dataset, "step input dataset")
  }
}

function scheduleReference(schedule: ScheduleDefinition): ScheduleReference {
  if (!isScheduleDefinition(schedule)) {
    throw new PipelineError("Pipeline .when(...) only accepts schedules.")
  }
  return { type: "schedule", scheduleId: schedule.id }
}

function createPipelineBuilder<TId extends string>(
  definition: PipelineDefinition<TId>
): PipelineBuilder<TId> {
  return {
    ...definition,
    when(schedule: ScheduleDefinition): PipelineBuilder<TId> {
      return createPipelineBuilder({
        ...definition,
        triggers: [...definition.triggers, scheduleReference(schedule)],
      })
    },
    // biome-ignore lint/suspicious/noThenProperty: Pipeline composition intentionally uses `.then(step)`.
    then(step: PipelineStepDefinition): PipelineBuilder<TId> {
      const graph: PipelineGraph = {
        kind: "sequence",
        nodes: [...definition.graph.nodes, { kind: "step", step }],
      }

      return createPipelineBuilder({
        ...definition,
        graph,
      })
    },
  }
}

/**
 * Define one dataset transform step.
 *
 * The returned definition is inert until referenced by a pipeline definition.
 */
export function definePipelineStep<TId extends string>(id: TId): PipelineStepInputBuilder<TId> {
  assertNonEmpty(id, "step id")

  return {
    inputs<TInputs extends Record<string, DatasetDefinition>>(
      inputs: TInputs
    ): PipelineStepOutputBuilder<TId, TInputs> {
      assertInputs(inputs)

      return {
        output(
          dataset: DatasetDefinition,
          options: PipelineStepOutputOptions = {}
        ): PipelineStepExecutorBuilder<TId, TInputs> {
          assertDataset(dataset, "step output dataset")
          const mode = options.mode ?? "snapshot"
          assertDatasetWriteMode(mode)

          return {
            run(handler): PipelineStepDefinition<TId, TInputs> {
              return {
                kind: "pipeline.step",
                id,
                inputs,
                output: dataset,
                mode,
                executor: {
                  kind: "run",
                  handler: handler as unknown as PipelineStepRunHandler,
                },
              }
            },
            sql(sql): PipelineStepDefinition<TId, TInputs> {
              return {
                kind: "pipeline.step",
                id,
                inputs,
                output: dataset,
                mode,
                executor: {
                  kind: "sql",
                  dialect: SQL_DIALECT.duckdb,
                  sql,
                },
              }
            },
          }
        },
      }
    },
  }
}

/**
 * Define a sequential pipeline that composes dataset transform steps.
 *
 * The returned definition is inert and safe to export from `pipelines/` modules.
 */
export function definePipeline<TId extends string>(id: TId): PipelineBuilder<TId> {
  assertNonEmpty(id, "id")

  return createPipelineBuilder({
    kind: "pipeline",
    id,
    triggers: [],
    graph: {
      kind: "sequence",
      nodes: [],
    },
  })
}
