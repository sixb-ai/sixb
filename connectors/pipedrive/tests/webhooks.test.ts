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
    expect(
      pipedrive({
        apiToken: "t",
        webhookAuth: { username: "sixb", password: "secret" },
        onEvent: () => {},
      }).webhooks
    ).toHaveLength(1)
  })

  test("verifies basic auth, dispatches the event, and responds 200", async () => {
    const received: PipedriveEventContext[] = []
    const webhook = pipedriveEventsWebhook({
      credential: { username: "sixb", password: "secret" },
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
      credential: { username: "sixb", password: "secret" },
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
    const webhook = pipedriveEventsWebhook({
      credential: { username: "sixb", password: "secret" },
      onEvent: () => {},
    })
    expect(() => webhook.body.parse({ meta: { action: "change" } })).toThrow(
      "Unexpected webhook payload"
    )
  })
})

describe("pipedriveEventsWebhook without credentials", () => {
  test("cannot be written without credentials or an explicit opt-in", () => {
    // @ts-expect-error - neither `credential` nor `allowUnverified`
    const missing: Parameters<typeof pipedriveEventsWebhook>[0] = { onEvent: () => {} }

    // `verifyBasicAuth` returned early when no credentials were configured, so this route
    // accepted any request that reached it.
    expect(() => pipedriveEventsWebhook(missing)).toThrow(/basic-auth/)
  })

  test("refuses credentials an unset environment variable would produce", () => {
    // `{ username: process.env.X!, password: process.env.Y! }` is a truthy object whatever the
    // variables hold, so the union cannot see this one. Both entry points have to catch it.
    const empty = { username: "", password: "" }
    const unset = { username: undefined, password: undefined } as unknown as {
      username: string
      password: string
    }

    expect(() => pipedriveEventsWebhook({ credential: empty, onEvent: () => {} })).toThrow(
      /non-empty username and password/
    )
    expect(() => pipedriveEventsWebhook({ credential: unset, onEvent: () => {} })).toThrow(
      /non-empty username and password/
    )
    expect(() => pipedrive({ apiToken: "t", webhookAuth: empty, onEvent: () => {} })).toThrow(
      /`webhookAuth` on `pipedrive\(\)`/
    )
  })

  test("accepts unverified deliveries when asked to, and says so", () => {
    const warnings = captureWarnings(() =>
      pipedriveEventsWebhook({ allowUnverified: true, onEvent: () => {} })
    )

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("accepts unverified requests")
  })
})

/** Captures `console.warn` for the duration of one call. */
function captureWarnings(run: () => void): string[] {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    run()
  } finally {
    console.warn = original
  }
  return warnings
}
