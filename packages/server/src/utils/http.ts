import { type SixbErrorCode, SixbValidationError, toSixbFailure } from "@sixb/core/errors"

export function toIsoString(value: Date): string {
  return value.toISOString()
}

export function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new SixbValidationError("runtime.invalid_input", `Invalid date: ${value}`)
  }

  return parsed
}

export function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new SixbValidationError("runtime.invalid_input", `Invalid integer: ${value}`)
  }

  return parsed
}

/**
 * The body of every error response the API returns.
 *
 * `code` is required, and response validation is what holds it: a route that answers with the
 * message alone fails its own declared schema and goes out as a 422, so a forgotten code is a
 * failing test rather than a silently code-less response.
 */
export interface ErrorResponseBody {
  readonly error: string
  readonly code: SixbErrorCode
}

/**
 * The HTTP status each code answers with.
 *
 * `Record` and not a `switch`, for the reason `SIXB_ERROR_RETRYABLE` is one: a new code cannot be
 * added without saying what the API returns for it. Reading the table is also how you check that
 * two codes meaning the same thing do not answer differently — the incoherence this replaced had a
 * run whose state refused the request answering 400 in one primitive and 409 in another.
 *
 * A code that no route can reach still needs a row, because nothing stops a future one from
 * throwing it; the status is the one the failure would deserve.
 */
const STATUS_BY_CODE: Record<SixbErrorCode, number> = {
  "action.commit_failed": 500,
  "action.failed": 500,
  "action.not_found": 404,
  "action.run_not_found": 404,
  "action.timed_out": 504,
  "agent.execution_lost": 500,
  "agent.failed": 500,
  "agent.not_found": 404,
  "agent.run_conflict": 409,
  "agent.run_not_found": 404,
  "agent.thread_conflict": 409,
  "agent.thread_not_found": 404,
  "agent.timed_out": 504,
  "auth.authentication_required": 401,
  "auth.csrf_rejected": 403,
  "auth.invalid_credentials": 401,
  "auth.origin_rejected": 403,
  "auth.permission_denied": 403,
  "auth.rate_limited": 429,
  "auth.record_not_found": 404,
  "auth.session_expired": 401,
  "broker.cursor_expired": 410,
  "broker.unavailable": 503,
  "connector.not_found": 404,
  "connector.rate_limited": 429,
  // The caller did nothing wrong and cannot fix it: these are Sixb's own conversation with a
  // third-party API, so they are 502/503 rather than the status the upstream sent us.
  "connector.request_failed": 502,
  "connector.unauthorized": 502,
  "connector.unavailable": 503,
  "dataset.not_found": 404,
  "dataset.version_not_found": 404,
  "event.append_failed": 500,
  "event.delivery_failed": 500,
  "ontology.invalid_value": 400,
  "ontology.type_not_found": 404,
  "pipeline.already_running": 409,
  "pipeline.failed": 500,
  "pipeline.not_found": 404,
  "pipeline.run_not_found": 404,
  "projection.failed": 500,
  "projection.not_found": 404,
  "projection.run_not_found": 404,
  "provider.failed": 500,
  "provider.unavailable": 503,
  "queue.lease_lost": 500,
  "queue.unavailable": 503,
  "rule.evaluation_failed": 500,
  "rule.not_found": 404,
  "runtime.cancelled": 409,
  // The app's own `define*()` call is wrong, which the caller of this request cannot fix.
  "runtime.invalid_definition": 500,
  "runtime.invalid_input": 400,
  "runtime.invariant_violated": 500,
  // 501 and not 400: the request was well-formed and the caller can do nothing about it. It is not
  // 404 either — that would claim the resource is absent when what is absent is the store that
  // would have recorded it.
  "runtime.not_configured": 501,
  "runtime.payload_too_large": 413,
  "runtime.unexpected": 500,
  // Well-formed, and this deployment cannot do it — the same answer as an empty provider slot.
  "runtime.unsupported": 501,
  "sandbox.failed": 500,
  "sandbox.isolation_unavailable": 501,
  "sandbox.not_running": 409,
  "sandbox.timed_out": 504,
  "storage.blob_failed": 500,
  "storage.conflict": 409,
  "storage.edit_rejected": 400,
  "storage.file_not_found": 404,
  "storage.lake_failed": 500,
  "storage.object_not_found": 404,
  "storage.query_failed": 500,
  "storage.query_invalid": 400,
  "storage.query_unsupported": 400,
  "storage.transaction_failed": 500,
  "storage.unavailable": 503,
  "storage.upload_conflict": 409,
  "storage.upload_expired": 410,
  "storage.upload_invalid": 400,
  "storage.upload_not_found": 404,
  "sync.already_running": 409,
  "sync.failed": 500,
  "sync.not_found": 404,
  "sync.run_not_found": 404,
  "telemetry.point_not_found": 404,
  "webhook.failed": 500,
  "webhook.not_found": 404,
  "webhook.run_not_found": 404,
  "webhook.unverified": 401,
  "workflow.agent_execution_not_found": 404,
  "workflow.failed": 500,
  "workflow.intervention_not_found": 404,
  "workflow.intervention_required": 409,
  "workflow.node_run_not_found": 404,
  "workflow.not_found": 404,
  "workflow.run_conflict": 409,
  "workflow.run_not_found": 404,
}

/** The status a code answers with, for a boundary that builds its own response. */
export function statusForErrorCode(code: SixbErrorCode): number {
  return STATUS_BY_CODE[code]
}

/**
 * The one way a route reports a failure it decided itself.
 *
 * The status comes from the code rather than from the call site, so the same condition cannot
 * answer two ways in two routes, and a caller reading `code` never has to reconcile it with the
 * status it arrived under.
 */
export function errorResponse(
  set: { status?: number | string },
  code: SixbErrorCode,
  message: string
): ErrorResponseBody {
  set.status = STATUS_BY_CODE[code]
  return { error: message, code }
}

/** A storage role the runtime was not configured with. */
export function unconfiguredStorageResponse(
  set: { status?: number | string },
  role: string
): ErrorResponseBody {
  return errorResponse(
    set,
    "runtime.not_configured",
    `[SixbServer] ${role} is not configured on this runtime.`
  )
}

/**
 * The one way a route reports a failure it caught.
 *
 * There is no `instanceof` chain left: every error the runtime raises on purpose carries a code, so
 * the status is a table lookup. What replaced the chain also replaced its tail — a guess at the
 * status from words in the message, which misfired whenever a validation message happened to
 * contain "not found".
 *
 * `fallbackCode` is what a thrown value with no code is filed as. It defaults to bad input rather
 * than to `runtime.unexpected`, which would answer 500 and turn every one of today's 400s into a
 * server error while Sixb still has bare throws left. A route that reaches this line only for
 * genuine surprises passes `runtime.unexpected` and gets the 500 it deserves.
 */
export function handleRouteError(
  error: unknown,
  set: { status?: number | string },
  fallbackCode: SixbErrorCode = "runtime.invalid_input"
): ErrorResponseBody {
  const failure = toSixbFailure(error, { fallbackCode })
  return errorResponse(set, failure.code, failure.message)
}
