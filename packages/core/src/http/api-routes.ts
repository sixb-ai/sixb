/**
 * The single source of truth for the Sixb HTTP API surface and its auth capabilities.
 *
 * Two views are derived from this one table:
 * - `AGENT_API_ROUTES` (@sixb/core agent gateway) = the `agentApi` rows, projected to {method, path}.
 * - `ACCESS_TOKEN_ROUTES` (@sixb/server bearer boundary) = the `accessToken` rows, with operationId.
 *
 * Because both views are projections of this table, the agent gateway allow-list is structurally a
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
  /** The route is proxied by the agent API gateway (a strict subset of the accessToken routes). */
  readonly agentApi: boolean
}

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
  // manage credentials).
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
    accessToken: true,
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
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "revokeAuthServiceAccountAccessToken",
    method: "POST",
    path: "/api/auth/service-accounts/:serviceAccountId/access-tokens/:tokenId/revoke",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "listObjectTypes",
    method: "GET",
    path: "/api/object-types",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getObjectType",
    method: "GET",
    path: "/api/object-types/:objectTypeId",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "listObjects",
    method: "GET",
    path: "/api/objects",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "queryObjects",
    method: "POST",
    path: "/api/objects/query",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "countObjects",
    method: "POST",
    path: "/api/objects/query/count",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "existsObjects",
    method: "POST",
    path: "/api/objects/query/exists",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "facetObjects",
    method: "POST",
    path: "/api/objects/query/facets",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getObject",
    method: "GET",
    path: "/api/objects/:objectTypeId/:objectId",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getBulkTelemetryHistory",
    method: "POST",
    path: "/api/telemetry/history",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getTelemetryHistory",
    method: "GET",
    path: "/api/objects/:objectTypeId/:objectId/telemetry/:propertyId/history",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getLatestTelemetry",
    method: "GET",
    path: "/api/objects/:objectTypeId/:objectId/telemetry/:propertyId/latest",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getObjectFileContent",
    method: "GET",
    path: "/api/objects/:objectTypeId/:objectId/files/content",
    accessToken: true,
    agentApi: true,
  },
  {
    // Bearer-capable (CLI/programmatic existence + range probes) but NOT agent-proxied: the agent
    // API gateway only forwards GET/POST, and an agent gains nothing from HEAD over GET (a file's
    // size already travels in its FileRef). Keeping this agentApi:true would throw at gateway
    // registration ("Unsupported agent API gateway method 'HEAD'") and stop the server booting.
    operationId: "headObjectFileContent",
    method: "HEAD",
    path: "/api/objects/:objectTypeId/:objectId/files/content",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "listActions",
    method: "GET",
    path: "/api/actions",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getAction",
    method: "GET",
    path: "/api/actions/:actionId",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "requestAction",
    method: "POST",
    path: "/api/actions/:actionId",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "getActionRun",
    method: "GET",
    path: "/api/action-runs/:runId",
    accessToken: true,
    agentApi: true,
  },
  {
    operationId: "listWorkflows",
    method: "GET",
    path: "/api/workflows",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "getWorkflow",
    method: "GET",
    path: "/api/workflows/:workflowId",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "requestWorkflowRun",
    method: "POST",
    path: "/api/workflows/:workflowId/runs",
    accessToken: true,
    agentApi: false,
  },
  {
    operationId: "listEvents",
    method: "GET",
    path: "/api/events",
    accessToken: true,
    agentApi: false,
  },
]

// Enforce the subset invariant at module load: a gateway-proxied route must also be a bearer route,
// or the gateway would expose a surface the access-token boundary does not recognize.
for (const route of SIXB_API_ROUTES) {
  if (route.agentApi && !route.accessToken) {
    throw new Error(
      `[Sixb] agent API route '${route.method} ${route.path}' must also be an access-token route.`
    )
  }
}
