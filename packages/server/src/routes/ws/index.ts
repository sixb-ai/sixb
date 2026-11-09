import type { Elysia } from "elysia"
import type { SharedAccessBoundary } from "../../auth/shared-access"
import type { SixbServer } from "../../server"
import { registerAgentStreamRoutes } from "./agents"
import { registerArtifactLiveRoutes } from "./artifacts"
import { registerEventStreamRoutes } from "./events"
import { registerLogStreamRoutes } from "./logs"
import { SharedSockets } from "./shared-sockets"

export function registerWebSocketRoutes(
  app: Elysia,
  server: SixbServer,
  sharedAccess: SharedAccessBoundary
) {
  // A shared link's session opens these two only: the boundary refuses it every other socket.
  const shared = new SharedSockets(sharedAccess)

  registerEventStreamRoutes(app, server, shared)
  registerLogStreamRoutes(app, server)
  registerAgentStreamRoutes(app, server)
  registerArtifactLiveRoutes(app, server, shared)
  return app
}
