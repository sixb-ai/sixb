import { randomUUID } from "node:crypto"
import type {
  ConnectorAdapter,
  ConnectorClient,
  ConnectorDefinition,
  Logger,
  RegisteredWebhook,
  SixbHostView,
  WebhookDefinition,
  WebhookMetadata,
  WebhookResponse,
} from "@sixb/core"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import { captureSixbFailure, createSixbError, toSixbFailure } from "@sixb/core/internal/errors"
import { bindPrimitiveExecution } from "@sixb/core/internal/primitive-execution"
import type {
  WebhookDeliveryClaimResult,
  WebhookDeliveryFailure,
  WebhookDeliveryKey,
} from "@sixb/core/storage"
import { WEBHOOK_DELIVERY_FAILURE_CODES, WEBHOOK_RUN_FAILURE_CODES } from "@sixb/core/storage"
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

interface WebhookRunFinishBaseInput {
  readonly host: SixbHostView
  readonly registered: RegisteredWebhook
  readonly runId: string
  readonly requestBodyBytes?: number
  readonly responseStatus?: number
  readonly idempotencyKey?: string
  readonly deliveryClaimResult?: WebhookDeliveryClaimResult
}

type WebhookRunFinishInput = WebhookRunFinishBaseInput &
  (
    | {
        readonly status: "succeeded" | "skipped"
        readonly error?: never
        readonly failure?: never
      }
    | {
        readonly status: "failed"
        readonly error: unknown
        readonly failure?: never
      }
    | {
        readonly status: "failed"
        readonly error?: never
        readonly failure: WebhookDeliveryFailure
      }
  )

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
    {
      detail: {
        hide: true,
      },
    }
  )
}

async function dispatchWebhook(options: DispatchWebhookOptions): Promise<unknown> {
  const runId = `webhookrun_${randomUUID()}`
  const { host, registered } = options
  const execution = bindPrimitiveExecution(host, {
    primitive: {
      kind: "webhook",
      id: registered.route,
      runId,
    },
    source: { type: "webhook", deliveryId: runId },
  })
  const logSession = host.logging.startExecution({ kind: "webhook", id: runId })
  let failureReported = false
  const reportFailure = (error: unknown) => {
    if (failureReported) return

    failureReported = true
    reportRunFailure(host, error, {
      projectId: host.id,
      run: {
        kind: "webhook",
        runId,
        connectorId: registered.connector.id,
        webhookId: registered.webhook.id,
      },
    })
  }

  await startWebhookRun(host, registered, options.request, runId)

  try {
    return await dispatchWebhookRun(
      options,
      runId,
      execution.sixb,
      (phase) => logSession.withContext({ phase }),
      reportFailure
    )
  } catch (error) {
    await finishWebhookRun({
      host,
      registered,
      runId,
      status: "failed",
      responseStatus: 500,
      error,
    })
    reportFailure(error)
    throw error
  } finally {
    await logSession.flush()
  }
}

async function dispatchWebhookRun(
  options: DispatchWebhookOptions,
  runId: string,
  sixb: ReturnType<typeof bindPrimitiveExecution>["sixb"],
  loggerForPhase: (phase: string) => Logger,
  reportFailure: (error: unknown) => void
): Promise<unknown> {
  const { host, registered, request, set } = options
  const { connector, webhook, route } = registered
  const requestMethod = request.method.toUpperCase()

  if (requestMethod !== webhook.method) {
    set.status = 405
    setHeader(set, "allow", webhook.method)
    await finishWebhookRun({
      host,
      registered,
      runId,
      status: "failed",
      responseStatus: 405,
      error: "Method not allowed",
    })
    return { error: "Method not allowed" }
  }

  let rawBody: Uint8Array
  try {
    rawBody = await readRawBody(request, options.bodyLimitBytes ?? DEFAULT_WEBHOOK_BODY_LIMIT_BYTES)
  } catch (error) {
    const responseStatus = error instanceof RequestBodyTooLargeError ? 413 : 400
    const message = error instanceof Error ? error.message : String(error)
    set.status = responseStatus
    await finishWebhookRun({
      host,
      registered,
      runId,
      status: "failed",
      responseStatus,
      error,
    })
    return { error: message }
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
    set.status = 401
    await finishWebhookRun({
      host,
      registered,
      runId,
      status: "failed",
      requestBodyBytes: rawBody.byteLength,
      responseStatus: 401,
      error: "Webhook verification failed",
    })
    return { error: "Webhook verification failed" }
  }

  let body: unknown
  try {
    body = parseWebhookBody(webhook, rawBody)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    set.status = 400
    await finishWebhookRun({
      host,
      registered,
      runId,
      status: "failed",
      requestBodyBytes: rawBody.byteLength,
      responseStatus: 400,
      error,
    })
    return { error: message }
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
    const claim = await claimDeliveryKey(host, webhook, idempotencyContext)
    idempotencyKey = claim.idempotencyKey
    deliveryClaimResult = claim.claimResult
    if (claim.status === "skip") {
      const result = accepted(set)
      await finishWebhookRun({
        host,
        registered,
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
    reportFailure(error)
    set.status = 500
    await finishWebhookRun({
      host,
      registered,
      runId,
      status: "failed",
      requestBodyBytes: rawBody.byteLength,
      responseStatus: 500,
      error: "Webhook delivery claim failed",
    })
    return { error: "Webhook delivery claim failed" }
  }

  let response: unknown
  try {
    response = await webhook.handle(handlerContext)
  } catch (error) {
    const deliveryFailure = createWebhookDeliveryFailure({
      registered,
      runId,
      idempotencyKey,
      message: "Webhook handler failed",
      cause: error,
      responseStatus: 500,
    })
    reportFailure(deliveryFailure.error)
    // Handler failures mark the key failed so the provider's next retry can
    // attempt the delivery again.
    if (deliveryKey) {
      await host.storage.webhookDeliveries?.fail({
        ...deliveryKey,
        failedAt: deliveryFailure.failure.at,
        failure: deliveryFailure.failure,
      })
    }

    set.status = 500
    await finishWebhookRun({
      host,
      registered,
      runId,
      status: "failed",
      requestBodyBytes: rawBody.byteLength,
      responseStatus: 500,
      idempotencyKey,
      deliveryClaimResult,
      failure: deliveryFailure.failure,
    })
    return { error: "Webhook handler failed" }
  }

  const responseStatus = getWebhookResponseStatus(response)
  const runStatus = responseStatus >= 200 && responseStatus <= 299 ? "succeeded" : "failed"
  const failureMessage = `Webhook handler returned HTTP ${responseStatus}`
  const shouldRetryDelivery =
    runStatus === "failed" && (responseStatus < 400 || responseStatus >= 500)
  const deliveryFailure = shouldRetryDelivery
    ? createWebhookDeliveryFailure({
        registered,
        runId,
        idempotencyKey,
        message: failureMessage,
        responseStatus,
      })
    : undefined

  try {
    if (deliveryKey) {
      const finalizedAt = new Date().toISOString()
      if (deliveryFailure) {
        await host.storage.webhookDeliveries?.fail({
          ...deliveryKey,
          failedAt: deliveryFailure.failure.at,
          failure: deliveryFailure.failure,
        })
      } else {
        await host.storage.webhookDeliveries?.complete({
          ...deliveryKey,
          completedAt: finalizedAt,
        })
      }
    }
  } catch (error) {
    reportFailure(error)
    set.status = 500
    await finishWebhookRun({
      host,
      registered,
      runId,
      status: "failed",
      requestBodyBytes: rawBody.byteLength,
      responseStatus: 500,
      idempotencyKey,
      deliveryClaimResult,
      error: "Webhook delivery completion failed",
    })
    return { error: "Webhook delivery completion failed" }
  }

  if (deliveryFailure) {
    reportFailure(deliveryFailure.error)
  }
  const terminalMetadata = {
    host,
    registered,
    runId,
    requestBodyBytes: rawBody.byteLength,
    responseStatus,
    idempotencyKey,
    deliveryClaimResult,
  }
  await finishWebhookRun(
    runStatus === "failed"
      ? deliveryFailure
        ? { ...terminalMetadata, status: "failed", failure: deliveryFailure.failure }
        : { ...terminalMetadata, status: "failed", error: failureMessage }
      : { ...terminalMetadata, status: "succeeded" }
  )

  return applyWebhookResponse(set, response)
}

async function startWebhookRun(
  host: SixbHostView,
  registered: RegisteredWebhook,
  request: Request,
  runId: string
): Promise<void> {
  const storage = host.storage.webhookRuns
  if (!storage) {
    return
  }

  try {
    await storage.start({
      id: runId,
      projectId: host.id,
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

async function finishWebhookRun(input: WebhookRunFinishInput): Promise<void> {
  const storage = input.host.storage.webhookRuns
  if (!storage) {
    return
  }

  try {
    const finishedAt =
      input.status === "failed" && input.failure ? new Date(input.failure.at) : new Date()
    const terminalMetadata = {
      id: input.runId,
      projectId: input.host.id,
      finishedAt,
      requestBodyBytes: input.requestBodyBytes,
      responseStatus: input.responseStatus,
      idempotencyKey: input.idempotencyKey,
      deliveryClaimResult: input.deliveryClaimResult,
    }
    await storage.finish(
      input.status === "failed"
        ? {
            ...terminalMetadata,
            status: "failed",
            error:
              input.failure ??
              captureSixbFailure(input.error, {
                allowedCodes: WEBHOOK_RUN_FAILURE_CODES,
                defaultCode: "internal.unexpected",
                details: {
                  connectorId: input.registered.connector.id,
                  webhookId: input.registered.webhook.id,
                  runId: input.runId,
                },
                at: finishedAt,
              }),
          }
        : { ...terminalMetadata, status: input.status }
    )
  } catch {
    // Webhook run history is observability-only. Do not change provider responses
    // when history storage is unavailable or temporarily failing.
  }
}

function createWebhookDeliveryFailure(input: {
  readonly registered: RegisteredWebhook
  readonly runId: string
  readonly idempotencyKey?: string
  readonly message: string
  readonly cause?: unknown
  readonly responseStatus?: number
}): { readonly error: Error; readonly failure: WebhookDeliveryFailure } {
  const at = new Date()
  const error = createSixbError("webhook.delivery_failed", input.message, {
    ...(input.cause === undefined ? {} : { cause: input.cause }),
    details: {
      connectorId: input.registered.connector.id,
      webhookId: input.registered.webhook.id,
      runId: input.runId,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(input.responseStatus === undefined ? {} : { responseStatus: input.responseStatus }),
    },
  })

  return {
    error,
    failure: toSixbFailure(error, {
      allowedCodes: WEBHOOK_DELIVERY_FAILURE_CODES,
      at,
    }),
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
  host: SixbHostView,
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

  const storage = host.storage.webhookDeliveries
  if (!storage) {
    throw new Error("Webhook delivery storage is not configured.")
  }

  const deliveryKey = {
    projectId: host.id,
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
  sixb: ReturnType<typeof bindPrimitiveExecution>["sixb"],
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
