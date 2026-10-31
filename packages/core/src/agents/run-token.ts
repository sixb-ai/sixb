import { createHmac, timingSafeEqual } from "node:crypto"
import { type AgentApiEffect, SIXB_API_ROUTES } from "../http/api-routes"
import { matchesPathPattern, normalizeRoutePath } from "../http/route-pattern"

// A run token lets an Agent's commands call the API as their run: a bearer token that names the
// run and proves it was issued under the run's current execution token. It needs no storage of
// its own and stops working when the run's execution ends or moves to another worker.
//
// A runner token is the runner's own: it reaches the run's session (run-session-serve.ts), which
// finishes the run, writes its messages and calls its models. It is issued under the same
// execution but signed for another purpose, so neither is ever accepted as the other: the run's
// commands hold only the run token, and never reach the session that runs them.
const RUN_TOKEN = { prefix: "sixb_run_v1_", purpose: "agent-run-token" } as const
const RUNNER_TOKEN = { prefix: "sixb_runner_v1_", purpose: "agent-runner-token" } as const

type TokenKind = typeof RUN_TOKEN | typeof RUNNER_TOKEN

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
  return signToken(RUN_TOKEN, input)
}

/** Whether a bearer token is a run token, whatever run it names or whether it is still valid. */
export function isAgentRunToken(token: string): boolean {
  return token.startsWith(RUN_TOKEN.prefix)
}

/** The run a run token names, unverified; undefined when the token is malformed. */
export function agentRunTokenRunId(token: string): string | undefined {
  return tokenRunId(RUN_TOKEN, token)
}

/** Whether the token was issued for this run under this execution token. */
export function isValidAgentRunToken(
  input: AgentRunTokenInput & { readonly token: string }
): boolean {
  return isValidToken(RUN_TOKEN, input)
}

/** The token a run's runner reaches its session with, never handed to the run's commands. */
export function createAgentRunnerToken(input: AgentRunTokenInput): string {
  return signToken(RUNNER_TOKEN, input)
}

/** Whether a bearer token is a runner token, whatever run it names or whether it is still valid. */
export function isAgentRunnerToken(token: string): boolean {
  return token.startsWith(RUNNER_TOKEN.prefix)
}

/** The run a runner token names, unverified; undefined when the token is malformed. */
export function agentRunnerTokenRunId(token: string): string | undefined {
  return tokenRunId(RUNNER_TOKEN, token)
}

/** Whether the runner token was issued for this run under this execution token. */
export function isValidAgentRunnerToken(
  input: AgentRunTokenInput & { readonly token: string }
): boolean {
  return isValidToken(RUNNER_TOKEN, input)
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

function signToken(kind: TokenKind, input: AgentRunTokenInput): string {
  const runId = Buffer.from(input.runId, "utf8").toString("base64url")
  const digest = createHmac("sha256", input.executionToken)
    .update(`${kind.purpose}:${input.projectId}:${input.runId}`)
    .digest("base64url")
  return `${kind.prefix}${runId}.${digest}`
}

function tokenRunId(kind: TokenKind, token: string): string | undefined {
  if (!token.startsWith(kind.prefix)) return undefined
  const [runId, digest, ...rest] = token.slice(kind.prefix.length).split(".")
  if (!runId || !digest || rest.length > 0) return undefined
  return Buffer.from(runId, "base64url").toString("utf8") || undefined
}

function isValidToken(
  kind: TokenKind,
  input: AgentRunTokenInput & { readonly token: string }
): boolean {
  const expectedBuffer = Buffer.from(signToken(kind, input))
  const actualBuffer = Buffer.from(input.token)
  return (
    expectedBuffer.byteLength === actualBuffer.byteLength &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  )
}
