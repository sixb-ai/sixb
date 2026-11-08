import { describe, expect, test } from "bun:test"
import { RESTORE_WITHIN_MS, screenToReopen } from "../src/shell/app-return"
import { startupImageMedia } from "../src/shell/phone/startup-image"

describe("an installed app coming back", () => {
  const now = 1_800_000_000_000

  test("relaunched at its start page soon after, it reopens the screen it was left on", () => {
    const left = { path: "/service-cases/sc-1042?tab=history", at: now - 5 * 60_000 }
    expect(screenToReopen(left, { path: "/", now })).toBe("/service-cases/sc-1042?tab=history")
  })

  test("it opens where iOS did when that is not the start page, or when left long ago", () => {
    const left = { path: "/quotes/q-1", at: now - 60_000 }
    expect(screenToReopen(left, { path: "/equipment", now })).toBeNull()
    expect(screenToReopen(left, { path: "/?from=push", now })).toBeNull()
    expect(
      screenToReopen({ ...left, at: now - RESTORE_WITHIN_MS - 1 }, { path: "/", now })
    ).toBeNull()
    expect(screenToReopen(null, { path: "/", now })).toBeNull()
  })

  test("it never reopens Home, another origin, or a time ahead of the clock", () => {
    expect(screenToReopen({ path: "/", at: now }, { path: "/", now })).toBeNull()
    expect(screenToReopen({ path: "//evil.example", at: now }, { path: "/", now })).toBeNull()
    expect(screenToReopen({ path: "https://x.y/", at: now }, { path: "/", now })).toBeNull()
    expect(screenToReopen({ path: "/quotes", at: now + 1000 }, { path: "/", now })).toBeNull()
  })
})

describe("the iOS launch image", () => {
  test("matches the screen in hand in each orientation, as iOS reads it", () => {
    const iPhone = { width: 402, height: 874, scale: 3 }
    expect(startupImageMedia(iPhone, "portrait")).toBe(
      "screen and (device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"
    )
    // A screen measured in landscape still names its short side as the width.
    expect(startupImageMedia({ width: 874, height: 402, scale: 3 }, "landscape")).toBe(
      "screen and (device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)"
    )
  })
})
