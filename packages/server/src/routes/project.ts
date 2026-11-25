import type { SixbHostView } from "@sixb/core"
import { branchRuntimeOf } from "@sixb/core/internal/branches"
import type { Elysia } from "elysia"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ProjectInfoResponseSchema } from "../schemas/project"

/**
 * What the app reads once when it loads. On a branch it says which, for the banner every page
 * draws: its name, when production took its copy, and, on a branch production runs, production's
 * app, where the banner goes back to and refreshes it.
 */
export function registerProjectRoutes(app: Elysia, host: SixbHostView) {
  const branch = host.branch
  const runtime = branchRuntimeOf(host)
  const project = {
    id: host.id,
    locale: host.locale,
    timeZone: host.timeZone,
    ...(branch
      ? {
          branch: {
            name: branch.name,
            dataTakenAt: runtime?.takenAt ?? null,
            productionUrl: runtime?.hosted?.productionOrigin ?? null,
          },
        }
      : {}),
  }
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
