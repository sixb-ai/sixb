import { describe, expect, test } from "bun:test"
import { livePersonName } from "../src/artifacts/live/presence"

const labels = { guest: "Guest", teamMember: "Team member" }

describe("a person on a live artifact", () => {
  // Guard proof: return `user.name` alone from livePersonName; an unnamed member's avatar and
  // selection then say nothing at all.
  test("is named by the server, else as a guest or a team member, never by anything else", () => {
    const color = "#0090ff"
    expect(livePersonName({ id: "user:ava", name: "Ava Martin", color }, labels)).toBe("Ava Martin")
    expect(livePersonName({ id: "user:bob", name: "", color }, labels)).toBe("Team member")
    expect(livePersonName({ id: "guest:shs_1", name: "", color, guest: true }, labels)).toBe(
      "Guest"
    )
  })
})
