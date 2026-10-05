import { migrateStorage, prepareObjectQueries } from "@sixb/core"
import { loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import { stopSixbProviders } from "../lib/runtime"

export async function runDbPrepare(options: { entry?: string } = {}): Promise<void> {
  const entry = await resolveRuntimeEntry(options)
  const sixb = await loadSixbFromEntry(entry)
  try {
    console.info(
      "[SixbCLI] Preparing ontology query indexes; backfills may temporarily block object writes."
    )
    await migrateStorage(sixb.storage)
    const result = await prepareObjectQueries({
      projectId: sixb.id,
      ontology: sixb.definitions.ontology,
      storage: sixb.storage,
    })
    console.info(
      `[SixbCLI] Prepared ${result.objectTypes} object types and ${result.indexes} query indexes.`
    )
    for (const warning of result.warnings) console.warn(`[SixbCLI] ${warning}`)
  } finally {
    await stopSixbProviders(sixb)
  }
}
