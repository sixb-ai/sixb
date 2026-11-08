import type { Elysia } from "elysia"
import type { SixbServer } from "../../server"
import { registerAgentStreamRoutes } from "./agents"
import { registerArtifactLiveRoutes } from "./artifacts"
import { registerEventStreamRoutes } from "./events"
import { registerLogStreamRoutes } from "./logs"

export function registerWebSocketRoutes(app: Elysia, server: SixbServer) {
  registerEventStreamRoutes(app, server)
  registerLogStreamRoutes(app, server)
  registerAgentStreamRoutes(app, server)
  registerArtifactLiveRoutes(app, server)
  return app
}
