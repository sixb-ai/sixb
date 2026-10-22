import type { ApiClient } from "../api-client"
import { isHelp, parseCommandArgs, requestsHelp } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"

export const MODEL_KINDS = ["language", "image", "speech", "transcription"] as const
export type ModelKind = (typeof MODEL_KINDS)[number]

type TokenPrice =
  | string
  | { readonly default: string; readonly tiers: readonly { readonly price: string }[] }
type VariantPrice =
  | string
  | {
      readonly default?: string
      readonly variants: readonly (Readonly<Record<string, string>> & { readonly price: string })[]
    }

/** The prices a binding bills by, as GET /api/models returns them. */
export interface RateCard {
  readonly input?: TokenPrice
  readonly output?: TokenPrice
  readonly cacheReadInput?: TokenPrice
  readonly audioOutput?: TokenPrice
  readonly images?: VariantPrice
  readonly characters?: VariantPrice
  readonly audioInputSeconds?: VariantPrice
}

interface CatalogEntry {
  readonly provider: string
  readonly modelId: string
  readonly isDefault: boolean
  readonly name?: string
  readonly description?: string
  readonly rateCard?: RateCard
  readonly [option: string]: unknown
}

interface Catalog {
  readonly language: readonly CatalogEntry[]
  readonly image: readonly CatalogEntry[]
  readonly audio: {
    readonly speech: readonly CatalogEntry[]
    readonly transcription: readonly CatalogEntry[]
  }
}

export async function models(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP.models)
  if (sub === "list") {
    const { options } = parseCommandArgs(rest, { "--kind": "string" }, "models list", 0)
    const kind = options["--kind"] === undefined ? undefined : modelKind(options["--kind"])
    const entries = catalogEntries((await api.get("/api/models")) as Catalog)
    return writeJson(
      entries
        .filter((entry) => kind === undefined || entry.kind === kind)
        .map(({ kind, entry }) => ({
          kind,
          model: entry.modelId,
          provider: entry.provider,
          ...(entry.isDefault ? { default: true } : {}),
          ...(entry.description ? { description: entry.description } : {}),
          price: describePrice(entry.rateCard),
        }))
    )
  }
  if (sub === "get") {
    const { positionals, options } = parseCommandArgs(rest, { "--kind": "string" }, "models get", 1)
    const kind = options["--kind"] === undefined ? undefined : modelKind(options["--kind"])
    const entries = catalogEntries((await api.get("/api/models")) as Catalog)
    const { kind: found, entry } = findModel(entries, positionals[0] ?? "", kind)
    const { provider, modelId, isDefault, rateCard, ...details } = entry
    return writeJson({
      kind: found,
      model: modelId,
      provider,
      default: isDefault,
      ...details,
      price: describePrice(rateCard),
      ...(rateCard ? { rateCard } : {}),
    })
  }
  fail(`Unknown models command '${sub}'.`)
}

function modelKind(value: string): ModelKind {
  const kind = MODEL_KINDS.find((candidate) => candidate === value)
  if (!kind) fail(`Unknown model kind '${value}'. Use one of: ${MODEL_KINDS.join(", ")}.`)
  return kind
}

function catalogEntries(catalog: Catalog): { kind: ModelKind; entry: CatalogEntry }[] {
  return [
    ...catalog.language.map((entry) => ({ kind: "language" as const, entry })),
    ...catalog.image.map((entry) => ({ kind: "image" as const, entry })),
    ...catalog.audio.speech.map((entry) => ({ kind: "speech" as const, entry })),
    ...catalog.audio.transcription.map((entry) => ({ kind: "transcription" as const, entry })),
  ]
}

/**
 * A model by id, or provider:modelId when two providers share an id. An id that names models of
 * several kinds needs --kind.
 */
export function findModel(
  entries: readonly { readonly kind: ModelKind; readonly entry: CatalogEntry }[],
  reference: string,
  kind: ModelKind | undefined
): { kind: ModelKind; entry: CatalogEntry } {
  const separator = reference.indexOf(":")
  const provider = separator > 0 ? reference.slice(0, separator) : undefined
  const modelId = separator > 0 ? reference.slice(separator + 1) : reference
  const matches = entries.filter(
    (candidate) =>
      candidate.entry.modelId === modelId &&
      (provider === undefined || candidate.entry.provider === provider) &&
      (kind === undefined || candidate.kind === kind)
  )
  const [match] = matches
  if (!match) {
    fail(
      `No ${kind === undefined ? "" : `${kind} `}model '${reference}' is configured. Run 'sixb models list'.`
    )
  }
  if (matches.length > 1) {
    const kinds = new Set(matches.map((candidate) => candidate.kind))
    fail(
      kinds.size > 1
        ? `'${reference}' is configured as ${[...kinds].join(" and ")}. Add --kind <kind>.`
        : `'${reference}' is configured by ${matches.map((candidate) => candidate.entry.provider).join(" and ")}. Use provider:${modelId}.`
    )
  }
  return match
}

/**
 * A rate card as people read it: "$0.04 per image", "per image: $0.041 at 768x768, otherwise
 * $0.048", "$3 input · $15 output per 1M tokens".
 */
export function describePrice(card: RateCard | undefined): string {
  if (!card) return "price unknown"
  const parts = [
    variantPrice(card.images, "per image", "at"),
    variantPrice(card.characters, "per 1M characters", "for"),
    variantPrice(card.audioInputSeconds, "per second of audio", "for"),
    card.input !== undefined && card.output !== undefined
      ? `${dollars(tokenPrice(card.input))} input · ${dollars(tokenPrice(card.output))} output per 1M tokens`
      : undefined,
    card.audioOutput === undefined
      ? undefined
      : `${dollars(tokenPrice(card.audioOutput))} per 1M audio tokens`,
  ].filter((part): part is string => part !== undefined)
  return parts.length === 0 ? "price unknown" : parts.join(" · ")
}

function variantPrice(
  price: VariantPrice | undefined,
  unit: string,
  joiner: string
): string | undefined {
  if (price === undefined) return undefined
  if (typeof price === "string") return `${dollars(price)} ${unit}`
  // Variants that all cost the default say nothing a single price doesn't.
  if (price.variants.every((variant) => variant.price === price.default)) {
    return `${dollars(price.default ?? "")} ${unit}`
  }
  const variants = price.variants.map(({ price: amount, ...dimensions }) => {
    const label = Object.values(dimensions).join(" ")
    return `${dollars(amount)} ${joiner} ${label}`
  })
  const otherwise = price.default === undefined ? [] : [`otherwise ${dollars(price.default)}`]
  return `${unit}: ${[...variants, ...otherwise].join(", ")}`
}

// A tiered price reads as its starting rate; `sixb models get` shows the tiers.
function tokenPrice(price: TokenPrice): string {
  return typeof price === "string" ? price : price.default
}

function dollars(amount: string): string {
  return `$${amount}`
}
