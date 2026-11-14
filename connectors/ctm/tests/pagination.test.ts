import { describe, expect, test } from "bun:test"
import { toCallPage, toPage, walkPages } from "../src/pagination"
import type { CtmPage } from "../src/types"
import { collect } from "./helpers"

describe("toPage", () => {
  test("reads CTM's envelope", () => {
    const body = { page: 2, per_page: 10, total_entries: 25, total_pages: 3, users: [{ id: 1 }] }

    expect(toPage(body, "users", 2)).toEqual({
      records: [{ id: 1 }],
      page: 2,
      perPage: 10,
      totalEntries: 25,
      totalPages: 3,
      nextPage: 3,
    })
  })

  test("ends on the last page even when next_page still holds a URL", () => {
    // CTM's receiving numbers answer with a next_page URL on their only page.
    const body = {
      total_entries: 1,
      total_pages: 1,
      next_page: "https://api.calltrackingmetrics.com/api/v1/accounts/1/receiving_numbers",
      receiving_numbers: [{ id: "RPN1" }],
    }

    expect(toPage(body, "receiving_numbers", 1).nextPage).toBeNull()
  })

  test("takes the only array when the records come under another name", () => {
    // CTM's do-not-call list answers with `receiving_numbers`.
    const body = { total_pages: 1, receiving_numbers: [{ id: "x" }] }

    expect(toPage(body, "do_not_calls", 1).records).toEqual([{ id: "x" }])
  })

  test("reads a bare array, and counts from `total` when that is what CTM sends", () => {
    expect(toPage([{ id: 1 }], "agents", 1)).toMatchObject({ records: [{ id: 1 }], nextPage: null })
    expect(
      toPage({ total: 4, change_notifications: [] }, "change_notifications", 1).totalEntries
    ).toBe(4)
  })

  test("without total_pages, follows next_page only while pages have records", () => {
    expect(toPage({ next_page: "/x?page=2", items: [{ id: 1 }] }, "items", 1).nextPage).toBe(2)
    expect(toPage({ next_page: "/x?page=2", items: [] }, "items", 1).nextPage).toBeNull()
  })

  test("refuses a body it cannot read records from", () => {
    expect(() => toPage({ a: [], b: [] }, "users", 1)).toThrow("Expected a list of users")
    expect(() => toPage("oops", "users", 1)).toThrow("got string")
  })
})

describe("toCallPage", () => {
  test("keeps the cursor only while there are records", () => {
    expect(toCallPage({ calls: [{ id: 1 }], after: "abc" }).after).toBe("abc")
    expect(toCallPage({ calls: [], after: "abc" }).after).toBeNull()
    expect(toCallPage({ calls: [{ id: 1 }], after: "" }).after).toBeNull()
  })

  test("ignores the sort array next to the records", () => {
    const body = { sort: [{ unix_time: {} }], stats: { talk_time: { mean: 3 } }, calls: [] }

    expect(toCallPage(body)).toMatchObject({ records: [], stats: { talk_time: { mean: 3 } } })
  })
})

describe("walkPages", () => {
  test("refuses a page that does not advance", async () => {
    const stuck = async (): Promise<CtmPage<number>> => ({
      records: [1],
      page: 1,
      perPage: 1,
      totalEntries: null,
      totalPages: null,
      nextPage: 1,
    })

    const error = await collect(walkPages(stuck)).catch((caught: unknown) => caught)

    expect(String(error)).toContain("did not advance")
  })
})
