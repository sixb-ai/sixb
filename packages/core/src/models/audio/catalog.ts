import type { ModelRef } from "../catalog"
import { indexModelBindings } from "../catalog-index"
import type { SpeechModel, TranscriptionModel } from "./types"

export interface TranscriptionModelEntry extends ModelRef {
  readonly model: TranscriptionModel
}

export interface TranscriptionModelCatalog {
  readonly default: TranscriptionModelEntry
  list(): readonly TranscriptionModelEntry[]
  getByRef(ref: ModelRef): TranscriptionModelEntry | null
}

export interface SpeechModelEntry extends ModelRef {
  readonly model: SpeechModel
}

export interface SpeechModelCatalog {
  readonly default: SpeechModelEntry
  list(): readonly SpeechModelEntry[]
  getByRef(ref: ModelRef): SpeechModelEntry | null
}

export interface AudioModelCatalog {
  readonly transcription?: TranscriptionModelCatalog
  readonly speech?: SpeechModelCatalog
}

export interface AudioModelCatalogInput {
  /** Ordered; the first entry is the default transcriber. */
  readonly transcription?: readonly TranscriptionModel[]
  /** Ordered; the first entry is the default speech model. */
  readonly speech?: readonly SpeechModel[]
}

export function createAudioCatalog(
  input: AudioModelCatalogInput | undefined
): AudioModelCatalog | undefined {
  if (input === undefined) return undefined
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (input.transcription === undefined && input.speech === undefined)
  ) {
    throw new TypeError("[Sixb] models.audio must configure transcription or speech models.")
  }

  const transcription = familyCatalog(
    input.transcription,
    "transcription",
    assertTranscriptionModel
  )
  const speech = familyCatalog(input.speech, "speech", assertSpeechModel)
  return Object.freeze({
    ...(transcription === undefined ? {} : { transcription }),
    ...(speech === undefined ? {} : { speech }),
  })
}

function familyCatalog<TModel extends { readonly providerId: string; readonly modelId: string }>(
  models: readonly TModel[] | undefined,
  family: "transcription" | "speech",
  validate: (model: TModel) => void
) {
  if (models === undefined) return undefined
  if (!Array.isArray(models)) {
    throw new TypeError(
      `[Sixb] models.audio.${family} must be a nonempty array of ${family} models.`
    )
  }

  const index = indexModelBindings(models, `audio.${family}`, validate)
  const [defaultEntry] = index.list()
  if (!defaultEntry) {
    throw new TypeError(`[Sixb] models.audio.${family} must contain at least one model.`)
  }
  return Object.freeze({ ...index, default: defaultEntry })
}

export function assertTranscriptionModel(model: unknown): asserts model is TranscriptionModel {
  const candidate = model as Partial<TranscriptionModel> | null
  const definition = candidate?.definition
  if (
    !candidate ||
    !isValidId(candidate.providerId) ||
    !isValidId(candidate.modelId) ||
    typeof candidate.transcribe !== "function" ||
    definition?.kind !== "transcription" ||
    definition.providerId !== candidate.providerId ||
    definition.modelId !== candidate.modelId
  ) {
    throw invalidModel()
  }

  if (!Number.isSafeInteger(definition.maxInputBytes) || definition.maxInputBytes <= 0) {
    throw invalidModel()
  }

  const mediaTypes = definition.mediaTypes
  if (
    mediaTypes !== undefined &&
    (!Array.isArray(mediaTypes) ||
      mediaTypes.length === 0 ||
      !mediaTypes.every((type) => typeof type === "string" && /^audio\/[a-z0-9.+-]+$/.test(type)))
  ) {
    throw invalidModel()
  }
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
}

function invalidModel(): TypeError {
  return new TypeError(
    "[SixbModels] Invalid transcription model identity, definition or input limits."
  )
}

export function assertSpeechModel(model: unknown): asserts model is SpeechModel {
  const candidate = model as Partial<SpeechModel> | null
  const definition = candidate?.definition
  if (
    !candidate ||
    !isValidId(candidate.providerId) ||
    !isValidId(candidate.modelId) ||
    typeof candidate.speak !== "function" ||
    definition?.kind !== "speech" ||
    definition.providerId !== candidate.providerId ||
    definition.modelId !== candidate.modelId
  ) {
    throw invalidSpeechModel("identity")
  }

  const limit = definition.maxInputCharacters
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw invalidSpeechModel("maxInputCharacters")
  }
  if (!isOptionalList(definition.voices)) throw invalidSpeechModel("voices")
  if (
    !isOptionalList(definition.outputMediaTypes) ||
    definition.outputMediaTypes?.some((type) => !/^audio\/[a-z0-9.+-]+$/.test(type))
  ) {
    throw invalidSpeechModel("outputMediaTypes")
  }
  if (definition.instructions !== undefined && typeof definition.instructions !== "boolean") {
    throw invalidSpeechModel("instructions")
  }
  if (
    candidate.defaultVoice !== undefined &&
    (!isValidId(candidate.defaultVoice) ||
      (definition.voices !== undefined && !definition.voices.includes(candidate.defaultVoice)))
  ) {
    throw invalidSpeechModel("defaultVoice")
  }
}

function isOptionalList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.length > 0 && value.every((entry) => isValidId(entry)))
  )
}

function invalidSpeechModel(field: string): TypeError {
  return new TypeError(`[SixbModels] Invalid speech model ${field}.`)
}
