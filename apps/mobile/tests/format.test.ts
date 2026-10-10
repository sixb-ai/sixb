import { describe, expect, test } from "bun:test"
import { errorMessage, formatBytes, greeting, initials } from "../src/lib/format"

describe("format", () => {
  test("greets by the time of day", () => {
    expect(greeting(new Date(2026, 9, 10, 0, 0))).toBe("Good morning")
    expect(greeting(new Date(2026, 9, 10, 11, 59))).toBe("Good morning")
    expect(greeting(new Date(2026, 9, 10, 12, 0))).toBe("Good afternoon")
    expect(greeting(new Date(2026, 9, 10, 17, 59))).toBe("Good afternoon")
    expect(greeting(new Date(2026, 9, 10, 18, 0))).toBe("Good evening")
  })

  test("takes initials from a name, an email or an id", () => {
    expect(initials("Ava Chen")).toBe("AC")
    expect(initials("ava maria chen")).toBe("AM")
    expect(initials("ava.chen@acme.com")).toBe("AC")
    expect(initials("ava")).toBe("A")
    expect(initials("")).toBe("?")
  })

  test("drops the framework's prefix from an error for the person to read", () => {
    expect(errorMessage(new Error("[SixbClient] Device login was aborted."))).toBe(
      "Device login was aborted."
    )
    expect(errorMessage(new Error("[SixbServer] Too many sign-in codes."))).toBe(
      "Too many sign-in codes."
    )
    expect(errorMessage("offline")).toBe("offline")
  })

  test("writes a file size in the unit that fits", () => {
    expect(formatBytes(820)).toBe("820 B")
    expect(formatBytes(1024)).toBe("1 KB")
    expect(formatBytes(840_000)).toBe("820 KB")
    expect(formatBytes(3_565_158)).toBe("3.4 MB")
  })
})
