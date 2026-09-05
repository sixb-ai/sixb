import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const SOURCE_URL = "https://models.dev/api.json"
const OUTPUT_PATH = resolve(import.meta.dir, "../packages/agent-worker/src/models-dev/catalog.json")

interface ModelsDevModel {
  readonly limit?: {
    readonly context?: number
    readonly input?: number
  }
}

interface ModelsDevProvider {
  readonly models: Readonly<Record<string, ModelsDevModel>>
}

interface GeneratedModel {
  readonly limits: {
    readonly context: number
    readonly input?: number
  }
}

const response = await fetch(SOURCE_URL)
if (!response.ok) {
  throw new Error(`[SixbModelsDev] Models.dev returned HTTP ${response.status}.`)
}
const sourceText = await response.text()
const source = JSON.parse(sourceText) as Readonly<Record<string, ModelsDevProvider>>
const providers: Record<string, Record<string, GeneratedModel>> = {}
let modelCount = 0

for (const [providerId, provider] of Object.entries(source).sort(compareEntries)) {
  const models: Record<string, GeneratedModel> = {}
  for (const [modelId, model] of Object.entries(provider.models).sort(compareEntries)) {
    if (!isPositiveSafeInteger(model.limit?.context)) continue
    models[modelId] = {
      limits: {
        context: model.limit.context,
        ...(isPositiveSafeInteger(model.limit.input) ? { input: model.limit.input } : {}),
      },
    }
    modelCount += 1
  }
  if (Object.keys(models).length > 0) providers[providerId] = models
}

const output = {
  source: {
    id: "models.dev",
    version: `sha256:${createHash("sha256").update(sourceText).digest("hex")}`,
    url: SOURCE_URL,
    observedAt: new Date().toISOString(),
  },
  providers,
}

await mkdir(dirname(OUTPUT_PATH), { recursive: true })
await Bun.write(OUTPUT_PATH, `${JSON.stringify(output)}\n`)
console.log(
  `[SixbModelsDev] Wrote ${modelCount} context limits from ${Object.keys(providers).length} providers to ${OUTPUT_PATH} (${output.source.version}).`
)

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function compareEntries(
  left: readonly [string, unknown],
  right: readonly [string, unknown]
): number {
  return left[0].localeCompare(right[0])
}
