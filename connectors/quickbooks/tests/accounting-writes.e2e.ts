import { expect, test } from "bun:test"
import type {
  QuickBooksAccount,
  QuickBooksCdcEntity,
  QuickBooksClient,
  QuickBooksInvoiceLine,
} from "../src"
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

live(
  "employee, class, department and payment method maintenance with activation",
  async () => {
    await withJournal("references", async ({ qb, tag, write, defer }) => {
      const employeeInput = {
        GivenName: "Sixb",
        FamilyName: tag,
        DisplayName: `${tag}-employee`,
        BillableTime: true,
        BillRate: 45,
      }
      let employee = await write("Employee.create", employeeInput, (o) =>
        qb.employees.create(employeeInput, o)
      )
      const employeeId = employee.Id
      defer("Employee.deactivate", async () => {
        const input = revision(await qb.employees.get(employeeId))
        await write("Employee.deactivate", input, (o) => qb.employees.deactivate(input, o))
        expect((await qb.employees.get(employeeId)).Active).toBe(false)
      })
      const employeeUpdate = { ...revision(employee), HiredDate: today(-30) }
      employee = await write("Employee.update", employeeUpdate, (o) =>
        qb.employees.update(employeeUpdate, o)
      )
      expect(employee.HiredDate).toBe(employeeUpdate.HiredDate)
      expect(employee.DisplayName).toBe(employeeInput.DisplayName)
      expect(
        (await qb.employees.list({ name: employeeInput.DisplayName })).items.map((row) => row.Id)
      ).toEqual([employeeId])
      let input = revision(employee)
      employee = await write("Employee.deactivate", input, (o) => qb.employees.deactivate(input, o))
      expect(employee.Active).toBe(false)
      expect(
        (await qb.employees.list({ active: false, ids: [employeeId] })).items.map((row) => row.Id)
      ).toEqual([employeeId])
      input = revision(employee)
      employee = await write("Employee.reactivate", input, (o) => qb.employees.reactivate(input, o))
      expect(employee.Active).toBe(true)

      // Class and Department updates require Name even when sparse (live error 2020).
      const classInput = { Name: `${tag}-class` }
      let klass = await write("Class.create", classInput, (o) => qb.classes.create(classInput, o))
      const classId = klass.Id
      defer("Class.deactivate", async () => {
        const current = await qb.classes.get(classId)
        const input = { ...revision(current), Name: current.Name }
        await write("Class.deactivate", input, (o) => qb.classes.deactivate(input, o))
        expect((await qb.classes.get(classId)).Active).toBe(false)
      })
      const classUpdate = { ...revision(klass), Name: `${classInput.Name}-u` }
      klass = await write("Class.update", classUpdate, (o) => qb.classes.update(classUpdate, o))
      expect((await qb.classes.list({ name: classUpdate.Name })).items.map((r) => r.Id)).toEqual([
        classId,
      ])
      let classState = { ...revision(klass), Name: klass.Name }
      klass = await write("Class.deactivate", classState, (o) =>
        qb.classes.deactivate(classState, o)
      )
      expect(klass.Active).toBe(false)
      classState = { ...revision(klass), Name: klass.Name }
      klass = await write("Class.reactivate", classState, (o) =>
        qb.classes.reactivate(classState, o)
      )
      expect(klass.Active).toBe(true)

      const departmentInput = { Name: `${tag}-department` }
      let department = await write("Department.create", departmentInput, (o) =>
        qb.departments.create(departmentInput, o)
      )
      const departmentId = department.Id
      defer("Department.deactivate", async () => {
        const current = await qb.departments.get(departmentId)
        const input = { ...revision(current), Name: current.Name }
        await write("Department.deactivate", input, (o) => qb.departments.deactivate(input, o))
        expect((await qb.departments.get(departmentId)).Active).toBe(false)
      })
      const departmentUpdate = { ...revision(department), Name: `${departmentInput.Name}-u` }
      department = await write("Department.update", departmentUpdate, (o) =>
        qb.departments.update(departmentUpdate, o)
      )
      expect(
        (await qb.departments.list({ name: departmentUpdate.Name })).items.map((r) => r.Id)
      ).toEqual([departmentId])
      let departmentState = { ...revision(department), Name: department.Name }
      department = await write("Department.deactivate", departmentState, (o) =>
        qb.departments.deactivate(departmentState, o)
      )
      expect(department.Active).toBe(false)
      departmentState = { ...revision(department), Name: department.Name }
      department = await write("Department.reactivate", departmentState, (o) =>
        qb.departments.reactivate(departmentState, o)
      )
      expect(department.Active).toBe(true)

      const methodInput = { Name: `${tag}-method`.slice(0, 31), Type: "NON_CREDIT_CARD" as const }
      let method = await write("PaymentMethod.create", methodInput, (o) =>
        qb.paymentMethods.create(methodInput, o)
      )
      const methodId = method.Id
      defer("PaymentMethod.deactivate", async () => {
        const input = revision(await qb.paymentMethods.get(methodId))
        await write("PaymentMethod.deactivate", input, (o) =>
          qb.paymentMethods.deactivate(input, o)
        )
        expect((await qb.paymentMethods.get(methodId)).Active).toBe(false)
      })
      const methodUpdate = { ...revision(method), Type: "CREDIT_CARD" as const }
      method = await write("PaymentMethod.update", methodUpdate, (o) =>
        qb.paymentMethods.update(methodUpdate, o)
      )
      expect(method.Type).toBe("CREDIT_CARD")
      input = revision(method)
      method = await write("PaymentMethod.deactivate", input, (o) =>
        qb.paymentMethods.deactivate(input, o)
      )
      expect(method.Active).toBe(false)
      input = revision(method)
      method = await write("PaymentMethod.reactivate", input, (o) =>
        qb.paymentMethods.reactivate(input, o)
      )
      expect(method.Active).toBe(true)
    })
  },
  5 * 60_000
)

async function accountsByType(qb: QuickBooksClient) {
  const accounts: QuickBooksAccount[] = []
  for await (const account of qb.accounts.listAll()) accounts.push(account)
  const find = (type: string) => {
    const account = accounts.find((row) => row.AccountType === type)
    if (!account) throw new Error(`[QuickBooksLive] Sandbox needs an active ${type} account`)
    return account
  }
  return { bank: find("Bank"), card: find("Credit Card"), expense: find("Expense"), accounts }
}

live(
  "sales receipt and refund receipt lifecycles",
  async () => {
    await withJournal("receipts", async ({ qb, tag, write, defer }) => {
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
      const { bank } = await accountsByType(qb)
      const lines: QuickBooksInvoiceLine[] = [
        {
          Amount: 12,
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: { ItemRef: { value: item.Id }, Qty: 1, UnitPrice: 12 },
        },
      ]

      const receiptInput = {
        CustomerRef: { value: customer.Id },
        BillEmail: { Address: sendTo },
        DepositToAccountRef: { value: bank.Id },
        PrivateNote: tag,
        Line: lines,
      }
      let receipt = await write("SalesReceipt.create", receiptInput, (o) =>
        qb.salesReceipts.create(receiptInput, o)
      )
      const receiptId = receipt.Id
      defer("SalesReceipt.delete", async () => {
        const input = revision(await qb.salesReceipts.get(receiptId))
        expect(
          (await write("SalesReceipt.delete", input, (o) => qb.salesReceipts.delete(input, o)))
            .status
        ).toBe("Deleted")
        expect((await qb.salesReceipts.list({ ids: [receiptId] })).items).toHaveLength(0)
      })
      expect(receipt.TotalAmt).toBe(12)
      expect(
        (await qb.salesReceipts.list({ customerIds: [customer.Id] })).items.map((row) => row.Id)
      ).toEqual([receiptId])
      const receiptUpdate = { ...revision(receipt), PrivateNote: `${tag}-updated` }
      receipt = await write("SalesReceipt.update", receiptUpdate, (o) =>
        qb.salesReceipts.update(receiptUpdate, o)
      )
      expect(receipt.PrivateNote).toBe(receiptUpdate.PrivateNote)
      expect(receipt.TotalAmt).toBe(12)
      receipt = await write("SalesReceipt.send", { id: receiptId, sendTo }, (o) =>
        qb.salesReceipts.send(receiptId, { ...o, sendTo })
      )
      expect(receipt.EmailStatus).toBe("EmailSent")
      const receiptPdf = await qb.salesReceipts.downloadPdf(receiptId)
      expect(new TextDecoder().decode(receiptPdf.slice(0, 5))).toBe("%PDF-")
      const receiptVoid = revision(receipt)
      receipt = await write("SalesReceipt.void", receiptVoid, (o) =>
        qb.salesReceipts.void(receiptVoid, o)
      )
      expect(receipt.TotalAmt).toBe(0)
      expect((await qb.salesReceipts.get(receiptId)).TotalAmt).toBe(0)

      const refundInput = {
        CustomerRef: { value: customer.Id },
        BillEmail: { Address: sendTo },
        DepositToAccountRef: { value: bank.Id },
        PrivateNote: tag,
        Line: lines,
      }
      let refund = await write("RefundReceipt.create", refundInput, (o) =>
        qb.refundReceipts.create(refundInput, o)
      )
      const refundId = refund.Id
      defer("RefundReceipt.delete", async () => {
        const input = revision(await qb.refundReceipts.get(refundId))
        expect(
          (await write("RefundReceipt.delete", input, (o) => qb.refundReceipts.delete(input, o)))
            .status
        ).toBe("Deleted")
        expect((await qb.refundReceipts.list({ ids: [refundId] })).items).toHaveLength(0)
      })
      expect(refund.TotalAmt).toBe(12)
      const refundUpdate = { ...revision(refund), PrivateNote: `${tag}-updated` }
      refund = await write("RefundReceipt.update", refundUpdate, (o) =>
        qb.refundReceipts.update(refundUpdate, o)
      )
      expect(refund.PrivateNote).toBe(refundUpdate.PrivateNote)
      const refundPdf = await qb.refundReceipts.downloadPdf(refundId)
      expect(new TextDecoder().decode(refundPdf.slice(0, 5))).toBe("%PDF-")
      // RefundReceipt has no EmailStatus; the send response is the refund receipt itself.
      refund = await write("RefundReceipt.send", { id: refundId, sendTo }, (o) =>
        qb.refundReceipts.send(refundId, { ...o, sendTo })
      )
      expect(refund.Id).toBe(refundId)
      expect(refund.BillEmail?.Address).toBe(sendTo)
      expect(refund.DeliveryInfo?.DeliveryType).toBe("Email")
      const refundVoid = revision(refund)
      refund = await write("RefundReceipt.void", refundVoid, (o) =>
        qb.refundReceipts.void(refundVoid, o)
      )
      expect(refund.TotalAmt).toBe(0)
      expect((await qb.refundReceipts.get(refundId)).TotalAmt).toBe(0)
    })
  },
  5 * 60_000
)
