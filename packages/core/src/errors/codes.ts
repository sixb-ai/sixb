/**
 * The stable machine vocabulary for every failure Sixb reports.
 *
 * A code is what survives the trip a message cannot make: it is written into the run row, returned
 * on the wire, handed to the runtime observer, and rendered by Atlas — the same string on all four
 * surfaces. Message text is for a human reading one failure; the code is for the branch a caller
 * writes once and keeps.
 *
 * Sorted, and the sort is enforced: `error-codes-doc.test.ts` reads this list against the table in
 * `docs/runtime/error-codes.md` and fails on the first divergence, in either direction.
 */
export const SIXB_ERROR_CODES = [
  "action.commit_failed",
  "action.failed",
  "action.not_found",
  "action.run_not_found",
  "action.timed_out",
  "agent.execution_lost",
  "agent.failed",
  "agent.not_found",
  "agent.run_conflict",
  "agent.run_not_found",
  "agent.thread_conflict",
  "agent.thread_not_found",
  "agent.timed_out",
  "auth.authentication_required",
  "auth.csrf_rejected",
  "auth.invalid_credentials",
  "auth.origin_rejected",
  "auth.permission_denied",
  "auth.rate_limited",
  "auth.record_not_found",
  "auth.session_expired",
  "broker.cursor_expired",
  "broker.unavailable",
  "connector.not_found",
  "connector.rate_limited",
  "connector.request_failed",
  "connector.unauthorized",
  "connector.unavailable",
  "dataset.not_found",
  "dataset.version_not_found",
  "event.append_failed",
  "event.delivery_failed",
  "ontology.invalid_value",
  "ontology.type_not_found",
  "pipeline.already_running",
  "pipeline.failed",
  "pipeline.not_found",
  "pipeline.run_not_found",
  "projection.failed",
  "projection.not_found",
  "projection.run_not_found",
  "provider.failed",
  "provider.unavailable",
  "queue.lease_lost",
  "queue.unavailable",
  "rule.evaluation_failed",
  "rule.not_found",
  "runtime.cancelled",
  "runtime.invalid_definition",
  "runtime.invalid_input",
  "runtime.invariant_violated",
  "runtime.not_configured",
  "runtime.payload_too_large",
  "runtime.unexpected",
  "runtime.unsupported",
  "sandbox.failed",
  "sandbox.isolation_unavailable",
  "sandbox.not_running",
  "sandbox.timed_out",
  "storage.blob_failed",
  "storage.conflict",
  "storage.edit_rejected",
  "storage.file_not_found",
  "storage.lake_failed",
  "storage.object_not_found",
  "storage.query_failed",
  "storage.query_invalid",
  "storage.query_unsupported",
  "storage.transaction_failed",
  "storage.unavailable",
  "storage.upload_conflict",
  "storage.upload_expired",
  "storage.upload_invalid",
  "storage.upload_not_found",
  "sync.already_running",
  "sync.failed",
  "sync.not_found",
  "telemetry.point_not_found",
  "webhook.failed",
  "webhook.not_found",
  "webhook.unverified",
  "workflow.agent_execution_not_found",
  "workflow.failed",
  "workflow.intervention_not_found",
  "workflow.intervention_required",
  "workflow.node_run_not_found",
  "workflow.not_found",
  "workflow.run_conflict",
  "workflow.run_not_found",
] as const

/**
 * Closed on purpose, and the wire is closed with it.
 *
 * Same call already made for {@link AgentRunDiagnosticCode}: Sixb writes these codes and the
 * generated client is what reads them, so an open union would only be honest if the HTTP schema
 * were open too — and that costs the OpenAPI enum, the client's autocompletion, and Atlas's
 * exhaustive `switch`. A new code is a minor version bump.
 *
 * A third party never mints a code. A storage, queue, broker, or sandbox provider reports
 * `provider.*`; a connector reports `connector.*`; both name themselves in `details`. That is what
 * keeps the enum bounded without making third-party failures anonymous.
 */
export type SixbErrorCode = (typeof SIXB_ERROR_CODES)[number]

/** Every namespace in {@link SIXB_ERROR_CODES}, i.e. the part before the first dot. */
export type SixbErrorNamespace = SixbErrorCode extends `${infer Namespace}.${string}`
  ? Namespace
  : never

/**
 * Whether retrying the same operation, unchanged, can plausibly succeed.
 *
 * This is a property of the condition, not of the call site, so it lives with the code rather than
 * being re-decided at every `throw`. A caller with better information overrides it per instance —
 * a `SixbError` constructed with `{ retryable: false }` stays not retryable whatever the table
 * says. `Record<SixbErrorCode, boolean>` and not a `Set`, so a new code cannot be added without
 * answering the question.
 */
export const SIXB_ERROR_RETRYABLE: Record<SixbErrorCode, boolean> = {
  "action.commit_failed": false,
  "action.failed": false,
  "action.not_found": false,
  "action.run_not_found": false,
  "action.timed_out": true,
  "agent.execution_lost": true,
  "agent.failed": false,
  "agent.not_found": false,
  "agent.run_conflict": false,
  "agent.run_not_found": false,
  "agent.thread_conflict": false,
  "agent.thread_not_found": false,
  "agent.timed_out": true,
  "auth.authentication_required": false,
  "auth.csrf_rejected": false,
  "auth.invalid_credentials": false,
  "auth.origin_rejected": false,
  "auth.permission_denied": false,
  "auth.rate_limited": true,
  "auth.record_not_found": false,
  "auth.session_expired": false,
  "broker.cursor_expired": false,
  "broker.unavailable": true,
  "connector.not_found": false,
  "connector.rate_limited": true,
  "connector.request_failed": false,
  "connector.unauthorized": false,
  "connector.unavailable": true,
  "dataset.not_found": false,
  "dataset.version_not_found": false,
  "event.append_failed": true,
  "event.delivery_failed": true,
  "ontology.invalid_value": false,
  "ontology.type_not_found": false,
  "pipeline.already_running": false,
  "pipeline.failed": false,
  "pipeline.not_found": false,
  "pipeline.run_not_found": false,
  "projection.failed": false,
  "projection.not_found": false,
  "projection.run_not_found": false,
  "provider.failed": false,
  "provider.unavailable": true,
  "queue.lease_lost": true,
  "queue.unavailable": true,
  "rule.evaluation_failed": false,
  "rule.not_found": false,
  "runtime.cancelled": false,
  "runtime.invalid_definition": false,
  "runtime.invalid_input": false,
  "runtime.invariant_violated": false,
  "runtime.not_configured": false,
  "runtime.payload_too_large": false,
  "runtime.unexpected": false,
  "runtime.unsupported": false,
  "sandbox.failed": false,
  "sandbox.isolation_unavailable": false,
  "sandbox.not_running": false,
  "sandbox.timed_out": true,
  "storage.blob_failed": true,
  "storage.conflict": true,
  "storage.edit_rejected": false,
  "storage.file_not_found": false,
  "storage.lake_failed": true,
  "storage.object_not_found": false,
  "storage.query_failed": false,
  "storage.query_invalid": false,
  "storage.query_unsupported": false,
  "storage.transaction_failed": false,
  "storage.unavailable": true,
  "storage.upload_conflict": false,
  "storage.upload_expired": false,
  "storage.upload_invalid": false,
  "storage.upload_not_found": false,
  "sync.already_running": false,
  "sync.failed": false,
  "sync.not_found": false,
  "telemetry.point_not_found": false,
  "webhook.failed": false,
  "webhook.not_found": false,
  "webhook.unverified": false,
  "workflow.agent_execution_not_found": false,
  "workflow.failed": false,
  "workflow.intervention_not_found": false,
  "workflow.intervention_required": false,
  "workflow.node_run_not_found": false,
  "workflow.not_found": false,
  "workflow.run_conflict": false,
  "workflow.run_not_found": false,
}

const CODES: ReadonlySet<string> = new Set(SIXB_ERROR_CODES)

/** Narrows an arbitrary string — a wire value, a database column — to a known code. */
export function isSixbErrorCode(value: unknown): value is SixbErrorCode {
  return typeof value === "string" && CODES.has(value)
}

/** The namespace half of a code: `"storage"` for `"storage.conflict"`. */
export function sixbErrorNamespace(code: SixbErrorCode): SixbErrorNamespace {
  return code.slice(0, code.indexOf(".")) as SixbErrorNamespace
}

export type ConnectorResponseErrorCode =
  | "connector.rate_limited"
  | "connector.request_failed"
  | "connector.unauthorized"
  | "connector.unavailable"

/**
 * Classifies an upstream HTTP status into the `connector.*` namespace.
 *
 * Every connector wraps a REST API and every one of them faces the same four questions — is this a
 * credential problem, a rate limit, the far side being down, or a bad request? The answer is a
 * property of HTTP, not of the vendor, so the rule lives here once instead of as a `switch`
 * duplicated per connector and drifting.
 *
 * 408 and 425 join the 5xx family: both mean the request never got a verdict, so retrying it is
 * the same bet as retrying a 503.
 */
export function connectorCodeForStatus(status: number): ConnectorResponseErrorCode {
  if (status === 401 || status === 403) return "connector.unauthorized"
  if (status === 429) return "connector.rate_limited"
  if (status >= 500 || status === 408 || status === 425) return "connector.unavailable"
  return "connector.request_failed"
}
