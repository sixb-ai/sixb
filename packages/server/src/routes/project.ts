import type { OntologySource, Pario } from "@pario/core"
import type { Elysia } from "elysia"
import { ProjectInfoResponseSchema } from "../schemas/project"

export function registerProjectRoutes(app: Elysia, pario: Pario<readonly OntologySource[]>) {
  return app.get("/api/project", async () => ({ id: pario.id }), {
    response: { 200: ProjectInfoResponseSchema },
    detail: {
      summary: "Get current project metadata",
      tags: ["Project"],
      operationId: "getProjectInfo",
    },
  })
}
