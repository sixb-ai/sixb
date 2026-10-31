import { expect, test } from "bun:test"
import { isAllowedAgentApiRequest } from "../../src/agents/run-token"
import { SIXB_API_ROUTES } from "../../src/http"
import { assertSixbApiRoutes } from "../../src/http/api-routes"

// The server's access-token boundary looks routes up by operationId, so a duplicate would hand one
// route the other's bearer policy. (`agentApi ⇒ accessToken` is enforced when the table loads.)
test("SIXB_API_ROUTES operationIds are unique", () => {
  const ids = SIXB_API_ROUTES.map((route) => route.operationId)
  expect(new Set(ids).size).toBe(ids.length)
})

// Guard proof: drop the `agentEffect` check from `assertSixbApiRoutes`; the table loads with a
// state-changing run-token route the approval gate does not know.
test("a run-token route that can change state must say what it changes", () => {
  const route = {
    operationId: "archiveInvoice",
    method: "POST",
    path: "/api/invoices/:id/archive",
    accessToken: true,
    agentApi: true,
  }

  expect(() => assertSixbApiRoutes([route])).toThrow(
    "[Sixb] agent API route 'POST /api/invoices/:id/archive' must declare its agentEffect."
  )
  expect(() => assertSixbApiRoutes([{ ...route, agentEffect: "action" }])).not.toThrow()
  expect(() => assertSixbApiRoutes([{ ...route, method: "GET" }])).not.toThrow()
})

// Guard proof: add the decision route to SIXB_API_ROUTES with `agentApi: true`; the Agent could
// then approve its own call, with its requester's rights.
test("the Agent reaches no approval decision or mode route", () => {
  for (const [method, path] of [
    ["POST", "/api/agent-threads/thr_1/approvals/apr_1/decision"],
    ["PUT", "/api/agent-threads/thr_1/approval-mode"],
    ["GET", "/api/agent-threads/thr_1/approvals"],
    ["GET", "/api/agent-approvals"],
    ["GET", "/api/agent/preferences"],
    ["PUT", "/api/agent/preferences"],
  ] as const) {
    expect({ method, path, allowed: isAllowedAgentApiRequest(method, path) }).toEqual({
      method,
      path,
      allowed: false,
    })
  }
})
