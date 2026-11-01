import { describe, expect, test } from "bun:test"
import { AGENT_API_ROUTES } from "@sixb/core/internal/agents"

// The `sixb` this worker installs in each sandbox must reach every route a run token opens.
const CLI_API_ROUTES = [
  "GET /api/project",
  "GET /api/object-types",
  "GET /api/object-types/:objectTypeId",
  "GET /api/objects",
  "POST /api/objects/query",
  "POST /api/objects/:objectTypeId/by/:propertyId",
  "POST /api/objects/query/links",
  "POST /api/objects/query/count",
  "POST /api/objects/query/exists",
  "POST /api/objects/query/facets",
  "POST /api/telemetry/history",
  "GET /api/objects/:objectTypeId/:objectId/telemetry/:propertyId/history",
  "GET /api/objects/:objectTypeId/:objectId/telemetry/:propertyId/latest",
  "GET /api/objects/:objectTypeId/:objectId/files/content",
  "GET /api/actions",
  "GET /api/actions/:actionId",
  "POST /api/actions/:actionId",
  "POST /api/files",
  "GET /api/action-runs",
  "GET /api/action-runs/:runId",
  "GET /api/action-runs/:runId/files/content",
  "GET /api/workflows",
  "GET /api/workflows/:workflowId",
  "POST /api/workflows/:workflowId/runs",
  "GET /api/workflow-runs",
  "GET /api/workflow-runs/:runId",
  "GET /api/workflow-runs/:runId/files/content",
  "GET /api/objects/search",
  "GET /api/users",
  "GET /api/users/:userId",
  "GET /api/models",
  "POST /api/models/language/generations",
  "POST /api/models/image/generations",
  "POST /api/models/audio/speech",
  "POST /api/models/audio/transcriptions",
  "GET /api/ai/model-calls/:callId/files",
  "GET /api/ai/model-calls/:callId/files/content",
  "GET /api/datasets",
  "GET /api/datasets/:datasetId",
  "GET /api/datasets/:datasetId/versions",
  "GET /api/datasets/:datasetId/rows",
  "GET /api/syncs",
  "GET /api/syncs/:syncId",
  "GET /api/sync-runs",
  "GET /api/pipelines",
  "GET /api/pipelines/:pipelineId",
  "GET /api/pipeline-runs",
  "GET /api/pipeline-runs/:runId",
  "GET /api/agent-memory/:repo",
  "POST /api/agent-memory/:repo/revisions",
  "GET /api/agent-threads/:threadId/messages",
] as const

const ARTIFACTS_THROUGH_THE_RUNNER =
  "The run's session reaches artifacts for publish_artifact and $SIXB_ARTIFACTS."

const INTENTIONAL_CLI_ROUTE_ALTERNATIVES = new Map([
  [
    "GET /api/objects/:objectTypeId/:objectId",
    "Exact object reads use POST /api/objects/query with opaque refs.",
  ],
  [
    "GET /api/agent-threads/:threadId/messages/:messageId/files/content",
    "Run attachments are materialized in the sandbox before the model starts.",
  ],
  // A runner's session publishes and reads the conversation's artifacts through these; the Agent
  // publishes with publish_artifact and finds each latest version in $SIXB_ARTIFACTS.
  ["GET /api/artifacts", ARTIFACTS_THROUGH_THE_RUNNER],
  ["GET /api/artifacts/:artifactId", ARTIFACTS_THROUGH_THE_RUNNER],
  ["GET /api/artifacts/:artifactId/versions/:version", ARTIFACTS_THROUGH_THE_RUNNER],
  ["GET /api/artifacts/:artifactId/versions/:version/content", ARTIFACTS_THROUGH_THE_RUNNER],
  ["GET /api/artifacts/:artifactId/versions/:version/queries/:name", ARTIFACTS_THROUGH_THE_RUNNER],
  ["POST /api/artifacts", ARTIFACTS_THROUGH_THE_RUNNER],
  ["POST /api/artifacts/:artifactId/versions", ARTIFACTS_THROUGH_THE_RUNNER],
])

describe("the sandbox CLI's route coverage", () => {
  test("accounts for every route a run token opens", () => {
    const direct = new Set<string>(CLI_API_ROUTES)
    const alternatives = new Set(INTENTIONAL_CLI_ROUTE_ALTERNATIVES.keys())
    expect([...direct].filter((route) => alternatives.has(route))).toEqual([])
    expect([...INTENTIONAL_CLI_ROUTE_ALTERNATIVES.values()].every(Boolean)).toBe(true)

    const accountedFor = [...direct, ...alternatives].sort()
    const exposed = AGENT_API_ROUTES.map((route) => `${route.method} ${route.path}`).sort()
    expect(accountedFor).toEqual(exposed)
  })
})
