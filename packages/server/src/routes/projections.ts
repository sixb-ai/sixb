import type {
  OntologySource,
  ProjectionDefinition,
  Sixb,
  TelemetryProjectionDefinition,
} from "@sixb/core"
import type { Elysia } from "elysia"
import { ErrorResponseSchema } from "../schemas/common"
import {
  ProjectionListResponseSchema,
  ProjectionParamsSchema,
  ProjectionResponseSchema,
} from "../schemas/projections"

export function registerProjectionRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/projections",
      () => {
        return {
          objectProjections: [...sixb.getObjectProjections()],
          linkProjections: [...sixb.getLinkProjections()],
          telemetryProjections: sixb.getTelemetryProjections().map(serializeTelemetryProjection),
        }
      },
      {
        response: { 200: ProjectionListResponseSchema },
        detail: {
          summary: "List all projection definitions",
          tags: ["Projections"],
          operationId: "listProjections",
        },
      }
    )
    .get(
      "/api/projections/:projectionId",
      ({ params, set }) => {
        const all = [
          ...sixb.getObjectProjections(),
          ...sixb.getLinkProjections(),
          ...sixb.getTelemetryProjections(),
        ]
        const found = all.find((p) => p.id === params.projectionId)
        if (!found) {
          set.status = 404
          return { error: `Projection '${params.projectionId}' not found` }
        }
        return serializeProjection(found)
      },
      {
        params: ProjectionParamsSchema,
        response: { 200: ProjectionResponseSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get a projection definition by id",
          tags: ["Projections"],
          operationId: "getProjection",
        },
      }
    )
}

function serializeProjection(projection: ProjectionDefinition) {
  if (projection._tag !== "TelemetryProjectionDefinition") {
    return projection
  }

  return serializeTelemetryProjection(projection)
}

function serializeTelemetryProjection(projection: TelemetryProjectionDefinition) {
  return {
    _tag: projection._tag,
    id: projection.id,
    objectTypeId: projection.objectTypeId,
    propertyId: projection.propertyId,
    datasetId: projection.datasetId,
    objectIdField: projection.objectIdField,
    atField: projection.atField,
    valueField: projection.valueField,
    ...(projection.unitField !== undefined ? { unitField: projection.unitField } : {}),
  }
}
