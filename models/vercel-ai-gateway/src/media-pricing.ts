import { isJsonObject, type ModelPriceVariant, type ModelVariantPrice } from "@sixb/core/models"

const DIMENSIONS = ["size", "quality", "style"] as const

/**
 * The catalog's per-image price: a flat `image` price, refined by `image_dimension_quality_pricing`
 * entries keyed by size, quality or style. A `default` size prices requests that name none.
 * Operation entries are surcharges the reported cost covers; tables that mix dimensions cannot be
 * matched safely and stay unpriced.
 */
export function gatewayImagePrice(pricing: Record<string, unknown>): ModelVariantPrice | undefined {
  const flat = price(pricing.image)
  const entries = Array.isArray(pricing.image_dimension_quality_pricing)
    ? pricing.image_dimension_quality_pricing.filter(
        (entry) => isJsonObject(entry) && entry.operation === undefined
      )
    : []
  if (entries.length === 0) return flat

  let shape: string | undefined
  let defaultPrice = flat
  const variants: ModelPriceVariant[] = []
  for (const entry of entries) {
    if (!isJsonObject(entry)) return undefined
    const cost = price(entry.cost)
    const keys = Object.keys(entry).filter((key) => key !== "cost")
    if (!cost || keys.some((key) => !(DIMENSIONS as readonly string[]).includes(key))) {
      return undefined
    }
    if (keys.length === 1 && entry.size === "default") {
      defaultPrice = cost
      continue
    }

    const key = keys.sort().join(",")
    if (shape !== undefined && key !== shape) return undefined
    shape = key
    const variant: { -readonly [K in keyof ModelPriceVariant]: ModelPriceVariant[K] } = {
      price: cost,
    }
    for (const dimension of DIMENSIONS) {
      const value = entry[dimension]
      if (value === undefined) continue
      if (typeof value !== "string" || !value.trim()) return undefined
      variant[dimension] = value
    }
    variants.push(variant)
  }

  if (variants.length === 0) return defaultPrice
  return { ...(defaultPrice === undefined ? {} : { default: defaultPrice }), variants }
}

function price(value: unknown): string | undefined {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? value : undefined
}
