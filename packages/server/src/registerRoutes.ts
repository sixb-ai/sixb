import type { SixbHostView } from "@sixb/core"
import type { Elysia } from "elysia"
import { registerActionRunRoutes } from "./routes/action-runs"
import { registerActionRoutes } from "./routes/actions"
import { registerAgentApiGatewayRoutes } from "./routes/agent-api-gateway"
import { registerAgentRoutes } from "./routes/agents"
import { registerConnectorRoutes } from "./routes/connectors"
import { registerDatasetRoutes } from "./routes/datasets"
import { registerEventRoutes } from "./routes/events"
import { registerFileRoutes } from "./routes/files"
import { registerLinkRoutes } from "./routes/links"
import { registerLogRoutes } from "./routes/logs"
import { registerObjectRoutes } from "./routes/objects"
import { registerOntologyRoutes } from "./routes/ontology"
import { registerPipelineRoutes } from "./routes/pipelines"
import { registerProjectRoutes } from "./routes/project"
import { registerProjectionRoutes } from "./routes/projections"
import { registerRuleRoutes } from "./routes/rules"
import { registerShareGrantRoutes, type ShareGrantRouteOptions } from "./routes/share-grants"
import { registerStatusRoutes } from "./routes/status"
import { registerSyncRoutes } from "./routes/syncs"
import { registerTelemetryRoutes } from "./routes/telemetry"
import { registerWebhookRunRoutes } from "./routes/webhook-runs"
import { registerWorkflowRoutes } from "./routes/workflows"

export function registerHttpRoutes(
  app: Elysia,
  host: SixbHostView,
  options: ShareGrantRouteOptions
) {
  registerAgentApiGatewayRoutes(app, host)
  registerProjectRoutes(app, host)
  registerStatusRoutes(app, host)
  registerConnectorRoutes(app, host)
  registerDatasetRoutes(app, host)
  registerSyncRoutes(app, host)
  registerPipelineRoutes(app, host)
  registerWorkflowRoutes(app, host)
  registerRuleRoutes(app, host)
  registerOntologyRoutes(app, host)
  registerObjectRoutes(app, host)
  registerActionRoutes(app, host)
  registerFileRoutes(app, host)
  registerActionRunRoutes(app, host)
  registerAgentRoutes(app, host)
  registerLinkRoutes(app, host)
  registerTelemetryRoutes(app, host)
  registerEventRoutes(app, host)
  registerLogRoutes(app, host)
  registerProjectionRoutes(app, host)
  registerWebhookRunRoutes(app, host)
  registerShareGrantRoutes(app, host, options)

  return app
}
