import { describe, expect, test } from "bun:test"
import { parseSubscriptionMessage } from "../src/routes/ws"

describe("parseSubscriptionMessage", () => {
  test("accepts a valid subscribe message", () => {
    const result = parseSubscriptionMessage({
      type: "subscribe",
      topic: "telemetry",
      types: ["telemetry.appended"],
      afterCursor: "10",
      limit: 50,
    })

    expect(result).toEqual({
      ok: true,
      data: {
        type: "subscribe",
        topic: "telemetry",
        types: ["telemetry.appended"],
        afterCursor: "10",
        limit: 50,
      },
    })
  })

  test("accepts workflow event subscriptions", () => {
    const result = parseSubscriptionMessage({
      type: "subscribe",
      topic: "workflows",
      types: ["workflow.run.finished"],
    })

    expect(result).toEqual({
      ok: true,
      data: {
        type: "subscribe",
        topic: "workflows",
        types: ["workflow.run.finished"],
      },
    })
  })

  test("rejects non-object payloads", () => {
    const result = parseSubscriptionMessage("subscribe")

    expect(result).toEqual({
      ok: false,
      error: "Message must be a JSON object.",
    })
  })

  test("rejects invalid topic values", () => {
    const result = parseSubscriptionMessage({
      type: "subscribe",
      topic: "invalid-topic",
    })

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error("Expected invalid subscription message")
    }

    expect(result.error).toContain("Invalid input")
  })

  test("accepts unsubscribe messages", () => {
    const result = parseSubscriptionMessage({ type: "unsubscribe" })

    expect(result).toEqual({
      ok: true,
      data: { type: "unsubscribe" },
    })
  })
})
