import { expect, test } from "bun:test"
import { SIXB_API_ROUTES } from "../../src/http"

// The server's access-token boundary looks routes up by operationId, so a duplicate would hand one
// route the other's bearer policy. (`agentApi ⇒ accessToken` is enforced when the table loads.)
test("SIXB_API_ROUTES operationIds are unique", () => {
  const ids = SIXB_API_ROUTES.map((route) => route.operationId)
  expect(new Set(ids).size).toBe(ids.length)
})
