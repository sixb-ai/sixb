import { createHmac, timingSafeEqual } from "node:crypto"
import { type AgentApiEffect, SIXB_API_ROUTES } from "../http/api-routes"
import { matchesPathPattern, normalizeRoutePath } from "../http/route-pattern"

export const AGENT_API_GATEWAY_PREFIX = "/__sixb/agent-api"

const AGENT_API_GATEWAY_CAPABILITY_PREFIX = "sixb_agw_v1_"

export interface AgentApiGatewayCapabilityInput {
  readonly projectId: string
  readonly runId: string
  readonly executionToken: string
}

export interface AgentApiRoute {
  readonly method: string
  readonly path: string
  /** What a call changes; a GET reads. */
  readonly effect: AgentApiEffect
}

/**
 * The routes the agent API gateway may proxy — the `agentApi` projection of the canonical
 * {@link SIXB_API_ROUTES} table, so this list can never drift from (nor exceed) the bearer boundary.
 */
export const AGENT_API_ROUTES: readonly AgentApiRoute[] = SIXB_API_ROUTES.filter(
  (route) => route.agentApi
).map((route) => ({
  method: route.method,
  path: route.path,
  effect: route.agentEffect ?? "read",
}))

export function createAgentApiGatewayCapability(input: AgentApiGatewayCapabilityInput): string {
  return `${AGENT_API_GATEWAY_CAPABILITY_PREFIX}${capabilityDigest(input)}`
}

export function isValidAgentApiGatewayCapability(
  input: AgentApiGatewayCapabilityInput & { readonly capability: string }
): boolean {
  const expected = createAgentApiGatewayCapability(input)
  const actual = input.capability
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(actual)
  return (
    expectedBuffer.byteLength === actualBuffer.byteLength &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  )
}

export function isAllowedAgentApiRequest(method: string, pathname: string): boolean {
  return findAgentApiRoute(method, pathname) !== undefined
}

/** The gateway route a request matches, with what it changes. */
export function findAgentApiRoute(method: string, pathname: string): AgentApiRoute | undefined {
  const normalizedMethod = method.toUpperCase()
  const normalizedPath = normalizeRoutePath(pathname)
  return AGENT_API_ROUTES.find(
    (route) => route.method === normalizedMethod && matchesPathPattern(normalizedPath, route.path)
  )
}

function capabilityDigest(input: AgentApiGatewayCapabilityInput): string {
  return createHmac("sha256", input.executionToken)
    .update(`agent-api-gateway:${input.projectId}:${input.runId}`)
    .digest("base64url")
}
