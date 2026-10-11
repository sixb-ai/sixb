import type { DatasetDefinition } from "../datasets/types"
import { lineageColumn } from "../lake-storage/lineage"
import type { DatasetColumnLineage, DatasetColumnRef } from "../lake-storage/types"
import { runStepLineage, stepReadColumns } from "../pipelines/lineage"
import type { PipelineDefinition, PipelineStepDefinition } from "../pipelines/types"

/** A step of a registered pipeline. A step reused by two pipelines is two registered steps. */
export interface RegisteredStep {
  readonly pipelineId: string
  readonly step: PipelineStepDefinition
}

/** The column that declares a marking, and the steps it went through to reach a column. */
export interface MarkingOrigin {
  readonly column: DatasetColumnRef
  /** `pipeline/step`, upstream first. Empty when the column declares the marking itself. */
  readonly steps: readonly string[]
}

/** Each marking a column carries, with one path it arrived by. */
export type ColumnMarkingOrigins = ReadonlyMap<string, MarkingOrigin>

/** Markings of every column of every registered dataset, derived from the definitions. */
export interface DatasetMarkings {
  /** Empty for a column without markings or that is not registered. */
  of(column: DatasetColumnRef): ColumnMarkingOrigins
}

export function registeredSteps(
  pipelines: readonly PipelineDefinition[]
): readonly RegisteredStep[] {
  return pipelines.flatMap((pipeline) =>
    pipeline.graph.nodes.map(({ step }) => ({ pipelineId: pipeline.id, step }))
  )
}

/** Lineage of each `run` step, built once per step object; undefined for other steps. */
export function runStepLineages(
  datasetsById: ReadonlyMap<string, DatasetDefinition>
): (entry: RegisteredStep) => DatasetColumnLineage | undefined {
  const lineages = new Map<PipelineStepDefinition, DatasetColumnLineage>()

  return ({ step }) => {
    if (step.executor.kind !== "run") return undefined

    let lineage = lineages.get(step)
    if (!lineage) {
      lineage = runStepLineage(step, datasetsById)
      lineages.set(step, lineage)
    }

    return lineage
  }
}

export function stepLabel(entry: RegisteredStep): string {
  return `${entry.pipelineId}/${entry.step.id}`
}

type MutableOrigins = Map<string, MarkingOrigin>

const NO_MARKINGS: ColumnMarkingOrigins = new Map()

interface KnownLineage {
  readonly lineage: DatasetColumnLineage
  /** What a column the lineage does not list depends on. */
  readonly reads: readonly DatasetColumnRef[]
}

/**
 * Markings each column carries according to the registered definitions: the ones it declares, and
 * the ones each step derives from the columns it depends on, once that step's lineage is known.
 *
 * What decided the rows of a step's inputs decides the rows of its output, whether or not the step
 * reads a column of that input: `SELECT count(*) FROM rich` reveals which rows `rich` holds. So
 * each dataset also keeps the markings of its row dependencies, and every output column of a step
 * carries those of every input it reads, as the lineage each version records does.
 *
 * A step may read its own output and a dataset may have several producers, so a step whose output
 * gains a marking queues the steps that read that output, until nothing changes. Lineage can be
 * added in rounds: each round only revisits what the new lineage reaches.
 */
export class MarkingPropagation implements DatasetMarkings {
  private readonly datasetsById: ReadonlyMap<string, DatasetDefinition>
  /** Marked columns only, by dataset, built when a dataset is first looked at. */
  private readonly markings = new Map<string, Map<string, MutableOrigins>>()
  /** Markings of what decides each dataset's rows, for datasets a step writes. */
  private readonly rowMarkings = new Map<string, MutableOrigins>()
  private readonly ordered: readonly RegisteredStep[]
  private readonly readers = new Map<string, RegisteredStep[]>()
  private readonly known = new Map<RegisteredStep, KnownLineage>()
  private readonly queue = new Set<RegisteredStep>()

  constructor(
    datasetsById: ReadonlyMap<string, DatasetDefinition>,
    steps: readonly RegisteredStep[]
  ) {
    this.datasetsById = datasetsById
    this.ordered = inDependencyOrder(steps)

    for (const entry of steps) {
      for (const input of new Set(Object.values(entry.step.inputs).map((dataset) => dataset.id))) {
        appendTo(this.readers, input, entry)
      }
    }
  }

  of(ref: DatasetColumnRef): ColumnMarkingOrigins {
    return this.markedColumns(ref.datasetId).get(ref.column) ?? NO_MARKINGS
  }

  /**
   * Derive markings through every step `lineageOf` knows the lineage of. A step it returns null
   * for derives nothing until a later call knows it.
   */
  derive(lineageOf: (entry: RegisteredStep) => DatasetColumnLineage | null): this {
    for (const entry of this.ordered) {
      if (this.known.has(entry)) continue

      const lineage = lineageOf(entry)
      if (!lineage) continue

      this.known.set(entry, { lineage, reads: stepReadColumns(entry.step) })
      this.queue.add(entry)
    }

    for (const entry of this.queue) {
      this.queue.delete(entry)
      const known = this.known.get(entry)
      if (!known || !this.apply(entry, known)) continue

      // Entries added while iterating a Set are visited, so the queue drains in this loop.
      for (const reader of this.readers.get(entry.step.output.id) ?? []) {
        if (this.known.has(reader)) this.queue.add(reader)
      }
    }

    return this
  }

  /** Whether the output's rows or any output column gained a marking. */
  private apply(entry: RegisteredStep, { lineage, reads }: KnownLineage): boolean {
    const label = stepLabel(entry)
    const rows = this.union(lineage.rows)

    for (const input of new Set(Object.values(entry.step.inputs).map((dataset) => dataset.id))) {
      for (const [markingId, origin] of this.rowMarkings.get(input) ?? []) {
        if (!rows.has(markingId)) rows.set(markingId, origin)
      }
    }

    let everyRead: ReadonlyMap<string, MarkingOrigin> | undefined
    let changed = false

    const outputId = entry.step.output.id
    let outputRows = this.rowMarkings.get(outputId)

    for (const [markingId, origin] of rows) {
      if (outputRows?.has(markingId)) continue
      if (!outputRows) {
        outputRows = new Map()
        this.rowMarkings.set(outputId, outputRows)
      }

      outputRows.set(markingId, { column: origin.column, steps: [...origin.steps, label] })
      changed = true
    }

    const marked = this.markedColumns(outputId)
    for (const { name: column } of this.datasetsById.get(outputId)?.schema.columns ?? []) {
      const values = lineageColumn(lineage, column)
      const valueSource = values ? this.union(values) : (everyRead ?? this.union(reads))
      if (!values) everyRead = valueSource

      for (const source of [rows, valueSource]) {
        for (const [markingId, origin] of source) {
          let origins = marked.get(column)
          if (origins?.has(markingId)) continue
          if (!origins) {
            origins = new Map()
            marked.set(column, origins)
          }

          origins.set(markingId, { column: origin.column, steps: [...origin.steps, label] })
          changed = true
        }
      }
    }

    return changed
  }

  private markedColumns(datasetId: string): Map<string, MutableOrigins> {
    let columns = this.markings.get(datasetId)
    if (!columns) {
      columns = new Map()
      for (const column of this.datasetsById.get(datasetId)?.schema.columns ?? []) {
        if (!column.markings?.length) continue

        const origin = { column: { datasetId, column: column.name }, steps: [] }
        columns.set(column.name, new Map(column.markings.map((id) => [id, origin])))
      }

      this.markings.set(datasetId, columns)
    }

    return columns
  }

  /** Every marking of these columns, each with the first origin found. */
  private union(columns: readonly DatasetColumnRef[]): MutableOrigins {
    const union: MutableOrigins = new Map()
    for (const column of columns) {
      for (const [markingId, origin] of this.of(column)) {
        if (!union.has(markingId)) union.set(markingId, origin)
      }
    }
    return union
  }
}

/** Producers before consumers, so most markings arrive by their shortest path. */
function inDependencyOrder(steps: readonly RegisteredStep[]): readonly RegisteredStep[] {
  const producers = producersByDataset(steps)
  const ordered: RegisteredStep[] = []
  const visited = new Set<RegisteredStep>()

  const visit = (entry: RegisteredStep): void => {
    if (visited.has(entry)) return

    visited.add(entry)
    for (const input of Object.values(entry.step.inputs)) {
      for (const producer of producers.get(input.id) ?? []) visit(producer)
    }

    ordered.push(entry)
  }

  for (const entry of steps) visit(entry)
  return ordered
}

function producersByDataset(
  steps: readonly RegisteredStep[]
): ReadonlyMap<string, readonly RegisteredStep[]> {
  const producers = new Map<string, RegisteredStep[]>()
  for (const entry of steps) appendTo(producers, entry.step.output.id, entry)
  return producers
}

function appendTo<TValue>(map: Map<string, TValue[]>, key: string, value: TValue): void {
  const values = map.get(key)
  if (values) values.push(value)
  else map.set(key, [value])
}
