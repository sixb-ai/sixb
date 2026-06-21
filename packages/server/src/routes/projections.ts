import { isAllowed, type OntologySource, type ProjectionDefinition, type Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { requestAuthState } from "../auth/scope"
import { ErrorResponseSchema } from "../schemas/common"
import {
  ProjectionListResponseSchema,
  ProjectionParamsSchema,
  ProjectionResponseSchema,
} from "../schemas/projections"

function canViewProjection(
  authz: ReturnType<typeof requestAuthState>["authz"],
  projection: ProjectionDefinition
) {
  return isAllowed(authz, { kind: "dataset.view", datasetId: projection.datasetId })
}

export function registerProjectionRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/projections",
      (context) => {
        const { authz } = requestAuthState(context)
        return {
          objectProjections: [...sixb.getObjectProjections()].filter((projection) =>
            canViewProjection(authz, projection)
          ),
          linkProjections: [...sixb.getLinkProjections()].filter((projection) =>
            canViewProjection(authz, projection)
          ),
          telemetryProjections: [...sixb.getTelemetryProjections()].filter((projection) =>
            canViewProjection(authz, projection)
          ),
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
      (context) => {
        const { params, set } = context
        const { authz } = requestAuthState(context)
        const all = [
          ...sixb.getObjectProjections(),
          ...sixb.getLinkProjections(),
          ...sixb.getTelemetryProjections(),
        ]
        const found = all.find((p) => p.id === params.projectionId)
        if (!found || !canViewProjection(authz, found)) {
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
