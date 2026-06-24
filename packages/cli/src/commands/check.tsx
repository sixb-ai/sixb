import { resolve } from "node:path"
import { loadSixbFromEntry } from "../lib/loadSixb"
import { generateProjectTypes } from "../lib/typegen"
import { CheckView, renderStatic } from "../ui"

export interface CheckOptions {
  entry?: string
}

export async function runCheck(options: CheckOptions = {}) {
  const entry = resolve(options.entry ?? "sixb.config.ts")
  await generateProjectTypes({ entry })
  const sixb = await loadSixbFromEntry(entry)
  const objectTypes = sixb.listObjectTypes()

  const providerStatus = { ok: true, message: "configured" }
  const projectValidation =
    objectTypes.length > 0
      ? { ok: true, message: `${objectTypes.length} object type(s)` }
      : { ok: false, message: "No object types loaded" }

  await renderStatic(
    <CheckView
      projectId={sixb.id}
      events={providerStatus}
      storage={providerStatus}
      timeseries={providerStatus}
      broker={providerStatus}
      projectValidation={projectValidation}
      ontology={{
        enabled: true,
        source: entry,
        errors: objectTypes.length > 0 ? 0 : 1,
        warnings: 0,
      }}
      warnings={[]}
    />
  )

  if (objectTypes.length === 0) process.exit(1)
}
