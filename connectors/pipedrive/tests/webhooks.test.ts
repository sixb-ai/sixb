import { describe, expect, test } from "bun:test"
import { noopLogger } from "@sixb/core"
import type { PipedriveEventContext } from "../src"
import { pipedrive, pipedriveEventsWebhook } from "../src"

type VerifyCtx = Parameters<NonNullable<ReturnType<typeof pipedriveEventsWebhook>["verify"]>>[0]
type HandleCtx = Parameters<ReturnType<typeof pipedriveEventsWebhook>["handle"]>[0]

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

describe("pipedrive events webhook", () => {
  test("registers only when onEvent is set", () => {
    expect(pipedrive({ apiToken: "t" }).webhooks).toBeUndefined()
    expect(pipedrive({ apiToken: "t", onEvent: () => {} }).webhooks).toHaveLength(1)
  })

  test("verifies basic auth, dispatches the event, and responds 200", async () => {
    const received: PipedriveEventContext[] = []
    const webhook = pipedriveEventsWebhook({
      auth: { username: "sixb", password: "secret" },
      onEvent: (context) => {
        received.push(context)
      },
    })
    const body = {
      meta: {
        action: "change",
        entity: "deal",
        id: "delivery-1",
        correlation_id: "correlation-1",
        version: "2.0",
      },
      data: { id: 42, title: "Roof job" },
      previous: { title: "Old title" },
    }
    const sixb = { id: "demo" }
    const client = () => Promise.resolve({} as never)

    webhook.verify?.({
      request: new Request("https://x/hook", {
        method: "POST",
        headers: { authorization: basic("sixb", "secret") },
      }),
      rawBody: new TextEncoder().encode(JSON.stringify(body)),
    } as unknown as VerifyCtx)

    const result = await webhook.handle({
      request: new Request("https://x/hook", { method: "POST" }),
      body: webhook.body.parse(body),
      sixb,
      logger: noopLogger,
      client,
    } as unknown as HandleCtx)

    expect(result).toEqual({ status: 200 })
    expect(received).toHaveLength(1)
    expect(received[0]?.event.meta.action).toBe("change")
    expect(received[0]?.event.meta.entity).toBe("deal")
    expect(received[0]?.event.data).toEqual({ id: 42, title: "Roof job" })
    expect(received[0]?.sixb).toBe(sixb as never)
    expect(received[0]?.logger).toBe(noopLogger)
    expect(received[0]?.client).toBe(client)
  })

  test("rejects invalid basic auth when configured", () => {
    const webhook = pipedriveEventsWebhook({
      auth: { username: "sixb", password: "secret" },
      onEvent: () => {},
    })

    expect(() =>
      webhook.verify?.({
        request: new Request("https://x/hook", {
          method: "POST",
          headers: { authorization: basic("sixb", "wrong") },
        }),
        rawBody: new TextEncoder().encode("{}"),
      } as unknown as VerifyCtx)
    ).toThrow("Invalid webhook basic auth")
  })

  test("rejects an unexpected payload shape", () => {
    const webhook = pipedriveEventsWebhook({ onEvent: () => {} })
    expect(() => webhook.body.parse({ meta: { action: "change" } })).toThrow(
      "Unexpected webhook payload"
    )
  })
})
