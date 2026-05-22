import { resolve } from "node:path"
import { migrateStorage } from "@pario/core"
import { loadParioFromEntry } from "../lib/loadPario"
import { DbMigrateView, renderStatic } from "../ui"

export interface DbMigrateOptions {
  entry?: string
}

export async function runDbMigrate(options: DbMigrateOptions = {}) {
  const entry = resolve(options.entry ?? "pario.config.ts")
  const pario = await loadParioFromEntry(entry)
  const result = await migrateStorage(pario.storage)

  await renderStatic(<DbMigrateView projectId={pario.id} status={result.status} />)
}
