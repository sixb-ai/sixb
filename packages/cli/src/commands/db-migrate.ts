import { migrateStorage } from "@sixb/core"
import { loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import { stopSixbProviders } from "../lib/runtime"
import { dbMigrateView, renderStatic, withTask } from "../ui"

export interface DbMigrateOptions {
  entry?: string
}

export async function runDbMigrate(options: DbMigrateOptions = {}) {
  const entry = await resolveRuntimeEntry({ entry: options.entry })
  const sixb = await withTask("db migrate", "Loading project", () => loadSixbFromEntry(entry))

  try {
    const result = await withTask("db migrate", "Migrating storage", () =>
      migrateStorage(sixb.storage, {
        projectId: sixb.id,
        ontology: sixb.definitions.ontology,
      })
    )
    await renderStatic(
      dbMigrateView({
        projectId: sixb.id,
        status: result.status,
        applied: result.reports.flatMap((report) => report.applied),
      })
    )
  } finally {
    await stopSixbProviders(sixb)
  }
}
