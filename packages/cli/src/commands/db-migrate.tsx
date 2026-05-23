import { migrateStorage } from "@sixb/core"
import { loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import { stopSixbProviders } from "../lib/runtime"
import { DbMigrateView, renderStatic } from "../ui"

export interface DbMigrateOptions {
  entry?: string
}

export async function runDbMigrate(options: DbMigrateOptions = {}) {
  const entry = await resolveRuntimeEntry({ entry: options.entry })
  const sixb = await loadSixbFromEntry(entry)

  try {
    const result = await migrateStorage(sixb.storage)
    await renderStatic(<DbMigrateView projectId={sixb.id} status={result.status} />)
  } finally {
    await stopSixbProviders(sixb)
  }
}
