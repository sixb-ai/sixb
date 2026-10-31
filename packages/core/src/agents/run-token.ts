import { createHmac, timingSafeEqual } from "node:crypto"
import { type AgentApiEffect, SIXB_API_ROUTES } from "../http/api-routes"
import { matchesPathPattern, normalizeRoutePath } from "../http/route-pattern"

// A run token lets an Agent's commands call the API as their run: a bearer token that names the
// run and proves it was issued under the run's current execution token. It needs no storage of
// its own and stops working when the run's execution ends or moves to another worker.
const AGENT_RUN_TOKEN_PREFIX = "sixb_run_v1_"

export interface AgentRunTokenInput {
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
 * The routes a run token may call — the `agentApi` projection of the canonical
 * {@link SIXB_API_ROUTES} table, so this list can never drift from (nor exceed) the bearer boundary.
 */
export const AGENT_API_ROUTES: readonly AgentApiRoute[] = SIXB_API_ROUTES.filter(
  (route) => route.agentApi
).map((route) => ({
  method: route.method,
  path: route.path,
  effect: route.agentEffect ?? "read",
}))

export function createAgentRunToken(input: AgentRunTokenInput): string {
  const runId = Buffer.from(input.runId, "utf8").toString("base64url")
  return `${AGENT_RUN_TOKEN_PREFIX}${runId}.${runTokenDigest(input)}`
}

/** Whether a bearer token is a run token, whatever run it names or whether it is still valid. */
export function isAgentRunToken(token: string): boolean {
  return token.startsWith(AGENT_RUN_TOKEN_PREFIX)
}

/** The run a run token names, unverified; undefined when the token is malformed. */
export function agentRunTokenRunId(token: string): string | undefined {
  if (!isAgentRunToken(token)) return undefined
  const [runId, digest, ...rest] = token.slice(AGENT_RUN_TOKEN_PREFIX.length).split(".")
  if (!runId || !digest || rest.length > 0) return undefined
  return Buffer.from(runId, "base64url").toString("utf8") || undefined
}

/** Whether the token was issued for this run under this execution token. */
export function isValidAgentRunToken(
  input: AgentRunTokenInput & { readonly token: string }
): boolean {
  const expected = createAgentRunToken(input)
  const actual = input.token
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

function runTokenDigest(input: AgentRunTokenInput): string {
  return createHmac("sha256", input.executionToken)
    .update(`agent-run-token:${input.projectId}:${input.runId}`)
    .digest("base64url")
}
