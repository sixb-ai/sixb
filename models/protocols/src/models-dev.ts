import { defineModelRateCard, type ModelRateCard } from "@sixb/core/models"
import { object } from "./json"

export const MODELS_DEV_URL = "https://models.dev/api.json"

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_CATALOG_BYTES = 32 * 1024 * 1024

export interface ModelsDevDownloadOptions {
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly timeoutMs?: number
}

/** Downloads the models.dev catalog as text, bounded in time and size. Callers own error mapping. */
export async function downloadModelsDev(options: ModelsDevDownloadOptions = {}): Promise<string> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const response = await abortable(
    () => (options.fetch ?? fetch)(MODELS_DEV_URL, { signal, redirect: "error" }),
    signal
  )
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await abortable(() => reader.read(), signal)
      if (chunk.done) break
      bytes += chunk.value.length
      if (bytes > MAX_CATALOG_BYTES) throw new Error("Catalog exceeds 32 MiB")
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks).toString()
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/**
 * A models.dev `cost` object as a rate card, in USD per million tokens. `cache_write` becomes
 * `cacheWriteInput`; context tiers become token tiers. Anything the card cannot represent exactly
 * returns `undefined`, so callers report the price as unknown instead of guessing.
 */
export function modelsDevRateCard(
  raw: Record<string, unknown> | undefined
): ModelRateCard | undefined {
  if (!raw || raw.tiers === undefined) return flatRates(raw)
  const { tiers, context_over_200k: legacy, ...base } = raw
  const card = flatRates(base)
  if (!card || !Array.isArray(tiers)) return undefined
  const parsed: { size: number; card: ModelRateCard }[] = []
  for (const value of tiers) {
    const entry = object(value)
    if (!entry) return undefined
    const { tier, ...prices } = entry
    const threshold = object(tier)
    const size = threshold?.size
    const tierCard = flatRates(prices)
    if (
      !tierCard ||
      !threshold ||
      Object.keys(threshold).some((k) => k !== "type" && k !== "size") ||
      (threshold.type !== undefined && threshold.type !== "context") ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size >= Number.MAX_SAFE_INTEGER
    )
      return undefined
    parsed.push({ size, card: tierCard })
  }
  parsed.sort((a, b) => a.size - b.size)
  if (new Set(parsed.map((t) => t.size)).size !== parsed.length) return undefined
  const keys = ["input", "output", "cacheReadInput", "cacheWriteInput"] as const
  if (legacy !== undefined) {
    const mirror = flatRates(object(legacy))
    if (
      !mirror ||
      parsed.length !== 1 ||
      parsed[0]!.size < 200000 ||
      keys.some((k) => mirror[k] !== parsed[0]!.card[k])
    )
      return undefined
  }
  // Missing cache rates are unknown, not inherited or silently treated as zero.
  if (parsed.some((t) => keys.some((k) => (card[k] === undefined) !== (t.card[k] === undefined))))
    return undefined
  const price = (key: (typeof keys)[number]) => {
    const basePrice = card[key]
    if (basePrice === undefined || !parsed.length) return basePrice
    if (typeof basePrice !== "string") return undefined
    return {
      default: basePrice,
      tiers: parsed.map((t, i) => ({
        minTokens: t.size + 1,
        ...(parsed[i + 1] ? { maxTokens: parsed[i + 1]!.size + 1 } : {}),
        price: String(t.card[key]),
      })),
    }
  }
  return defineModelRateCard({
    currency: "USD",
    input: price("input")!,
    output: price("output")!,
    ...(card.cacheReadInput === undefined ? {} : { cacheReadInput: price("cacheReadInput")! }),
    ...(card.cacheWriteInput === undefined ? {} : { cacheWriteInput: price("cacheWriteInput")! }),
  })
}

function flatRates(raw: Record<string, unknown> | undefined): ModelRateCard | undefined {
  if (!raw) return undefined
  // These are reference prices per million tokens. Unrepresented tiers/dimensions must not
  // silently become flat prices; callers can supply an estimator for those billing contracts.
  if (Object.keys(raw).some((k) => !["input", "output", "cache_read", "cache_write"].includes(k)))
    return undefined
  const decimal = (v: unknown) =>
    (typeof v === "number" || typeof v === "string") && /^\d+(\.\d+)?$/.test(String(v))
      ? String(v)
      : undefined
  const input = decimal(raw.input),
    output = decimal(raw.output)
  if (input === undefined || output === undefined) return undefined
  const read = decimal(raw.cache_read),
    write = decimal(raw.cache_write)
  if (
    (raw.cache_read !== undefined && read === undefined) ||
    (raw.cache_write !== undefined && write === undefined)
  )
    return undefined
  return defineModelRateCard({
    currency: "USD",
    input,
    output,
    ...(read === undefined ? {} : { cacheReadInput: read }),
    ...(write === undefined ? {} : { cacheWriteInput: write }),
  })
}

function abortable<T>(operation: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    signal.throwIfAborted()
    const abort = () => {
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return operation()
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
  })
}
