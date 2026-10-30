import { access, mkdir, stat } from "node:fs/promises"
import { dirname, extname, join, parse } from "node:path"
import type { ApiClient } from "../api-client"
import { enumValue, integerInRange, isHelp, parseCommandArgs, requestsHelp } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { idSegment, readText } from "./shared"

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
  readonly tier?: string
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
          ...(entry.tier ? { tier: entry.tier } : {}),
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
  if (sub === "text") return generateText(api, rest)
  if (sub === "image") return generateImages(api, rest)
  if (sub === "speech") return generateSpeech(api, rest)
  if (sub === "transcribe") return transcribe(api, rest)
  if (sub === "calls") return calls(api, rest)
  fail(`Unknown models command '${sub}'.`)
}

interface FileRef {
  readonly blobId: string
  readonly mediaType?: string
  readonly sizeBytes: number
}

interface CallResult {
  readonly callId: string
  readonly model: { readonly provider: string; readonly modelId: string }
  readonly cost: { readonly status: string; readonly money?: { readonly amountNanos: string } }
  readonly text?: string
  readonly finishReason?: string
  readonly files?: readonly FileRef[]
  readonly warnings?: readonly string[]
}

const SPEECH_FORMATS = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
} as const
const SPEECH_FORMAT_NAMES = Object.keys(SPEECH_FORMATS) as (keyof typeof SPEECH_FORMATS)[]

// Files the commands upload, and the extension a downloaded file takes from its media type.
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".opus": "audio/opus",
  ".m4a": "audio/mp4",
  ".webm": "audio/webm",
}
const EXTENSIONS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MEDIA_TYPES)
    .filter(([extension]) => extension !== ".jpeg")
    .map(([extension, mediaType]) => [mediaType, extension])
)

async function generateText(api: ApiClient, args: readonly string[]): Promise<void> {
  const { positionals, options } = parseCommandArgs(
    args,
    {
      "--model": "string",
      "--instructions": "string",
      "--max-output-tokens": "string",
      "--reasoning": "string",
      "--file": "string",
    },
    "models text",
    [0, 1]
  )
  const prompt = await readPrompt(positionals[0], options["--file"])
  const maxOutputTokens = options["--max-output-tokens"]
  const result = (await api.post("/api/models/language/generations", {
    ...(await languageModelRef(api, options["--model"])),
    prompt,
    ...(options["--instructions"] === undefined ? {} : { instructions: options["--instructions"] }),
    ...(maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: integerInRange("--max-output-tokens", maxOutputTokens, 1, 1_000_000) }),
    ...(options["--reasoning"] === undefined ? {} : { reasoning: options["--reasoning"] }),
  })) as CallResult
  writeJson({
    callId: result.callId,
    model: result.model.modelId,
    text: result.text,
    finishReason: result.finishReason,
    cost: describeCost(result.cost),
  })
}

async function generateImages(api: ApiClient, args: readonly string[]): Promise<void> {
  const { positionals, options } = parseCommandArgs(
    args,
    {
      "--output": "string",
      "--model": "string",
      "--n": "string",
      "--size": "string",
      "--aspect-ratio": "string",
      "--quality": "string",
      "--style": "string",
      "--seed": "string",
      "--image": "strings",
    },
    "models image",
    1
  )
  const output = requireOutput(options["--output"], "models image")
  const seed = options["--seed"]
  if (seed !== undefined && !/^-?[0-9]+$/.test(seed)) fail("--seed must be an integer.")
  const model = await modelRef(api, options["--model"], "image")
  const images = []
  for (const path of options["--image"] ?? []) images.push(await uploadInput(api, path, "image"))
  const result = (await api.post("/api/models/image/generations", {
    ...model,
    prompt: positionals[0],
    ...(options["--n"] === undefined ? {} : { n: integerInRange("--n", options["--n"], 1, 100) }),
    ...optional("size", options["--size"]),
    ...optional("aspectRatio", options["--aspect-ratio"]),
    ...optional("quality", options["--quality"]),
    ...optional("style", options["--style"]),
    ...(seed === undefined ? {} : { seed: Number(seed) }),
    ...(images.length > 0 ? { images } : {}),
  })) as CallResult
  writeJson(await savedResult(api, result, output))
}

async function generateSpeech(api: ApiClient, args: readonly string[]): Promise<void> {
  const { positionals, options } = parseCommandArgs(
    args,
    {
      "--output": "string",
      "--model": "string",
      "--voice": "string",
      "--format": "string",
      "--instructions": "string",
      "--speed": "string",
      "--language": "string",
    },
    "models speech",
    1
  )
  const output = requireOutput(options["--output"], "models speech")
  const format = options["--format"]
  const speed = options["--speed"]
  if (speed !== undefined && !(Number(speed) > 0)) fail("--speed must be a positive number.")
  const result = (await api.post("/api/models/audio/speech", {
    ...(await modelRef(api, options["--model"], "speech")),
    text: positionals[0],
    ...optional("voice", options["--voice"]),
    ...(format === undefined
      ? {}
      : { mediaType: SPEECH_FORMATS[enumValue("--format", format, SPEECH_FORMAT_NAMES)] }),
    ...optional("instructions", options["--instructions"]),
    ...(speed === undefined ? {} : { speed: Number(speed) }),
    ...optional("language", options["--language"]),
  })) as CallResult
  writeJson(await savedResult(api, result, output))
}

async function transcribe(api: ApiClient, args: readonly string[]): Promise<void> {
  const { positionals, options } = parseCommandArgs(
    args,
    { "--model": "string" },
    "models transcribe",
    1
  )
  const model = await modelRef(api, options["--model"], "transcription")
  const audio = await uploadInput(api, positionals[0] ?? "", "audio")
  const result = (await api.post("/api/models/audio/transcriptions", {
    ...model,
    audio,
  })) as CallResult
  writeJson({
    callId: result.callId,
    model: result.model.modelId,
    text: result.text,
    cost: describeCost(result.cost),
  })
}

async function calls(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (sub !== "files")
    fail(`Unknown models calls command '${sub ?? ""}'. Use 'models calls files'.`)
  const { positionals, options } = parseCommandArgs(
    rest,
    { "--output": "string" },
    "models calls files",
    1
  )
  const callId = positionals[0] ?? ""
  const call = (await api.get(`/api/ai/model-calls/${idSegment(callId)}/files`)) as {
    readonly callId: string
    readonly files: readonly FileRef[]
  }
  const output = options["--output"]
  if (output === undefined) return writeJson(call)
  writeJson({ callId: call.callId, files: await saveFiles(api, call.callId, call.files, output) })
}

/** A --model reference as the request body names it; absent, the kind's default answers. */
async function modelRef(
  api: ApiClient,
  reference: string | undefined,
  kind: ModelKind
): Promise<{ model?: { provider: string; modelId: string } }> {
  if (reference === undefined) return {}
  const { entry } = findModel(
    catalogEntries((await api.get("/api/models")) as Catalog),
    reference,
    kind
  )
  return { model: { provider: entry.provider, modelId: entry.modelId } }
}

// The tiers of `models.language`, restated: this package depends on no other Sixb package.
const LANGUAGE_TIERS = ["light", "standard", "heavy"] as const

/**
 * A text request's --model: a tier goes to the server as is, which answers with that tier's model,
 * or the default when the project configures no such tier. Anything else names a model.
 */
async function languageModelRef(
  api: ApiClient,
  reference: string | undefined
): Promise<{ model?: string | { provider: string; modelId: string } }> {
  const tier = LANGUAGE_TIERS.find((candidate) => candidate === reference)
  if (tier !== undefined) return { model: tier }
  return modelRef(api, reference, "language")
}

/** The prompt given as an argument, or read from --file: a path, or - for standard input. */
async function readPrompt(
  argument: string | undefined,
  source: string | undefined
): Promise<string> {
  if (argument !== undefined && source !== undefined) {
    fail("models text takes its prompt as an argument or from --file, not both.")
  }

  const prompt = source === undefined ? argument : await readText(source, "Prompt file")
  if (prompt === undefined) {
    fail('models text requires a prompt: "<prompt>", or --file <path|-> to read it.')
  }
  if (!prompt.trim()) fail("The prompt is empty.")
  return prompt
}

function requireOutput(output: string | undefined, command: string): string {
  if (!output) fail(`${command} requires --output <path>: a file, or a directory ending in /.`)
  return output
}

function optional(field: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [field]: value }
}

async function uploadInput(api: ApiClient, path: string, kind: "image" | "audio") {
  try {
    await access(path)
  } catch {
    fail(`Input file '${path}' does not exist.`)
  }
  const mediaType = MEDIA_TYPES[extname(path).toLowerCase()]
  if (!mediaType?.startsWith(`${kind}/`)) {
    const accepted = Object.entries(MEDIA_TYPES)
      .filter(([, type]) => type.startsWith(`${kind}/`))
      .map(([extension]) => extension)
    fail(`'${path}' is not an ${kind} file. Use ${accepted.join(", ")}.`)
  }
  return api.upload("/api/files", path, undefined, mediaType)
}

async function savedResult(api: ApiClient, result: CallResult, output: string) {
  return {
    callId: result.callId,
    model: result.model.modelId,
    files: await saveFiles(api, result.callId, result.files ?? [], output),
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    cost: describeCost(result.cost),
  }
}

/**
 * Download a call's files. A directory (an existing one, or a path ending in /) receives
 * `<call-id>.<ext>`; a file path is used as given, numbered when there are several. Either way the
 * extension follows the file's media type, so the paths written are the ones returned.
 */
async function saveFiles(
  api: ApiClient,
  callId: string,
  files: readonly FileRef[],
  output: string
): Promise<string[]> {
  const directory = output.endsWith("/") || (await stat(output).catch(() => null))?.isDirectory()
  const paths = files.map((file, index) => {
    const number = files.length > 1 ? `-${index + 1}` : ""
    const extension = (file.mediaType && EXTENSIONS[file.mediaType]) ?? ""
    if (directory) return join(output, `${callId}${number}${extension || ".bin"}`)
    const { dir, name, ext } = parse(output)
    return join(dir, `${name}${number}${extension || ext}`)
  })
  for (const [index, path] of paths.entries()) {
    await mkdir(dirname(path), { recursive: true })
    await api.download(`/api/ai/model-calls/${idSegment(callId)}/files/content`, path, {
      path: `/files/${index}`,
    })
  }
  return paths
}

/** What a call cost, in USD, as the provider reported it or the binding's card rated it. */
export function describeCost(cost: CallResult["cost"]): string {
  if (!cost.money) return "unknown"
  const nanos = BigInt(cost.money.amountNanos)
  const whole = nanos / 1_000_000_000n
  const fraction = (nanos % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "")
  return `$${whole}${fraction ? `.${fraction}` : ""}`
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
 * A model by id, or provider:modelId when two providers share an id. An id may itself hold a
 * colon, so the whole reference is tried as an id first. An id that names models of several
 * kinds needs --kind.
 */
export function findModel(
  entries: readonly { readonly kind: ModelKind; readonly entry: CatalogEntry }[],
  reference: string,
  kind: ModelKind | undefined
): { kind: ModelKind; entry: CatalogEntry } {
  const ofKind = entries.filter((candidate) => kind === undefined || candidate.kind === kind)
  let matches = ofKind.filter((candidate) => candidate.entry.modelId === reference)
  const separator = reference.indexOf(":")
  if (matches.length === 0 && separator > 0) {
    const provider = reference.slice(0, separator)
    const modelId = reference.slice(separator + 1)
    matches = ofKind.filter(
      (candidate) => candidate.entry.provider === provider && candidate.entry.modelId === modelId
    )
  }
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
        : `'${reference}' is configured by ${matches.map((candidate) => candidate.entry.provider).join(" and ")}. Use provider:${reference}.`
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
  const only = price.default
  if (only !== undefined && price.variants.every((variant) => variant.price === only)) {
    return `${dollars(only)} ${unit}`
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
