import type { OntologySource, Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { StatusResponseSchema } from "../schemas/status"

export function registerStatusRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app.get(
    "/api/status",
    async () => ({
      status: "ok" as const,
      objectTypes: sixb.listObjectTypes().length,
      functions: sixb.getFunctionDefinitions().length,
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
