import type { AuthorizationContext } from "../authorization"
import { findDatasetIngestRuntime } from "../datasets/ingest-flush"
import { createTestingScope } from "../execution/scopes"
import type { ExecutionScope } from "../execution/types"
import { bindModelExecutionAttempt } from "../models/execution/binding"
import { SixbHost, type SixbHostOptions } from "../runtime/host"
import { isBoundSixb, type Sixb } from "../runtime/sixb"

export type { AuthorizationContext } from "../authorization"

export interface TestExecutionOptions {
  readonly signal?: AbortSignal
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

export function createTestSixb(
  hostOrOptions: TestExecutionHost | SixbHostOptions,
  options: TestExecutionOptions = {}
): Sixb {
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
  if (!isBoundSixb(sixb)) {
    throw new Error("[Sixb] Test host did not return an execution-bound Sixb SDK.")
  }
  bindModelExecutionAttempt(sixb.models, {
    attempt: 1,
    signal: options.signal ?? new AbortController().signal,
  })
  flushIngestionInline(host, sixb)
  return sixb
}

/**
 * `ingest` stores changes for a worker to write. A test reads them right after, so the test SDK
 * writes them itself, as it runs actions: the call returns once its version is committed. A
 * worker running beside the test may write them instead.
 */
function flushIngestionInline(host: TestExecutionHost, sixb: Sixb): void {
  const runtime = findDatasetIngestRuntime(host)
  if (!runtime) return

  const { datasets } = sixb
  const ingest = datasets.ingest.bind(datasets)

  datasets.ingest = async (dataset, input) => {
    const result = await ingest(dataset, input)
    if (result.changes > 0) {
      await runtime.flush(dataset.id, input.signal ?? new AbortController().signal)
    }
    return result
  }
}
