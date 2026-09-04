import type { LanguageModelEntry, SixbHostView } from "@sixb/core"
import type { Elysia } from "elysia"
import {
  type LanguageModelDisplay,
  type LanguageModelDisplayResolver,
  ModelsDevDisplayResolver,
} from "../models-dev/display"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ModelCatalogSchema } from "../schemas/models"

function serializeLanguageModel(
  entry: LanguageModelEntry,
  defaultEntry: LanguageModelEntry,
  display: LanguageModelDisplay
) {
  return {
    provider: entry.provider,
    modelId: entry.modelId,
    isDefault: entry.provider === defaultEntry.provider && entry.modelId === defaultEntry.modelId,
    ...display,
  }
}

export interface ModelRouteOptions {
  readonly displayResolver?: LanguageModelDisplayResolver
}

export function registerModelRoutes(
  app: Elysia,
  host: SixbHostView,
  options: ModelRouteOptions = {}
) {
  const displayResolver = options.displayResolver ?? new ModelsDevDisplayResolver()

  return app.get(
    "/api/models",
    async () => {
      const language = host.definitions.models?.language
      const entries = language?.list() ?? []
      const displays = entries.length === 0 ? [] : await displayResolver.resolveAll(entries)
      const serialized = language
        ? entries.map((entry, index) =>
            serializeLanguageModel(entry, language.default, requireModelDisplay(displays, index))
          )
        : []
      return ModelCatalogSchema.parse({
        language: serialized,
      })
    },
    {
      response: { 200: ModelCatalogSchema },
      detail: {
        summary: "List the project model catalog",
        tags: [OPENAPI_TAGS.models.name],
        operationId: "listModels",
      },
    }
  )
}

function requireModelDisplay(
  displays: readonly LanguageModelDisplay[],
  index: number
): LanguageModelDisplay {
  const display = displays[index]
  if (display) return display
  throw new Error("[SixbServer] Model display resolver returned incomplete metadata.")
}
