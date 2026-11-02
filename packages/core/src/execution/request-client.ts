import { getRequestClientAddress } from "../auth/client-address"
import type { ExecutionContext } from "./types"

const MAX_USER_AGENT_LENGTH = 512

/**
 * The client behind the HTTP request that started an execution, as the server resolved it.
 *
 * Process-local: it is never written to an execution, run, or any other record. A handler that
 * needs it later stores it itself.
 */
export interface RequestClient {
  /**
   * The client's IP address: the socket peer, or the address its trusted proxies forwarded.
   * `undefined` when the server did not resolve one, as for a request handled in-process.
   */
  readonly address: string | undefined
  /** The request's `User-Agent` header, at most 512 characters. */
  readonly userAgent: string | undefined
}

// Keyed by the request execution itself: nested executions (a workflow, the agent, an Action that
// another one requests) are other contexts, and find nothing here.
const requestClients = new WeakMap<ExecutionContext, RequestClient>()

/** Remember the client of the HTTP request a request execution was created for. */
export function bindRequestClient(execution: ExecutionContext, request: Request): void {
  if (execution.executor.type !== "request") {
    throw new Error("[Sixb] Only a request execution has a request client.")
  }
  const userAgent = request.headers.get("user-agent")?.trim()
  requestClients.set(
    execution,
    Object.freeze({
      address: getRequestClientAddress(request),
      userAgent: userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : undefined,
    })
  )
}

/** The client of the HTTP request behind this exact execution, if it is a request execution. */
export function getRequestClient(execution: ExecutionContext): RequestClient | undefined {
  return requestClients.get(execution)
}
