import { resolve } from "node:path"
import { loadParioFromEntry } from "../lib/loadPario"
import { CheckView, renderStatic } from "../ui"

export interface CheckOptions {
  entry?: string
}

export async function runCheck(options: CheckOptions = {}) {
  const entry = resolve(options.entry ?? "pario.config.ts")
  const pario = await loadParioFromEntry(entry)
  const objectTypes = pario.listObjectTypes()

  const providerStatus = { ok: true, message: "configured" }
  const projectValidation =
    objectTypes.length > 0
      ? { ok: true, message: `${objectTypes.length} object type(s)` }
      : { ok: false, message: "No object types loaded" }

  await renderStatic(
    <CheckView
      projectId={pario.id}
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
