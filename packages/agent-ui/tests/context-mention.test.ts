import { describe, expect, test } from "bun:test"
import { findAgentContextMention, removeAgentContextMention } from "../src/utils/contextMention"

describe("agent context mentions", () => {
  test("finds only the token immediately before the caret", () => {
    expect(findAgentContextMention("Check @inv-12", 13)).toEqual({
      start: 6,
      end: 13,
      query: "inv-12",
    })
    expect(findAgentContextMention("email@example.com", 17)).toBeNull()
    expect(findAgentContextMention("@invoice later", 14)).toBeNull()
  })

  test("removes UI syntax without adding it to the sent text", () => {
    expect(
      removeAgentContextMention("Check @inv-12", { start: 6, end: 13, query: "inv-12" })
    ).toEqual({ value: "Check ", caret: 6 })
  })
})
