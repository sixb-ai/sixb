import type { Elysia } from "elysia"
import type { ParioServerRuntime } from "../runtime"
import { StatusResponseSchema } from "../schemas/status"

export function registerStatusRoutes(app: Elysia, pario: ParioServerRuntime) {
  return app.get(
    "/api/status",
    async () => ({
      status: "ok" as const,
      objectTypes: pario.listObjectTypes().length,
      functions: pario.getFunctionDefinitions().length,
    }),
    {
      response: { 200: StatusResponseSchema },
      detail: {
        summary: "Get runtime status",
        tags: ["Status"],
        operationId: "getStatus",
      },
    }
  )
}
