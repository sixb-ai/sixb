import { afterEach, expect, test } from "bun:test"
import { collect, createTestClient, empty, json, query, recorder } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function category(id: string, name: string) {
  return {
    id,
    name,
    visibleForReimbursements: true,
    visibleForCardSpend: true,
    visibleForOther: false,
  }
}

test("list reads the categories collection", async () => {
  const calls = recorder([
    json({ categories: [category("cat-1", "Travel")], page: { nextPage: "cat-1" } }),
  ])
  const mc = await createTestClient()

  const page = await mc.categories.list({ limit: 50 })

  expect(page.categories[0]?.name).toBe("Travel")
  expect(page.page.nextPage).toBe("cat-1")
  expect(calls[0]?.url).toStartWith("https://api.mercury.com/api/v1/categories?")
  expect(query(calls[0]?.url ?? "").get("limit")).toBe("50")
})

test("listAll walks every page of categories", async () => {
  recorder([
    json({ categories: [category("cat-1", "Travel")], page: { nextPage: "cat-1" } }),
    json({ categories: [category("cat-2", "Software")], page: {} }),
  ])
  const mc = await createTestClient()

  const categories = await collect(mc.categories.listAll())

  expect(categories.map((entry) => entry.name)).toEqual(["Travel", "Software"])
})

test("create posts the full visibility triple", async () => {
  const calls = recorder([json(category("cat-1", "Travel"), { status: 201 })])
  const mc = await createTestClient()

  const created = await mc.categories.create({
    name: "Travel",
    visibleForReimbursements: true,
    visibleForCardSpend: true,
    visibleForOther: false,
  })

  expect(created.id).toBe("cat-1")
  expect(calls[0]?.method).toBe("POST")
  expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
    name: "Travel",
    visibleForReimbursements: true,
    visibleForCardSpend: true,
    visibleForOther: false,
  })
})

test("update uses POST on the category path, matching Mercury's API", async () => {
  const calls = recorder([json(category("cat-1", "Business Travel"))])
  const mc = await createTestClient()

  await mc.categories.update("cat-1", { name: "Business Travel" })

  expect(calls[0]?.method).toBe("POST")
  expect(calls[0]?.url).toBe("https://api.mercury.com/api/v1/categories/cat-1")
  expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ name: "Business Travel" })
})

test("delete resolves on a 204 with no body", async () => {
  const calls = recorder([empty()])
  const mc = await createTestClient()

  await expect(mc.categories.delete("cat-1")).resolves.toBeUndefined()
  expect(calls[0]?.method).toBe("DELETE")
})
