import { afterEach, expect, test } from "bun:test"
import { collect, createTestClient, empty, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function customer(id: string, name: string) {
  return { id, name, email: `${id}@example.com` }
}

test("list reads the Accounts Receivable customers collection", async () => {
  const calls = recorder([json({ customers: [customer("cus-1", "Globex")], page: {} })])
  const mc = await createTestClient()

  const page = await mc.customers.list()

  expect(page.customers[0]?.name).toBe("Globex")
  expect(calls[0]?.url).toStartWith("https://api.mercury.com/api/v1/ar/customers")
})

test("listAll pages through customers", async () => {
  recorder([
    json({ customers: [customer("cus-1", "Globex")], page: { nextPage: "cus-1" } }),
    json({ customers: [customer("cus-2", "Initech")], page: {} }),
  ])
  const mc = await createTestClient()

  const customers = await collect(mc.customers.listAll())

  expect(customers.map((entry) => entry.name)).toEqual(["Globex", "Initech"])
})

test("create posts name, email, and address", async () => {
  const calls = recorder([json(customer("cus-1", "Globex"))])
  const mc = await createTestClient()

  await mc.customers.create({
    name: "Globex",
    email: "ap@globex.example",
    address: {
      address1: "500 Terry A Francois Blvd",
      city: "San Francisco",
      region: "CA",
      postalCode: "94158",
      country: "US",
    },
  })

  expect(calls[0]?.method).toBe("POST")
  expect(calls[0]?.url).toBe("https://api.mercury.com/api/v1/ar/customers")
  expect(JSON.parse(calls[0]?.body ?? "{}").address.region).toBe("CA")
})

test("update uses POST on the customer path", async () => {
  const calls = recorder([json(customer("cus-1", "Globex Ltd"))])
  const mc = await createTestClient()

  await mc.customers.update("cus-1", { name: "Globex Ltd" })

  expect(calls[0]?.method).toBe("POST")
  expect(calls[0]?.url).toBe("https://api.mercury.com/api/v1/ar/customers/cus-1")
})

test("get exposes deletedAt for a soft-deleted customer", async () => {
  recorder([json({ ...customer("cus-1", "Globex"), deletedAt: "2026-07-20T00:00:00Z" })])
  const mc = await createTestClient()

  const found = await mc.customers.get("cus-1")

  expect(found.deletedAt).toBe("2026-07-20T00:00:00Z")
})

test("delete issues a DELETE and tolerates a 200 with a body", async () => {
  const calls = recorder([json({ ok: true }, { status: 200 })])
  const mc = await createTestClient()

  await mc.customers.delete("cus-1")

  expect(calls[0]?.method).toBe("DELETE")
})

test("delete also tolerates a bodiless 204", async () => {
  recorder([empty()])
  const mc = await createTestClient()

  await expect(mc.customers.delete("cus-1")).resolves.toBeUndefined()
})
