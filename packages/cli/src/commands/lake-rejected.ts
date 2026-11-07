import { loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import { stopSixbProviders } from "../lib/runtime"
import { withTask } from "../ui"

/** A week of refusals is rarely this many; past it, ask for one dataset. */
const LIMIT = 500

export interface LakeRejectedOptions {
  entry?: string
  dataset?: string
}

/**
 * Prints, as JSON, the deliveries refused after `ingest` answered: what each held, whole, and why,
 * so that someone can fix them and send them again. They stay for a week.
 */
export async function runLakeRejected(options: LakeRejectedOptions = {}) {
  const entry = await resolveRuntimeEntry({ entry: options.entry })
  const sixb = await withTask("lake rejected", "Loading project", () => loadSixbFromEntry(entry))

  try {
    const inbox = sixb.storage.datasetIngest
    if (!inbox) throw new Error("[SixbCLI] Configured storage keeps no ingested changes.")

    const rejected = await inbox.listRejected({
      projectId: sixb.id,
      limit: LIMIT,
      ...(options.dataset === undefined ? {} : { datasetId: options.dataset }),
    })

    process.stdout.write(`${JSON.stringify(rejected, null, 2)}\n`)
  } finally {
    await stopSixbProviders(sixb)
  }
}
