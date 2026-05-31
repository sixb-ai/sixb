import { migrateStorage } from "@pario/core"
import { loadParioFromEntry } from "../lib/loadPario"
import { resolveRuntimeEntry } from "../lib/production"
import { stopParioProviders } from "../lib/runtime"
import { DbMigrateView, renderStatic } from "../ui"

export interface DbMigrateOptions {
  entry?: string
}

export async function runDbMigrate(options: DbMigrateOptions = {}) {
  const entry = await resolveRuntimeEntry({ entry: options.entry })
  const pario = await loadParioFromEntry(entry)

  try {
    const result = await migrateStorage(pario.storage)
    await renderStatic(<DbMigrateView projectId={pario.id} status={result.status} />)
  } finally {
    await stopParioProviders(pario)
  }
}
