import { resolve } from "node:path"
import { errorMessage } from "../lib/errors"
import { checkRuntimeHealth } from "../lib/health"
import { type LoadedSixbHost, loadSixbFromEntry } from "../lib/loadSixb"
import {
  checkRuntimePipelineMarkings,
  readAppliedMarkingNotices,
  stopSixbProviders,
} from "../lib/runtime"
import { generateProjectTypes } from "../lib/typegen"
import { CheckView, renderStatic } from "../ui"

export interface CheckOptions {
  entry?: string
}

export async function runCheck(options: CheckOptions = {}) {
  const entry = resolve(options.entry ?? "sixb.config.ts")
  await generateProjectTypes({ entry })
  const sixb = await loadSixbFromEntry(entry)

  try {
    const objectTypes = sixb.definitions.ontology.listObjectTypes()
    const health = await checkRuntimeHealth(sixb)
    const markings = await checkMarkings(sixb, health.storage.ok)

    const projectValidation =
      objectTypes.length > 0
        ? { ok: true, message: `${objectTypes.length} object type(s)` }
        : { ok: false, message: "No object types loaded" }

    await renderStatic(
      <CheckView
        projectId={sixb.id}
        storage={health.storage}
        timeseries={health.timeseries}
        broker={health.broker}
        queues={health.queues}
        projectValidation={projectValidation}
        markings={markings}
        ontology={{
          enabled: true,
          source: entry,
          errors: objectTypes.length > 0 ? 0 : 1,
          // Ontology warnings, which nothing produces yet. The provider warnings below
          // are a different thing and counting them here read as ontology drift.
          warnings: 0,
        }}
        warnings={[...health.warnings, ...markings.warnings]}
      />
    )

    // A failing probe exits non-zero so `sixb check` can gate a deploy. `exitCode`, not
    // `exit()`: `process.exit()` terminates immediately and the `finally` below never runs, so
    // the providers this command opened were left unclosed on the one path where that matters.
    const failed = [health.storage, health.timeseries, health.broker, health.queues, markings].some(
      (check) => !check.ok
    )
    if (objectTypes.length === 0 || failed) process.exitCode = 1
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

const CLOSE_TIMEOUT_MS = 10_000

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
