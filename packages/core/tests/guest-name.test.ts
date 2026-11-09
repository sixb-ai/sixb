import { describe, expect, test } from "bun:test"
import { GUEST_NAME_MAX_LENGTH, guestName } from "../src/shares/guest-name"

describe("a shared link's guest name", () => {
  test("is kept on one line, its spaces collapsed", () => {
    expect(guestName("  Ava   Martin ")).toBe("Ava Martin")
    expect(guestName("Zoë\u00a0 Lefèvre")).toBe("Zoë Lefèvre")
    expect(guestName("👩🏽‍💻 Ana")).toBe("👩🏽‍💻 Ana")
  })

  // Guard proof: drop UNSAFE_CHARACTERS; a name that turns text around then reads as a member's.
  test("refuses what could read as someone else, or as nothing", () => {
    for (const value of [
      "",
      "   ",
      "Ava\nMartin",
      "Ava\tMartin",
      "Ava\u0000",
      "‮nitraM avA",
      "A B",
    ]) {
      expect(guestName(value)).toBeNull()
    }
    expect(guestName(42)).toBeNull()
  })

  test("holds at most its length, counted in characters", () => {
    expect(guestName("é".repeat(GUEST_NAME_MAX_LENGTH))).toHaveLength(GUEST_NAME_MAX_LENGTH)
    expect(guestName("é".repeat(GUEST_NAME_MAX_LENGTH + 1))).toBeNull()
  })
})
