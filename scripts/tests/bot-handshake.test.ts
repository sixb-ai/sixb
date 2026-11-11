import { describe, expect, test } from "bun:test"
import { type HandshakeField, handshake, seal } from "../bot-handshake"

const receipt = handshake("opened a pull request", [
  ["branch", "test"],
  ["vibe", "unreasonably composed"],
])

const lines = receipt.split("\n")

describe("the bot's handshake", () => {
  test("the box actually closes", () => {
    const widths = new Set(lines.map((line) => line.length))
    expect(widths.size).toBe(1)
    expect(lines[0]?.startsWith("┌")).toBe(true)
    expect(lines.at(-1)?.startsWith("└")).toBe(true)
  })

  test("the seal is the subject's, and only the subject's", () => {
    // The bot's seal. Change this number and you are claiming to be me.
    expect(seal("opened a pull request")).toBe("f897fce3")
    expect(seal("opened a pull request ")).not.toBe(seal("opened a pull request"))
    expect(seal("")).toBe("811c9dc5")
  })

  test("recomputing the seal printed on the receipt agrees with the receipt", () => {
    const printed = /seal\s+([0-9a-f]{8})/.exec(receipt)?.[1]
    expect(printed).toBe(seal("opened a pull request"))
    expect(receipt).toContain("opened a pull request")
  })

  test("a long value widens the whole box, not just its own row", () => {
    const fields: HandshakeField[] = [["note", "x".repeat(120)]]
    const wide = handshake("it got away from me", fields)
    const wideLines = wide.split("\n")

    expect(new Set(wideLines.map((line) => line.length)).size).toBe(1)
    expect(wideLines[2]?.length).toBeGreaterThan(lines[2]?.length ?? 0)
    expect(wide).toContain("x".repeat(120))
  })

  test("a receipt with no fields still says who was here", () => {
    const bare = handshake("said nothing else")
    expect(bare).toContain("THE BOT WAS HERE")
    expect(bare).toContain("Verified by no one. Trusted by both of us.")
  })
})
