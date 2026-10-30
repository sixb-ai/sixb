import { describe, expect, test } from "bun:test"
import { isAccessTokenRoute } from "../src/auth/access-token-boundary"

function request(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method })
}

describe("access token auth boundary", () => {
  test("allows only scoped V1 API routes", () => {
    const allowedRoutes = [
      ["GET", "/api/project"],
      ["GET", "/api/auth/access-management-options"],
      ["GET", "/api/auth/access-tokens"],
      ["POST", "/api/auth/access-tokens/tok_1/revoke"],
      ["GET", "/api/auth/service-accounts"],
      ["POST", "/api/auth/service-accounts"],
      ["POST", "/api/auth/service-accounts/svc_1/disable"],
      ["GET", "/api/auth/service-accounts/svc_1/access-tokens"],
      ["POST", "/api/auth/service-accounts/svc_1/access-tokens/tok_1/revoke"],
      ["GET", "/api/object-types"],
      ["GET", "/api/object-types/device"],
      ["GET", "/api/objects?objectTypeId=device"],
      ["GET", "/api/objects/search?q=fan"],
      ["POST", "/api/objects/query"],
      ["POST", "/api/objects/query/links"],
      ["POST", "/api/objects/query/count"],
      ["POST", "/api/objects/query/exists"],
      ["POST", "/api/objects/query/facets"],
      ["GET", "/api/objects/device/fan-1"],
      ["PUT", "/api/objects/device/fan-1"],
      ["PUT", "/api/objects/device/fan-1/links/located-at"],
      ["DELETE", "/api/objects/device/fan-1/links/located-at"],
      ["POST", "/api/objects/device/fan-1/telemetry/temperature"],
      ["POST", "/api/telemetry/history"],
      ["GET", "/api/objects/device/fan-1/telemetry/temperature/history"],
      ["GET", "/api/objects/device/fan-1/telemetry/temperature/latest"],
      ["GET", "/api/actions"],
      ["GET", "/api/actions/start-fan"],
      ["POST", "/api/actions/start-fan"],
      ["POST", "/api/files"],
      ["GET", "/api/action-runs"],
      ["GET", "/api/action-runs/act_run_1"],
      ["GET", "/api/workflows"],
      ["GET", "/api/workflows/renew-contract"],
      ["POST", "/api/workflows/renew-contract/runs"],
      ["GET", "/api/workflow-runs"],
      ["GET", "/api/workflow-runs/run_1"],
      ["GET", "/api/workflow-runs/run_1/files/content?path=/input/document"],
      ["GET", "/api/agent-threads/thr_1/messages/msg_1/files/content?path=/parts/1/fileRef"],
      ["GET", "/api/events"],
      ["POST", "/api/share-grants"],
      ["GET", "/api/share-grants?definitionId=published-report"],
      ["DELETE", "/api/share-grants/shr_1"],
      ["GET", "/api/datasets"],
      ["GET", "/api/datasets/orders"],
      ["GET", "/api/datasets/orders/versions"],
      ["GET", "/api/datasets/orders/rows?limit=10"],
      ["GET", "/api/syncs"],
      ["GET", "/api/syncs/catalog"],
      ["GET", "/api/sync-runs?syncId=catalog"],
      ["GET", "/api/pipelines"],
      ["GET", "/api/pipelines/catalog"],
      ["GET", "/api/pipeline-runs"],
      ["GET", "/api/pipeline-runs/run_1"],
    ] as const

    for (const [method, path] of allowedRoutes) {
      expect(isAccessTokenRoute(request(method, path)), `${method} ${path}`).toBe(true)
    }
  })

  test("rejects raw, admin, browser, and integration routes", () => {
    const rejectedRoutes = [
      // Creating a token takes a signed-in session; an access token cannot mint another.
      ["POST", "/api/auth/access-tokens"],
      ["POST", "/api/auth/service-accounts/svc_1/access-tokens"],
      // The object, link, and telemetry writes moved out of this list: they enforce `edit:object`
      // and `append:telemetry` now, which is the precondition SIXB_API_ROUTES states for bearer
      // eligibility. Link reads moved out too now that they enforce both source and target view.
      ["GET", "/api/objects/device/fan-1/links"],
      ["GET", "/api/workflow-interventions"],
      ["POST", "/api/workflow-interventions/int_1/submit"],
      ["GET", "/api/workflows/renew-contract/runs/run_1"],
      ["GET", "/api/agent"],
      ["GET", "/api/agent-threads"],
      ["POST", "/api/agent-threads"],
      ["GET", "/api/agent-threads/thr_1"],
      ["GET", "/api/agent-threads/thr_1/messages"],
      ["POST", "/api/agent-threads/thr_1/messages"],
      ["GET", "/api/agent-runs/run_1"],
      // Reading syncs and pipelines takes a token; running one still takes a signed-in session.
      ["POST", "/api/syncs/catalog/runs"],
      ["POST", "/api/pipelines/catalog/runs"],
      ["GET", "/api/datasets/orders/versions/v_1"],
      ["GET", "/api/auth/session"],
      ["GET", "/api/auth/membership-options"],
      ["GET", "/api/auth/members"],
      ["PATCH", "/api/auth/members/usr_1/groups"],
      ["POST", "/api/auth/members/usr_1/suspend"],
      ["POST", "/api/auth/members/usr_1/reactivate"],
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
})
