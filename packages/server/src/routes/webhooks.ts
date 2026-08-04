import { randomUUID } from "node:crypto"
import type {
  ConnectorAdapter,
  ConnectorClient,
  ConnectorDefinition,
  Logger,
  OntologySource,
  RegisteredWebhook,
  Sixb,
  WebhookDefinition,
  WebhookMetadata,
  WebhookResponse,
} from "@sixb/core"
import type { SixbErrorCode } from "@sixb/core/errors"
import { isSixbError } from "@sixb/core/errors"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import type {
  FinishWebhookRunStatus,
  WebhookDeliveryClaimResult,
  WebhookDeliveryKey,
} from "@sixb/core/storage"
import { type SixbFailure, toSixbFailure } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { errorResponse, toErrorResponseBody } from "../utils/http"
import { readRequestBodyWithLimit } from "../utils/request-body"

const DEFAULT_WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024

interface ElysiaSet {
  status?: number | string
  headers?: unknown
}

interface DispatchWebhookOptions {
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly registered: RegisteredWebhook
  readonly request: Request
  readonly set: ElysiaSet
  readonly bodyLimitBytes?: number
}

interface WebhookRunFinishInput {
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly runId: string
  readonly status: FinishWebhookRunStatus
  readonly requestBodyBytes?: number
  readonly responseStatus?: number
  readonly idempotencyKey?: string
  readonly deliveryClaimResult?: WebhookDeliveryClaimResult
  readonly error?: SixbFailure
}

type DeliveryClaimResult =
  | {
      readonly status: "run"
      readonly key: WebhookDeliveryKey | null
      readonly idempotencyKey?: string
      readonly claimResult?: WebhookDeliveryClaimResult
    }
  | {
      readonly status: "skip"
      readonly idempotencyKey: string
      readonly claimResult: WebhookDeliveryClaimResult
    }

export function registerWebhookRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app.all(
    "/api/webhooks/:connectorId/:webhookId",
    async ({ params, request, set }) => {
      const registered = sixb.getWebhookById(params.connectorId, params.webhookId)

      if (!registered) {
        return errorResponse(set, "webhook.not_found", "Webhook not found")
      }

      return dispatchWebhook({ sixb, registered, request, set })
    },
    {
      detail: {
        hide: true,
      },
    }
  )
}

async function dispatchWebhook(options: DispatchWebhookOptions): Promise<unknown> {
  const runId = `webhookrun_${randomUUID()}`
  const { sixb, registered } = options
  const logSession = sixb.logs.startExecution({ kind: "webhook", id: runId })
  let failureReported = false
  const reportFailure = (failure: SixbFailure, cause: unknown) => {
    if (failureReported) return

    failureReported = true
    reportRunFailure(sixb, cause, {
      projectId: sixb.id,
      failure,
      run: {
        kind: "webhook",
        runId,
        connectorId: registered.connector.id,
        webhookId: registered.webhook.id,
      },
    })
  }

  await startWebhookRun(sixb, registered, options.request, runId)

  try {
    return await dispatchWebhookRun(
      options,
      runId,
      (phase) => logSession.withContext({ phase }),
      reportFailure
    )
  } catch (error) {
    const failure = toSixbFailure(error, { fallbackCode: "webhook.failed" })
    await finishWebhookRun({
      sixb,
      runId,
      status: "failed",
      responseStatus: 500,
      error: failure,
    })
    reportFailure(failure, error)
    throw error
  } finally {
    await logSession.flush()
  }
}

async function dispatchWebhookRun(
  options: DispatchWebhookOptions,
  runId: string,
  loggerForPhase: (phase: string) => Logger,
  reportFailure: (failure: SixbFailure, cause: unknown) => void
): Promise<unknown> {
  const { sixb, registered, request, set } = options
  const { connector, webhook, route } = registered
  const requestMethod = request.method.toUpperCase()

  if (requestMethod !== webhook.method) {
    const failure = webhookFailure("runtime.invalid_input", "Method not allowed")
    set.status = 405
    setHeader(set, "allow", webhook.method)
    await finishWebhookRun({
      sixb,
      runId,
      status: "failed",
      responseStatus: 405,
      error: failure,
    })
    return toErrorResponseBody(failure)
  }

  let rawBody: Uint8Array
  try {
    rawBody = await readRawBody(request, options.bodyLimitBytes ?? DEFAULT_WEBHOOK_BODY_LIMIT_BYTES)
  } catch (error) {
    const responseStatus = isSixbError(error, "runtime.payload_too_large") ? 413 : 400
    const failure = toSixbFailure(error, { fallbackCode: "runtime.invalid_input" })
    set.status = responseStatus
    await finishWebhookRun({
      sixb,
      runId,
      status: "failed",
      responseStatus,
      error: failure,
    })
    return toErrorResponseBody(failure)
  }

  const metadata = toWebhookMetadata(webhook, route)
  const baseContext = {
    sixb,
    connector,
    webhook: metadata,
    request,
    rawBody,
  }
  const verifyContext = {
    ...baseContext,
    logger: loggerForPhase("verify"),
  }

  try {
    await webhook.verify?.(verifyContext)
  } catch {
    const failure = webhookFailure("webhook.unverified", "Webhook verification failed")
    set.status = 401
    await finishWebhookRun({
      sixb,
      runId,
      status: "failed",
      requestBodyBytes: rawBody.byteLength,
      responseStatus: 401,
      error: failure,
    })
    return toErrorResponseBody(failure)
  }

  let body: unknown
  try {
    body = parseWebhookBody(webhook, rawBody)
  } catch (error) {
    const failure = toSixbFailure(error, { fallbackCode: "runtime.invalid_input" })
    set.status = 400
    await finishWebhookRun({
      sixb,
      runId,
      status: "failed",
      requestBodyBytes: rawBody.byteLength,
      responseStatus: 400,
      error: failure,
    })
    return toErrorResponseBody(failure)
  }

  const handlerContext = {
    ...baseContext,
    logger: loggerForPhase("handle"),
    body,
    client: createClientResolver(sixb, connector),
  }
  const idempotencyContext = {
    ...handlerContext,
    logger: loggerForPhase("idempotency"),
  }

  // Claim before running the handler so duplicate and concurrent provider
  // retries can be acknowledged without repeating side effects.
  let deliveryKey: WebhookDeliveryKey | null = null
  let idempotencyKey: string | undefined
  let deliveryClaimResult: WebhookDeliveryClaimResult | undefined
  try {
    const claim = await claimDeliveryKey(sixb, webhook, idempotencyContext)
    idempotencyKey = claim.idempotencyKey
    deliveryClaimResult = claim.claimResult
    if (claim.status === "skip") {
      const result = accepted(set)
      await finishWebhookRun({
        sixb,
        runId,
        status: "skipped",
        requestBodyBytes: rawBody.byteLength,
        responseStatus: 202,
        idempotencyKey: claim.idempotencyKey,
        deliveryClaimResult: claim.claimResult,
      })
      return result
    }
    deliveryKey = claim.key
  } catch (error) {
    const failure = webhookFailure("webhook.failed", "Webhook delivery claim failed")
    reportFailure(failure, error)
    set.status = 500
    await finishWebhookRun({
      sixb,
      runId,
      status: "failed",
      requestBodyBytes: rawBody.byteLength,
      responseStatus: 500,
      error: failure,
    })
    return toErrorResponseBody(failure)
  }

  let response: unknown
  try {
    response = await webhook.handle(handlerContext as never)
  } catch (error) {
    reportFailure(webhookFailure("webhook.failed", "Webhook handler failed"), error)
    // Handler failures mark the key failed so the provider's next retry can
    // attempt the delivery again.
    if (deliveryKey) {
      await sixb.storage.webhookDeliveries?.fail({
        ...deliveryKey,
        failedAt: new Date().toISOString(),
        error: toSixbFailure(error, { fallbackCode: "webhook.failed" }),
      })
    }

    const failure = webhookFailure("webhook.failed", "Webhook handler failed")
    set.status = 500
    await finishWebhookRun({
      sixb,
      runId,
      status: "failed",
      requestBodyBytes: rawBody.byteLength,
      responseStatus: 500,
      idempotencyKey,
      deliveryClaimResult,
      error: failure,
    })
    return toErrorResponseBody(failure)
  }

  const responseStatus = getWebhookResponseStatus(response)
  const runStatus = responseStatus >= 200 && responseStatus <= 299 ? "succeeded" : "failed"
  const failureMessage = `Webhook handler returned HTTP ${responseStatus}`
  const responseError = runStatus === "failed" ? failureMessage : undefined
  const shouldRetryDelivery =
    runStatus === "failed" && (responseStatus < 400 || responseStatus >= 500)

  try {
    if (deliveryKey) {
      const finalizedAt = new Date().toISOString()
      if (shouldRetryDelivery) {
        await sixb.storage.webhookDeliveries?.fail({
          ...deliveryKey,
          failedAt: finalizedAt,
          error: webhookFailure("webhook.failed", failureMessage),
        })
      } else {
        await sixb.storage.webhookDeliveries?.complete({
          ...deliveryKey,
          completedAt: finalizedAt,
        })
      }
    }
  } catch (error) {
    const failure = webhookFailure("webhook.failed", "Webhook delivery completion failed")
    reportFailure(failure, error)
    set.status = 500
    await finishWebhookRun({
      sixb,
      runId,
      status: "failed",
      requestBodyBytes: rawBody.byteLength,
      responseStatus: 500,
      idempotencyKey,
      deliveryClaimResult,
      error: failure,
    })
    return toErrorResponseBody(failure)
  }

  if (shouldRetryDelivery) {
    reportFailure(webhookFailure("webhook.failed", failureMessage), new Error(failureMessage))
  }
  await finishWebhookRun({
    sixb,
    runId,
    status: runStatus,
    requestBodyBytes: rawBody.byteLength,
    responseStatus,
    idempotencyKey,
    deliveryClaimResult,
    error: responseError ? webhookFailure("webhook.failed", responseError) : undefined,
  })

  return applyWebhookResponse(set, response)
}

async function startWebhookRun(
  sixb: Sixb<readonly OntologySource[]>,
  registered: RegisteredWebhook,
  request: Request,
  runId: string
): Promise<void> {
  const storage = sixb.storage.webhookRuns
  if (!storage) {
    return
  }

  try {
    await storage.start({
      id: runId,
      projectId: sixb.id,
      connectorId: registered.connector.id,
      webhookId: registered.webhook.id,
      method: request.method.toUpperCase(),
      route: registered.route,
    })
  } catch {
    // Webhook run history is observability-only. Logging and dispatch continue
    // even when history storage is unavailable or temporarily failing.
  }
}

/** A webhook run's terminal failure, recorded in the one shape the other run tables use. */
/** A failure the route decided itself rather than caught: there is nothing to unwrap. */
function webhookFailure(code: SixbErrorCode, message: string): SixbFailure {
  return { code, message }
}

/**
 * The wire form of a failure this route already recorded.
 *
 * The status stays explicit here, unlike everywhere else: a webhook endpoint answers the provider
 * that called it, so a method mismatch owes it a 405 with an `Allow` header and an oversized body a
 * 413, neither of which the code alone would produce.
 */
async function finishWebhookRun(input: WebhookRunFinishInput): Promise<void> {
  const storage = input.sixb.storage.webhookRuns
  if (!storage) {
    return
  }

  try {
    await storage.finish({
      id: input.runId,
      projectId: input.sixb.id,
      status: input.status,
      finishedAt: new Date(),
      requestBodyBytes: input.requestBodyBytes,
      responseStatus: input.responseStatus,
      idempotencyKey: input.idempotencyKey,
      deliveryClaimResult: input.deliveryClaimResult,
      error: input.error,
    })
  } catch {
    // Webhook run history is observability-only. Do not change provider responses
    // when history storage is unavailable or temporarily failing.
  }
}

function readRawBody(request: Request, limitBytes: number): Promise<Uint8Array> {
  return readRequestBodyWithLimit(request, limitBytes, `Webhook body exceeds ${limitBytes} bytes.`)
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

async function claimDeliveryKey(
  sixb: Sixb<readonly OntologySource[]>,
  webhook: WebhookDefinition,
  context: Parameters<NonNullable<WebhookDefinition["idempotencyKey"]>>[0]
): Promise<DeliveryClaimResult> {
  if (!webhook.idempotencyKey) {
    return { status: "run", key: null }
  }

  const idempotencyKey = await webhook.idempotencyKey(context)
  if (idempotencyKey === null || idempotencyKey === undefined) {
    return { status: "run", key: null }
  }

  const storage = sixb.storage.webhookDeliveries
  if (!storage) {
    throw new Error("Webhook delivery storage is not configured.")
  }

  const deliveryKey = {
    projectId: sixb.id,
    connectorId: context.connector.id,
    webhookId: webhook.id,
    idempotencyKey,
  }

  const result = await storage.claim({
    ...deliveryKey,
    receivedAt: new Date().toISOString(),
  })

  if (result.claimResult === "duplicate" || result.claimResult === "in_progress") {
    return { status: "skip", idempotencyKey, claimResult: result.claimResult }
  }

  if (result.claimResult !== "claimed") {
    throw new Error(`Unknown webhook delivery claim result: ${result.claimResult}`)
  }

  return { status: "run", key: deliveryKey, idempotencyKey, claimResult: result.claimResult }
}

function createClientResolver(
  sixb: Sixb<readonly OntologySource[]>,
  connector: ConnectorDefinition
): () => Promise<ConnectorClient<ConnectorAdapter>> {
  let clientPromise: Promise<ConnectorClient<ConnectorAdapter>> | null = null

  return () => {
    // Avoid connecting inbound-only handlers or handlers that never need the
    // outbound client, while still reusing one connection within the request.
    clientPromise ??= sixb.connector(connector)
    return clientPromise
  }
}

function toWebhookMetadata(webhook: WebhookDefinition, route: string): WebhookMetadata {
  return {
    id: webhook.id,
    method: webhook.method,
    route,
    bodyFormat: webhook.body.format,
  }
}

function applyWebhookResponse(set: ElysiaSet, response: unknown): unknown {
  const webhookResponse = isWebhookResponse(response) ? response : undefined
  set.status = getWebhookResponseStatus(response)

  if (webhookResponse?.headers) {
    for (const [key, value] of new Headers(webhookResponse.headers)) {
      setHeader(set, key, value)
    }
  }

  return webhookResponse?.body
}

function getWebhookResponseStatus(response: unknown): number {
  const webhookResponse = isWebhookResponse(response) ? response : undefined
  return webhookResponse?.status ?? 202
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
