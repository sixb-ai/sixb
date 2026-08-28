import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const SOURCE_URL = "https://models.dev/api.json"
const OUTPUT_PATH = resolve(import.meta.dir, "../packages/agent-worker/src/models-dev/catalog.json")

interface ModelsDevCost {
  readonly input: number
  readonly output: number
  readonly cache_read?: number
  readonly cache_write?: number
  readonly reasoning?: number
  readonly input_audio?: number
  readonly output_audio?: number
  readonly tiers?: readonly (ModelsDevCost & {
    readonly tier: { readonly type: string; readonly size: number }
  })[]
}

interface ModelsDevMode {
  readonly cost?: ModelsDevCost
}

interface ModelsDevModel {
  readonly cost?: ModelsDevCost
  readonly limit?: {
    readonly context?: number
    readonly input?: number
  }
  readonly experimental?: {
    readonly modes?: Readonly<Record<string, ModelsDevMode>>
  }
}

interface ModelsDevProvider {
  readonly models: Readonly<Record<string, ModelsDevModel>>
}

interface GeneratedModelLimits {
  readonly context: number
  readonly input?: number
}

interface GeneratedRateSet {
  readonly input: string
  readonly output: string
  readonly cacheRead?: string
  readonly cacheWrite?: string
  readonly reasoning?: string
  readonly inputAudio?: string
  readonly outputAudio?: string
}

interface GeneratedPrice extends GeneratedRateSet {
  readonly tiers?: readonly (GeneratedRateSet & { readonly aboveInputTokens: string })[]
  readonly modes?: Readonly<Record<string, Omit<GeneratedPrice, "modes">>>
}

interface GeneratedCatalogModel {
  readonly limits?: GeneratedModelLimits
  readonly pricing?: GeneratedPrice
}

const response = await fetch(SOURCE_URL)
if (!response.ok) {
  throw new Error(`[SixbModelsDev] Models.dev returned HTTP ${response.status}.`)
}
const sourceText = await response.text()
const source = JSON.parse(sourceText) as Readonly<Record<string, ModelsDevProvider>>
const providers: Record<string, Record<string, GeneratedCatalogModel>> = {}
let modelCount = 0

for (const [providerId, provider] of Object.entries(source).sort(compareEntries)) {
  const models: Record<string, GeneratedCatalogModel> = {}
  for (const [modelId, model] of Object.entries(provider.models).sort(compareEntries)) {
    const limits = generatedLimits(model.limit)
    const pricing = model.cost ? generatedPrice(model.cost, model.experimental?.modes) : undefined
    if (!limits && !pricing) continue

    models[modelId] = {
      ...(limits ? { limits } : {}),
      ...(pricing ? { pricing } : {}),
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
  `[SixbModelsDev] Wrote ${modelCount} models from ${Object.keys(providers).length} providers to ${OUTPUT_PATH} (${output.source.version}).`
)

function generatedLimits(limit: ModelsDevModel["limit"]): GeneratedModelLimits | undefined {
  if (!isPositiveSafeInteger(limit?.context)) return undefined
  return {
    context: limit.context,
    ...(isPositiveSafeInteger(limit.input) ? { input: limit.input } : {}),
  }
}

function generatedPrice(
  cost: ModelsDevCost,
  sourceModes?: Readonly<Record<string, ModelsDevMode>>
): GeneratedPrice {
  const modes = Object.fromEntries(
    Object.entries(sourceModes ?? {})
      .sort(compareEntries)
      .flatMap(([mode, value]) =>
        value.cost ? [[mode, generatedPrice(value.cost, undefined)]] : []
      )
  )
  const tiers = cost.tiers?.map((tier) => {
    if (tier.tier.type !== "context") {
      throw new Error(`[SixbModelsDev] Unsupported Models.dev tier '${tier.tier.type}'.`)
    }
    return {
      ...rateSet(tier),
      aboveInputTokens: integerString(tier.tier.size, "tier size"),
    }
  })
  return {
    ...rateSet(cost),
    ...(tiers?.length ? { tiers } : {}),
    ...(Object.keys(modes).length ? { modes } : {}),
  }
}

function rateSet(cost: ModelsDevCost): GeneratedRateSet {
  return {
    input: dollarsPerMillionToNanos(cost.input),
    output: dollarsPerMillionToNanos(cost.output),
    ...(cost.cache_read === undefined
      ? {}
      : { cacheRead: dollarsPerMillionToNanos(cost.cache_read) }),
    ...(cost.cache_write === undefined
      ? {}
      : { cacheWrite: dollarsPerMillionToNanos(cost.cache_write) }),
    ...(cost.reasoning === undefined
      ? {}
      : { reasoning: dollarsPerMillionToNanos(cost.reasoning) }),
    ...(cost.input_audio === undefined
      ? {}
      : { inputAudio: dollarsPerMillionToNanos(cost.input_audio) }),
    ...(cost.output_audio === undefined
      ? {}
      : { outputAudio: dollarsPerMillionToNanos(cost.output_audio) }),
  }
}

/**
 * Models.dev publishes JSON numbers. Its generated feed occasionally contains binary-float tails
 * such as 0.049999999999999996, so catalog compilation rounds the textual value to the nearest
 * currency nanounit per million tokens. Runtime money arithmetic never uses floating point.
 */
function dollarsPerMillionToNanos(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`[SixbModelsDev] Invalid Models.dev price '${String(value)}'.`)
  }
  const decimal = value.toString()
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(decimal)
  if (!match) throw new Error(`[SixbModelsDev] Invalid Models.dev decimal '${decimal}'.`)

  const whole = match[1]!
  const fraction = match[2] ?? ""
  const exponent = Number(match[3] ?? "0")
  const digits = `${whole}${fraction}`
  const decimalPlaces = fraction.length - exponent
  let scaled: bigint
  if (decimalPlaces <= 9) {
    scaled = BigInt(digits) * 10n ** BigInt(9 - decimalPlaces)
  } else {
    const divisor = 10n ** BigInt(decimalPlaces - 9)
    const coefficient = BigInt(digits)
    scaled = (coefficient + divisor / 2n) / divisor
  }
  if (scaled < 0n || scaled > 9_223_372_036_854_775_807n) {
    throw new Error(
      `[SixbModelsDev] Models.dev price '${decimal}' exceeds signed 64-bit nanounits.`
    )
  }
  return scaled.toString()
}

function integerString(value: number, field: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`[SixbModelsDev] Models.dev ${field} must be a non-negative safe integer.`)
  }
  return value.toString()
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function compareEntries(
  left: readonly [string, unknown],
  right: readonly [string, unknown]
): number {
  return left[0].localeCompare(right[0])
}
