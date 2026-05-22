import type { OntologySource, Pario } from "@pario/core"
import type { Elysia } from "elysia"
import { ErrorResponseSchema } from "../schemas/common"
import {
  ProjectionListResponseSchema,
  ProjectionParamsSchema,
  ProjectionResponseSchema,
} from "../schemas/projections"

export function registerProjectionRoutes(app: Elysia, pario: Pario<readonly OntologySource[]>) {
  return app
    .get(
      "/api/projections",
      () => {
        return {
          objectProjections: [...pario.getObjectProjections()],
          linkProjections: [...pario.getLinkProjections()],
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
        const all = [...pario.getObjectProjections(), ...pario.getLinkProjections()]
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
