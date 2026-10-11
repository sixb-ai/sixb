import { errorMessage } from "../lib/errors"
import { loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import {
  checkRuntimeLakeDefinitions,
  checkRuntimePipelineMarkings,
  readAppliedMarkingNotices,
  stopSixbProviders,
} from "../lib/runtime"
import { LakeCheckView, renderStatic } from "../ui"

export interface LakeCheckOptions {
  entry?: string
}

export async function runLakeCheck(options: LakeCheckOptions = {}) {
  const entry = await resolveRuntimeEntry({ entry: options.entry })
  const sixb = await loadSixbFromEntry(entry)

  try {
    await checkRuntimeLakeDefinitions(sixb)
    await checkRuntimePipelineMarkings(sixb)

    // The code is right; what projections applied before it is a warning until they reproject.
    const warnings = await readAppliedMarkingNotices(sixb).catch((error: unknown) => [
      `[SixbCLI] Could not read the dataset versions projections applied: ${errorMessage(error)}`,
    ])

    await renderStatic(<LakeCheckView projectId={sixb.id} status="ok" warnings={warnings} />)
  } finally {
    await stopSixbProviders(sixb)
  }
}
