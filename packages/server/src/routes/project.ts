import type { OntologySource, Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ProjectInfoResponseSchema } from "../schemas/project"
export function registerProjectRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app.get("/api/project", async () => ({ id: sixb.id }), {
    response: { 200: ProjectInfoResponseSchema },
    detail: {
      summary: "Get current project metadata",
      tags: [OPENAPI_TAGS.project.name],
      operationId: "getProjectInfo",
      security: bearerSecurityRequirement("getProjectInfo"),
    },
  })
}
