import type { DatasetDefinition, SixbHostView } from "@sixb/core"
import { getDefinitionsManifestReader } from "@sixb/core/internal/manifest"
import type { Elysia } from "elysia"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { DefinitionsManifestSchema } from "../schemas/definitions"
import { handleRouteError } from "../utils/http"

export function registerDefinitionRoutes(app: Elysia, _host: SixbHostView) {
  return app.get(
    "/api/definitions",
    async (context) => {
      try {
        const manifest = await getDefinitionsManifestReader(requireRequestSixb(context)).read()
        return {
          ...manifest,
          definitions: [...manifest.definitions],
          projections: [...manifest.projections],
          datasets: manifest.datasets.map(serializeDataset),
        }
      } catch (error) {
        return handleRouteError(error, context.set)
      }
    },
    {
      response: { 200: DefinitionsManifestSchema, 403: ErrorResponseSchema },
      detail: {
        summary: "Describe the project's definitions",
        description:
          "Every definition this runtime runs, with the file that declares it and a hash, so two runtimes such as production and a branch can be compared.",
        tags: [OPENAPI_TAGS.project.name],
        operationId: "getDefinitionsManifest",
        security: accessTokenSecurityRequirement("getDefinitionsManifest"),
      },
    }
  )
}

function serializeDataset(dataset: DatasetDefinition) {
  const { primaryKey, partitionBy } = dataset
  return {
    kind: dataset.kind,
    id: dataset.id,
    schema: {
      columns: dataset.schema.columns.map(({ markings, ...column }) => ({
        ...column,
        ...(markings ? { markings: [...markings] } : {}),
      })),
    },
    ...(primaryKey === undefined
      ? {}
      : { primaryKey: typeof primaryKey === "string" ? primaryKey : [...primaryKey] }),
    ...(dataset.sequenceBy === undefined ? {} : { sequenceBy: dataset.sequenceBy }),
    ...(partitionBy === undefined ? {} : { partitionBy: [...partitionBy] }),
    ...(dataset.description === undefined ? {} : { description: dataset.description }),
  }
}
