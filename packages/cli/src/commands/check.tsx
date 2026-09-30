import { resolve } from "node:path"
import { checkRuntimeHealth } from "../lib/health"
import { loadSixbFromEntry } from "../lib/loadSixb"
import { stopSixbProviders } from "../lib/runtime"
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
        ontology={{
          enabled: true,
          source: entry,
          errors: objectTypes.length > 0 ? 0 : 1,
          // Ontology warnings, which nothing produces yet. The provider warnings below
          // are a different thing and counting them here read as ontology drift.
          warnings: 0,
        }}
        warnings={health.warnings}
      />
    )

    // A failing probe exits non-zero so `sixb check` can gate a deploy. `exitCode`, not
    // `exit()`: `process.exit()` terminates immediately and the `finally` below never runs, so
    // the providers this command opened were left unclosed on the one path where that matters.
    const failed = [health.storage, health.timeseries, health.broker, health.queues].some(
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
}

const CLOSE_TIMEOUT_MS = 10_000

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
