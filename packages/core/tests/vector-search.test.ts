import { expect, test } from "bun:test"
import { InMemoryStorage } from "../src"
import { normalizeVector } from "../src/objects/vectors/profile"
import { verifyVectorSearch } from "./fixtures/vector-search"

test("managed cosine vectors normalize extreme magnitudes without losing their direction", () => {
  // Regression proof: return raw float32 values from normalizeVector; these checks fail.
  for (const values of [
    [3, 4],
    [3e20, 4e20],
    [3e-30, 4e-30],
  ]) {
    const actual = normalizeVector(values, 2)
    expect(actual[0]).toBeCloseTo(0.6, 6)
    expect(actual[1]).toBeCloseTo(0.8, 6)
    expect(Math.hypot(...actual)).toBeCloseTo(1, 6)
  }
})

test("memory follows the same named-vector search contract as SQL", async () => {
  await verifyVectorSearch(new InMemoryStorage())
})
