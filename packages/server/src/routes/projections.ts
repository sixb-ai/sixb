import type { OntologySource, Sixb } from "@sixb/core"
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
          telemetryProjections: [...sixb.getTelemetryProjections()],
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
        return found
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
