import type { LanguageModelEntry, SixbHostView } from "@sixb/core"
import type {
  ImageModelEntry,
  ModelDefinition,
  ModelRateCard,
  SpeechModelEntry,
  TranscriptionModelEntry,
} from "@sixb/core/models"
import type { Elysia } from "elysia"
import { languageModelDisplay, rateCardDisplay, resolvedForDisplay } from "../models/display"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ModelCatalogSchema } from "../schemas/models"

async function serializeLanguageModel(entry: LanguageModelEntry, defaultEntry: LanguageModelEntry) {
  return {
    ...(await languageModelDisplay(entry)),
    provider: entry.provider,
    modelId: entry.modelId,
    isDefault: entry.provider === defaultEntry.provider && entry.modelId === defaultEntry.modelId,
    ...(entry.model.defaultReasoning === undefined
      ? {}
      : { defaultReasoning: entry.model.defaultReasoning }),
  }
}

/** What every kind's entry shares: identity, the default, how to describe it, and its prices. */
function catalogEntry(
  entry: { readonly provider: string; readonly modelId: string },
  defaultEntry: { readonly provider: string; readonly modelId: string },
  model: { readonly definition: ModelDefinition; readonly rateCard?: ModelRateCard }
) {
  const definition = model.definition
  return {
    provider: entry.provider,
    modelId: entry.modelId,
    isDefault: entry.provider === defaultEntry.provider && entry.modelId === defaultEntry.modelId,
    name: definition.name ?? entry.modelId,
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.via ? { via: definition.via } : {}),
    ...rateCardDisplay(model.rateCard),
  }
}

async function serializeImageModel(entry: ImageModelEntry, defaultEntry: ImageModelEntry) {
  const model = await resolvedForDisplay(entry)
  const definition = model.definition
  return {
    ...catalogEntry(entry, defaultEntry, model),
    ...(definition.maxImagesPerCall === undefined
      ? {}
      : { maxImagesPerCall: definition.maxImagesPerCall }),
    ...(definition.sizes ? { sizes: [...definition.sizes] } : {}),
    ...(definition.aspectRatios ? { aspectRatios: [...definition.aspectRatios] } : {}),
    ...(definition.qualities ? { qualities: [...definition.qualities] } : {}),
    ...(definition.styles ? { styles: [...definition.styles] } : {}),
    ...(definition.inputImages
      ? {
          inputImages: {
            maxCount: definition.inputImages.maxCount,
            maxBytes: definition.inputImages.maxBytes,
            ...(definition.inputImages.mediaTypes
              ? { mediaTypes: [...definition.inputImages.mediaTypes] }
              : {}),
          },
        }
      : {}),
  }
}

async function serializeSpeechModel(entry: SpeechModelEntry, defaultEntry: SpeechModelEntry) {
  const model = await resolvedForDisplay(entry)
  const definition = model.definition
  return {
    ...catalogEntry(entry, defaultEntry, model),
    ...(model.defaultVoice === undefined ? {} : { defaultVoice: model.defaultVoice }),
    ...(definition.voices ? { voices: [...definition.voices] } : {}),
    ...(definition.outputMediaTypes ? { outputMediaTypes: [...definition.outputMediaTypes] } : {}),
    ...(definition.maxInputCharacters === undefined
      ? {}
      : { maxInputCharacters: definition.maxInputCharacters }),
    ...(definition.instructions === undefined ? {} : { instructions: definition.instructions }),
  }
}

async function serializeTranscriptionModel(
  entry: TranscriptionModelEntry,
  defaultEntry: TranscriptionModelEntry
) {
  const model = await resolvedForDisplay(entry)
  const definition = model.definition
  return {
    ...catalogEntry(entry, defaultEntry, model),
    maxInputBytes: definition.maxInputBytes,
    ...(definition.mediaTypes ? { mediaTypes: [...definition.mediaTypes] } : {}),
  }
}

export function registerModelRoutes(app: Elysia, host: SixbHostView) {
  return app.get(
    "/api/models",
    async () => {
      const models = host.definitions.models
      const language = models?.language
      const image = models?.image
      const speech = models?.audio?.speech
      const transcription = models?.audio?.transcription
      return ModelCatalogSchema.parse({
        language: language
          ? await Promise.all(
              language.list().map((entry) => serializeLanguageModel(entry, language.default))
            )
          : [],
        image: image
          ? await Promise.all(
              image.list().map((entry) => serializeImageModel(entry, image.default))
            )
          : [],
        audio: {
          speech: speech
            ? await Promise.all(
                speech.list().map((entry) => serializeSpeechModel(entry, speech.default))
              )
            : [],
          transcription: transcription
            ? await Promise.all(
                transcription
                  .list()
                  .map((entry) => serializeTranscriptionModel(entry, transcription.default))
              )
            : [],
        },
      })
    },
    {
      response: { 200: ModelCatalogSchema },
      detail: {
        summary: "List the project's models of every kind, with their options and prices",
        tags: [OPENAPI_TAGS.models.name],
        operationId: "listModels",
      },
    }
  )
}
