import { loadParioFromEntry } from "../lib/loadPario"
import { resolveRuntimeEntry } from "../lib/production"
import { checkRuntimeLakeDefinitions, stopParioProviders } from "../lib/runtime"
import { LakeCheckView, renderStatic } from "../ui"

export interface LakeCheckOptions {
  entry?: string
}

export async function runLakeCheck(options: LakeCheckOptions = {}) {
  const entry = await resolveRuntimeEntry({ entry: options.entry })
  const pario = await loadParioFromEntry(entry)

  try {
    await checkRuntimeLakeDefinitions(pario)
    await renderStatic(<LakeCheckView projectId={pario.id} status="ok" />)
  } finally {
    await stopParioProviders(pario)
  }
}
