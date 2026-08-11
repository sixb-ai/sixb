import type { SixbHostRuntime } from "@sixb/core"
import type { Elysia } from "elysia"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  HealthResponseSchema,
  ReadinessResponseSchema,
  StatusResponseSchema,
} from "../schemas/status"
export function registerStatusRoutes(app: Elysia, host: SixbHostRuntime) {
  app.get("/health", () => ({ status: "ok" as const }), {
    response: { 200: HealthResponseSchema },
    detail: {
      hide: true,
      summary: "Check process liveness",
      tags: [OPENAPI_TAGS.status.name],
      operationId: "getHealth",
    },
  })

  app.get(
    "/ready",
    async ({ set }) => {
      const readiness = await host.checkReadiness()
      if (readiness.status === "unready") set.status = 503
      return readiness
    },
    {
      response: { 200: ReadinessResponseSchema, 503: ReadinessResponseSchema },
      detail: {
        hide: true,
        summary: "Check runtime readiness",
        tags: [OPENAPI_TAGS.status.name],
        operationId: "getReadiness",
      },
    }
  )

  return app.get(
    "/api/status",
    async () => ({
      ...host.getOntologyOperationalStatus(),
      objectTypes: host.objects.listTypes().length,
    }),
    {
      response: { 200: StatusResponseSchema },
      detail: {
        summary: "Get runtime status",
        tags: [OPENAPI_TAGS.status.name],
        operationId: "getStatus",
      },
    }
  )
}
