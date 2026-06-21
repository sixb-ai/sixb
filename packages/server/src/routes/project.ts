import type { OntologySource, Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { SIXB_BEARER_SECURITY_REQUIREMENT } from "../openapi/security"
import { ProjectInfoResponseSchema } from "../schemas/project"

export function registerProjectRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app.get("/api/project", async () => ({ id: sixb.id }), {
    response: { 200: ProjectInfoResponseSchema },
    detail: {
      summary: "Get current project metadata",
      tags: ["Project"],
      operationId: "getProjectInfo",
      security: SIXB_BEARER_SECURITY_REQUIREMENT,
    },
  })
}
