import type { ModelRef } from "../catalog"
import { indexModelBindings } from "../catalog-index"
import type { ImageModel } from "./types"

export interface ImageModelEntry extends ModelRef {
  readonly model: ImageModel
}

export interface ImageModelCatalog {
  readonly default: ImageModelEntry
  list(): readonly ImageModelEntry[]
  getByRef(ref: ModelRef): ImageModelEntry | null
}

export function createImageCatalog(
  models: readonly ImageModel[] | undefined
): ImageModelCatalog | undefined {
  if (models === undefined) return undefined
  if (!Array.isArray(models)) {
    throw new TypeError("[Sixb] models.image must be a nonempty array of image models.")
  }

  const index = indexModelBindings(models, "image", assertImageModel)
  const [defaultEntry] = index.list()
  if (!defaultEntry) {
    throw new TypeError("[Sixb] models.image must contain at least one model.")
  }

  return Object.freeze({ ...index, default: defaultEntry })
}

export function assertImageModel(model: unknown): asserts model is ImageModel {
  const candidate = model as Partial<ImageModel> | null
  const definition = candidate?.definition
  if (
    !candidate ||
    !isValidId(candidate.providerId) ||
    !isValidId(candidate.modelId) ||
    typeof candidate.generate !== "function" ||
    definition?.kind !== "image" ||
    definition.providerId !== candidate.providerId ||
    definition.modelId !== candidate.modelId
  ) {
    throw invalidModel("identity")
  }

  if (
    definition.maxImagesPerCall !== undefined &&
    !isPositiveInteger(definition.maxImagesPerCall)
  ) {
    throw invalidModel("maxImagesPerCall")
  }
  for (const field of ["sizes", "aspectRatios", "qualities", "styles"] as const) {
    if (!isOptionalList(definition[field])) throw invalidModel(field)
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
  return new TypeError(`[SixbModels] Invalid image model ${field}.`)
}
