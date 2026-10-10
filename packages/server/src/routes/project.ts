import type { SixbHostView } from "@sixb/core"
import type { Elysia } from "elysia"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ProjectInfoResponseSchema } from "../schemas/project"
export function registerProjectRoutes(app: Elysia, host: SixbHostView) {
  const project = { id: host.id, locale: host.locale, timeZone: host.timeZone }
  return app.get("/api/project", async () => project, {
    response: { 200: ProjectInfoResponseSchema },
    detail: {
      summary: "Get current project metadata",
      tags: [OPENAPI_TAGS.project.name],
      operationId: "getProjectInfo",
      security: accessTokenSecurityRequirement("getProjectInfo"),
    },
  })
}
