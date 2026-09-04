import { describe, expect, test } from "bun:test"
import {
  aiLimitAmountInput,
  aiLimitSubjectChoices,
  aiLimitSubjectLabel,
  aiLimitUsagePercent,
  formatAiLimitQuantity,
  formatAiLimitQuantityExact,
  parseAiLimitFormQuantity,
} from "../src/lib/aiLimits"

describe("AI limit presentation", () => {
  test("parses token limits without accepting fractional or unsafe values", () => {
    expect(parseAiLimitFormQuantity("tokens.total", "12,500")).toEqual({
      ok: true,
      quantity: { meter: "tokens.total", amount: 12_500 },
    })
    expect(parseAiLimitFormQuantity("tokens.total", "1.5").ok).toBe(false)
    expect(parseAiLimitFormQuantity("tokens.total", "9007199254740992").ok).toBe(false)
  })

  test("converts decimal cost input to exact nanounits", () => {
    const parsed = parseAiLimitFormQuantity("cost.catalogEstimated", "1,234.000000009", "usd")
    expect(parsed).toEqual({
      ok: true,
      quantity: {
        meter: "cost.catalogEstimated",
        amount: { currency: "USD", amountNanos: "1234000000009" },
      },
    })
    if (!parsed.ok) throw new Error("expected a parsed cost limit")
    expect(aiLimitAmountInput(parsed.quantity)).toBe("1234.000000009")
    expect(formatAiLimitQuantity(parsed.quantity)).toBe("USD 1,234.00")
    expect(formatAiLimitQuantityExact(parsed.quantity)).toBe("USD 1,234.000000009")
    expect(parseAiLimitFormQuantity("cost.catalogEstimated", "1", "EUR")).toEqual({
      ok: false,
      error: "Catalog-estimated limits use USD.",
    })
    expect(parseAiLimitFormQuantity("cost.catalogEstimated", "1.0000000001").ok).toBe(false)
    expect(parseAiLimitFormQuantity("cost.catalogEstimated", "9223372036.854775808").ok).toBe(false)
  })

  test("includes actual, reserved, and unknown capacity in the usage bar", () => {
    expect(
      aiLimitUsagePercent({
        limit: { meter: "tokens.total", amount: 1_000 },
        actual: { meter: "tokens.total", amount: 400 },
        reserved: { meter: "tokens.total", amount: 100 },
        unknown: { meter: "tokens.total", amount: 50 },
      })
    ).toBe(55)

    expect(
      aiLimitUsagePercent({
        limit: {
          meter: "cost.catalogEstimated",
          amount: { currency: "USD", amountNanos: "100000000000" },
        },
        actual: {
          meter: "cost.catalogEstimated",
          amount: { currency: "USD", amountNanos: "82096" },
        },
        reserved: {
          meter: "cost.catalogEstimated",
          amount: { currency: "USD", amountNanos: "0" },
        },
        unknown: {
          meter: "cost.catalogEstimated",
          amount: { currency: "USD", amountNanos: "0" },
        },
      })
    ).toBe(0.000082)
  })

  test("builds friendly selectable subjects without requiring typed ids", () => {
    const directory = {
      groups: [{ id: "customer-success", label: "Customer success" }],
      users: [
        {
          id: "usr_1",
          email: "ada@example.com",
          displayName: "Ada Lovelace",
          status: "active" as const,
        },
      ],
      serviceAccounts: [
        {
          id: "svc_1",
          name: "Billing automation",
          status: "suspended" as const,
        },
      ],
    }

    expect(aiLimitSubjectChoices(directory, "group")).toEqual([
      { value: "customer-success", label: "Customer success" },
    ])
    expect(aiLimitSubjectChoices(directory, "user")).toEqual([
      {
        value: "usr_1",
        label: "Ada Lovelace",
        description: "ada@example.com · Active",
      },
    ])
    expect(aiLimitSubjectChoices(directory, "serviceAccount")).toEqual([
      {
        value: "svc_1",
        label: "Billing automation",
        description: "Suspended",
      },
    ])
    expect(aiLimitSubjectLabel({ type: "user", id: "usr_1" }, directory)).toBe("Ada Lovelace")
  })
})
