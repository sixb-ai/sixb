import { createEditBuilder, defineObjectType, type EditBatch, link, prop } from "../src"

const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

const Payment = defineObjectType({
  id: "Payment",
  name: "Payment",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string", { required: true }),
  ],
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("amount", "double", { required: true }),
    prop("status", "string", { required: true }),
    prop("paidAt", "timestamp"),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
  links: [
    link("customer", Customer, {
      cardinality: "one",
      properties: [prop("role", "string", { required: true }), prop("since", "timestamp")],
    }),
  ],
})

const edit = createEditBuilder({ runId: "act_1" })
const invoice = edit.create(Invoice, {
  amount: 120,
  status: "draft",
})
const existingInvoice = edit.object(Invoice, "inv_1")
const customer = edit.object(Customer, "cus_1")
const payment = edit.object(Payment, "pay_1")

edit.set(invoice, Invoice.p.status, "paid")
edit.set(invoice, Invoice.p.amount, 125)
edit.set(invoice, {
  amount: 125,
  status: "paid",
  paidAt: new Date("2026-06-01T10:00:00.000Z"),
})
edit.set(Invoice, "inv_1", {
  status: "paid",
  paidAt: new Date("2026-06-01T10:00:00.000Z"),
})
edit.set(existingInvoice, {
  status: "sent",
})
invoice.set({
  status: "paid",
})
edit.link(invoice, Invoice.l.customer, customer, {
  properties: {
    role: "billTo",
    since: new Date("2026-06-01T10:00:00.000Z"),
  },
})
invoice.link(Invoice.l.customer, customer, {
  properties: {
    role: "shipTo",
  },
})

const batch: EditBatch = edit
  .set(invoice, {
    status: "sent",
  })
  .link(invoice, Invoice.l.customer, customer, {
    properties: {
      role: "billTo",
    },
  })
  .toEditBatch()

// @ts-expect-error amount expects a number
edit.set(invoice, Invoice.p.amount, "120")

// @ts-expect-error amount expects a number
edit.set(invoice, {
  amount: "120",
})

// @ts-expect-error primary properties cannot be updated
edit.set(invoice, {
  id: "inv_2",
})

// @ts-expect-error telemetry properties cannot be edited in the MVP
edit.set(invoice, {
  temperature: 22,
})

// @ts-expect-error Invoice has no bogus property
edit.set(invoice, {
  bogus: true,
})

// @ts-expect-error Customer.name does not belong to Invoice refs
edit.set(invoice, Customer.p.name, "Acme")

// @ts-expect-error Invoice.customer must target Customer refs
edit.link(invoice, Invoice.l.customer, payment, {
  properties: {
    role: "billTo",
  },
})

// @ts-expect-error Invoice.customer requires link properties
edit.link(invoice, Invoice.l.customer, customer)

edit.link(invoice, Invoice.l.customer, customer, {
  properties: {
    role: "billTo",
    // @ts-expect-error Invoice.customer has no bogus link property
    bogus: true,
  },
})

edit.create(Invoice, {
  // @ts-expect-error Invoice has no bogus property
  bogus: true,
})

void batch
