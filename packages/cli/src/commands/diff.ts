import { dirname, resolve } from "node:path"
import { writeJson } from "@sixb/cli-core"
import { type GetDefinitionsManifestResponse, getDefinitionsManifest } from "@sixb/client"
import type { DatasetDefinition } from "@sixb/core"
import {
  buildDefinitionsManifest,
  type DefinitionsManifest,
  diffManifests,
} from "@sixb/core/internal/manifest"
import { createCliSixbClient, unwrapSixbApiResult } from "../lib/api-client"
import { assertDeclaredEnv } from "../lib/env-config"
import { loadSixbFromEntry } from "../lib/loadSixb"
import { resolveProfileApiClientConfig } from "../lib/profile-api-client"
import { stopSixbProviders } from "../lib/runtime"
import { diffView, renderStatic } from "../ui"

export interface DiffOptions {
  readonly entry?: string
  readonly apiUrl?: string
  readonly token?: string
  readonly profile?: string
  readonly json?: boolean
}

/** What this checkout changes against the instance the profile points at, usually production. */
export async function runDiff(options: DiffOptions = {}): Promise<void> {
  const entry = resolve(options.entry ?? "sixb.config.ts")
  const config = await resolveProfileApiClientConfig(options)
  // First, so a missing login fails before the project loads.
  const base = toManifest(
    unwrapSixbApiResult(await getDefinitionsManifest({ client: createCliSixbClient(config) }))
  )

  await assertDeclaredEnv(dirname(entry))
  const sixb = await loadSixbFromEntry(entry)
  let head: DefinitionsManifest
  try {
    head = await buildDefinitionsManifest(sixb, { commit: null })
  } finally {
    await stopSixbProviders(sixb)
  }

  const diff = diffManifests(base, head)
  if (diff.plan.datasets.some((step) => step.change === "refused")) process.exitCode = 1

  if (options.json) {
    writeJson({ base: { apiUrl: config.apiUrl, commit: base.commit }, ...diff })
  } else {
    await renderStatic(diffView({ apiUrl: config.apiUrl, commit: base.commit, diff }))
  }
  // Loading the project can leave a client retrying a server it never reached; the answer is out.
  process.exit(process.exitCode ?? 0)
}

function toManifest(response: GetDefinitionsManifestResponse): DefinitionsManifest {
  return { ...response, datasets: response.datasets.map(toDataset) }
}

/** The API sends a composite key as a plain list; the definition types it as two or more. */
function toDataset({
  primaryKey,
  ...dataset
}: GetDefinitionsManifestResponse["datasets"][number]): DatasetDefinition {
  if (primaryKey === undefined || typeof primaryKey === "string") {
    return { ...dataset, ...(primaryKey === undefined ? {} : { primaryKey }) }
  }
  const [first, second, ...rest] = primaryKey
  if (first === undefined || second === undefined) {
    throw new Error(
      `[SixbCLI] Dataset '${dataset.id}' has a composite key of fewer than two columns.`
    )
  }
  return { ...dataset, primaryKey: [first, second, ...rest] }
}
