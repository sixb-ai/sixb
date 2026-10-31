import type { SixbHostView } from "@sixb/core"
import type { Elysia } from "elysia"
import type { ResolvedSixbApiBrowserPolicy } from "./auth/browser-origin"
import type { SharedAccessBoundary } from "./auth/shared-access"
import { registerActionRunRoutes } from "./routes/action-runs"
import { registerActionRoutes } from "./routes/actions"
import { registerActivityRoutes } from "./routes/activity"
import { registerAgentApprovalRoutes } from "./routes/agent-approvals"
import { registerAgentChildRoutes } from "./routes/agent-children"
import { registerAgentComputerRoutes } from "./routes/agent-computers"
import { registerAgentMemoryRoutes } from "./routes/agent-memory"
import { registerAgentRunnerRoutes } from "./routes/agent-runners"
import { registerAgentRoutes } from "./routes/agents"
import { registerAiAccountingRoutes } from "./routes/ai-accounting"
import { registerArtifactFrameRoutes } from "./routes/artifact-frames"
import { registerArtifactRoutes } from "./routes/artifacts"
import {
  type ConnectorConnectionRouteOptions,
  registerConnectorConnectionRunRoutes,
} from "./routes/connector-connection-runs"
import { registerConnectorConnectionRoutes } from "./routes/connector-connections"
import { registerConnectorRoutes } from "./routes/connectors"
import { registerDatasetRoutes } from "./routes/datasets"
import { registerEventRoutes } from "./routes/events"
import { registerFileDownloadRoutes } from "./routes/file-downloads"
import { registerFileRoutes } from "./routes/files"
import { registerLinkRoutes } from "./routes/links"
import { registerLogRoutes } from "./routes/logs"
import { registerModelCallRoutes } from "./routes/model-calls"
import { registerModelGenerationRoutes } from "./routes/model-generations"
import { registerModelRoutes } from "./routes/models"
import { registerObjectRoutes } from "./routes/objects"
import { registerObservedAgentThreadRoutes } from "./routes/observed-agent-threads"
import { registerOntologyRoutes } from "./routes/ontology"
import { registerPipelineRoutes } from "./routes/pipelines"
import { registerProjectRoutes } from "./routes/project"
import { registerProjectionRoutes } from "./routes/projections"
import { registerRuleRoutes } from "./routes/rules"
import { registerShareGrantRoutes } from "./routes/share-grants"
import { registerSharedAccessRoutes } from "./routes/shared-access"
import { registerStatusRoutes } from "./routes/status"
import { registerSyncRoutes } from "./routes/syncs"
import { registerTelemetryRoutes } from "./routes/telemetry"
import { registerUserRoutes } from "./routes/users"
import { registerWebhookRunRoutes } from "./routes/webhook-runs"
import { registerWorkflowRoutes } from "./routes/workflows"

export interface HttpRouteOptions {
  readonly connectorConnections: ConnectorConnectionRouteOptions
  readonly sharedAccess: SharedAccessBoundary
  /** Where frames are served from and which app origins may show them. */
  readonly browserPolicy: ResolvedSixbApiBrowserPolicy
}

export function registerHttpRoutes(app: Elysia, host: SixbHostView, options: HttpRouteOptions) {
  registerAiAccountingRoutes(app, host)
  registerModelCallRoutes(app, host)
  registerModelGenerationRoutes(app, host)
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
  registerShareGrantRoutes(app, host)
  registerSharedAccessRoutes(app, options.sharedAccess)
  registerOntologyRoutes(app, host)
  registerObjectRoutes(app, host)
  registerActionRoutes(app, host)
  registerFileRoutes(app, host)
  registerFileDownloadRoutes(app, host)
  registerActionRunRoutes(app, host)
  registerAgentRoutes(app, host)
  registerAgentChildRoutes(app, host)
  registerAgentRunnerRoutes(app, host)
  registerAgentComputerRoutes(app, host)
  registerAgentApprovalRoutes(app, host)
  registerObservedAgentThreadRoutes(app, host)
  registerAgentMemoryRoutes(app)
  registerArtifactRoutes(app, host)
  registerArtifactFrameRoutes(app, host, options.browserPolicy)
  registerModelRoutes(app, host)
  registerLinkRoutes(app, host)
  registerTelemetryRoutes(app, host)
  registerEventRoutes(app, host)
  registerLogRoutes(app, host)
  registerActivityRoutes(app, host)
  registerUserRoutes(app, host)
  registerProjectionRoutes(app, host)
  registerWebhookRunRoutes(app, host)

  return app
}
