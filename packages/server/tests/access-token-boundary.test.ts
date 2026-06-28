import { describe, expect, test } from "bun:test"
import {
  isAccessTokenRoute,
  shouldVerifyCsrfForAuthSource,
} from "../src/auth/access-token-boundary"
import { classifyRoute } from "../src/auth/public-routes"

function request(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method })
}

describe("access token auth boundary", () => {
  test("allows only scoped V1 API routes", () => {
    const allowedRoutes = [
      ["GET", "/api/project"],
      ["GET", "/api/auth/access-management-options"],
      ["GET", "/api/auth/access-tokens"],
      ["POST", "/api/auth/access-tokens"],
      ["POST", "/api/auth/access-tokens/tok_1/revoke"],
      ["GET", "/api/auth/service-accounts"],
      ["POST", "/api/auth/service-accounts"],
      ["POST", "/api/auth/service-accounts/svc_1/disable"],
      ["GET", "/api/auth/service-accounts/svc_1/access-tokens"],
      ["POST", "/api/auth/service-accounts/svc_1/access-tokens"],
      ["POST", "/api/auth/service-accounts/svc_1/access-tokens/tok_1/revoke"],
      ["GET", "/api/object-types"],
      ["GET", "/api/object-types/device"],
      ["GET", "/api/objects?objectTypeId=device"],
      ["POST", "/api/objects/query"],
      ["POST", "/api/objects/query/count"],
      ["POST", "/api/objects/query/exists"],
      ["POST", "/api/objects/query/facets"],
      ["GET", "/api/objects/device/fan-1"],
      ["POST", "/api/telemetry/history"],
      ["GET", "/api/objects/device/fan-1/telemetry/temperature/history"],
      ["GET", "/api/objects/device/fan-1/telemetry/temperature/latest"],
      ["GET", "/api/actions"],
      ["GET", "/api/actions/start-fan"],
      ["POST", "/api/actions/start-fan"],
      ["GET", "/api/action-runs/act_run_1"],
      ["GET", "/api/workflows"],
      ["GET", "/api/workflows/renew-contract"],
      ["POST", "/api/workflows/renew-contract/runs"],
      ["GET", "/api/events"],
    ] as const

    for (const [method, path] of allowedRoutes) {
      expect(isAccessTokenRoute(request(method, path)), `${method} ${path}`).toBe(true)
    }
  })

  test("rejects raw, admin, browser, and integration routes", () => {
    const rejectedRoutes = [
      ["PUT", "/api/objects/device/fan-1"],
      ["GET", "/api/objects/device/fan-1/links"],
      ["PUT", "/api/objects/device/fan-1/links/located-at"],
      ["DELETE", "/api/objects/device/fan-1/links/located-at"],
      ["POST", "/api/objects/device/fan-1/telemetry/temperature"],
      ["GET", "/api/workflow-interventions"],
      ["POST", "/api/workflow-interventions/int_1/submit"],
      ["GET", "/api/workflows/renew-contract/runs/run_1"],
      ["GET", "/api/agents"],
      ["GET", "/api/agents/assistant"],
      ["GET", "/api/agent-threads"],
      ["POST", "/api/agent-threads"],
      ["GET", "/api/agent-threads/thr_1"],
      ["GET", "/api/agent-threads/thr_1/messages"],
      ["POST", "/api/agent-threads/thr_1/messages"],
      ["GET", "/api/agent-runs/run_1"],
      ["GET", "/api/syncs"],
      ["POST", "/api/syncs/catalog/runs"],
      ["GET", "/api/pipelines"],
      ["POST", "/api/pipelines/catalog/runs"],
      ["GET", "/api/auth/session"],
      ["POST", "/api/auth/invitations"],
      ["POST", "/api/auth/sign-out"],
      ["POST", "/api/webhooks/github"],
      ["GET", "/docs"],
      ["GET", "/ws/events"],
    ] as const

    for (const [method, path] of rejectedRoutes) {
      expect(isAccessTokenRoute(request(method, path)), `${method} ${path}`).toBe(false)
    }
  })

  test("requires CSRF only for cookie-session authenticated mutations", () => {
    const readRoute = classifyRoute(request("GET", "/api/objects"))
    const mutationRoute = classifyRoute(request("POST", "/api/objects/query"))

    expect(shouldVerifyCsrfForAuthSource(readRoute, "session")).toBe(false)
    expect(shouldVerifyCsrfForAuthSource(mutationRoute, "session")).toBe(true)
    expect(shouldVerifyCsrfForAuthSource(mutationRoute, "accessToken")).toBe(false)
  })
})
