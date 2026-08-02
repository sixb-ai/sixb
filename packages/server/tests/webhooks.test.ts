import { describe, expect, test } from "bun:test"
import {
  defineConnector,
  defineWebhook,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type LogEntry,
  type LoggerProvider,
  type OntologySource,
  Sixb,
  type SixbErrorContext,
  type SixbErrorHandler,
  type SixbOptions,
} from "@sixb/core"
import { flushSixbErrors } from "@sixb/core/internal/error-reporting"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

function createSixbInstance<TOntologySources extends readonly OntologySource[]>(
  options: SixbOptions<TOntologySources>
): Sixb<TOntologySources> {
  const SixbConstructor = Sixb as unknown as new (
    options: SixbOptions<TOntologySources>
  ) => Sixb<TOntologySources>

  return new SixbConstructor(options)
}

describe("webhook routes", () => {
  test("dispatches validated bodies with raw bytes, metadata, and lazy clients", async () => {
    let rawBodyText = ""
    let requestHeader = ""
    let connected = false
    const logEntries: LogEntry[] = []
    const logger: LoggerProvider = {
      write(entry) {
        logEntries.push(entry)
      },
    }

    const connector = defineConnector("github", {
      type: "test",
      webhooks: [
        defineWebhook("events")
          .post()
          .json({
            parse(value: unknown): { name: string } {
              if (!isRecord(value) || typeof value.name !== "string") {
                throw new Error("name is required")
              }

              return { name: value.name }
            },
          })
          .verify(({ request, rawBody, logger }) => {
            logger.info("verified")
            requestHeader = request.headers.get("x-provider") ?? ""
            rawBodyText = new TextDecoder().decode(rawBody)
          })
          .idempotencyKey(({ logger }) => {
            logger.info("resolved idempotency")
            return null
          })
          .handle(async ({ body, client, sixb, request, webhook, logger }) => {
            logger.info("handled")
            const resolved = (await client()) as { source: string }
            connected = resolved.source === "github"

            return {
              status: 201,
              headers: { "x-webhook": webhook.route },
              body: {
                name: body.name,
                projectId: sixb.id,
                requestHeader: request.headers.get("x-provider"),
              },
            }
          }),
      ],
      connect() {
        return { source: "github" }
      },
    })

    const storage = new InMemoryStorage()
    const app = createWebhookApp([connector], storage, logger)
    const payload = JSON.stringify({ name: "issue-opened" })
    const response = await app.fetch(
      new Request("http://localhost/api/webhooks/github/events", {
        method: "POST",
        headers: { "content-type": "application/json", "x-provider": "github" },
        body: payload,
      })
    )

    expect(response.status).toBe(201)
    expect(response.headers.get("x-webhook")).toBe("/api/webhooks/github/events")
    expect(await response.json()).toEqual({
      name: "issue-opened",
      projectId: "test-project",
      requestHeader: "github",
    })
    expect(rawBodyText).toBe(payload)
    expect(requestHeader).toBe("github")
    expect(connected).toBe(true)

    const runs = await storage.webhookRuns.list({
      projectId: "test-project",
      connectorId: "github",
      webhookId: "events",
    })
    const [run] = runs.runs

    expect(runs.total).toBe(1)
    expect(run).toMatchObject({
      connectorId: "github",
      webhookId: "events",
      method: "POST",
      route: "/api/webhooks/github/events",
      status: "succeeded",
      responseStatus: 201,
    })
    expect(run?.requestBodyBytes).toBe(new TextEncoder().encode(payload).byteLength)
    expect(logEntries.map((entry) => [entry.message, entry.context.phase])).toEqual([
      ["verified", "verify"],
      ["resolved idempotency", "idempotency"],
      ["handled", "handle"],
    ])
    expect(new Set(logEntries.map((entry) => entry.context.run.id))).toEqual(new Set([run?.id]))
    expect(logEntries.every((entry) => entry.context.run.kind === "webhook")).toBe(true)
  })

  test("returns 400 for body validation failures before handlers run", async () => {
    let calls = 0
    const connector = defineConnector("edge", {
      type: "test",
      webhooks: [
        defineWebhook("telemetry")
          .post()
          .json({
            parse(value: unknown): { value: number } {
              if (!isRecord(value) || typeof value.value !== "number") {
                throw new Error("value must be a number")
              }

              return { value: value.value }
            },
          })
          .handle(() => {
            calls += 1
          }),
      ],
      connect() {
        return {}
      },
    })

    const storage = new InMemoryStorage()
    const app = createWebhookApp([connector], storage)
    const payload = JSON.stringify({ value: "hot" })
    const response = await app.fetch(
      new Request("http://localhost/api/webhooks/edge/telemetry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      })
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "value must be a number",
      code: "runtime.invalid_input",
    })
    expect(calls).toBe(0)

    const runs = await storage.webhookRuns.list({ projectId: "test-project" })
    const [run] = runs.runs

    expect(runs.total).toBe(1)
    expect(run).toMatchObject({
      connectorId: "edge",
      webhookId: "telemetry",
      status: "failed",
      responseStatus: 400,
      error: { code: "runtime.invalid_input", message: "value must be a number" },
    })
    expect(run?.requestBodyBytes).toBe(new TextEncoder().encode(payload).byteLength)
  })

  test("skips duplicate idempotent deliveries before handlers run", async () => {
    let calls = 0
    const connector = defineConnector("github", {
      type: "test",
      webhooks: [
        defineWebhook("events")
          .post()
          .json()
          .idempotencyKey(({ request }) => request.headers.get("x-github-delivery"))
          .handle(() => {
            calls += 1
          }),
      ],
      connect() {
        return {}
      },
    })

    const storage = new InMemoryStorage()
    const app = createWebhookApp([connector], storage)
    const request = () =>
      new Request("http://localhost/api/webhooks/github/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-1",
        },
        body: JSON.stringify({ ok: true }),
      })

    const first = await app.fetch(request())
    const second = await app.fetch(request())

    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(calls).toBe(1)

    const runs = await storage.webhookRuns.list({
      projectId: "test-project",
      connectorId: "github",
      webhookId: "events",
      order: "asc",
    })
    const succeeded = runs.runs.find((run) => run.status === "succeeded")
    const skipped = runs.runs.find((run) => run.status === "skipped")

    expect(runs.total).toBe(2)
    expect(succeeded).toMatchObject({
      responseStatus: 202,
      idempotencyKey: "delivery-1",
      deliveryClaimResult: "claimed",
    })
    expect(skipped).toMatchObject({
      responseStatus: 202,
      idempotencyKey: "delivery-1",
      deliveryClaimResult: "duplicate",
    })

    const listResponse = await app.fetch(
      new Request(
        "http://localhost/api/webhook-runs?connectorId=github&webhookId=events&status=skipped&idempotencyKey=delivery-1"
      )
    )
    const listBody = (await listResponse.json()) as {
      runs: Array<{
        status: string
        connectorId: string
        webhookId: string
        idempotencyKey?: string
        deliveryClaimResult?: string
      }>
      total: number
      hasMore: boolean
    }

    expect(listResponse.status).toBe(200)
    expect(listBody).toMatchObject({
      total: 1,
      hasMore: false,
      runs: [
        {
          connectorId: "github",
          webhookId: "events",
          status: "skipped",
          idempotencyKey: "delivery-1",
          deliveryClaimResult: "duplicate",
        },
      ],
    })
  })

  test("provides webhook logging when run history storage is not configured", async () => {
    const logEntries: LogEntry[] = []
    const connector = defineConnector("github", {
      type: "test",
      webhooks: [
        defineWebhook("events")
          .post()
          .json()
          .handle(({ logger }) => {
            logger.info("handled without history")
          }),
      ],
      connect() {
        return {}
      },
    })
    const storage = new InMemoryStorage()
    Object.defineProperty(storage, "webhookRuns", { value: undefined })
    const app = createWebhookApp([connector], storage, {
      write(entry) {
        logEntries.push(entry)
      },
    })

    const response = await app.fetch(
      new Request("http://localhost/api/webhooks/github/events", {
        method: "POST",
        body: JSON.stringify({ ok: true }),
      })
    )

    expect(response.status).toBe(202)
    expect(logEntries).toHaveLength(1)
    expect(logEntries[0]).toMatchObject({
      message: "handled without history",
      context: { run: { kind: "webhook" }, phase: "handle" },
    })
  })

  test("maps unknown, unsupported, verification, and handler errors", async () => {
    const handlerError = new Error("boom")
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    const connector = defineConnector("github", {
      type: "test",
      webhooks: [
        defineWebhook("events")
          .post()
          .text()
          .verify(() => {
            throw new Error("bad signature")
          })
          .handle(() => {
            throw new Error("should not run")
          }),
        defineWebhook("failing")
          .post()
          .text()
          .handle(() => {
            throw handlerError
          }),
      ],
      connect() {
        return {}
      },
    })

    const storage = new InMemoryStorage()
    const { app, sixb } = createWebhookRuntime(
      [connector],
      storage,
      undefined,
      (error, context) => {
        reports.push({ error, context })
      }
    )

    const unknown = await app.fetch(
      new Request("http://localhost/api/webhooks/github/missing", { method: "POST" })
    )
    const unsupported = await app.fetch(
      new Request("http://localhost/api/webhooks/github/events", { method: "GET" })
    )
    const unauthorized = await app.fetch(
      new Request("http://localhost/api/webhooks/github/events", {
        method: "POST",
        body: "hello",
      })
    )
    const failed = await app.fetch(
      new Request("http://localhost/api/webhooks/github/failing", {
        method: "POST",
        body: "hello",
      })
    )
    await flushSixbErrors(sixb)

    expect(unknown.status).toBe(404)
    expect(unsupported.status).toBe(405)
    expect(unsupported.headers.get("allow")).toBe("POST")
    expect(unauthorized.status).toBe(401)
    expect(failed.status).toBe(500)

    const runs = await storage.webhookRuns.list({ projectId: "test-project" })

    expect(runs.total).toBe(3)
    expect(runs.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          webhookId: "events",
          method: "GET",
          status: "failed",
          responseStatus: 405,
          error: { code: "runtime.invalid_input", message: "Method not allowed" },
        }),
        expect.objectContaining({
          webhookId: "events",
          method: "POST",
          status: "failed",
          responseStatus: 401,
          error: { code: "webhook.unverified", message: "Webhook verification failed" },
        }),
        expect.objectContaining({
          webhookId: "failing",
          method: "POST",
          status: "failed",
          responseStatus: 500,
          error: { code: "webhook.failed", message: "Webhook handler failed" },
        }),
      ])
    )

    const failedRun = runs.runs.find((run) => run.webhookId === "failing")
    expect(reports).toHaveLength(1)
    expect(reports[0]?.error).toBe(handlerError)
    expect(reports[0]?.context).toMatchObject({
      type: "run.failed",
      notificationId: `project:test-project:run:webhook:${failedRun?.id}:failed:${reports[0]?.context.occurredAt}`,
      projectId: "test-project",
      run: {
        kind: "webhook",
        runId: failedRun?.id,
        connectorId: "github",
        webhookId: "failing",
      },
    })
  })

  test("reports delivery infrastructure and returned non-4xx failures exactly once", async () => {
    const claimError = new Error("claim storage unavailable")
    const completionError = new Error("completion storage unavailable")
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    const connector = defineConnector("github", {
      type: "test",
      webhooks: [
        defineWebhook("claim-failure")
          .post()
          .json()
          .idempotencyKey(() => "claim-delivery")
          .handle(() => undefined),
        defineWebhook("completion-failure")
          .post()
          .json()
          .idempotencyKey(() => "completion-delivery")
          .handle(() => undefined),
        defineWebhook("unavailable")
          .post()
          .json()
          .handle(() => ({ status: 503, body: { error: "Retry later" } })),
        defineWebhook("redirected")
          .post()
          .json()
          .handle(() => ({ status: 302, body: { location: "elsewhere" } })),
        defineWebhook("client-rejection")
          .post()
          .json()
          .handle(() => ({ status: 422, body: { error: "Invalid event" } })),
        defineWebhook("success")
          .post()
          .json()
          .handle(() => undefined),
      ],
      connect() {
        return {}
      },
    })

    const storage = new InMemoryStorage()
    const deliveries = storage.webhookDeliveries
    const claim = deliveries.claim.bind(deliveries)
    const complete = deliveries.complete.bind(deliveries)
    deliveries.claim = async (input) => {
      if (input.webhookId === "claim-failure") {
        throw claimError
      }
      return claim(input)
    }
    deliveries.complete = async (input) => {
      if (input.webhookId === "completion-failure") {
        throw completionError
      }
      return complete(input)
    }
    storage.webhookRuns.finish = async () => {
      throw new Error("run history unavailable")
    }

    const { app, sixb } = createWebhookRuntime(
      [connector],
      storage,
      undefined,
      (error, context) => {
        reports.push({ error, context })
      }
    )
    const dispatch = (webhookId: string) =>
      app.fetch(
        new Request(`http://localhost/api/webhooks/github/${webhookId}`, {
          method: "POST",
          body: JSON.stringify({ ok: true }),
        })
      )

    const claimFailure = await dispatch("claim-failure")
    const completionFailure = await dispatch("completion-failure")
    const skippedRetry = await dispatch("completion-failure")
    const unavailable = await dispatch("unavailable")
    const redirected = await dispatch("redirected")
    const clientRejection = await dispatch("client-rejection")
    const success = await dispatch("success")
    await flushSixbErrors(sixb)

    expect(claimFailure.status).toBe(500)
    expect(completionFailure.status).toBe(500)
    expect(skippedRetry.status).toBe(202)
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({ error: "Retry later" })
    expect(redirected.status).toBe(302)
    expect(clientRejection.status).toBe(422)
    expect(success.status).toBe(202)

    expect(reports).toHaveLength(4)
    expect(reports.map((report) => report.error)).toEqual([
      claimError,
      completionError,
      expect.any(Error),
      expect.any(Error),
    ])
    expect(reports[2]?.error.message).toBe("Webhook handler returned HTTP 503")
    expect(reports[3]?.error.message).toBe("Webhook handler returned HTTP 302")
    const runContexts = reports.map((report) => {
      if (report.context.type !== "run.failed") {
        throw new Error(`Unexpected error context '${report.context.type}'.`)
      }
      return report.context
    })
    expect(runContexts.map((context) => context.run)).toEqual([
      {
        kind: "webhook",
        runId: expect.stringMatching(/^webhookrun_/),
        connectorId: "github",
        webhookId: "claim-failure",
      },
      {
        kind: "webhook",
        runId: expect.stringMatching(/^webhookrun_/),
        connectorId: "github",
        webhookId: "completion-failure",
      },
      {
        kind: "webhook",
        runId: expect.stringMatching(/^webhookrun_/),
        connectorId: "github",
        webhookId: "unavailable",
      },
      {
        kind: "webhook",
        runId: expect.stringMatching(/^webhookrun_/),
        connectorId: "github",
        webhookId: "redirected",
      },
    ])
    expect(reports.every((report) => report.context.projectId === "test-project")).toBe(true)
    expect(new Set(runContexts.map((context) => context.run.runId)).size).toBe(4)
  })

  test("retries idempotent deliveries after a returned server failure", async () => {
    let invocations = 0
    const connector = defineConnector("github", {
      type: "test",
      webhooks: [
        defineWebhook("retryable")
          .post()
          .json()
          .idempotencyKey(() => "delivery-1")
          .handle(() => {
            invocations += 1
            return { status: 503, body: { error: "Retry later" } }
          }),
      ],
      connect() {
        return {}
      },
    })
    const app = createWebhookApp([connector])
    const dispatch = () =>
      app.fetch(
        new Request("http://localhost/api/webhooks/github/retryable", {
          method: "POST",
          body: JSON.stringify({ ok: true }),
        })
      )

    const first = await dispatch()
    const retry = await dispatch()

    expect(first.status).toBe(503)
    expect(retry.status).toBe(503)
    expect(invocations).toBe(2)
  })
})

function createWebhookApp(
  connectors: SixbOptions<readonly OntologySource[]>["connectors"],
  storage = new InMemoryStorage(),
  logger?: LoggerProvider
) {
  return createWebhookRuntime(connectors, storage, logger).app
}

function createWebhookRuntime(
  connectors: SixbOptions<readonly OntologySource[]>["connectors"],
  storage = new InMemoryStorage(),
  logger?: LoggerProvider,
  onError?: SixbErrorHandler
) {
  const sixb = createSixbInstance<readonly OntologySource[]>({
    id: "test-project",
    ontology: [],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    connectors,
    logger,
    onError,
  })
  const server = new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
  return { app: createSixbApi(server), sixb }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
