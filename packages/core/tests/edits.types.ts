import { defineObjectType, type EditBatch, link, prop } from "../src"
import { recordEdits } from "../src/actions/worker"

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

const batch: Promise<EditBatch> = recordEdits({ runId: "act_1" }, ({ objects }) => {
  const invoice = objects(Invoice).create({
    amount: 120,
    status: "draft",
  })
  const existingInvoice = objects(Invoice).byId("inv_1")
  const customer = objects(Customer).byId("cus_1")
  const payment = objects(Payment).byId("pay_1")

  invoice.update({
    amount: 125,
    status: "paid",
    paidAt: new Date("2026-06-01T10:00:00.000Z"),
  })
  existingInvoice.update({
    status: "sent",
  })
  invoice.link(Invoice.l.customer, customer, {
    properties: {
      role: "billTo",
      since: new Date("2026-06-01T10:00:00.000Z"),
    },
  })
  invoice.unlink(Invoice.l.customer, customer)
  payment.delete()

  invoice.update({
    // @ts-expect-error amount expects a number
    amount: "120",
  })

  invoice.update({
    // @ts-expect-error primary properties cannot be updated
    id: "inv_2",
  })

  invoice.update({
    // @ts-expect-error telemetry properties cannot be edited in the MVP
    temperature: 22,
  })

  invoice.update({
    // @ts-expect-error Invoice has no bogus property
    bogus: true,
  })

  // @ts-expect-error Invoice.customer must target Customer refs
  invoice.link(Invoice.l.customer, payment, {
    properties: {
      role: "billTo",
    },
  })

  // @ts-expect-error Invoice.customer requires link properties
  invoice.link(Invoice.l.customer, customer)

  invoice.link(Invoice.l.customer, customer, {
    properties: {
      role: "billTo",
      // @ts-expect-error Invoice.customer has no bogus link property
      bogus: true,
    },
  })

  objects(Invoice).create({
    // @ts-expect-error Invoice has no bogus property
    bogus: true,
  })
})

void batch
