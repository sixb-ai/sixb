import { expect, test } from "bun:test"
import { insertBounded } from "../src/storage/ontology/in-memory/shared-state"

// Regression proof: restore the linear findIndex implementation; comparisons exceed this bound.
test("bounded selection skips rows after the selected page and preserves stable ties", () => {
  const rows: { order: number; id: number }[] = []
  let comparisons = 0
  const compare = (left: { order: number }, right: { order: number }) => {
    comparisons++
    return left.order - right.order
  }
  for (let i = 0; i < 10_000; i++) insertBounded(rows, { order: i, id: i }, 100, compare)
  expect(comparisons).toBeLessThan(20_000)
  for (let i = 0; i < 100; i++) insertBounded(rows, { order: 0, id: 10_000 + i }, 100, compare)
  expect(rows.map((row) => row.id)).toEqual([
    0,
    ...Array.from({ length: 99 }, (_, i) => 10_000 + i),
  ])
})

test("bounded selection matches stable sorting for reversed and interleaved input", () => {
  for (const input of [
    Array.from({ length: 1000 }, (_, i) => 1000 - i),
    Array.from({ length: 1000 }, (_, i) => (i * 137) % 997),
  ]) {
    const selected: number[] = []
    for (const value of input) insertBounded(selected, value, 50, (a, b) => a - b)
    expect(selected).toEqual([...input].sort((a, b) => a - b).slice(0, 50))
  }
})
