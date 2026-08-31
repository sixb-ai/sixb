import type { LanguageModelEntry, SixbHostView } from "@sixb/core"
import type { Elysia } from "elysia"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ModelCatalogSchema } from "../schemas/models"

function serializeLanguageModel(entry: LanguageModelEntry, defaultEntry: LanguageModelEntry) {
  return {
    provider: entry.provider,
    modelId: entry.modelId,
    isDefault: entry.provider === defaultEntry.provider && entry.modelId === defaultEntry.modelId,
  }
}

export function registerModelRoutes(app: Elysia, host: SixbHostView) {
  return app.get(
    "/api/models",
    () => {
      const language = host.definitions.models?.language
      return ModelCatalogSchema.parse({
        language:
          language === undefined
            ? []
            : language.list().map((entry) => serializeLanguageModel(entry, language.default)),
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
