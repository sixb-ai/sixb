import { describe, expect, test } from "bun:test"
import type { OntologySource, Sixb } from "@sixb/core"
import { Elysia } from "elysia"
import { registerActionRunRoutes } from "../src/routes/action-runs"
import { registerAgentRoutes } from "../src/routes/agents"
import { registerPipelineRoutes } from "../src/routes/pipelines"
import { registerProjectionRoutes } from "../src/routes/projections"
import { registerRuleRoutes } from "../src/routes/rules"
import { registerWebhookRunRoutes } from "../src/routes/webhook-runs"
import { registerWorkflowRoutes } from "../src/routes/workflows"

// A runtime whose optional run-history roles are all absent — the shape a project
// gets from `createSixb()` without the matching storage provider.
function sixbWithoutRunHistory(): Sixb<readonly OntologySource[]> {
  return {
    id: "my-app",
    storage: {},
    listRules: () => [],
    getRuleById: () => null,
    listPipelines: () => [],
    getPipelineById: () => null,
    listObjectProjections: () => [],
    listLinkProjections: () => [],
    listTelemetryProjections: () => [],
    getProjectionById: () => null,
    workflows: { list: () => [], getById: () => null },
    agents: { list: () => [], getById: () => null },
  } as unknown as Sixb<readonly OntologySource[]>
}

type Register = (app: Elysia, sixb: Sixb<readonly OntologySource[]>) => unknown

function appFor(register: Register): Elysia {
  return register(
    new Elysia().derive(() => ({ authz: null, scoped: null })) as unknown as Elysia,
    sixbWithoutRunHistory()
  ) as Elysia
}

// Each entry is one route family: the storage role it needs, and a request that
// reaches the guard.
const ROUTES: ReadonlyArray<{
  readonly name: string
  readonly register: Register
  readonly request: string
  readonly role: string
}> = [
  {
    name: "action runs",
    register: registerActionRunRoutes as Register,
    request: "http://localhost/api/action-runs",
    role: "Action run storage",
  },
  {
    name: "projection runs",
    register: registerProjectionRoutes as Register,
    request: "http://localhost/api/projection-runs",
    role: "Projection run storage",
  },
  {
    name: "pipeline runs",
    register: registerPipelineRoutes as Register,
    request: "http://localhost/api/pipeline-runs/run-1",
    role: "Pipeline run storage",
  },
  {
    name: "workflow runs",
    register: registerWorkflowRoutes as Register,
    request: "http://localhost/api/workflow-runs",
    role: "Workflow run storage",
  },
  {
    name: "workflow interventions",
    register: registerWorkflowRoutes as Register,
    request: "http://localhost/api/workflow-interventions",
    role: "Workflow intervention storage",
  },
  {
    name: "agent threads",
    register: registerAgentRoutes as Register,
    request: "http://localhost/api/agent-threads",
    role: "Agent storage",
  },
  {
    name: "rule states",
    register: registerRuleRoutes as Register,
    request: "http://localhost/api/rule-states",
    role: "Rule state storage",
  },
  {
    name: "webhook runs",
    register: registerWebhookRunRoutes as Register,
    request: "http://localhost/api/webhook-runs",
    role: "Webhook run storage",
  },
]

describe("routes whose storage role is not configured", () => {
  for (const route of ROUTES) {
    test(`${route.name} answers 501 and names the missing role`, async () => {
      const app = appFor(route.register)
      const response = await app.handle(new Request(route.request))

      // 501 and not 400: the request is well-formed and the caller cannot fix this.
      expect(response.status).toBe(501)
      expect(await response.json()).toEqual({
        error: `[SixbServer] ${route.role} is not configured on this runtime.`,
      })
    })
  }

  // The regression this whole family guards against: a run-history route that
  // answers `200 {total: 0}` reads as "nothing happened yet" when the truth is
  // "nothing is being recorded".
  test("no route reports an empty history instead of an unrecorded one", async () => {
    for (const route of ROUTES) {
      const app = appFor(route.register)
      const response = await app.handle(new Request(route.request))
      expect(response.status).not.toBe(200)
    }
  })
})
