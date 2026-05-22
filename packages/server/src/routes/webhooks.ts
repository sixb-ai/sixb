import type {
  ConnectorAdapter,
  ConnectorClient,
  ConnectorDefinition,
  OntologySource,
  Pario,
  RegisteredWebhook,
  WebhookDefinition,
  WebhookDeliveryKey,
  WebhookMetadata,
  WebhookResponse,
} from "@pario/core"
import type { Elysia } from "elysia"

const DEFAULT_WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024

interface ElysiaSet {
  status?: number | string
  headers?: unknown
}

interface DispatchWebhookOptions {
  readonly pario: Pario<readonly OntologySource[]>
  readonly registered: RegisteredWebhook
  readonly request: Request
  readonly set: ElysiaSet
  readonly bodyLimitBytes?: number
}

export function registerWebhookRoutes(app: Elysia, pario: Pario<readonly OntologySource[]>) {
  return app.all(
    "/api/webhooks/:connectorId/:webhookId",
    async ({ params, request, set }) => {
      const registered = pario.getWebhookById(params.connectorId, params.webhookId)

      if (!registered) {
        set.status = 404
        return { error: "Webhook not found" }
      }

      return dispatchWebhook({ pario, registered, request, set })
    },
    {
      detail: {
        hide: true,
      },
    }
  )
}

async function dispatchWebhook(options: DispatchWebhookOptions): Promise<unknown> {
  const { pario, registered, request, set } = options
  const { connector, webhook, route } = registered

  if (request.method.toUpperCase() !== webhook.method) {
    set.status = 405
    setHeader(set, "allow", webhook.method)
    return { error: "Method not allowed" }
  }

  let rawBody: Uint8Array
  try {
    rawBody = await readRawBody(request, options.bodyLimitBytes ?? DEFAULT_WEBHOOK_BODY_LIMIT_BYTES)
  } catch (error) {
    set.status = error instanceof WebhookBodyTooLargeError ? 413 : 400
    return { error: error instanceof Error ? error.message : String(error) }
  }

  const metadata = toWebhookMetadata(webhook, route)
  const verifyContext = {
    pario,
    connector,
    webhook: metadata,
    request,
    rawBody,
  }

  try {
    await webhook.verify?.(verifyContext)
  } catch {
    set.status = 401
    return { error: "Webhook verification failed" }
  }

  let body: unknown
  try {
    body = parseWebhookBody(webhook, rawBody)
  } catch (error) {
    set.status = 400
    return { error: error instanceof Error ? error.message : String(error) }
  }

  const handlerContext = {
    ...verifyContext,
    body,
    client: createClientResolver(pario, connector),
  }

  // Claim before running the handler so duplicate and concurrent provider
  // retries can be acknowledged without repeating side effects.
  let deliveryKey: WebhookDeliveryKey | null = null
  try {
    const claim = await claimDeliveryKey(pario, webhook, handlerContext)
    if (claim.status === "skip") {
      return accepted(set)
    }
    deliveryKey = claim.key
  } catch {
    set.status = 500
    return { error: "Webhook delivery claim failed" }
  }

  let response: unknown
  try {
    response = await webhook.handle(handlerContext as never)
  } catch (error) {
    // Handler failures mark the key failed so the provider's next retry can
    // attempt the delivery again.
    if (deliveryKey) {
      await pario.storage.webhookDeliveries?.fail({
        ...deliveryKey,
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })
    }

    set.status = 500
    return { error: "Webhook handler failed" }
  }

  try {
    if (deliveryKey) {
      // Mark completion only after the synchronous handler has succeeded.
      await pario.storage.webhookDeliveries?.complete({
        ...deliveryKey,
        completedAt: new Date().toISOString(),
      })
    }
  } catch {
    set.status = 500
    return { error: "Webhook delivery completion failed" }
  }

  return applyWebhookResponse(set, response)
}

async function readRawBody(request: Request, limitBytes: number): Promise<Uint8Array> {
  const contentLengthHeader = request.headers.get("content-length")
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10)
    if (Number.isFinite(contentLength) && contentLength > limitBytes) {
      throw new WebhookBodyTooLargeError(limitBytes)
    }
  }

  const buffer = await request.arrayBuffer()
  if (buffer.byteLength > limitBytes) {
    throw new WebhookBodyTooLargeError(limitBytes)
  }

  return new Uint8Array(buffer)
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
  pario: Pario<readonly OntologySource[]>,
  webhook: WebhookDefinition,
  context: Parameters<NonNullable<WebhookDefinition["idempotencyKey"]>>[0]
): Promise<
  { readonly status: "run"; readonly key: WebhookDeliveryKey | null } | { readonly status: "skip" }
> {
  if (!webhook.idempotencyKey) {
    return { status: "run", key: null }
  }

  const idempotencyKey = await webhook.idempotencyKey(context)
  if (idempotencyKey === null || idempotencyKey === undefined) {
    return { status: "run", key: null }
  }

  const storage = pario.storage.webhookDeliveries
  if (!storage) {
    throw new Error("Webhook delivery storage is not configured.")
  }

  const deliveryKey = {
    projectId: pario.id,
    connectorId: context.connector.id,
    webhookId: webhook.id,
    idempotencyKey,
  }

  const result = await storage.claim({
    ...deliveryKey,
    receivedAt: new Date().toISOString(),
  })

  if (result.claimResult === "duplicate" || result.claimResult === "in_progress") {
    return { status: "skip" }
  }

  if (result.claimResult !== "claimed") {
    throw new Error(`Unknown webhook delivery claim result: ${result.claimResult}`)
  }

  return { status: "run", key: deliveryKey }
}

function createClientResolver(
  pario: Pario<readonly OntologySource[]>,
  connector: ConnectorDefinition
): () => Promise<ConnectorClient<ConnectorAdapter>> {
  let clientPromise: Promise<ConnectorClient<ConnectorAdapter>> | null = null

  return () => {
    // Avoid connecting inbound-only handlers or handlers that never need the
    // outbound client, while still reusing one connection within the request.
    clientPromise ??= pario.connector(connector)
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
  set.status = webhookResponse?.status ?? 202

  if (webhookResponse?.headers) {
    for (const [key, value] of new Headers(webhookResponse.headers)) {
      setHeader(set, key, value)
    }
  }

  return webhookResponse?.body
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

class WebhookBodyTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Webhook body exceeds ${limitBytes} bytes.`)
  }
}

function isWebhookResponse(value: unknown): value is WebhookResponse {
  return typeof value === "object" && value !== null
}
