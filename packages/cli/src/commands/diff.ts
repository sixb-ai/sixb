import { dirname, resolve } from "node:path"
import { writeJson } from "@sixb/cli-core"
import {
  createSixbClient,
  type GetDefinitionsManifestResponse,
  getDefinitionsManifest,
  type SixbClient,
} from "@sixb/client"
import type { DatasetDefinition } from "@sixb/core"
import {
  buildDefinitionsManifest,
  type DefinitionsManifest,
  diffManifests,
} from "@sixb/core/internal/manifest"
import {
  createCliSixbClient,
  type SixbApiClientConfig,
  unwrapSixbApiResult,
} from "../lib/api-client"
import { assertDeclaredEnv } from "../lib/env-config"
import { SixbApiError, SixbCliError } from "../lib/errors"
import { loadSixbFromEntry } from "../lib/loadSixb"
import { resolveProfileApiClientConfig } from "../lib/profile-api-client"
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
  // An instance with sign-in off needs no token; one that needs it answers 401 and says so.
  const client = config.token
    ? createCliSixbClient(config)
    : createSixbClient({ baseUrl: config.apiUrl })
  // First, so an unreachable or refusing instance fails before the project loads.
  const base = toManifest(await readManifest(client, config))

  await assertDeclaredEnv(dirname(entry))
  // Definitions only: storage is never opened, so nothing is stopped either. Stopping would drain
  // the outbox, which reads a database this command has no reason to touch.
  const head = await buildDefinitionsManifest(await loadSixbFromEntry(entry), { commit: null })

  const diff = diffManifests(base, head)
  if (diff.plan.datasets.some((step) => step.change === "refused")) process.exitCode = 1

  if (options.json) {
    writeJson({ base: { apiUrl: config.apiUrl, commit: base.commit }, ...diff })
  } else {
    await renderStatic(diffView({ apiUrl: config.apiUrl, commit: base.commit, diff }))
  }
  // Providers the config created may hold the process open; the answer is out.
  process.exit(process.exitCode ?? 0)
}

async function readManifest(
  client: SixbClient,
  config: SixbApiClientConfig
): Promise<GetDefinitionsManifestResponse> {
  try {
    return unwrapSixbApiResult(await getDefinitionsManifest({ client }))
  } catch (error) {
    if (error instanceof SixbApiError && error.status === 401 && !config.token) {
      throw new SixbCliError(`[SixbCLI] ${config.apiUrl} needs you to sign in.`, {
        remediation: `Run \`sixb login ${config.apiUrl}\`, or set SIXB_API_URL and SIXB_API_TOKEN.`,
      })
    }
    throw error
  }
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
