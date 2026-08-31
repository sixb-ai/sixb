import { describe, expect, test } from "bun:test"
import { utcAccountingRangeForCalendarDays } from "../src/lib/aiUsageDateRange"

describe("AI usage calendar ranges", () => {
  test("maps browser calendar days to whole UTC accounting buckets", () => {
    expect(utcAccountingRangeForCalendarDays(new Date(2026, 8, 10), new Date(2026, 8, 10))).toEqual(
      {
        from: "2026-09-10T00:00:00.000Z",
        to: "2026-09-11T00:00:00.000Z",
      }
    )

    expect(utcAccountingRangeForCalendarDays(new Date(2026, 8, 10), new Date(2026, 8, 12))).toEqual(
      {
        from: "2026-09-10T00:00:00.000Z",
        to: "2026-09-13T00:00:00.000Z",
      }
    )
  })
})
