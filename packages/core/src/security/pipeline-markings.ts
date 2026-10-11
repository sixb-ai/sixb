import type { DatasetDefinition } from "../datasets/types"
import type {
  LakeStorageWithSql,
  SqlTransformAnalysis,
  SqlTransformColumnRef,
} from "../lake-storage/sql-transforms"
import type { DatasetColumnLineage, DatasetColumnRef, LakeStorage } from "../lake-storage/types"
import { PipelineError } from "../pipelines/errors"
import { stepInputColumns, stepReadColumns } from "../pipelines/lineage"
import type { PipelineStepDefinition } from "../pipelines/types"
import type { SixbDefinitions } from "../runtime/definitions"
import { SecurityValidationError } from "./errors"
import {
  type DatasetMarkings,
  MarkingPropagation,
  type RegisteredStep,
  registeredSteps,
  runStepLineages,
} from "./marking-propagation"
import { describeOrigins, validateProjectionMarkings } from "./projection-markings"

/**
 * Derive the markings SQL steps give their outputs and check every projection against them.
 *
 * Startup cannot see through SQL, so this preflight completes it before a host serves traffic. It
 * is a diagnostic: each version records the lineage of the SQL that actually ran, and reads and
 * projections enforce markings from that record whether or not this ran.
 *
 * Only steps that read a marked column are analyzed, each step once. Analyzing a step can mark
 * the inputs of others, so steps are analyzed in waves, a few at a time within a wave. A step whose
 * SQL cannot be analyzed, or a lake provider that cannot analyze SQL, is reported with the step
 * and a marked column it reads.
 */
export async function checkPipelineMarkings(input: {
  readonly definitions: Pick<SixbDefinitions, "ontology" | "datasets" | "pipelines" | "projections">
  readonly lakeStorage: LakeStorage | LakeStorageWithSql
}): Promise<void> {
  const { definitions, lakeStorage } = input
  const datasetsById = new Map(definitions.datasets.list().map((dataset) => [dataset.id, dataset]))
  const steps = registeredSteps(definitions.pipelines.list())
  const runLineageOf = runStepLineages(datasetsById)
  const analyzed = new Map<PipelineStepDefinition, DatasetColumnLineage>()
  const lineageOf = (entry: RegisteredStep) =>
    runLineageOf(entry) ?? analyzed.get(entry.step) ?? null

  const markings = new MarkingPropagation(datasetsById, steps).derive(lineageOf)
  for (;;) {
    const wave = new Map<PipelineStepDefinition, RegisteredStep>()
    for (const entry of steps) {
      if (entry.step.executor.kind !== "sql" || analyzed.has(entry.step)) continue
      if (stepReadColumns(entry.step).some((ref) => markings.of(ref).size > 0)) {
        if (!wave.has(entry.step)) wave.set(entry.step, entry)
      }
    }
    if (wave.size === 0) break

    await forEachConcurrently([...wave], ANALYSIS_CONCURRENCY, async ([step, entry]) => {
      analyzed.set(step, await analyzeSqlStep(entry, markings, datasetsById, lakeStorage))
    })
    markings.derive(lineageOf)
  }
  validateProjectionMarkings(definitions.projections, definitions.ontology, markings)
}

/** Analyses run at once. A provider may open a database per analysis, so a wave is not unbounded. */
const ANALYSIS_CONCURRENCY = 8

/** Run `task` on each item, `limit` at a time. Stops starting new tasks once one fails. */
async function forEachConcurrently<TItem>(
  items: readonly TItem[],
  limit: number,
  task: (item: TItem) => Promise<void>
): Promise<void> {
  const pending = items.values()
  let failed = false
  const worker = async () => {
    for (const item of pending) {
      if (failed) return
      try {
        await task(item)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

async function analyzeSqlStep(
  entry: RegisteredStep,
  markings: DatasetMarkings,
  datasetsById: ReadonlyMap<string, DatasetDefinition>,
  lakeStorage: LakeStorage | LakeStorageWithSql
): Promise<DatasetColumnLineage> {
  const { step } = entry
  const subject = `[Sixb] Pipeline '${entry.pipelineId}' step '${step.id}'`
  if (step.executor.kind !== "sql") throw new PipelineError(`${subject} is not a SQL step.`)
  const sql = "sql" in lakeStorage ? lakeStorage.sql : undefined
  if (!sql?.analyze) {
    throw new SecurityValidationError(
      `${subject} reads ${describeMarkedRead(step, markings)}, but the lake provider cannot analyze SQL to derive the markings of its output. Use a lake provider that analyzes SQL, or pick only unmarked columns.`
    )
  }

  const inputs = Object.entries(step.inputs)
  let analysis: SqlTransformAnalysis
  try {
    analysis = await sql.analyze({
      sql: step.executor.sql,
      sources: Object.fromEntries(
        inputs.map(([name, dataset]) => [
          name,
          {
            dataset: registeredDataset(datasetsById, dataset.id, subject),
            columns: stepInputColumns(dataset),
          },
        ])
      ),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new PipelineError(`${subject} could not be analyzed: ${reason}`, { cause: error })
  }
  if (!analysis.supported) {
    throw new SecurityValidationError(
      `${subject} reads ${describeMarkedRead(step, markings)}, but its SQL cannot be analyzed: ${analysis.reason}. Rewrite that part of the query, or pick only unmarked columns.`
    )
  }

  const datasetIdBySource = new Map(inputs.map(([name, dataset]) => [name, dataset.id]))
  const toRef = (ref: SqlTransformColumnRef): DatasetColumnRef => {
    const datasetId = datasetIdBySource.get(ref.source)
    if (datasetId === undefined) {
      throw new PipelineError(`${subject} analysis references unknown source '${ref.source}'.`)
    }
    return { datasetId, column: ref.column }
  }
  return {
    rows: analysis.lineage.rows.map(toRef),
    columns: Object.fromEntries(
      Object.entries(analysis.lineage.columns).map(([column, refs]) => [column, refs.map(toRef)])
    ),
  }
}

/** A marked column the step reads, for messages. */
function describeMarkedRead(step: PipelineStepDefinition, markings: DatasetMarkings): string {
  const ref = stepReadColumns(step).find((candidate) => markings.of(candidate).size > 0)
  if (!ref) return "no marked column"
  const path = `${ref.datasetId}.${ref.column}`
  return `column '${path}', which carries ${describeOrigins(markings.of(ref), path)}`
}

function registeredDataset(
  datasetsById: ReadonlyMap<string, DatasetDefinition>,
  datasetId: string,
  subject: string
): DatasetDefinition {
  const dataset = datasetsById.get(datasetId)
  if (!dataset) throw new PipelineError(`${subject} reads unregistered dataset '${datasetId}'.`)
  return dataset
}
