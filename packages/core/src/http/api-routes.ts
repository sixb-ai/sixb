/**
 * The single source of truth for the Sixb HTTP API surface and its auth capabilities.
 *
 * Two views are derived from this one table:
 * - `AGENT_API_ROUTES` (@sixb/core run tokens) = the `agentApi` rows, projected to {method, path}.
 * - `ACCESS_TOKEN_ROUTES` (@sixb/server bearer boundary) = the `accessToken` rows, with operationId.
 *
 * Because both views are projections of this table, what a run token may call is structurally a
 * subset of the bearer boundary — the invariant below enforces `agentApi ⇒ accessToken` at load
 * time. This table lives in @sixb/core (never @sixb/server) because @sixb/server depends on core,
 * not the reverse; the operationId strings are opaque here.
 */
export interface SixbApiRoute {
  /** OpenAPI operationId — the server keys its bearer security requirement off this. */
  readonly operationId: string
  readonly method: string
  readonly path: string
  /** The route accepts a bearer access token (enforced by the server access-token boundary). */
  readonly accessToken: boolean
  /** A run token may call the route (a strict subset of the accessToken routes). */
  readonly agentApi: boolean
  /**
   * What the route changes when the Agent calls it, for every `agentApi` route but a GET. A run
   * token's `action` and `workflow` calls wait for the requester's approval when their mode asks.
   */
  readonly agentEffect?: AgentApiEffect
  /** The canonical handler may run under an explicitly selected shared session. */
  readonly sharedSession?: boolean
}

/**
 * `read` changes nothing (a read sent as POST); `memory` writes the Agent's own notes; `file` stores
 * a blob nothing points at yet; `model` costs what AI limits already bound; `artifact` publishes
 * into the run's conversation.
 */
export type AgentApiEffect =
  | "read"
  | "action"
  | "workflow"
  | "memory"
  | "file"
  | "model"
  | "artifact"

export const SIXB_API_ROUTES: readonly SixbApiRoute[] = [
  {
    operationId: "getProjectInfo",
    method: "GET",
    path: "/api/project",
    accessToken: true,
    agentApi: true,
  },
  // Token and service-account management is bearer-capable so the CLI can authenticate with a
  // personal access token. It is NOT exposed to agents. The runtime still confines every operation
  // to the caller's own groups, and service-account tokens are rejected (only user principals may
  // manage credentials). Creating a token is the exception: it takes a signed-in session, so no
  // access token can mint one broader or longer-lived than itself.
  {
    operationId: "getAuthAccessManagementOptions",
    method: "GET",
    path: "/api/auth/access-management-options",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "listAuthAccessTokens",
    method: "GET",
    path: "/api/auth/access-tokens",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "createAuthPersonalAccessToken",
    method: "POST",
    path: "/api/auth/access-tokens",
    accessToken: false,
    agentApi: false,
  },
  {
    operationId: "revokeAuthAccessToken",
    method: "POST",
    path: "/api/auth/access-tokens/:tokenId/revoke",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "listAuthServiceAccounts",
    method: "GET",
    path: "/api/auth/service-accounts",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "createAuthServiceAccount",
    method: "POST",
    path: "/api/auth/service-accounts",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "disableAuthServiceAccount",
    method: "POST",
    path: "/api/auth/service-accounts/:serviceAccountId/disable",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "listAuthServiceAccountAccessTokens",
    method: "GET",
    path: "/api/auth/service-accounts/:serviceAccountId/access-tokens",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "createAuthServiceAccountAccessToken",
    method: "POST",
    path: "/api/auth/service-accounts/:serviceAccountId/access-tokens",
    accessToken: false,
    agentApi: false,
  },
  {
    operationId: "revokeAuthServiceAccountAccessToken",
    method: "POST",
    path: "/api/auth/service-accounts/:serviceAccountId/access-tokens/:tokenId/revoke",
    accessToken: true,
    agentApi: false,
  },
  // Share lifecycle management is bearer-capable for programmatic administration but never
  // agent-proxied. Shared sessions themselves use the canonical object/action routes and land in
  // the request boundary separately.
  {
    operationId: "issueSharedAccessGrant",
    method: "POST",
    path: "/api/share-grants",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "listSharedAccessGrants",
    method: "GET",
    path: "/api/share-grants",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "revokeSharedAccessGrant",
    method: "DELETE",
    path: "/api/share-grants/:grantId",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "listObjectTypes",
    method: "GET",
    path: "/api/object-types",
    accessToken: true,
    agentApi: true,
    sharedSession: true,
  },
  {
    operationId: "getObjectType",
    method: "GET",
    path: "/api/object-types/:objectTypeId",
    accessToken: true,
    agentApi: true,
    sharedSession: true,
  },
  {
    operationId: "listObjects",
    method: "GET",
    path: "/api/objects",
    accessToken: true,
    agentApi: true,
    sharedSession: true,
  },
  {
    operationId: "queryObjects",
    method: "POST",
    path: "/api/objects/query",
    accessToken: true,
    agentApi: true,
    agentEffect: "read",
    sharedSession: true,
  },
  {
    operationId: "queryObjectLinks",
    method: "POST",
    path: "/api/objects/query/links",
    accessToken: true,
    agentApi: true,
    agentEffect: "read",
    sharedSession: true,
  },
  {
    operationId: "countObjects",
    method: "POST",
    path: "/api/objects/query/count",
    accessToken: true,
    agentApi: true,
    agentEffect: "read",
    sharedSession: true,
  },
  {
    operationId: "existsObjects",
    method: "POST",
    path: "/api/objects/query/exists",
    accessToken: true,
    agentApi: true,
    agentEffect: "read",
    sharedSession: true,
  },
  {
    operationId: "facetObjects",
    method: "POST",
    path: "/api/objects/query/facets",
    accessToken: true,
    agentApi: true,
    agentEffect: "read",
    sharedSession: true,
  },
  {
    operationId: "getObject",
    method: "GET",
    path: "/api/objects/:objectTypeId/:objectId",
    accessToken: true,
    agentApi: true,
    sharedSession: true,
  },
  // A read: POST only so the value, an email say, stays out of URLs and their logs.
  {
    operationId: "getObjectByUniqueProperty",
    method: "POST",
    path: "/api/objects/:objectTypeId/by/:propertyId",
    accessToken: true,
    agentApi: true,
    agentEffect: "read",
    sharedSession: true,
  },
  // The four write routes. Bearer-capable because their execution facade enforces authorization
  // (`edit:object` / `append:telemetry`), which is exactly the precondition this table requires.
  // NOT open to run tokens: letting an agent turn write objects on its own is a separate decision,
  // and a run token's request already runs as its run, so flipping `agentApi` later needs no
  // authorization work — only that decision.
  {
    operationId: "upsertObject",
    method: "PUT",
    path: "/api/objects/:objectTypeId/:objectId",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "upsertObjectLink",
    method: "PUT",
    path: "/api/objects/:objectTypeId/:objectId/links/:linkId",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "removeObjectLink",
    method: "DELETE",
    path: "/api/objects/:objectTypeId/:objectId/links/:linkId",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "appendTelemetry",
    method: "POST",
    path: "/api/objects/:objectTypeId/:objectId/telemetry/:propertyId",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "getBulkTelemetryHistory",
    method: "POST",
    path: "/api/telemetry/history",
    accessToken: true,
    agentApi: true,
    agentEffect: "read",
    sharedSession: true,
  },
  {
    operationId: "getTelemetryHistory",
    method: "GET",
    path: "/api/objects/:objectTypeId/:objectId/telemetry/:propertyId/history",
    accessToken: true,
    agentApi: true,
    sharedSession: true,
  },
  {
    operationId: "getLatestTelemetry",
    method: "GET",
    path: "/api/objects/:objectTypeId/:objectId/telemetry/:propertyId/latest",
    accessToken: true,
    agentApi: true,
    sharedSession: true,
  },
  {
    operationId: "getObjectFileContent",
    method: "GET",
    path: "/api/objects/:objectTypeId/:objectId/files/content",
    accessToken: true,
    agentApi: true,
    sharedSession: true,
  },
  {
    // Bearer-capable (CLI/programmatic existence + range probes) but NOT open to run tokens: an
    // agent gains nothing from HEAD over GET (a file's size already travels in its FileRef).
    operationId: "headObjectFileContent",
    method: "HEAD",
    path: "/api/objects/:objectTypeId/:objectId/files/content",
    accessToken: true,
    agentApi: false,
    sharedSession: true,
  },
  {
    operationId: "listActions",
    method: "GET",
    path: "/api/actions",
    accessToken: true,
    agentApi: true,
    sharedSession: true,
  },
  {
    operationId: "getAction",
    method: "GET",
    path: "/api/actions/:actionId",
    accessToken: true,
    agentApi: true,
    sharedSession: true,
  },
  {
    operationId: "requestAction",
    method: "POST",
    path: "/api/actions/:actionId",
    accessToken: true,
    agentApi: true,
    agentEffect: "action",
    sharedSession: true,
  },
  {
    operationId: "uploadFileRaw",
    method: "POST",
    path: "/api/files",
    accessToken: true,
    agentApi: true,
    agentEffect: "file",
  },
  {
    operationId: "listActionRuns",
    method: "GET",
    path: "/api/action-runs",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getActionRun",
    method: "GET",
    path: "/api/action-runs/:runId",
    accessToken: true,
    agentApi: true,
    sharedSession: true,
  },
  {
    operationId: "getActionRunFileContent",
    method: "GET",
    path: "/api/action-runs/:runId/files/content",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "headActionRunFileContent",
    method: "HEAD",
    path: "/api/action-runs/:runId/files/content",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "listWorkflows",
    method: "GET",
    path: "/api/workflows",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getWorkflow",
    method: "GET",
    path: "/api/workflows/:workflowId",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "requestWorkflowRun",
    method: "POST",
    path: "/api/workflows/:workflowId/runs",
    accessToken: true,
    agentApi: true,
    agentEffect: "workflow",
  },
  {
    operationId: "listWorkflowRuns",
    method: "GET",
    path: "/api/workflow-runs",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getWorkflowRun",
    method: "GET",
    path: "/api/workflow-runs/:runId",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "cancelWorkflowRun",
    method: "POST",
    path: "/api/workflow-runs/:runId/cancel",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "getWorkflowAgentNodeExecution",
    method: "GET",
    path: "/api/workflow-runs/:runId/nodes/:nodeKey/agent-execution",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "getWorkflowRunFileContent",
    method: "GET",
    path: "/api/workflow-runs/:runId/files/content",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "headWorkflowRunFileContent",
    method: "HEAD",
    path: "/api/workflow-runs/:runId/files/content",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "getWorkflowNodeRunFileContent",
    method: "GET",
    path: "/api/workflow-runs/:runId/nodes/:nodeKey/files/content",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "headWorkflowNodeRunFileContent",
    method: "HEAD",
    path: "/api/workflow-runs/:runId/nodes/:nodeKey/files/content",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "getAgentMessageFileContent",
    method: "GET",
    path: "/api/agent-threads/:threadId/messages/:messageId/files/content",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "headAgentMessageFileContent",
    method: "HEAD",
    path: "/api/agent-threads/:threadId/messages/:messageId/files/content",
    accessToken: true,
    agentApi: false,
  },
  // A sub-agent's files are for people reading its conversation; its parent got them from
  // `wait_agent`.
  {
    operationId: "getAgentChildFileContent",
    method: "GET",
    path: "/api/agent-threads/:threadId/child-files/content",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "headAgentChildFileContent",
    method: "HEAD",
    path: "/api/agent-threads/:threadId/child-files/content",
    accessToken: true,
    agentApi: false,
  },
  // The Agent reads and saves its memory with `sixb memory` in its sandbox. Its history and deleting
  // a repo are for people, so run tokens can't reach them.
  {
    operationId: "getAgentMemory",
    method: "GET",
    path: "/api/agent-memory/:repo",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "listAgentMemoryRevisions",
    method: "GET",
    path: "/api/agent-memory/:repo/revisions",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "saveAgentMemory",
    method: "POST",
    path: "/api/agent-memory/:repo/revisions",
    accessToken: true,
    agentApi: true,
    agentEffect: "memory",
  },
  {
    operationId: "deleteAgentMemory",
    method: "DELETE",
    path: "/api/agent-memory/:repo",
    accessToken: true,
    agentApi: false,
  },
  // Artifacts are reachable with an access token, so the CLI and integrations can publish them. A
  // run token reads them as the run's requester, and publishes into the run's conversation.
  {
    operationId: "listArtifacts",
    method: "GET",
    path: "/api/artifacts",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "createArtifact",
    method: "POST",
    path: "/api/artifacts",
    accessToken: true,
    agentApi: true,
    agentEffect: "artifact",
  },
  {
    operationId: "getArtifact",
    method: "GET",
    path: "/api/artifacts/:artifactId",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "deleteArtifact",
    method: "DELETE",
    path: "/api/artifacts/:artifactId",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "getArtifactState",
    method: "GET",
    path: "/api/artifacts/:artifactId/state",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "clearArtifactState",
    method: "DELETE",
    path: "/api/artifacts/:artifactId/state",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "setArtifactState",
    method: "PUT",
    path: "/api/artifacts/:artifactId/state/:key",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "deleteArtifactStateValue",
    method: "DELETE",
    path: "/api/artifacts/:artifactId/state/:key",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "publishArtifactVersion",
    method: "POST",
    path: "/api/artifacts/:artifactId/versions",
    accessToken: true,
    agentApi: true,
    agentEffect: "artifact",
  },
  {
    operationId: "getArtifactVersion",
    method: "GET",
    path: "/api/artifacts/:artifactId/versions/:version",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getArtifactQuery",
    method: "GET",
    path: "/api/artifacts/:artifactId/versions/:version/queries/:name",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "createArtifactFrame",
    method: "POST",
    path: "/api/artifacts/:artifactId/versions/:version/frame",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "getArtifactFileContent",
    method: "GET",
    path: "/api/artifacts/:artifactId/versions/:version/content",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "headArtifactFileContent",
    method: "HEAD",
    path: "/api/artifacts/:artifactId/versions/:version/content",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "searchObjects",
    method: "GET",
    path: "/api/objects/search",
    accessToken: true,
    agentApi: true,
    sharedSession: true,
  },
  {
    operationId: "listEvents",
    method: "GET",
    path: "/api/events",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "listLogs",
    method: "GET",
    path: "/api/logs",
    accessToken: true,
    agentApi: false,
  },
  // A browser records its own activity, signed in or through a shared link. Access tokens never
  // do: a script is not a visit.
  {
    operationId: "getActivityCaptureConfig",
    method: "GET",
    path: "/api/activity/capture-config",
    accessToken: false,
    agentApi: false,
    sharedSession: true,
  },
  {
    operationId: "captureActivity",
    method: "POST",
    path: "/api/activity/events",
    accessToken: false,
    agentApi: false,
    sharedSession: true,
  },
  {
    operationId: "listActivityVisits",
    method: "GET",
    path: "/api/activity/visits",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "listActivityUsers",
    method: "GET",
    path: "/api/activity/users",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "getActivitySummary",
    method: "GET",
    path: "/api/activity/summary",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "getActivityCalendar",
    method: "GET",
    path: "/api/activity/calendar",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "getActivityVisitTimeline",
    method: "GET",
    path: "/api/activity/visits/:visitId/timeline",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "listActivityConnections",
    method: "GET",
    path: "/api/activity/connections",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "listUsers",
    method: "GET",
    path: "/api/users",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getUser",
    method: "GET",
    path: "/api/users/:userId",
    accessToken: true,
    agentApi: true,
  },
  // Data reads, for people and agents alike: datasets need dataset.view and redact marked columns;
  // syncs and pipelines list only what the caller may run. Running them stays session-only.
  {
    operationId: "listDatasets",
    method: "GET",
    path: "/api/datasets",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getDataset",
    method: "GET",
    path: "/api/datasets/:datasetId",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "listDatasetVersions",
    method: "GET",
    path: "/api/datasets/:datasetId/versions",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "listDatasetRows",
    method: "GET",
    path: "/api/datasets/:datasetId/rows",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "listSyncs",
    method: "GET",
    path: "/api/syncs",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getSync",
    method: "GET",
    path: "/api/syncs/:syncId",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "listSyncRuns",
    method: "GET",
    path: "/api/sync-runs",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "listPipelines",
    method: "GET",
    path: "/api/pipelines",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getPipeline",
    method: "GET",
    path: "/api/pipelines/:pipelineId",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "listPipelineRuns",
    method: "GET",
    path: "/api/pipeline-runs",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getPipelineRun",
    method: "GET",
    path: "/api/pipeline-runs/:runId",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "listModels",
    method: "GET",
    path: "/api/models",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "generateText",
    method: "POST",
    path: "/api/models/language/generations",
    accessToken: true,
    agentApi: true,
    agentEffect: "model",
  },
  {
    operationId: "generateImages",
    method: "POST",
    path: "/api/models/image/generations",
    accessToken: true,
    agentApi: true,
    agentEffect: "model",
  },
  {
    operationId: "generateSpeech",
    method: "POST",
    path: "/api/models/audio/speech",
    accessToken: true,
    agentApi: true,
    agentEffect: "model",
  },
  {
    operationId: "transcribeAudio",
    method: "POST",
    path: "/api/models/audio/transcriptions",
    accessToken: true,
    agentApi: true,
    agentEffect: "model",
  },
  {
    operationId: "getAiAccountingOverview",
    method: "GET",
    path: "/api/ai/accounting/overview",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "listAiModelCalls",
    method: "GET",
    path: "/api/ai/model-calls",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "getAiModelCallFiles",
    method: "GET",
    path: "/api/ai/model-calls/:callId/files",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getAiModelCallFileContent",
    method: "GET",
    path: "/api/ai/model-calls/:callId/files/content",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "headAiModelCallFileContent",
    method: "HEAD",
    path: "/api/ai/model-calls/:callId/files/content",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "listAiModelCallGroups",
    method: "GET",
    path: "/api/ai/model-call-groups",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "listAiLimitPolicies",
    method: "GET",
    path: "/api/ai/limits",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "getAiLimitStatus",
    method: "GET",
    path: "/api/ai/limits/status",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "getAiLimitSubjectOptions",
    method: "GET",
    path: "/api/ai/limits/subjects",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "createAiLimitPolicy",
    method: "POST",
    path: "/api/ai/limits",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "updateAiLimitPolicy",
    method: "PUT",
    path: "/api/ai/limits/:limitId",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "deleteAiLimitPolicy",
    method: "DELETE",
    path: "/api/ai/limits/:limitId",
    accessToken: true,
    agentApi: false,
  },
]

/**
 * The table's invariants, enforced at module load. A route open to run tokens must also be a bearer
 * route, or run tokens would reach a surface the access-token boundary does not recognize. One that
 * can change state names what it changes, so a route added later cannot skip the approval gate by
 * accident.
 */
export function assertSixbApiRoutes(routes: readonly SixbApiRoute[]): void {
  for (const route of routes) {
    if (route.agentApi && !route.accessToken) {
      throw new Error(
        `[Sixb] agent API route '${route.method} ${route.path}' must also be an access-token route.`
      )
    }
    if (route.agentApi && route.method !== "GET" && route.agentEffect === undefined) {
      throw new Error(
        `[Sixb] agent API route '${route.method} ${route.path}' must declare its agentEffect.`
      )
    }
  }
}

assertSixbApiRoutes(SIXB_API_ROUTES)
