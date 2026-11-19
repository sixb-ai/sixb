import type { ModelRef } from "../catalog"
import { indexModelBindings } from "../catalog-index"
import type { VideoModel } from "./types"

export interface VideoModelEntry extends ModelRef {
  readonly model: VideoModel
}

export interface VideoModelCatalog {
  readonly default: VideoModelEntry
  list(): readonly VideoModelEntry[]
  getByRef(ref: ModelRef): VideoModelEntry | null
}

export function createVideoCatalog(
  models: readonly VideoModel[] | undefined
): VideoModelCatalog | undefined {
  if (models === undefined) return undefined
  if (!Array.isArray(models)) {
    throw new TypeError("[Sixb] models.video must be a nonempty array of video models.")
  }

  const index = indexModelBindings(models, "video", assertVideoModel)
  const [defaultEntry] = index.list()
  if (!defaultEntry) {
    throw new TypeError("[Sixb] models.video must contain at least one model.")
  }

  return Object.freeze({ ...index, default: defaultEntry })
}

export function assertVideoModel(model: unknown): asserts model is VideoModel {
  const candidate = model as Partial<VideoModel> | null
  const definition = candidate?.definition
  if (
    !candidate ||
    !isValidId(candidate.providerId) ||
    !isValidId(candidate.modelId) ||
    typeof candidate.start !== "function" ||
    typeof candidate.status !== "function" ||
    definition?.kind !== "video" ||
    definition.providerId !== candidate.providerId ||
    definition.modelId !== candidate.modelId
  ) {
    throw invalidModel("identity")
  }

  if (
    definition.maxVideosPerCall !== undefined &&
    !isPositiveInteger(definition.maxVideosPerCall)
  ) {
    throw invalidModel("maxVideosPerCall")
  }
  for (const field of ["resolutions", "aspectRatios"] as const) {
    if (!isOptionalList(definition[field])) throw invalidModel(field)
  }
  if (
    definition.durations !== undefined &&
    (!Array.isArray(definition.durations) ||
      definition.durations.length === 0 ||
      !definition.durations.every(isPositiveInteger))
  ) {
    throw invalidModel("durations")
  }
  if (definition.audio !== undefined && typeof definition.audio !== "boolean") {
    throw invalidModel("audio")
  }

  const inputImages = definition.inputImages
  if (
    inputImages !== undefined &&
    (!inputImages ||
      !isPositiveInteger(inputImages.maxCount) ||
      !isPositiveInteger(inputImages.maxBytes) ||
      !isOptionalList(inputImages.mediaTypes) ||
      inputImages.mediaTypes?.some((type) => !/^image\/[a-z0-9.+-]+$/.test(type)))
  ) {
    throw invalidModel("inputImages")
  }
}

function isOptionalList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length > 0 &&
      value.every((entry) => typeof entry === "string" && entry.trim() === entry && entry))
  )
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
}

function invalidModel(field: string): TypeError {
  return new TypeError(`[SixbModels] Invalid video model ${field}.`)
}
