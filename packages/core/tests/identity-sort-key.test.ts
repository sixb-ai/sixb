import { expect, test } from "bun:test"
import { canonicalIdentitySortKey } from "../src/materialization/refs"

const utf8Hex = (parts: readonly string[]) =>
  Buffer.from(JSON.stringify(parts), "utf8").toString("hex")

// Red proof: skip a non-ASCII character instead of returning `utf8Hex(json)`; the last two fail.
test("an identity sort key is the UTF-8 bytes of its JSON tuple, in hexadecimal", () => {
  for (const parts of [
    ["Order", "ord_1"],
    ['quote"d', "back\\slash", "tab\there"],
    ["Café", "ключ"],
    ["Emoji", "😀"],
  ]) {
    expect(canonicalIdentitySortKey(parts)).toBe(utf8Hex(parts))
  }
})
