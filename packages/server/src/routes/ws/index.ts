import type { Elysia } from "elysia"
import type { SixbServer } from "../../server"
import { registerAgentStreamRoutes } from "./agents"
import { registerEventStreamRoutes } from "./events"

export function registerWebSocketRoutes(app: Elysia, server: SixbServer) {
  registerEventStreamRoutes(app, server)
  registerAgentStreamRoutes(app, server)
  return app
}
