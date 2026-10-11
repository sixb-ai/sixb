import { describe, expect, spyOn, test } from "bun:test"
import { LakeConcurrencyError } from "@sixb/core/lake-storage"
import {
  CatalogMovedError,
  rerunWhenCatalogMoves,
} from "../src/internal/ducklake-version-transaction"

const moved = () => new CatalogMovedError("[Test] The catalog moved.")

describe("rerunWhenCatalogMoves", () => {
  test("reruns until the transaction commits", async () => {
    const random = spyOn(Math, "random").mockReturnValue(0)
    try {
      let attempts = 0
      const result = await rerunWhenCatalogMoves("raw.events", async (attempt) => {
        attempts = attempt
        if (attempt < 4) throw moved()
        return "committed"
      })
      expect({ result, attempts }).toEqual({ result: "committed", attempts: 4 })
    } finally {
      random.mockRestore()
    }
  })

  test("fails with the attempt count once every rerun lost", async () => {
    const random = spyOn(Math, "random").mockReturnValue(0)
    try {
      let attempts = 0
      const failure = await rerunWhenCatalogMoves("raw.events", async (attempt) => {
        attempts = attempt
        throw moved()
      }).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(LakeConcurrencyError)
      expect(failure).not.toBeInstanceOf(CatalogMovedError)
      expect(String(failure)).toContain(`during ${attempts} attempts`)
      expect(String(failure)).toContain("dataset 'raw.events'")
      expect(attempts).toBe(16)
    } finally {
      random.mockRestore()
    }
  })

  test("does not rerun other failures", async () => {
    let attempts = 0
    const failure = await rerunWhenCatalogMoves("raw.events", async () => {
      attempts++
      throw new Error("[Test] Disk full.")
    }).catch((error: unknown) => error)
    expect({ message: String(failure), attempts }).toEqual({
      message: "Error: [Test] Disk full.",
      attempts: 1,
    })
  })

  // Regression proof: wait with a plain timer. The abort then only lands after the wait.
  test("an abort stops the wait before a rerun", async () => {
    const random = spyOn(Math, "random").mockReturnValue(0.999)
    const controller = new AbortController()
    try {
      let attempts = 0
      let abortedAt = 0
      const failure = await rerunWhenCatalogMoves(
        "raw.events",
        async (attempt) => {
          attempts = attempt
          // The fifth rerun waits 160 ms: abort right after it starts.
          if (attempt === 5) {
            setTimeout(() => {
              abortedAt = performance.now()
              controller.abort(new Error("[Test] Aborted."))
            }, 1)
          }
          throw moved()
        },
        controller.signal
      ).catch((error: unknown) => error)

      expect(String(failure)).toBe("Error: [Test] Aborted.")
      expect(attempts).toBe(5)
      expect(performance.now() - abortedAt).toBeLessThan(100)
    } finally {
      random.mockRestore()
    }
  })
})
