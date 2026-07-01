import { describe, expect, test } from "bun:test"
import { AGENT_API_ROUTES } from "../../src/agents"
import { SIXB_API_ROUTES } from "../../src/http"

describe("SIXB_API_ROUTES", () => {
  test("every agent API route is also an access-token route (subset invariant)", () => {
    for (const route of SIXB_API_ROUTES) {
      if (route.agentApi) {
        expect(route.accessToken).toBe(true)
      }
    }
  })

  test("AGENT_API_ROUTES is exactly the agentApi projection ({method, path})", () => {
    const expected = SIXB_API_ROUTES.filter((route) => route.agentApi).map((route) => ({
      method: route.method,
      path: route.path,
    }))
    expect(AGENT_API_ROUTES).toEqual(expected)
  })

  test("operationIds are unique", () => {
    const ids = SIXB_API_ROUTES.map((route) => route.operationId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
