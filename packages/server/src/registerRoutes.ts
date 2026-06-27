import type { OntologySource, Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { registerActionRunRoutes } from "./routes/action-runs"
import { registerActionRoutes } from "./routes/actions"
import { registerAgentRoutes } from "./routes/agents"
import { registerConnectorRoutes } from "./routes/connectors"
import { registerDatasetRoutes } from "./routes/datasets"
import { registerEventRoutes } from "./routes/events"
import { registerLinkRoutes } from "./routes/links"
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

export function registerHttpRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  registerProjectRoutes(app, sixb)
  registerStatusRoutes(app, sixb)
  registerConnectorRoutes(app, sixb)
  registerDatasetRoutes(app, sixb)
  registerSyncRoutes(app, sixb)
  registerPipelineRoutes(app, sixb)
  registerWorkflowRoutes(app, sixb)
  registerRuleRoutes(app, sixb)
  registerOntologyRoutes(app, sixb)
  registerObjectRoutes(app, sixb)
  registerActionRoutes(app, sixb)
  registerActionRunRoutes(app, sixb)
  registerAgentRoutes(app, sixb)
  registerLinkRoutes(app, sixb)
  registerTelemetryRoutes(app, sixb)
  registerEventRoutes(app, sixb)
  registerProjectionRoutes(app, sixb)
  registerWebhookRunRoutes(app, sixb)

  return app
}
