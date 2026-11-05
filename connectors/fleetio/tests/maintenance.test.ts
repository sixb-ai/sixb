import { afterEach, describe, expect, test } from "bun:test"
import { collect, createTestClient, empty, json, page, recorder, route } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("issues", () => {
  test("close, resolve and reopen use PUT and return the issue", async () => {
    const calls = recorder([
      json({ id: 1, state: "closed" }),
      json({ id: 1, state: "resolved" }),
      json({ id: 1, state: "open" }),
    ])
    const fl = await createTestClient()

    const closed = await fl.issues.close(1, { note: "Duplicate" })
    await fl.issues.resolve(1, { note: "Fixed" })
    const reopened = await fl.issues.reopen(1)

    expect(calls.map(route)).toEqual([
      "PUT /api/issues/1/close",
      "PUT /api/issues/1/resolve",
      "PUT /api/issues/1/reopen",
    ])
    expect(calls[0]?.body).toEqual({ note: "Duplicate" })
    expect(calls[2]?.body).toBeUndefined()
    expect(closed.state).toBe("closed")
    expect(reopened.state).toBe("open")
  })

  test("get joins the requested includes", async () => {
    const calls = recorder([json({ id: 1 }), json({ id: 1 })])
    const fl = await createTestClient()

    await fl.issues.get(1, { includes: ["comments", "labels"] })
    await fl.issues.get(1)

    expect(calls.map(route)).toEqual([
      "GET /api/issues/1?includes=comments,labels",
      "GET /api/issues/1",
    ])
  })
})

describe("service tasks", () => {
  test("get can expand the task's parts", async () => {
    const calls = recorder([json({ id: 1 })])
    const fl = await createTestClient()

    await fl.serviceTasks.get(1, { expand: { service_task_parts: "true" } })

    expect(route(calls[0]!)).toBe("GET /api/service_tasks/1?expand[service_task_parts]=true")
  })
})

describe("service entry line items", () => {
  test("address the line item under its service entry", async () => {
    const calls = recorder([page([{ id: 1 }], { next_cursor: "n" }), page([{ id: 2 }]), empty()])
    const fl = await createTestClient()

    const items = await collect(fl.serviceEntryLineItems.listAll(5))
    await fl.serviceEntryLineItems.delete(5, 2)

    expect(items).toHaveLength(2)
    expect(calls[1]?.url.pathname).toBe("/api/service_entries/5/service_entry_line_items")
    expect(route(calls[2]!)).toBe("DELETE /api/service_entries/5/service_entry_line_items/2")
  })
})

describe("watchers", () => {
  test("address a record by type and ID", async () => {
    const calls = recorder([
      page([{ id: 3, name: "Sam" }]),
      page([{ id: 3, name: "Sam" }]),
      empty(),
      empty(),
    ])
    const fl = await createTestClient()

    await fl.watchers.list("work_order", 9, { filter: { name: { like: "Sa" } } })
    await fl.watchers.search("work_order", 9, { pageSize: 10, sort: { id: "desc" } })
    await fl.watchers.watch("work_order", 9)
    await fl.watchers.unwatch("work_order", 9)

    expect(calls.map(route)).toEqual([
      "GET /api/watchers/work_order/9?filter[name][like]=Sa",
      "POST /api/watchers/work_order/9/search",
      "PUT /api/watchers/work_order/9/watch",
      "PUT /api/watchers/work_order/9/unwatch",
    ])
    expect(calls[1]?.body).toEqual({ per_page: 10, sort: { id: "desc" } })
  })
})

describe("labels", () => {
  test("list and create", async () => {
    const calls = recorder([page([{ id: 1, name: "Brakes" }]), json({ id: 2 }, { status: 201 })])
    const fl = await createTestClient()

    await fl.labels.list()
    const created = await fl.labels.create({ name: "Urgent" })

    expect(calls.map(route)).toEqual(["GET /api/labels", "POST /api/labels"])
    expect(created.id).toBe(2)
  })
})
