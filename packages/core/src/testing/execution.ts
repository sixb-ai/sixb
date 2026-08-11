import type { AuthorizationContext } from "../authorization"
import { createTestingScope } from "../execution/scopes"
import type { ExecutionScope } from "../execution/types"

export type { AuthorizationContext } from "../authorization"
export type { ExecutionScope } from "../execution/types"

export interface TestExecutionOptions {
  readonly authorization?: AuthorizationContext
  readonly executionId?: string
  readonly requestId?: string
  readonly correlationId?: string
}

/**
 * Create a principal test scope from `authorization`, or an explicit disabled scope when omitted.
 * Test scopes deliberately omit live session identity. Trusted primitive and kernel authority
 * remain unavailable to application tests.
 */
export function createTestExecutionScope(
  projectId: string,
  options: TestExecutionOptions = {}
): ExecutionScope {
  return createTestingScope({
    projectId,
    ...(options.authorization === undefined ? {} : { context: options.authorization }),
    ...(options.executionId === undefined ? {} : { executionId: options.executionId }),
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
  })
}
