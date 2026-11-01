import { expect, test } from "bun:test"
import { canonicalJson, canonicalJsonStringify } from "../src/json"

// Removal proof: return `current` unchanged from the replacer in canonicalJsonStringify; the key
// orders print as given and the first assertion fails.
test("prints every object's keys sorted, at any depth", () => {
  const live = { exitCode: 0, stdout: "hi", nested: { b: [{ y: 1, x: 2 }], a: null } }
  const fromJsonb = { stdout: "hi", nested: { a: null, b: [{ x: 2, y: 1 }] }, exitCode: 0 }

  expect(canonicalJsonStringify(live)).toBe(canonicalJsonStringify(fromJsonb))
  expect(canonicalJsonStringify(live)).toBe(
    '{"exitCode":0,"nested":{"a":null,"b":[{"x":2,"y":1}]},"stdout":"hi"}'
  )
})

test("keeps array order and everything else JSON.stringify does", () => {
  const value = {
    list: [3, 1, undefined, () => 1],
    dropped: undefined,
    fn: () => 1,
    at: new Date("2026-11-01T00:00:00.000Z"),
    boxed: new String("text"),
    custom: { toJSON: () => ({ z: 1, a: 2 }) },
    "10": "ten",
    "2": "two",
  }

  expect(JSON.parse(canonicalJsonStringify(value))).toEqual(JSON.parse(JSON.stringify(value)))
  expect(canonicalJsonStringify(value)).toBe(
    '{"2":"two","10":"ten","at":"2026-11-01T00:00:00.000Z","boxed":"text","custom":{"a":2,"z":1},"list":[3,1,null,null]}'
  )
  expect(canonicalJsonStringify(undefined)).toBeUndefined()
  expect(canonicalJsonStringify("plain")).toBe('"plain"')
  expect(canonicalJsonStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]')
})

// Removal proof: return `value` unchanged from canonicalJson; the printed order follows the input.
test("copies a JSON value with sorted keys, for bodies that hold it as an object", () => {
  const input = { path: "a.ts", offset: 2, limit: { to: 1, from: 0 } }
  const copy = canonicalJson(input)

  expect(JSON.stringify(copy)).toBe('{"limit":{"from":0,"to":1},"offset":2,"path":"a.ts"}')
  expect(copy).toEqual(input)
  expect(JSON.stringify(input)).toBe('{"path":"a.ts","offset":2,"limit":{"to":1,"from":0}}')
})
