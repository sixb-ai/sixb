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
    const objectTypes = sixb.listObjectTypes()
    const health = await checkRuntimeHealth(sixb)

    const projectValidation =
      objectTypes.length > 0
        ? { status: "ok" as const, message: `${objectTypes.length} object type(s)` }
        : { status: "failed" as const, message: "No object types loaded" }

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

    // A failing probe exits non-zero so `sixb check` can gate a deploy. It used to exit
    // 0 for everything except an empty ontology, which made it useless in a pipeline.
    // `unverified` is not a failure: nothing is wrong with a provider that exposes no
    // probe, and gating a deploy on it would punish the honest report.
    const failed = [health.storage, health.timeseries, health.broker, health.queues].some(
      (check) => check.status === "failed"
    )
    if (objectTypes.length === 0 || failed) process.exit(1)
  } finally {
    // Tear down runtime providers (broker, queues, storage, connectors) so the
    // process can exit instead of hanging on open connections. Mirrors lake-check.
    await stopSixbProviders(sixb)
  }
}
