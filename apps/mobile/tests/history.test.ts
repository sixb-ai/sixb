import { describe, expect, test } from "bun:test"
import type { AgentThreadSummary } from "../src/lib/agent/types"
import { historySections, historyTime, lastActivity } from "../src/lib/history"

// Built from local date parts, so the calendar-day arithmetic holds in any timezone.
const NOW = new Date(2026, 9, 10, 9, 30)

function at(year: number, month: number, day: number, hour = 12, minute = 0): string {
  return new Date(year, month, day, hour, minute).toISOString()
}

function thread(id: string, lastMessageAt: string, title?: string): AgentThreadSummary {
  return {
    id,
    projectId: "project",
    ownerPrincipal: { type: "user", id: "user" },
    title,
    status: "active",
    activeRunId: null,
    lastMessageAt,
    messageCount: 2,
    createdAt: lastMessageAt,
    updatedAt: lastMessageAt,
  }
}

function shape(sections: ReturnType<typeof historySections>) {
  return sections.map((section) => [section.title, section.data.map((item) => item.id)])
}

describe("historySections", () => {
  test("groups chats by calendar day, not by hours elapsed", () => {
    const sections = historySections(
      [
        thread("early-today", at(2026, 9, 10, 0, 10)),
        // Under ten hours before `NOW`, and still yesterday.
        thread("late-yesterday", at(2026, 9, 9, 23, 50)),
        thread("six-days", at(2026, 9, 4)),
        thread("seven-days", at(2026, 9, 3)),
        thread("twenty-nine-days", at(2026, 8, 11)),
      ],
      "",
      NOW
    )

    expect(shape(sections)).toEqual([
      ["Today", ["early-today"]],
      ["Yesterday", ["late-yesterday"]],
      ["Previous 7 Days", ["six-days"]],
      ["Previous 30 Days", ["seven-days", "twenty-nine-days"]],
    ])
  })

  test("names older chats by month, with the year once it differs", () => {
    const august = at(2026, 7, 2)
    const lastYear = at(2025, 11, 24)
    const sections = historySections(
      [thread("august", august), thread("last-year", lastYear)],
      "",
      NOW
    )

    expect(shape(sections)).toEqual([
      [new Date(august).toLocaleDateString(undefined, { month: "long" }), ["august"]],
      [
        new Date(lastYear).toLocaleDateString(undefined, { month: "long", year: "numeric" }),
        ["last-year"],
      ],
    ])
    expect(sections[1]?.title).toContain("2025")
  })

  test("keeps a chat dated ahead of this device's clock under Today", () => {
    const sections = historySections([thread("ahead", at(2026, 9, 11, 1, 0))], "", NOW)
    expect(shape(sections)).toEqual([["Today", ["ahead"]]])
  })

  test("searches titles without regard to case or surrounding spaces", () => {
    const threads = [
      thread("a", at(2026, 9, 10), "Quarterly revenue"),
      thread("b", at(2026, 9, 10), "Hiring plan"),
      thread("c", at(2026, 9, 9), "REVENUE by region"),
    ]

    expect(shape(historySections(threads, "  revenue ", NOW))).toEqual([
      ["Today", ["a"]],
      ["Yesterday", ["c"]],
    ])
    expect(historySections(threads, "payroll", NOW)).toEqual([])
  })

  test("finds a chat saved without a title by the name the list shows for it", () => {
    const threads = [thread("blank", at(2026, 9, 10), "  "), thread("none", at(2026, 9, 10))]
    expect(shape(historySections(threads, "untitled", NOW))).toEqual([["Today", ["blank", "none"]]])
  })
})

describe("lastActivity", () => {
  test("falls back to the last change for a chat with no messages", () => {
    const empty = { ...thread("empty", at(2026, 9, 1)), lastMessageAt: undefined }
    expect(lastActivity(empty)).toBe(empty.updatedAt)
    expect(lastActivity(thread("busy", at(2026, 9, 8)))).toBe(at(2026, 9, 8))
  })
})

describe("historyTime", () => {
  test("shows the time today, then the day, then the date", () => {
    const today = at(2026, 9, 10, 6, 14)
    const tuesday = at(2026, 9, 6)
    const older = at(2026, 8, 3)

    expect(historyTime(today, NOW)).toBe(
      new Date(today).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    )
    expect(historyTime(at(2026, 9, 9, 23, 50), NOW)).toBe("Yesterday")
    expect(historyTime(tuesday, NOW)).toBe(
      new Date(tuesday).toLocaleDateString(undefined, { weekday: "long" })
    )
    expect(historyTime(older, NOW)).toBe(
      new Date(older).toLocaleDateString(undefined, {
        year: "2-digit",
        month: "numeric",
        day: "numeric",
      })
    )
  })
})
