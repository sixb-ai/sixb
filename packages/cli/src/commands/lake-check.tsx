import { loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import { checkRuntimeLakeDefinitions, stopSixbProviders } from "../lib/runtime"
import { LakeCheckView, renderStatic } from "../ui"

export interface LakeCheckOptions {
  entry?: string
}

export async function runLakeCheck(options: LakeCheckOptions = {}) {
  const entry = await resolveRuntimeEntry({ entry: options.entry })
  const sixb = await loadSixbFromEntry(entry)

  try {
    await checkRuntimeLakeDefinitions(sixb)
    await renderStatic(<LakeCheckView projectId={sixb.id} status="ok" />)
  } finally {
    await stopSixbProviders(sixb)
  }
}
