import { parseArgs } from "node:util"
import {
  col,
  type DatasetDefinition,
  defineDataset,
  defineObjectType,
  defineProjection,
  OntologyRegistry,
  prop,
  type Storage,
} from "@sixb/core"
import {
  createOntologyMaterializer,
  ProjectionRegistry,
  type ProjectionSourceEntry,
} from "@sixb/core/internal/materializer"
import type { OntologySourceStorage } from "@sixb/core/storage"
import { type BenchmarkBackend, type BenchmarkProvider, createBenchmarkBackend } from "./providers"

const PROJECT_ID = "ontology-materialization-benchmark"
const DEFAULT_ROWS = 1_000_000

const BenchmarkItem = defineObjectType({
  id: "BenchmarkItem",
  name: "Benchmark item",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("label", "string", { required: true }),
  ],
})

const benchmarkDataset = defineDataset("benchmark-items", {
  schema: [col("id", "string"), col("label", "string")],
})

const benchmarkProjection = defineProjection("benchmark-items", BenchmarkItem)
  .fromDataset(benchmarkDataset)
  .properties({ id: "id", label: "label" })

interface BenchmarkConfig {
  readonly provider: BenchmarkProvider
  readonly rows: number
}

async function main(): Promise<void> {
  const config = readConfig()
  const backend = await createBenchmarkBackend(config.provider)
  try {
    const result = await runBenchmark(backend, config.rows)
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await backend.close()
  }
}

async function runBenchmark(backend: BenchmarkBackend, rows: number) {
  const ontology = new OntologyRegistry({ sources: [BenchmarkItem] })
  const projections = new ProjectionRegistry({
    projections: [benchmarkProjection],
    ontology,
    datasetsById: new Map<string, DatasetDefinition>([[benchmarkDataset.id, benchmarkDataset]]),
  })
  const datasetVersion = {
    datasetId: benchmarkDataset.id,
    versionId: `benchmark-${rows}`,
    createdAt: new Date().toISOString(),
  }
  const resolved = projections.resolveSource(benchmarkProjection.id)
  const claim = await requireProjectionRuns(backend.storage).startOrReclaim({
    id: `benchmark-${crypto.randomUUID()}`,
    projectId: PROJECT_ID,
    identity: {
      projectionId: resolved.projectionId,
      projectionKind: "object",
      protocol: "replacement",
      datasetVersion,
      ontologyRevision: projections.ontologyRevision,
      projectionRevision: resolved.projectionRevision,
      ownershipHash: resolved.ownershipHash,
    },
    target: { objectTypeId: BenchmarkItem.id },
  })

  let stagingCompletedAt: number | undefined
  let finalizationStartedAt: number | undefined
  const writerProbe = createCompetingWriterProbe(backend.storage)
  const storage = observeMaterialization(backend.storage, {
    onStagingCompleted() {
      stagingCompletedAt ??= performance.now()
    },
    onFinalizationStarted() {
      finalizationStartedAt ??= performance.now()
      writerProbe.start()
    },
  })
  const materializer = createOntologyMaterializer({
    projectId: PROJECT_ID,
    ontology,
    projections,
    storage,
  })
  const before = await backend.snapshot()
  const memory = startPeakRssMonitor()
  const startedAt = performance.now()

  try {
    const commit = await materializer.projections.replace({
      source: { projectionId: benchmarkProjection.id },
      datasetVersion,
      execution: claim.execution,
      entries: projectionEntries(rows),
    })
    const replacementCompletedAt = performance.now()
    await materializer.projections.finishRun({
      protocol: "replacement",
      source: { projectionId: benchmarkProjection.id },
      datasetVersion,
      execution: claim.execution,
      status: "succeeded",
    })
    const completedAt = performance.now()
    const writer = await writerProbe.stop()
    const peakRssBytes = memory.stop()
    const after = await backend.snapshot()
    const persisted = await backend.storage.objects.list({
      projectId: PROJECT_ID,
      objectTypeId: BenchmarkItem.id,
      limit: 1,
    })
    if (persisted.total !== rows) {
      throw new Error(`Expected ${rows} effective objects, found ${persisted.total}.`)
    }
    if (stagingCompletedAt === undefined) {
      throw new Error("Projection candidate never reached ready state.")
    }
    if (finalizationStartedAt === undefined) {
      throw new Error("Projection replacement never entered its final transaction.")
    }

    return {
      provider: backend.provider,
      rows,
      counts: commit.counts,
      timingsMs: {
        staging: round(stagingCompletedAt - startedAt),
        finalizationQueueWait: round(finalizationStartedAt - stagingCompletedAt),
        semanticFinalization: round(replacementCompletedAt - finalizationStartedAt),
        runFinalization: round(completedAt - replacementCompletedAt),
        total: round(completedAt - startedAt),
      },
      peakRssBytes,
      storage: {
        databaseGrowthBytes: after.databaseBytes - before.databaseBytes,
        walGrowthBytes: await backend.walGrowth(before, after),
      },
      competingWriter: writer,
      verifiedEffectiveObjects: persisted.total,
    }
  } catch (error) {
    await writerProbe.cancel()
    memory.stop()
    throw error
  }
}

function observeMaterialization(
  storage: Storage,
  observer: {
    readonly onStagingCompleted: () => void
    readonly onFinalizationStarted: () => void
  }
): Storage {
  const markReady = storage.ontology.sources.markReady.bind(storage.ontology.sources)
  const sources = Object.create(storage.ontology.sources) as OntologySourceStorage
  Object.defineProperty(sources, "markReady", {
    enumerable: true,
    value: async (input: Parameters<OntologySourceStorage["markReady"]>[0]) => {
      const ready = await markReady(input)
      observer.onStagingCompleted()
      return ready
    },
  })
  return {
    objects: storage.objects,
    timeseries: storage.timeseries,
    ontology: { ...storage.ontology, sources },
    projectionRuns: storage.projectionRuns,
    ping: () => storage.ping(),
    transaction: (run, options) =>
      storage.transaction((tx) => {
        observer.onFinalizationStarted()
        return run(tx)
      }, options),
  }
}

function startPeakRssMonitor() {
  let peakRssBytes = process.memoryUsage().rss
  const timer = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
  }, 50)
  return {
    stop() {
      clearInterval(timer)
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
      return peakRssBytes
    },
  }
}

function createCompetingWriterProbe(storage: Storage) {
  const actionRuns = storage.actionRuns
  if (!actionRuns) throw new Error("Benchmark storage must expose actionRuns.")
  const startGate = Promise.withResolvers<void>()
  let startedAt: number | undefined
  let cancelled = false
  const run = (async () => {
    await startGate.promise
    if (cancelled) return null
    const id = "competing-writer"
    await actionRuns.queue({
      id,
      projectId: PROJECT_ID,
      actionId: "benchmark-writer",
      subject: { kind: "none" },
      params: {},
      idempotencyKey: id,
    })
    return performance.now()
  })()

  return {
    start() {
      if (startedAt !== undefined) return
      startedAt = performance.now()
      startGate.resolve()
    },
    async stop() {
      if (startedAt === undefined) {
        throw new Error("Competing writer probe was never started.")
      }
      const completedAt = await run
      if (completedAt === null) throw new Error("Competing writer probe was cancelled.")
      return { waitMs: round(completedAt - startedAt) }
    },
    async cancel() {
      cancelled = true
      startGate.resolve()
      await run
    },
  }
}

async function* projectionEntries(rows: number): AsyncIterable<ProjectionSourceEntry> {
  const width = String(rows).length
  for (let ordinal = 0; ordinal < rows; ordinal += 1) {
    const id = `item-${String(ordinal).padStart(width, "0")}`
    yield {
      root: { kind: "object", ref: { objectTypeId: BenchmarkItem.id, primaryId: id } },
      assertions: [
        {
          kind: "object",
          ref: { objectTypeId: BenchmarkItem.id, primaryId: id },
          properties: { label: `Benchmark item ${ordinal}` },
        },
      ],
    }
  }
}

function requireProjectionRuns(storage: Storage) {
  if (!storage.projectionRuns) throw new Error("Benchmark storage must expose projectionRuns.")
  return storage.projectionRuns
}

function readConfig(): BenchmarkConfig {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      rows: { type: "string", default: String(DEFAULT_ROWS) },
    },
    strict: true,
  })
  if (values.provider !== "sqlite" && values.provider !== "postgres") {
    throw new Error("Use --provider sqlite or --provider postgres.")
  }
  const rows = Number(values.rows)
  if (!Number.isSafeInteger(rows) || rows <= 0) {
    throw new Error("--rows must be a positive safe integer.")
  }
  return { provider: values.provider, rows }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

await main()
