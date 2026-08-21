import { createHash, randomUUID } from "node:crypto"
import type {
  ConnectorAdapter,
  ConnectorClient,
  ConnectorDefinition,
  Logger,
  RegisteredWebhook,
  SixbFailure,
  SixbHostView,
  WebhookDefinition,
  WebhookMetadata,
  WebhookResponse,
} from "@sixb/core"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import { captureSixbFailure, createSixbError, toSixbFailure } from "@sixb/core/internal/errors"
import { bindDurablePrimitiveExecution } from "@sixb/core/internal/primitive-execution"
import { type AdmitWebhookRunResult, admitWebhookRun } from "@sixb/core/internal/webhooks"
import type { WebhookRunFailureCode } from "@sixb/core/storage"
import { WEBHOOK_RUN_FAILURE_CODES, WebhookRunError } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { RequestBodyTooLargeError, readRequestBodyWithLimit } from "../utils/request-body"

const DEFAULT_WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024

interface ElysiaSet {
  status?: number | string
  headers?: unknown
}

interface DispatchWebhookOptions {
  readonly host: SixbHostView
  readonly registered: RegisteredWebhook
  readonly request: Request
  readonly set: ElysiaSet
  readonly bodyLimitBytes?: number
}

interface PreparedWebhookRequest {
  readonly rawBody: Uint8Array
  readonly body: unknown
  readonly metadata: WebhookMetadata
  readonly idempotencyKey?: string
}

type PreparedWebhookResult =
  | { readonly status: "ready"; readonly request: PreparedWebhookRequest }
  | { readonly status: "responded"; readonly response: unknown }

type WebhookAdmissionResult =
  | AdmitWebhookRunResult
  | { readonly status: "responded"; readonly response: unknown }

type WebhookRunFailure = SixbFailure<WebhookRunFailureCode>

type FinishWebhookRunInput =
  | {
      readonly runId: string
      readonly status: "succeeded"
      readonly responseStatus: number
    }
  | {
      readonly runId: string
      readonly status: "failed"
      readonly responseStatus: number
      readonly failure: WebhookRunFailure
    }

export function registerWebhookRoutes(app: Elysia, host: SixbHostView) {
  return app.all(
    "/api/webhooks/:connectorId/:webhookId",
    async ({ params, request, set }) => {
      const registered = host.getWebhookById(params.connectorId, params.webhookId)
      if (!registered) {
        set.status = 404
        return { error: "Webhook not found" }
      }
      return dispatchWebhook({ host, registered, request, set })
    },
    { detail: { hide: true } }
  )
}

async function dispatchWebhook(options: DispatchWebhookOptions): Promise<unknown> {
  const candidateRunId = `webhookrun_${randomUUID()}`
  const prepared = await prepareWebhookRequest(options)
  if (prepared.status === "responded") return prepared.response

  const admission = await admitPreparedWebhook(options, candidateRunId, prepared.request)
  if (admission.status === "responded") return admission.response
  if (admission.status !== "admitted") return accepted(options.set)

  const executionLogs = options.host.logging.startExecution({
    kind: "webhook",
    id: admission.run.id,
  })
  try {
    return await executeWebhookHandler(
      options,
      prepared.request,
      admission,
      executionLogs.withContext({ phase: "handle" })
    )
  } finally {
    await executionLogs.flush()
  }
}

async function prepareWebhookRequest(
  options: DispatchWebhookOptions
): Promise<PreparedWebhookResult> {
  const { connector, webhook, route } = options.registered
  const requestMethod = options.request.method.toUpperCase()
  if (requestMethod !== webhook.method) {
    options.set.status = 405
    setHeader(options.set, "allow", webhook.method)
    return { status: "responded", response: { error: "Method not allowed" } }
  }

  let rawBody: Uint8Array
  try {
    rawBody = await readRequestBodyWithLimit(
      options.request,
      options.bodyLimitBytes ?? DEFAULT_WEBHOOK_BODY_LIMIT_BYTES,
      `Webhook body exceeds ${options.bodyLimitBytes ?? DEFAULT_WEBHOOK_BODY_LIMIT_BYTES} bytes.`
    )
  } catch (error) {
    const responseStatus = error instanceof RequestBodyTooLargeError ? 413 : 400
    options.set.status = responseStatus
    return {
      status: "responded",
      response: { error: error instanceof Error ? error.message : String(error) },
    }
  }

  const metadata = toWebhookMetadata(webhook, route)
  const baseContext = {
    connector,
    webhook: metadata,
    request: options.request,
    rawBody,
  }
  try {
    await webhook.verify?.(baseContext)
  } catch {
    options.set.status = 401
    return { status: "responded", response: { error: "Webhook verification failed" } }
  }

  let body: unknown
  try {
    body = parseWebhookBody(webhook, rawBody)
  } catch (error) {
    options.set.status = 400
    return {
      status: "responded",
      response: { error: error instanceof Error ? error.message : String(error) },
    }
  }

  try {
    const idempotencyKey = await webhook.idempotencyKey?.({
      ...baseContext,
      body,
    })
    return {
      status: "ready",
      request: {
        rawBody,
        body,
        metadata,
        ...(idempotencyKey === null || idempotencyKey === undefined ? {} : { idempotencyKey }),
      },
    }
  } catch {
    options.set.status = 500
    return { status: "responded", response: { error: "Webhook admission failed" } }
  }
}

async function admitPreparedWebhook(
  options: DispatchWebhookOptions,
  runId: string,
  prepared: PreparedWebhookRequest
): Promise<WebhookAdmissionResult> {
  try {
    return await admitWebhookRun({
      projectId: options.host.id,
      storage: options.host.storage,
      runId,
      connectorId: options.registered.connector.id,
      webhookId: options.registered.webhook.id,
      method: options.request.method.toUpperCase(),
      route: options.registered.route,
      requestBodyBytes: prepared.rawBody.byteLength,
      requestBodySha256: createHash("sha256").update(prepared.rawBody).digest("hex"),
      idempotencyKey: prepared.idempotencyKey,
    })
  } catch (error) {
    if (error instanceof WebhookRunError && error.code === "delivery_conflict") {
      options.set.status = 409
      return { status: "responded", response: { error: "Webhook delivery conflict" } }
    }
    options.set.status = 500
    return { status: "responded", response: { error: "Webhook admission failed" } }
  }
}

async function executeWebhookHandler(
  options: DispatchWebhookOptions,
  prepared: PreparedWebhookRequest,
  admission: Extract<AdmitWebhookRunResult, { readonly status: "admitted" }>,
  logger: Logger
): Promise<unknown> {
  const { host, registered, request, set } = options
  const { connector, webhook } = registered
  const runId = admission.run.id
  const reportFailure = createFailureReporter(host, registered, runId)

  let response: unknown
  try {
    const execution = bindDurablePrimitiveExecution(host, {
      execution: admission.execution,
      primitive: { kind: "webhook", id: registered.route, runId },
    })
    response = await webhook.handle({
      sixb: execution.sixb,
      connector,
      webhook: prepared.metadata,
      request,
      rawBody: prepared.rawBody,
      body: prepared.body,
      logger,
      client: createClientResolver(execution.sixb, connector),
    })
  } catch (error) {
    const failed = createWebhookRunFailure({
      registered,
      runId,
      idempotencyKey: prepared.idempotencyKey,
      responseStatus: 500,
      message: "Webhook handler failed",
      cause: error,
    })
    reportFailure(failed.error, failed.failure)
    try {
      await finishWebhookRun(host, {
        runId,
        status: "failed",
        responseStatus: 500,
        failure: failed.failure,
      })
    } catch (_finalizationError) {
      // The original failure remains the actionable cause. A terminal write failure leaves the
      // durable run visibly running instead of pretending that its outcome was recorded.
    }
    set.status = 500
    return { error: "Webhook handler failed" }
  }

  const responseStatus = getWebhookResponseStatus(response)
  const succeeded = responseStatus >= 200 && responseStatus <= 299
  const failed = succeeded
    ? undefined
    : createWebhookRunFailure({
        registered,
        runId,
        idempotencyKey: prepared.idempotencyKey,
        responseStatus,
        message: `Webhook handler returned HTTP ${responseStatus}`,
      })
  try {
    await finishWebhookRun(
      host,
      failed
        ? { runId, status: "failed", responseStatus, failure: failed.failure }
        : { runId, status: "succeeded", responseStatus }
    )
  } catch (error) {
    const failure = captureSixbFailure(error, {
      allowedCodes: WEBHOOK_RUN_FAILURE_CODES,
      defaultCode: "internal.unexpected",
      details: {
        connectorId: registered.connector.id,
        webhookId: registered.webhook.id,
        runId,
        phase: "finalize",
      },
    })
    reportFailure(error, failure)
    set.status = 500
    return { error: "Webhook run finalization failed" }
  }
  if (failed?.failure.retryable) {
    reportFailure(failed.error, failed.failure)
  }
  return applyWebhookResponse(set, response)
}

function createFailureReporter(
  host: SixbHostView,
  registered: RegisteredWebhook,
  runId: string
): (error: unknown, failure: WebhookRunFailure) => void {
  let reported = false
  return (error, failure) => {
    if (reported) return
    reported = true
    reportRunFailure(host, error, {
      projectId: host.id,
      runKind: "webhook",
      run: {
        runId,
        connectorId: registered.connector.id,
        webhookId: registered.webhook.id,
      },
      failure,
    })
  }
}

async function finishWebhookRun(host: SixbHostView, input: FinishWebhookRunInput): Promise<void> {
  const storage = host.storage.webhookRuns
  if (!storage) {
    throw createSixbError(
      "internal.unexpected",
      "[SixbServer] Webhook run storage is not configured."
    )
  }
  const terminal = {
    id: input.runId,
    projectId: host.id,
    responseStatus: input.responseStatus,
  }
  await storage.finish(
    input.status === "failed"
      ? {
          ...terminal,
          status: "failed",
          finishedAt: new Date(input.failure.at),
          error: input.failure,
        }
      : { ...terminal, status: "succeeded", finishedAt: new Date() }
  )
}

function createWebhookRunFailure(input: {
  readonly registered: RegisteredWebhook
  readonly runId: string
  readonly idempotencyKey?: string
  readonly responseStatus: number
  readonly message: string
  readonly cause?: unknown
}): { readonly error: Error; readonly failure: WebhookRunFailure } {
  const code =
    input.responseStatus < 400 || input.responseStatus >= 500
      ? "webhook.delivery_failed"
      : "webhook.delivery_rejected"
  const error = createSixbError(code, input.message, {
    ...(input.cause === undefined ? {} : { cause: input.cause }),
    details: {
      connectorId: input.registered.connector.id,
      webhookId: input.registered.webhook.id,
      runId: input.runId,
      responseStatus: input.responseStatus,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    },
  })
  return {
    error,
    failure: toSixbFailure(error, { allowedCodes: WEBHOOK_RUN_FAILURE_CODES }),
  }
}

function parseWebhookBody(webhook: WebhookDefinition, rawBody: Uint8Array): unknown {
  const decoded =
    webhook.body.format === "raw"
      ? rawBody
      : webhook.body.format === "text"
        ? new TextDecoder().decode(rawBody)
        : JSON.parse(new TextDecoder().decode(rawBody))
  return webhook.body.parse(decoded)
}

function createClientResolver(
  sixb: ReturnType<typeof bindDurablePrimitiveExecution>["sixb"],
  connector: ConnectorDefinition
): () => Promise<ConnectorClient<ConnectorAdapter>> {
  let clientPromise: Promise<ConnectorClient<ConnectorAdapter>> | null = null
  return () => {
    clientPromise ??= sixb.connector(connector)
    return clientPromise
  }
}

function toWebhookMetadata(webhook: WebhookDefinition, route: string): WebhookMetadata {
  return { id: webhook.id, method: webhook.method, route, bodyFormat: webhook.body.format }
}

function applyWebhookResponse(set: ElysiaSet, response: unknown): unknown {
  const webhookResponse = isWebhookResponse(response) ? response : undefined
  set.status = getWebhookResponseStatus(response)
  if (webhookResponse?.headers) {
    for (const [key, value] of new Headers(webhookResponse.headers)) setHeader(set, key, value)
  }
  return webhookResponse?.body
}

function getWebhookResponseStatus(response: unknown): number {
  return isWebhookResponse(response) ? (response.status ?? 202) : 202
}

function accepted(set: ElysiaSet): undefined {
  set.status = 202
  return undefined
}

function setHeader(set: ElysiaSet, key: string, value: string): void {
  if (!set.headers || typeof set.headers !== "object" || Array.isArray(set.headers)) {
    set.headers = {}
  }
  ;(set.headers as Record<string, string>)[key] = value
}

function isWebhookResponse(value: unknown): value is WebhookResponse {
  return typeof value === "object" && value !== null
}
