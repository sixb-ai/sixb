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
  type SixbErrorContext,
  type SixbErrorHandler,
  SixbHost,
  type SixbHostOptions,
} from "@sixb/core"
import { flushSixbErrors } from "@sixb/core/internal/error-reporting"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

function createSixbInstance<TOntologySources extends readonly OntologySource[]>(
  options: SixbHostOptions<TOntologySources>
): SixbHost<TOntologySources> {
  return new SixbHost<TOntologySources>(options)
}

describe("webhook routes", () => {
  test("dispatches validated bodies with raw bytes, metadata, and lazy clients", async () => {
    let rawBodyText = ""
    let requestHeader = ""
    let connected = false
    let handlerExecutionId = ""
    let verificationHadSdk = false
    let idempotencyHadSdk = false
    let verificationHadLogger = false
    let idempotencyHadLogger = false
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
          .verify((context) => {
            const { request, rawBody } = context
            verificationHadSdk = "sixb" in context
            verificationHadLogger = "logger" in context
            requestHeader = request.headers.get("x-provider") ?? ""
            rawBodyText = new TextDecoder().decode(rawBody)
          })
          .idempotencyKey((context) => {
            idempotencyHadSdk = "sixb" in context
            idempotencyHadLogger = "logger" in context
            return null
          })
          .handle(async ({ body, client, sixb, request, webhook, logger }) => {
            logger.info("handled")
            handlerExecutionId = sixb.execution.id
            const resolved = (await client()) as { source: string }
            connected = resolved.source === "github"

            return {
              status: 201,
              headers: { "x-webhook": webhook.route },
              body: {
                name: body.name,
                projectId: sixb.execution.projectId,
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
    expect(verificationHadSdk).toBe(false)
    expect(idempotencyHadSdk).toBe(false)
    expect(verificationHadLogger).toBe(false)
    expect(idempotencyHadLogger).toBe(false)

    const runs = await storage.webhookRuns.list({
      projectId: "test-project",
      connectorId: "github",
      webhookId: "events",
    })
    const [run] = runs.runs
    if (!run) throw new Error("Expected one admitted Webhook run.")

    expect(runs.total).toBe(1)
    expect(run).toMatchObject({
      connectorId: "github",
      webhookId: "events",
      method: "POST",
      route: "/api/webhooks/github/events",
      status: "succeeded",
      responseStatus: 201,
    })
    expect(run.executionId).toBe(handlerExecutionId)
    await expect(
      storage.executions.getById({ projectId: "test-project", id: run.executionId })
    ).resolves.toMatchObject({
      executor: { type: "primitive", kind: "webhook", runId: run.id },
      source: { type: "webhook", deliveryId: run.id },
      authorizationRef: {
        type: "trustedPrimitive",
        primitive: { kind: "webhook", id: run.route, runId: run.id },
      },
    })
    expect(run.requestBodyBytes).toBe(new TextEncoder().encode(payload).byteLength)
    expect(logEntries.map((entry) => [entry.message, entry.context.phase])).toEqual([
      ["handled", "handle"],
    ])
    expect(new Set(logEntries.map((entry) => entry.context.run.id))).toEqual(new Set([run.id]))
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
    expect(await response.json()).toEqual({ error: "value must be a number" })
    expect(calls).toBe(0)

    const runs = await storage.webhookRuns.list({ projectId: "test-project" })
    expect(runs.total).toBe(0)
  })

  test("acknowledges duplicate idempotent deliveries without rerunning handlers", async () => {
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
    const [succeeded] = runs.runs

    expect(runs.total).toBe(1)
    expect(succeeded).toMatchObject({
      responseStatus: 202,
      idempotencyKey: "delivery-1",
    })

    const listResponse = await app.fetch(
      new Request(
        "http://localhost/api/webhook-runs?connectorId=github&webhookId=events&status=succeeded&idempotencyKey=delivery-1"
      )
    )
    const listBody = (await listResponse.json()) as {
      runs: Array<{
        status: string
        connectorId: string
        webhookId: string
        idempotencyKey?: string
        executionId: string
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
          status: "succeeded",
          idempotencyKey: "delivery-1",
        },
      ],
    })
  })

  test("requires durable run storage when Webhooks are registered", () => {
    const connector = defineConnector("github", {
      type: "test",
      webhooks: [
        defineWebhook("events")
          .post()
          .json()
          .handle(() => undefined),
      ],
      connect() {
        return {}
      },
    })
    const storage = new InMemoryStorage()
    Object.defineProperty(storage, "webhookRuns", { value: undefined })
    expect(() => createWebhookApp([connector], storage)).toThrow(
      "[Sixb] Webhooks require storage.webhookRuns to be configured."
    )
  })

  test("rejects a reused delivery key with a different payload", async () => {
    let calls = 0
    const connector = defineConnector("github", {
      type: "test",
      webhooks: [
        defineWebhook("events")
          .post()
          .json()
          .idempotencyKey(() => "delivery-1")
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
    const dispatch = (value: number) =>
      app.fetch(
        new Request("http://localhost/api/webhooks/github/events", {
          method: "POST",
          body: JSON.stringify({ value }),
        })
      )

    expect((await dispatch(1)).status).toBe(202)
    const conflict = await dispatch(2)
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: "Webhook delivery conflict" })
    expect(calls).toBe(1)
    await expect(storage.webhookRuns.list({ projectId: "test-project" })).resolves.toMatchObject({
      total: 1,
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

    expect(runs.total).toBe(1)
    expect(runs.runs[0]).toMatchObject({
      webhookId: "failing",
      method: "POST",
      status: "failed",
      responseStatus: 500,
      error: {
        code: "webhook.delivery_failed",
        message: "Webhook delivery failed.",
        retryable: true,
      },
    })

    const failedRun = runs.runs.find((run) => run.webhookId === "failing")
    expect(failedRun?.error).toMatchObject({
      details: {
        connectorId: "github",
        webhookId: "failing",
        runId: failedRun?.id,
        responseStatus: 500,
      },
    })
    expect(failedRun?.error?.at).toBe(failedRun?.finishedAt?.toISOString())
    expect(reports).toHaveLength(1)
    expect(reports[0]?.error).toMatchObject({
      code: "webhook.delivery_failed",
      message: "Webhook handler failed",
      retryable: true,
      cause: handlerError,
      details: {
        connectorId: "github",
        webhookId: "failing",
        runId: failedRun?.id,
        responseStatus: 500,
      },
    })
    expect(reports[0]?.context).toMatchObject({
      type: "run.failed",
      notificationId: `project:test-project:run:webhook:${failedRun?.id}:failed:${reports[0]?.context.occurredAt}`,
      projectId: "test-project",
      runKind: "webhook",
      run: {
        runId: failedRun?.id,
        connectorId: "github",
        webhookId: "failing",
      },
      failure: failedRun?.error,
    })
  })

  test("reports returned non-4xx failures exactly once", async () => {
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    const connector = defineConnector("github", {
      type: "test",
      webhooks: [
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

    const unavailable = await dispatch("unavailable")
    const redirected = await dispatch("redirected")
    const clientRejection = await dispatch("client-rejection")
    const success = await dispatch("success")
    await flushSixbErrors(sixb)

    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({ error: "Retry later" })
    expect(redirected.status).toBe(302)
    expect(clientRejection.status).toBe(422)
    expect(success.status).toBe(202)

    expect(reports).toHaveLength(2)
    expect(reports[0]?.error.message).toBe("Webhook handler returned HTTP 503")
    expect(reports[1]?.error.message).toBe("Webhook handler returned HTTP 302")
    expect(reports[0]?.error).toMatchObject({
      code: "webhook.delivery_failed",
      retryable: true,
      details: {
        connectorId: "github",
        webhookId: "unavailable",
        responseStatus: 503,
      },
    })
    expect(reports[1]?.error).toMatchObject({
      code: "webhook.delivery_failed",
      retryable: true,
      details: {
        connectorId: "github",
        webhookId: "redirected",
        responseStatus: 302,
      },
    })
    const runContexts = reports.map((report) => {
      if (report.context.type !== "run.failed") {
        throw new Error(`Unexpected error context '${report.context.type}'.`)
      }
      return report.context
    })
    expect(runContexts.every((context) => context.runKind === "webhook")).toBe(true)
    expect(runContexts.map((context) => context.run)).toEqual([
      {
        runId: expect.stringMatching(/^webhookrun_/),
        connectorId: "github",
        webhookId: "unavailable",
      },
      {
        runId: expect.stringMatching(/^webhookrun_/),
        connectorId: "github",
        webhookId: "redirected",
      },
    ])
    expect(runContexts.map((context) => context.failure.code)).toEqual([
      "webhook.delivery_failed",
      "webhook.delivery_failed",
    ])
    expect(reports.every((report) => report.context.projectId === "test-project")).toBe(true)
    expect(new Set(runContexts.map((context) => context.run.runId)).size).toBe(2)
  })

  test("retries idempotent deliveries after a returned server failure", async () => {
    let invocations = 0
    const executionIds: string[] = []
    const connector = defineConnector("github", {
      type: "test",
      webhooks: [
        defineWebhook("retryable")
          .post()
          .json()
          .idempotencyKey(() => "delivery-1")
          .handle(({ sixb }) => {
            invocations += 1
            executionIds.push(sixb.execution.id)
            return { status: 503, body: { error: "Retry later" } }
          }),
      ],
      connect() {
        return {}
      },
    })
    const storage = new InMemoryStorage()
    const runFailures: unknown[] = []
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    const finishRun = storage.webhookRuns.finish.bind(storage.webhookRuns)
    storage.webhookRuns.finish = async (input) => {
      if (input.status === "failed") {
        runFailures.push(input.error)
      }
      return finishRun(input)
    }
    const { app, sixb } = createWebhookRuntime(
      [connector],
      storage,
      undefined,
      (error, context) => {
        reports.push({ error, context })
      }
    )
    const dispatch = () =>
      app.fetch(
        new Request("http://localhost/api/webhooks/github/retryable", {
          method: "POST",
          body: JSON.stringify({ ok: true }),
        })
      )

    const first = await dispatch()
    const retry = await dispatch()
    await flushSixbErrors(sixb)

    expect(first.status).toBe(503)
    expect(retry.status).toBe(503)
    expect(invocations).toBe(2)
    expect(runFailures).toHaveLength(2)
    expect(reports).toHaveLength(2)
    expect(reports[0]?.context).toMatchObject({ failure: runFailures[0] })
    expect(reports[1]?.context).toMatchObject({ failure: runFailures[1] })
    expect(runFailures).toEqual([
      expect.objectContaining({
        code: "webhook.delivery_failed",
        message: "Webhook delivery failed.",
        retryable: true,
        details: {
          connectorId: "github",
          webhookId: "retryable",
          idempotencyKey: "delivery-1",
          runId: expect.stringMatching(/^webhookrun_/),
          responseStatus: 503,
        },
      }),
      expect.objectContaining({
        code: "webhook.delivery_failed",
        message: "Webhook delivery failed.",
        retryable: true,
        details: {
          connectorId: "github",
          webhookId: "retryable",
          idempotencyKey: "delivery-1",
          runId: expect.stringMatching(/^webhookrun_/),
          responseStatus: 503,
        },
      }),
    ])
    expect(new Set(executionIds).size).toBe(1)
    const runs = await storage.webhookRuns.list({ projectId: "test-project" })
    expect(runs.total).toBe(1)
    expect(runs.runs[0]).toMatchObject({
      executionId: executionIds[0],
      status: "failed",
      responseStatus: 503,
      error: runFailures[1],
    })
  })
})

function createWebhookApp(
  connectors: SixbHostOptions<readonly OntologySource[]>["connectors"],
  storage = new InMemoryStorage(),
  logger?: LoggerProvider
) {
  return createWebhookRuntime(connectors, storage, logger).app
}

function createWebhookRuntime(
  connectors: SixbHostOptions<readonly OntologySource[]>["connectors"],
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
  const server = new SixbServer({ host: sixb, quiet: true, browser: createTestBrowserPolicy() })
  return { app: createSixbApi(server), sixb }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
