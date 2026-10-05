import { expect, test } from "bun:test"
import { PgAggregateAdmission } from "../src/objects/aggregate-admission"

// Guard removal: bypass the admission check; computations overlap and peak exceeds the limit.
// Remove the finally release; the queued work hangs instead of progressing after a failure.
test("aggregate admission bounds concurrent work and releases its slot after failure", async () => {
  const admission = new PgAggregateAdmission(1)
  let active = 0
  let peak = 0
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) =>
      admission.run(async () => {
        active++
        peak = Math.max(peak, active)
        try {
          await Promise.resolve()
          if (i === 2) throw new Error("expected aggregate failure")
          return i
        } finally {
          active--
        }
      })
    )
  )
  expect(peak).toBe(1)
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "fulfilled",
    "rejected",
    "fulfilled",
    "fulfilled",
    "fulfilled",
  ])
  expect(await admission.run(async () => 42)).toBe(42)
})
