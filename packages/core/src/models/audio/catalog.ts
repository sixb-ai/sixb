import type { ModelRef } from "../catalog"
import { indexModelBindings } from "../catalog-index"
import type { TranscriptionModel } from "./types"

export interface TranscriptionModelEntry extends ModelRef {
  readonly model: TranscriptionModel
}

export interface TranscriptionModelCatalog {
  readonly default: TranscriptionModelEntry
  list(): readonly TranscriptionModelEntry[]
  getByRef(ref: ModelRef): TranscriptionModelEntry | null
}

export interface AudioModelCatalog {
  readonly transcription?: TranscriptionModelCatalog
}

export interface AudioModelCatalogInput {
  /** Ordered; the first entry is the default transcriber. */
  readonly transcription?: readonly TranscriptionModel[]
}

export function createAudioCatalog(
  input: AudioModelCatalogInput | undefined
): AudioModelCatalog | undefined {
  if (input === undefined) return undefined
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !Array.isArray(input.transcription)
  ) {
    throw new TypeError(
      "[Sixb] models.audio.transcription must be a nonempty array of transcription models."
    )
  }

  const index = indexModelBindings(
    input.transcription,
    "audio.transcription",
    assertTranscriptionModel
  )
  const [defaultEntry] = index.list()
  if (!defaultEntry) {
    throw new TypeError("[Sixb] models.audio.transcription must contain at least one model.")
  }

  return Object.freeze({ transcription: Object.freeze({ ...index, default: defaultEntry }) })
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
