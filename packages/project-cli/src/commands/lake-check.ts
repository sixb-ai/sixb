import { errorMessage } from "../lib/errors"
import { loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import {
  checkRuntimeLakeDefinitions,
  checkRuntimePipelineMarkings,
  readAppliedMarkingNotices,
  stopSixbProviders,
} from "../lib/runtime"
import { lakeCheckView, renderStatic, withTask } from "../ui"

export interface LakeCheckOptions {
  entry?: string
}

export async function runLakeCheck(options: LakeCheckOptions = {}) {
  const entry = await resolveRuntimeEntry({ entry: options.entry })
  const sixb = await withTask("lake check", "Loading project", () => loadSixbFromEntry(entry))

  try {
    const warnings = await withTask("lake check", "Checking datasets", async (task) => {
      await checkRuntimeLakeDefinitions(sixb)
      task.step("Checking markings")
      await checkRuntimePipelineMarkings(sixb)

      // The code is right; what projections applied before it is a warning until they reproject.
      return readAppliedMarkingNotices(sixb).catch((error: unknown) => [
        `[SixbCLI] Could not read the dataset versions projections applied: ${errorMessage(error)}`,
      ])
    })

    await renderStatic(lakeCheckView({ projectId: sixb.id, warnings }))
  } finally {
    await stopSixbProviders(sixb)
  }
}
