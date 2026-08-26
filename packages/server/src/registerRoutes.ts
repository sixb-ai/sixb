import type { SixbHostView } from "@sixb/core"
import type { Elysia } from "elysia"
import { registerActionRunRoutes } from "./routes/action-runs"
import { registerActionRoutes } from "./routes/actions"
import { registerAgentApiGatewayRoutes } from "./routes/agent-api-gateway"
import { registerAgentRoutes } from "./routes/agents"
import { registerAiAccountingRoutes } from "./routes/ai-accounting"
import {
  type ConnectorConnectionRouteOptions,
  registerConnectorConnectionRunRoutes,
} from "./routes/connector-connection-runs"
import { registerConnectorConnectionRoutes } from "./routes/connector-connections"
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
import { registerStatusRoutes } from "./routes/status"
import { registerSyncRoutes } from "./routes/syncs"
import { registerTelemetryRoutes } from "./routes/telemetry"
import { registerWebhookRunRoutes } from "./routes/webhook-runs"
import { registerWorkflowRoutes } from "./routes/workflows"

export interface HttpRouteOptions {
  readonly connectorConnections: ConnectorConnectionRouteOptions
}

export function registerHttpRoutes(app: Elysia, host: SixbHostView, options: HttpRouteOptions) {
  registerAgentApiGatewayRoutes(app, host)
  registerAiAccountingRoutes(app, host)
  registerProjectRoutes(app, host)
  registerStatusRoutes(app, host)
  registerConnectorRoutes(app, host)
  registerConnectorConnectionRoutes(app, host)
  registerConnectorConnectionRunRoutes(app, host, options.connectorConnections)
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

  return app
}
