import type { AuthorizationContext } from "../authorization"
import { createTestingScope } from "../execution/scopes"
import type { ExecutionScope } from "../execution/types"
import type { OntologySource } from "../ontology"
import { SixbHost, type SixbHostOptions } from "../runtime/host"
import { isBoundSixb, type Sixb } from "../runtime/sixb"

export type { AuthorizationContext } from "../authorization"

export interface TestExecutionOptions {
  readonly authorization?: AuthorizationContext
  readonly executionId?: string
  readonly requestId?: string
  readonly correlationId?: string
}

/**
 * Bind a host to principal test authority from `authorization`, or to explicit disabled authority
 * when omitted. Test executions deliberately omit live session identity. Trusted primitive and
 * kernel authority remain unavailable to application tests.
 */
export interface TestExecutionHost {
  readonly id: string
  withScope(scope: ExecutionScope): object
}

export function createTestSixb<
  TOntologySources extends readonly OntologySource[] = readonly OntologySource[],
>(
  hostOrOptions: TestExecutionHost | SixbHostOptions<TOntologySources>,
  options: TestExecutionOptions = {}
): Sixb<TOntologySources> {
  const host: TestExecutionHost =
    "withScope" in hostOrOptions ? hostOrOptions : new SixbHost(hostOrOptions)
  const sixb = host.withScope(
    createTestingScope({
      projectId: host.id,
      ...(options.authorization === undefined ? {} : { context: options.authorization }),
      ...(options.executionId === undefined ? {} : { executionId: options.executionId }),
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    })
  )
  if (!isBoundSixb<TOntologySources>(sixb)) {
    throw new Error("[Sixb] Test host did not return an execution-bound Sixb SDK.")
  }
  return sixb
}
