import type { OntologySource, Pario } from "@pario/core"
import type { Elysia } from "elysia"
import { registerActionRoutes } from "./routes/actions"
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

export function registerHttpRoutes(app: Elysia, pario: Pario<readonly OntologySource[]>) {
  registerProjectRoutes(app, pario)
  registerStatusRoutes(app, pario)
  registerConnectorRoutes(app, pario)
  registerDatasetRoutes(app, pario)
  registerSyncRoutes(app, pario)
  registerPipelineRoutes(app, pario)
  registerRuleRoutes(app, pario)
  registerOntologyRoutes(app, pario)
  registerObjectRoutes(app, pario)
  registerActionRoutes(app, pario)
  registerLinkRoutes(app, pario)
  registerTelemetryRoutes(app, pario)
  registerEventRoutes(app, pario)
  registerProjectionRoutes(app, pario)
  registerWebhookRunRoutes(app, pario)

  return app
}
