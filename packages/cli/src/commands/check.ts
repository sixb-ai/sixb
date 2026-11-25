import { dirname, resolve } from "node:path"
import { migrateStorage, type TypeShapeCheck } from "@sixb/core"
import { getLakeRetentionRuntime, ingestStalledSince } from "@sixb/core/internal/runtime"
import { applyTypeShapes, checkTypeShapes } from "@sixb/core/internal/storage"
import { countLostRuns } from "@sixb/core/internal/workers"
import { assertDeclaredEnv } from "../lib/env-config"
import { errorMessage } from "../lib/errors"
import { checkRuntimeHealth } from "../lib/health"
import { type LoadedSixbHost, loadSixbFromEntry } from "../lib/loadSixb"
import {
  checkRuntimeLakeDefinitions,
  checkRuntimePipelineMarkings,
  readAppliedMarkingNotices,
  stopSixbProviders,
} from "../lib/runtime"
import { generateProjectTypes } from "../lib/typegen"
import {
  checkView,
  dbMigrateView,
  lakeCheckView,
  renderStatic,
  type TypeShapeSummary,
  withTask,
} from "../ui"

export interface CheckOptions {
  entry?: string
  /** Brings the storage schema up to date first, in the same project load, as a deploy does. */
  migrate?: boolean
  /** Checks the lake's dataset definitions too, as `sixb lake check` does. */
  lake?: boolean
}

export async function runCheck(options: CheckOptions = {}) {
  const entry = resolve(options.entry ?? "sixb.config.ts")
  // First, so a missing variable is named instead of surfacing as whatever reading it breaks.
  await assertDeclaredEnv(dirname(entry))

  const sixb = await withTask("check", "Generating types", async (task) => {
    await generateProjectTypes({ entry })
    task.step("Loading project")
    return loadSixbFromEntry(entry)
  })

  try {
    // Every check that can fail runs before the unique values and the object shapes are written,
    // the writes the old release can't run beside: a deploy that fails here restarts it on data
    // it still fits, with nothing prepared it would leave stale.
    const shapes = options.migrate ? await migrate(sixb) : undefined
    const passed = await probe(sixb, entry, options.lake === true, shapes)

    if (passed && shapes) {
      await withTask("check", "Recording object shapes", () =>
        applyTypeShapes(sixb.storage, migrationOptions(sixb), shapes)
      )
    }
  } finally {
    // Tear down runtime providers (broker, queues, storage, connectors) so the
    // process can exit instead of hanging on open connections. Mirrors lake-check.
    // A provider that cannot reach its server may never finish closing; the report is already
    // out, so a deploy gated on this command gets its answer instead of waiting forever.
    if (!(await settlesWithin(stopSixbProviders(sixb), CLOSE_TIMEOUT_MS))) {
      console.error(`[SixbCLI] Providers did not close within ${CLOSE_TIMEOUT_MS / 1000}s.`)
      process.exit(process.exitCode ?? 1)
    }
  }
  // A client can report itself closed and still hold the process open — one retrying a server it
  // never reached does. The report is out and teardown ran, so finish.
  process.exit(process.exitCode ?? 0)
}

/**
 * Probes every provider and the project, whether the stored objects fit the code, and the lake's
 * datasets when asked. Resolves whether everything passed.
 */
async function probe(
  sixb: LoadedSixbHost,
  entry: string,
  lake: boolean,
  migrated: TypeShapeCheck | undefined
): Promise<boolean> {
  const objectTypes = sixb.definitions.ontology.listObjectTypes()
  const { health, markings, shapes } = await withTask(
    "check",
    "Probing providers",
    async (task) => {
      const health = await checkRuntimeHealth(sixb)
      task.step("Checking markings")
      const markings = await checkMarkings(sixb, health.storage.ok)
      task.step("Checking the stored objects")
      return { health, markings, shapes: await checkShapes(sixb, health.storage.ok, migrated) }
    }
  )

  const projectValidation =
    objectTypes.length > 0
      ? {
          ok: true,
          message: `${objectTypes.length} object type${objectTypes.length === 1 ? "" : "s"}`,
        }
      : { ok: false, message: "No object types loaded" }

  await renderStatic(
    checkView({
      projectId: sixb.id,
      storage: health.storage,
      timeseries: health.timeseries,
      broker: health.broker,
      queues: health.queues,
      projectValidation,
      markings,
      ...(shapes ? { shapes } : {}),
      ontology: {
        enabled: true,
        source: entry,
        errors: objectTypes.length > 0 ? 0 : 1,
        // Ontology warnings, which nothing produces yet. The provider warnings below
        // are a different thing and counting them here read as ontology drift.
        warnings: 0,
      },
      warnings: [
        ...health.warnings,
        ...markings.warnings,
        ...(await lakeWorkerWarnings(sixb, health.storage.ok)),
        ...(await lostRunWarnings(sixb, health.storage.ok)),
      ],
    })
  )

  // A failing probe exits non-zero so `sixb check` can gate a deploy. `exitCode`, not
  // `exit()`: `process.exit()` terminates immediately and the `finally` below never runs, so
  // the providers this command opened were left unclosed on the one path where that matters.
  const failed = [
    health.storage,
    health.timeseries,
    health.broker,
    health.queues,
    markings,
    shapes ?? { ok: true },
  ].some((check) => !check.ok)
  if (objectTypes.length === 0 || failed) {
    process.exitCode = 1
    return false
  }

  if (lake) {
    await withTask("check", "Checking lake datasets", () => checkRuntimeLakeDefinitions(sixb))
    await renderStatic(lakeCheckView({ projectId: sixb.id }))
  }
  return true
}

/**
 * Whether the stored objects fit the code's object types: what `--migrate` found after migrating,
 * or a fresh read-only check. Absent when storage could not be read, which has its own row.
 */
async function checkShapes(
  sixb: LoadedSixbHost,
  storageOk: boolean,
  migrated: TypeShapeCheck | undefined
): Promise<(TypeShapeSummary & { readonly ok: boolean; readonly message: string }) | undefined> {
  if (!storageOk && !migrated) return undefined

  try {
    const check =
      migrated ??
      (await checkTypeShapes({
        storage: sixb.storage,
        projectId: sixb.id,
        ontology: sixb.definitions.ontology,
        mode: "check",
      }))
    const findings = check.types.flatMap((type) => type.findings)

    if (findings.length > 0) {
      const count = findings.length === 1 ? "1 change" : `${findings.length} changes`
      return { ok: false, message: `${count} they don't fit`, findings, narrows: check.narrows }
    }
    const message = check.narrows ? "fit · the services stop while their shapes change" : "fit"
    return { ok: true, message, findings, narrows: check.narrows }
  } catch (error) {
    return { ok: false, message: errorMessage(error), findings: [], narrows: false }
  }
}

const CLOSE_TIMEOUT_MS = 10_000

function migrationOptions(sixb: LoadedSixbHost) {
  return {
    projectId: sixb.id,
    ontology: sixb.definitions.ontology,
    security: sixb.definitions.security,
  }
}

/**
 * Migrates before anything is probed, since the probes read the schema. Always, as
 * `sixb db migrate` does: a release with no schema change can still add a query index or make a
 * property unique, and the services start with `--no-migrate`. The object shapes are only checked
 * here, and unique values left as they are: `runCheck` applies both once every other check passed.
 */
async function migrate(sixb: LoadedSixbHost): Promise<TypeShapeCheck | undefined> {
  const result = await withTask("check", "Migrating storage", () =>
    migrateStorage(sixb.storage, { ...migrationOptions(sixb), ontologyShapes: "check" })
  )
  await renderStatic(
    dbMigrateView({
      projectId: sixb.id,
      status: result.status,
      applied: result.reports.flatMap((report) => report.applied),
    })
  )
  return result.shapes
}

/**
 * What storage says, since no process knows what the others run. A storage that is down or behind
 * has its own row in this report.
 */
async function lakeWorkerWarnings(
  sixb: LoadedSixbHost,
  storageOk: boolean
): Promise<readonly string[]> {
  if (!storageOk) return []

  const [status, stalled] = await Promise.all([
    getLakeRetentionRuntime(sixb)
      .status()
      .catch(() => null),
    stalledIngestDatasets(sixb),
  ])

  return [
    ...(status?.state === "no-worker"
      ? ["Lake cleanup is requested but no lake worker has run it. Run `sixb worker lake`."]
      : []),
    ...(stalled.length > 0
      ? [
          `Ingested changes wait and nothing writes them, in ${stalled.join(", ")}. Run \`sixb worker lake\`.`,
        ]
      : []),
  ]
}

async function stalledIngestDatasets(sixb: LoadedSixbHost): Promise<readonly string[]> {
  const summaries = await sixb.storage.datasetIngest
    ?.summarize({ projectId: sixb.id })
    .catch(() => [])

  return (summaries ?? [])
    .filter(
      (summary) => summary.pendingDeliveries > 0 && ingestStalledSince(summary, Date.now()) !== null
    )
    .map((summary) => summary.datasetId)
}

/**
 * What the orchestrator's `runs` pass will do once it starts: runs that lost their job go on, with
 * their side effects, so whoever is upgrading can look at them first.
 */
async function lostRunWarnings(
  sixb: LoadedSixbHost,
  storageOk: boolean
): Promise<readonly string[]> {
  if (!storageOk) return []

  const counts = await countLostRuns({
    projectId: sixb.id,
    storage: sixb.storage,
    queues: sixb.queues,
    events: sixb.events,
    now: new Date(),
  }).catch(() => [])

  return counts.flatMap(({ primitive, goOn, end }) => [
    ...(goOn > 0
      ? [`${goOn} ${primitive} run(s) lost their job and will go on when the orchestrator starts.`]
      : []),
    ...(end > 0 ? [`${end} ${primitive} run(s) are too old to go on and will end cancelled.`] : []),
  ])
}

interface MarkingsCheck {
  readonly ok: boolean
  readonly warning?: boolean
  readonly message?: string
  readonly warnings: readonly string[]
}

/**
 * The SQL preflight, then what the versions projections applied still add to the code's markings.
 * The second is a warning, not a failure: the code is right, and only rerunning the pipeline with
 * it deployed applies a version it allows.
 */
async function checkMarkings(sixb: LoadedSixbHost, storageOk: boolean): Promise<MarkingsCheck> {
  try {
    await checkRuntimePipelineMarkings(sixb)
  } catch (error) {
    return { ok: false, message: errorMessage(error), warnings: [] }
  }

  // The storage row already reports an unreachable storage.
  if (!storageOk) return { ok: true, warnings: [] }

  try {
    const notices = await readAppliedMarkingNotices(sixb)
    if (notices.length === 0) return { ok: true, warnings: [] }

    const count =
      notices.length === 1 ? "1 projection applied" : `${notices.length} projections applied`
    return {
      ok: true,
      warning: true,
      message: `${count} a version the code does not allow`,
      warnings: notices,
    }
  } catch (error) {
    return { ok: false, message: errorMessage(error), warnings: [] }
  }
}

async function settlesWithin(work: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs)
  })
  try {
    return await Promise.race([work.then(() => true as const), timedOut])
  } finally {
    clearTimeout(timer)
  }
}
