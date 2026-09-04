import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const SOURCE_URL = "https://models.dev/api.json"
const MODEL_SOURCE_URL = "https://models.dev/models.json"
const OUTPUT_PATH = resolve(import.meta.dir, "../packages/agent-worker/src/models-dev/catalog.json")
const DISPLAY_OUTPUT_PATH = resolve(
  import.meta.dir,
  "../packages/server/src/models-dev/catalog.json"
)

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

type ModelsDevReasoningOption =
  | { readonly type: "toggle" }
  | { readonly type: "effort"; readonly values: readonly (string | null)[] }
  | { readonly type: "budget_tokens" }

interface ModelsDevModel {
  readonly cost?: ModelsDevCost
  readonly limit?: {
    readonly context?: number
    readonly input?: number
  }
  readonly experimental?: {
    readonly modes?: Readonly<Record<string, ModelsDevMode>>
  }
  readonly reasoning_options?: readonly ModelsDevReasoningOption[]
}

interface ModelsDevProvider {
  readonly name: string
  readonly models: Readonly<Record<string, ModelsDevModel>>
}

interface ModelsDevDisplayModel {
  readonly name: string
  readonly description: string
  readonly attachment: boolean
  readonly reasoning: boolean
  readonly reasoning_options?: readonly ModelsDevReasoningOption[]
  readonly tool_call: boolean
  readonly structured_output: boolean
  readonly modalities: {
    readonly input: readonly string[]
    readonly output: readonly string[]
  }
  readonly limit: { readonly context?: number }
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
const modelResponse = await fetch(MODEL_SOURCE_URL)
if (!modelResponse.ok) {
  throw new Error(`[SixbModelsDev] Models.dev returned HTTP ${modelResponse.status}.`)
}
const modelSourceText = await modelResponse.text()
const displaySource = JSON.parse(modelSourceText) as Readonly<Record<string, ModelsDevDisplayModel>>
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
const displayOutput = generatedDisplayCatalog(displaySource, source, modelSourceText)
await mkdir(dirname(DISPLAY_OUTPUT_PATH), { recursive: true })
await Bun.write(DISPLAY_OUTPUT_PATH, `${JSON.stringify(displayOutput)}\n`)
console.log(
  `[SixbModelsDev] Wrote ${modelCount} priced models and ${Object.keys(displayOutput.models).length} display models (${output.source.version}).`
)

function generatedDisplayCatalog(
  models: Readonly<Record<string, ModelsDevDisplayModel>>,
  providers: Readonly<Record<string, ModelsDevProvider>>,
  sourceText: string
) {
  const publisherNames: Record<string, string> = {}
  const generatedModels: Record<string, object> = {}

  for (const [canonicalId, model] of Object.entries(models).sort(compareEntries)) {
    const separator = canonicalId.indexOf("/")
    if (separator <= 0) continue
    const publisherId = canonicalId.slice(0, separator)
    const publisherModelId = canonicalId.slice(separator + 1)
    publisherNames[publisherId] = providers[publisherId]?.name ?? humanizeId(publisherId)

    const providerModel =
      providers[publisherId]?.models[publisherModelId] ?? providers.vercel?.models[canonicalId]
    const reasoningOptions = providerModel?.reasoning_options ?? model.reasoning_options
    const reasoningLevels = [
      ...new Set(
        reasoningOptions?.flatMap((option) =>
          option.type === "effort"
            ? option.values.filter((value): value is string => typeof value === "string")
            : []
        ) ?? []
      ),
    ]
    const reasoningToggle = reasoningOptions?.some((option) => option.type === "toggle") ?? false

    generatedModels[canonicalId] = {
      name: model.name,
      description: model.description,
      attachment: model.attachment,
      reasoning: model.reasoning,
      toolCall: model.tool_call,
      structuredOutput: model.structured_output,
      modalities: model.modalities,
      ...(isPositiveSafeInteger(model.limit.context)
        ? { contextWindowTokens: model.limit.context }
        : {}),
      ...(reasoningLevels.length === 0 ? {} : { reasoningLevels }),
      ...(reasoningToggle ? { reasoningToggle: true } : {}),
    }
  }

  return {
    source: {
      id: "models.dev",
      version: `sha256:${createHash("sha256").update(sourceText).digest("hex")}`,
      url: MODEL_SOURCE_URL,
      observedAt: new Date().toISOString(),
    },
    publisherNames,
    models: generatedModels,
  }
}

function humanizeId(value: string): string {
  return value
    .split(/[-_.]/g)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

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
