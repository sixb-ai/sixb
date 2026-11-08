import { expect, test } from "bun:test"
import type { QuickBooksCdcEntity, QuickBooksClient, QuickBooksInvoiceLine } from "../src"
import { revision, withJournal } from "./live"

const live = test.skipIf(process.env.QUICKBOOKS_LIVE !== "accounting-writes")
// Reserved example addresses test Intuit's send response, not inbox delivery.
const sendTo = process.env.QUICKBOOKS_SEND_TO ?? "sixb-invoice-test@example.com"

/** Bounded wait for a CDC record; CDC can lag a direct read by a few seconds. */
async function cdcRecord(
  qb: QuickBooksClient,
  entity: QuickBooksCdcEntity,
  changedSince: Date,
  match: (record: { Id: string; status?: string } & Record<string, unknown>) => boolean
) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await qb.cdc.get({ entities: [entity], changedSince })
    for (const batch of result.CDCResponse)
      for (const group of batch.QueryResponse)
        for (const record of (group[entity] ?? []) as ({ Id: string } & Record<string, unknown>)[])
          if (match(record)) return record
    if (attempt < 7) await Bun.sleep(3000)
  }
  throw new Error(`[QuickBooksLive] ${entity} CDC change not observed within bounded wait`)
}

async function serviceItem(qb: QuickBooksClient) {
  for await (const item of qb.items.listAll())
    if (item.Type === "Service" && item.IncomeAccountRef) return item
  throw new Error("[QuickBooksLive] Sandbox needs an active service item")
}

function today(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)
}

live(
  "estimate lifecycle, conversion to a linked invoice and invoice pay link",
  async () => {
    await withJournal("estimates", async ({ qb, tag, write, defer }) => {
      const started = new Date(Date.now() - 5000)
      const customerInput = {
        DisplayName: `${tag}-customer`,
        PrimaryEmailAddr: { Address: sendTo },
      }
      const customer = await write("Customer.create", customerInput, (o) =>
        qb.customers.create(customerInput, o)
      )
      defer("Customer.deactivate", async () => {
        const input = revision(await qb.customers.get(customer.Id))
        await write("Customer.deactivate", input, (o) => qb.customers.deactivate(input, o))
      })
      const item = await serviceItem(qb)
      const line = (Qty: number, UnitPrice: number): QuickBooksInvoiceLine => ({
        Amount: Qty * UnitPrice,
        DetailType: "SalesItemLineDetail",
        Description: tag,
        SalesItemLineDetail: { ItemRef: { value: item.Id }, Qty, UnitPrice },
      })

      const estimateInput = {
        CustomerRef: { value: customer.Id },
        BillEmail: { Address: sendTo },
        PrivateNote: tag,
        ExpirationDate: today(30),
        Line: [line(2, 5)],
      }
      let estimate = await write("Estimate.create", estimateInput, (o) =>
        qb.estimates.create(estimateInput, o)
      )
      const estimateId = estimate.Id
      defer("Estimate.delete", async () => {
        const input = revision(await qb.estimates.get(estimateId))
        expect(
          (await write("Estimate.delete", input, (o) => qb.estimates.delete(input, o))).status
        ).toBe("Deleted")
        expect((await qb.estimates.list({ ids: [estimateId] })).items).toHaveLength(0)
      })
      expect(estimate.TxnStatus).toBe("Pending")
      expect(estimate.TotalAmt).toBe(10)

      // Customer, document number and modification filters select the new estimate.
      const byCustomer = await qb.estimates.list({ customerIds: [customer.Id] })
      expect(byCustomer.items.map((row) => row.Id)).toEqual([estimateId])
      if (estimate.DocNumber) {
        const byNumber = await qb.estimates.list({
          docNumber: estimate.DocNumber,
          customerIds: [customer.Id],
        })
        expect(byNumber.items.map((row) => row.Id)).toEqual([estimateId])
      }
      const recent = []
      for await (const row of qb.estimates.listAll({ updatedSince: started, maxResults: 7 }))
        recent.push(row.Id)
      expect(recent).toContain(estimateId)

      // Sparse acceptance keeps the customer and lines untouched.
      const accept = {
        ...revision(estimate),
        PrivateNote: `${tag}-accepted`,
        TxnStatus: "Accepted" as const,
        AcceptedBy: "Sixb sandbox test",
        AcceptedDate: today(),
      }
      estimate = await write("Estimate.accept", accept, (o) => qb.estimates.update(accept, o))
      expect(estimate.TxnStatus).toBe("Accepted")
      expect(estimate.AcceptedBy).toBe(accept.AcceptedBy)
      expect(estimate.AcceptedDate).toBe(accept.AcceptedDate)
      expect(estimate.TotalAmt).toBe(10)
      expect(estimate.CustomerRef?.value).toBe(customer.Id)

      // Line edit: keep the existing line ID with a new quantity and add a line without an ID.
      const existing = estimate.Line?.find((row) => row.DetailType === "SalesItemLineDetail")
      if (!existing?.Id) throw new Error("[QuickBooksLive] Estimate line has no ID")
      const lines = {
        ...revision(estimate),
        Line: [{ ...line(3, 5), Id: existing.Id }, line(1, 7)],
      }
      estimate = await write("Estimate.lines", lines, (o) => qb.estimates.update(lines, o))
      const items = estimate.Line?.filter((row) => row.DetailType === "SalesItemLineDetail") ?? []
      expect(items.map((row) => row.Amount)).toEqual([15, 7])
      expect(items[0]?.Id).toBe(existing.Id)
      expect(estimate.TotalAmt).toBe(22)

      estimate = await write("Estimate.send", { id: estimateId, sendTo }, (o) =>
        qb.estimates.send(estimateId, { ...o, sendTo })
      )
      expect(estimate.EmailStatus).toBe("EmailSent")
      const pdf = await qb.estimates.downloadPdf(estimateId)
      expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-")
      await cdcRecord(
        qb,
        "Estimate",
        started,
        (row) => row.Id === estimateId && row.TxnStatus === "Accepted"
      )

      // Converting the accepted estimate: the invoice links it and QuickBooks marks it Converted.
      const invoiceInput = {
        CustomerRef: { value: customer.Id },
        BillEmail: { Address: sendTo },
        PrivateNote: tag,
        LinkedTxn: [{ TxnId: estimateId, TxnType: "Estimate" }],
        Line: [line(3, 5), line(1, 7)],
      }
      const invoice = await write("Invoice.create from estimate", invoiceInput, (o) =>
        qb.invoices.create(invoiceInput, o)
      )
      defer("Invoice.delete", async () => {
        const input = revision(await qb.invoices.get(invoice.Id))
        await write("Invoice.delete", input, (o) => qb.invoices.delete(input, o))
      })
      expect(invoice.LinkedTxn).toContainEqual({ TxnId: estimateId, TxnType: "Estimate" })
      const closed = await qb.estimates.get(estimateId)
      expect(closed.TxnStatus).toBe("Converted")
      expect(closed.LinkedTxn).toContainEqual({ TxnId: invoice.Id, TxnType: "Invoice" })

      // Queries return the pay link only with include=invoiceLink; reads by ID returned it
      // for eligible invoices either way. In the sandbox, eligibility required BillEmail.
      const linked = await qb.invoices.get(invoice.Id, { includeInvoiceLink: true })
      expect(linked.InvoiceLink).toMatch(/^https:\/\//)
      const listed = await qb.invoices.list({ ids: [invoice.Id], includeInvoiceLink: true })
      expect(listed.items[0]?.InvoiceLink).toBe(linked.InvoiceLink)
      const unlinked = await qb.invoices.list({ ids: [invoice.Id] })
      expect(unlinked.items[0]?.InvoiceLink).toBeUndefined()

      // Closed and Rejected are caller-settable; this estimate is deleted to observe a tombstone.
      const rejectedInput = { ...estimateInput, PrivateNote: `${tag}-rejected` }
      let rejected = await write("Estimate.create rejected", rejectedInput, (o) =>
        qb.estimates.create(rejectedInput, o)
      )
      const close = { ...revision(rejected), TxnStatus: "Closed" as const }
      rejected = await write("Estimate.close", close, (o) => qb.estimates.update(close, o))
      expect(rejected.TxnStatus).toBe("Closed")
      const reject = { ...revision(rejected), TxnStatus: "Rejected" as const }
      rejected = await write("Estimate.reject", reject, (o) => qb.estimates.update(reject, o))
      expect(rejected.TxnStatus).toBe("Rejected")
      const remove = revision(rejected)
      expect(
        (await write("Estimate.delete rejected", remove, (o) => qb.estimates.delete(remove, o)))
          .status
      ).toBe("Deleted")
      await cdcRecord(
        qb,
        "Estimate",
        started,
        (row) => row.Id === rejected.Id && row.status === "Deleted"
      )
    })
  },
  5 * 60_000
)
