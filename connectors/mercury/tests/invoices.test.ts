import { afterEach, expect, test } from "bun:test"
import { collect, createTestClient, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function invoice(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    invoiceNumber: "INV-0001",
    status: "Unpaid",
    customerId: "cus-1",
    amount: 2850.0,
    currencyCode: "USD",
    lineItems: [{ name: "Implementation", unitPrice: 950.0, quantity: 3 }],
    dueDate: "2026-08-10",
    invoiceDate: "2026-07-10",
    destinationAccountId: "acct-1",
    ccEmails: [],
    creditCardEnabled: false,
    achDebitEnabled: true,
    useRealAccountNumber: false,
    slug: "acme-inv-0001",
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z",
    ...overrides,
  }
}

test("list reads the Accounts Receivable invoices collection", async () => {
  const calls = recorder([json({ invoices: [invoice("inv-1")], page: {} })])
  const mc = await createTestClient()

  const page = await mc.invoices.list()

  expect(page.invoices[0]?.amount).toBe(2850)
  expect(page.invoices[0]?.lineItems[0]?.unitPrice).toBe(950)
  expect(calls[0]?.url).toStartWith("https://api.mercury.com/api/v1/ar/invoices")
})

test("listAll pages through invoices", async () => {
  recorder([
    json({ invoices: [invoice("inv-1")], page: { nextPage: "inv-1" } }),
    json({ invoices: [invoice("inv-2")], page: {} }),
  ])
  const mc = await createTestClient()

  const invoices = await collect(mc.invoices.listAll())

  expect(invoices.map((entry) => entry.id)).toEqual(["inv-1", "inv-2"])
})

test("create posts line items and can suppress the payer email", async () => {
  const calls = recorder([json(invoice("inv-1"))])
  const mc = await createTestClient()

  await mc.invoices.create({
    customerId: "cus-1",
    destinationAccountId: "acct-1",
    dueDate: "2026-08-10",
    invoiceDate: "2026-07-10",
    lineItems: [{ name: "Implementation", unitPrice: 950.0, quantity: 3, salesTaxRate: 0.0875 }],
    ccEmails: ["ap@globex.example"],
    creditCardEnabled: false,
    achDebitEnabled: true,
    useRealAccountNumber: false,
    sendEmailOption: "DontSend",
  })

  const body = JSON.parse(calls[0]?.body ?? "{}")
  expect(calls[0]?.method).toBe("POST")
  expect(body.sendEmailOption).toBe("DontSend")
  expect(body.lineItems[0].salesTaxRate).toBe(0.0875)
})

test("update replaces the editable fields via POST", async () => {
  const calls = recorder([json(invoice("inv-1", { invoiceNumber: "INV-0002" }))])
  const mc = await createTestClient()

  await mc.invoices.update("inv-1", {
    invoiceNumber: "INV-0002",
    dueDate: "2026-08-20",
    invoiceDate: "2026-07-10",
    lineItems: [{ name: "Implementation", unitPrice: 950.0, quantity: 4 }],
    ccEmails: [],
    creditCardEnabled: false,
    achDebitEnabled: true,
    useRealAccountNumber: false,
  })

  expect(calls[0]?.method).toBe("POST")
  expect(calls[0]?.url).toBe("https://api.mercury.com/api/v1/ar/invoices/inv-1")
  expect(JSON.parse(calls[0]?.body ?? "{}").lineItems[0].quantity).toBe(4)
})

test("cancel posts to the cancel subpath and returns the cancelled invoice", async () => {
  const calls = recorder([
    json(invoice("inv-1", { status: "Cancelled", canceledAt: "2026-07-26T00:00:00Z" })),
  ])
  const mc = await createTestClient()

  const cancelled = await mc.invoices.cancel("inv-1")

  expect(cancelled.status).toBe("Cancelled")
  expect(calls[0]?.method).toBe("POST")
  expect(calls[0]?.url).toBe("https://api.mercury.com/api/v1/ar/invoices/inv-1/cancel")
})
