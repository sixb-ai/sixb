import { expect, test } from "bun:test"
import {
  type QuickBooksAccount,
  QuickBooksApiError,
  type QuickBooksCdcEntity,
  type QuickBooksClient,
  type QuickBooksInvoiceLine,
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

/** Bounded wait until every expected entity/ID pair appears in one multi-entity CDC response. */
async function cdcChanges(
  qb: QuickBooksClient,
  changedSince: Date,
  expected: readonly (readonly [QuickBooksCdcEntity, string])[]
) {
  const entities = [...new Set(expected.map(([entity]) => entity))]
  let missing = expected
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await qb.cdc.get({ entities, changedSince })
    const seen = new Set<string>()
    for (const batch of result.CDCResponse)
      for (const group of batch.QueryResponse)
        for (const entity of entities)
          for (const record of (group[entity] ?? []) as { Id: string }[])
            seen.add(`${entity}:${record.Id}`)
    missing = expected.filter(([entity, id]) => !seen.has(`${entity}:${id}`))
    if (!missing.length) return
    if (attempt < 7) await Bun.sleep(3000)
  }
  throw new Error(`[QuickBooksLive] CDC did not report ${JSON.stringify(missing)}`)
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
      // Without sendTo, QuickBooks sends to the stored BillEmail.
      estimate = await write("Estimate.send BillEmail", { id: estimateId }, (o) =>
        qb.estimates.send(estimateId, o)
      )
      expect(estimate.EmailStatus).toBe("EmailSent")
      expect(estimate.BillEmail?.Address).toBe(sendTo)
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
      const started = new Date(Date.now() - 5000)
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
      await cdcChanges(qb, started, [
        ["Employee", employeeId],
        ["Class", classId],
        ["Department", departmentId],
        ["PaymentMethod", methodId],
      ])
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
      await cdcChanges(qb, started, [
        ["SalesReceipt", receiptId],
        ["RefundReceipt", refundId],
      ])
    })
  },
  5 * 60_000
)

live(
  "purchase (cash, check, card) and purchase order lifecycles",
  async () => {
    await withJournal("purchases", async ({ qb, tag, write, defer }) => {
      const started = new Date(Date.now() - 5000)
      const purchaseIds: string[] = []
      const vendorInput = { DisplayName: `${tag}-vendor` }
      const vendor = await write("Vendor.create", vendorInput, (o) =>
        qb.vendors.create(vendorInput, o)
      )
      defer("Vendor.deactivate", async () => {
        const input = revision(await qb.vendors.get(vendor.Id))
        await write("Vendor.deactivate", input, (o) => qb.vendors.deactivate(input, o))
      })
      const { bank, card, expense } = await accountsByType(qb)
      const expenseLine = (Amount: number) =>
        ({
          Amount,
          DetailType: "AccountBasedExpenseLineDetail",
          Description: tag,
          AccountBasedExpenseLineDetail: { AccountRef: { value: expense.Id } },
        }) as const

      for (const [PaymentType, account] of [
        ["Cash", bank],
        ["Check", bank],
        ["CreditCard", card],
      ] as const) {
        const DocNumber = `${PaymentType.slice(0, 2)}${tag.slice(-12)}`
        const input = {
          PaymentType,
          AccountRef: { value: account.Id },
          EntityRef: { value: vendor.Id, type: "Vendor" },
          DocNumber,
          PrivateNote: tag,
          Line: [expenseLine(3.5)],
        }
        let purchase = await write(`Purchase.${PaymentType}.create`, input, (o) =>
          qb.purchases.create(input, o)
        )
        const id = purchase.Id
        purchaseIds.push(id)
        defer(`Purchase.${PaymentType}.delete`, async () => {
          const current = revision(await qb.purchases.get(id))
          expect(
            (await write("Purchase.delete", current, (o) => qb.purchases.delete(current, o))).status
          ).toBe("Deleted")
          expect((await qb.purchases.list({ ids: [id] })).items).toHaveLength(0)
        })
        expect(purchase.PaymentType).toBe(PaymentType)
        expect(purchase.TotalAmt).toBe(3.5)
        expect((await qb.purchases.list({ docNumber: DocNumber })).items.map((r) => r.Id)).toEqual([
          id,
        ])
        // Sparse Purchase updates require PaymentType (live error 2020 without it).
        const update = { ...revision(purchase), PaymentType, PrivateNote: `${tag}-updated` }
        purchase = await write(`Purchase.${PaymentType}.update`, update, (o) =>
          qb.purchases.update(update, o)
        )
        expect(purchase.PrivateNote).toBe(update.PrivateNote)
        expect(purchase.TotalAmt).toBe(3.5)
        expect(purchase.EntityRef?.value).toBe(vendor.Id)
      }

      const orderInput = {
        VendorRef: { value: vendor.Id },
        POEmail: { Address: sendTo },
        PrivateNote: tag,
        Line: [expenseLine(6)],
      }
      let order = await write("PurchaseOrder.create", orderInput, (o) =>
        qb.purchaseOrders.create(orderInput, o)
      )
      const orderId = order.Id
      defer("PurchaseOrder.delete", async () => {
        const current = revision(await qb.purchaseOrders.get(orderId))
        expect(
          (
            await write("PurchaseOrder.delete", current, (o) =>
              qb.purchaseOrders.delete(current, o)
            )
          ).status
        ).toBe("Deleted")
        expect((await qb.purchaseOrders.list({ ids: [orderId] })).items).toHaveLength(0)
      })
      expect(order.POStatus).toBe("Open")
      expect(
        (await qb.purchaseOrders.list({ vendorIds: [vendor.Id] })).items.map((r) => r.Id)
      ).toEqual([orderId])
      const orderUpdate = { ...revision(order), Memo: tag, POStatus: "Closed" as const }
      order = await write("PurchaseOrder.update", orderUpdate, (o) =>
        qb.purchaseOrders.update(orderUpdate, o)
      )
      expect(order.POStatus).toBe("Closed")
      expect(order.TotalAmt).toBe(6)
      order = await write("PurchaseOrder.send", { id: orderId, sendTo }, (o) =>
        qb.purchaseOrders.send(orderId, { ...o, sendTo })
      )
      expect(order.EmailStatus).toBe("EmailSent")
      // Without sendTo, QuickBooks sends to the stored POEmail.
      order = await write("PurchaseOrder.send POEmail", { id: orderId }, (o) =>
        qb.purchaseOrders.send(orderId, o)
      )
      expect(order.EmailStatus).toBe("EmailSent")
      const pdf = await qb.purchaseOrders.downloadPdf(orderId)
      expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-")
      await cdcChanges(qb, started, [
        ...purchaseIds.map((id) => ["Purchase", id] as const),
        ["PurchaseOrder", orderId],
      ])
    })
  },
  5 * 60_000
)

live(
  "time activity lifecycle for an employee and a customer",
  async () => {
    await withJournal("time", async ({ qb, tag, write, defer }) => {
      const started = new Date(Date.now() - 5000)
      const employeeInput = { GivenName: "Sixb", FamilyName: tag, DisplayName: `${tag}-crew` }
      const employee = await write("Employee.create", employeeInput, (o) =>
        qb.employees.create(employeeInput, o)
      )
      defer("Employee.deactivate", async () => {
        const input = revision(await qb.employees.get(employee.Id))
        await write("Employee.deactivate", input, (o) => qb.employees.deactivate(input, o))
      })
      const customerInput = { DisplayName: `${tag}-customer` }
      const customer = await write("Customer.create", customerInput, (o) =>
        qb.customers.create(customerInput, o)
      )
      defer("Customer.deactivate", async () => {
        const input = revision(await qb.customers.get(customer.Id))
        await write("Customer.deactivate", input, (o) => qb.customers.deactivate(input, o))
      })
      // A just-created name can briefly fail as a reference (live error 2500 "Names element id
      // not found"); wait until both names are queryable before referencing them.
      for (let attempt = 0; ; attempt++) {
        const [employees, customers] = await Promise.all([
          qb.employees.list({ ids: [employee.Id] }),
          qb.customers.list({ ids: [customer.Id] }),
        ])
        if (employees.items.length && customers.items.length) break
        if (attempt === 9) throw new Error("[QuickBooksLive] New names did not become queryable")
        await Bun.sleep(1000)
      }
      const item = await serviceItem(qb)
      const date = today()
      const durationInput = {
        NameOf: "Employee" as const,
        EmployeeRef: { value: employee.Id },
        CustomerRef: { value: customer.Id },
        ItemRef: { value: item.Id },
        BillableStatus: "Billable" as const,
        HourlyRate: 50,
        Hours: 2,
        Minutes: 30,
        TxnDate: date,
        Description: tag,
      }
      let entry = await write("TimeActivity.create duration", durationInput, (o) =>
        qb.timeActivities.create(durationInput, o)
      )
      const entryId = entry.Id
      defer("TimeActivity.delete duration", async () => {
        const input = revision(await qb.timeActivities.get(entryId))
        expect(
          (await write("TimeActivity.delete", input, (o) => qb.timeActivities.delete(input, o)))
            .status
        ).toBe("Deleted")
        expect((await qb.timeActivities.list({ ids: [entryId] })).items).toHaveLength(0)
      })
      expect(entry.Hours).toBe(2)
      expect(entry.Minutes).toBe(30)
      expect(entry.EmployeeRef?.value).toBe(employee.Id)
      expect(
        (await qb.timeActivities.list({ customerIds: [customer.Id], txnDateFrom: date })).items.map(
          (row) => row.Id
        )
      ).toEqual([entryId])
      const update = { ...revision(entry), Hours: 3, Minutes: 0, Description: `${tag}-updated` }
      entry = await write("TimeActivity.update", update, (o) => qb.timeActivities.update(update, o))
      expect(entry.Hours).toBe(3)
      expect(entry.Description).toBe(update.Description)
      expect(entry.EmployeeRef?.value).toBe(employee.Id)

      const rangeInput = {
        NameOf: "Employee" as const,
        EmployeeRef: { value: employee.Id },
        CustomerRef: { value: customer.Id },
        StartTime: `${date}T08:00:00-08:00`,
        EndTime: `${date}T10:15:00-08:00`,
        Description: tag,
      }
      const ranged = await write("TimeActivity.create range", rangeInput, (o) =>
        qb.timeActivities.create(rangeInput, o)
      )
      defer("TimeActivity.delete range", async () => {
        const input = revision(await qb.timeActivities.get(ranged.Id))
        await write("TimeActivity.delete", input, (o) => qb.timeActivities.delete(input, o))
      })
      expect(ranged.StartTime).toBeTruthy()
      expect(ranged.EndTime).toBeTruthy()
      await cdcChanges(qb, started, [
        ["TimeActivity", entryId],
        ["TimeActivity", ranged.Id],
      ])
    })
  },
  5 * 60_000
)

live(
  "deposit (direct and linked payment), transfer and journal entry lifecycles",
  async () => {
    await withJournal("banking", async ({ qb, tag, write, defer }) => {
      const started = new Date(Date.now() - 5000)
      const { bank, expense, accounts } = await accountsByType(qb)
      const income = accounts.find((row) => row.AccountType === "Income")
      const undeposited = accounts.find((row) => row.AccountSubType === "UndepositedFunds")
      const target =
        accounts.find((row) => row.AccountType === "Bank" && row.Id !== bank.Id) ??
        accounts.find(
          (row) => row.AccountType === "Other Current Asset" && row.Id !== undeposited?.Id
        )
      if (!income || !undeposited || !target)
        throw new Error(
          "[QuickBooksLive] Need income, undeposited funds and a second asset account"
        )

      const directInput = {
        DepositToAccountRef: { value: bank.Id },
        PrivateNote: tag,
        Line: [
          {
            Amount: 7,
            DetailType: "DepositLineDetail" as const,
            DepositLineDetail: { AccountRef: { value: income.Id } },
          },
        ],
      }
      let deposit = await write("Deposit.create direct", directInput, (o) =>
        qb.deposits.create(directInput, o)
      )
      const depositId = deposit.Id
      defer("Deposit.delete direct", async () => {
        const input = revision(await qb.deposits.get(depositId))
        expect(
          (await write("Deposit.delete", input, (o) => qb.deposits.delete(input, o))).status
        ).toBe("Deleted")
        expect((await qb.deposits.list({ ids: [depositId] })).items).toHaveLength(0)
      })
      expect(deposit.TotalAmt).toBe(7)
      // Sparse Deposit updates require DepositToAccountRef (live error 2020 without it).
      const depositUpdate = {
        ...revision(deposit),
        DepositToAccountRef: directInput.DepositToAccountRef,
        PrivateNote: `${tag}-updated`,
      }
      deposit = await write("Deposit.update", depositUpdate, (o) =>
        qb.deposits.update(depositUpdate, o)
      )
      expect(deposit.PrivateNote).toBe(depositUpdate.PrivateNote)
      expect(deposit.TotalAmt).toBe(7)

      // Depositing a customer payment held in Undeposited Funds links it by LinkedTxn.
      const customerInput = { DisplayName: `${tag}-customer` }
      const customer = await write("Customer.create", customerInput, (o) =>
        qb.customers.create(customerInput, o)
      )
      defer("Customer.deactivate", async () => {
        const input = revision(await qb.customers.get(customer.Id))
        await write("Customer.deactivate", input, (o) => qb.customers.deactivate(input, o))
      })
      const paymentInput = {
        CustomerRef: { value: customer.Id },
        TotalAmt: 5,
        DepositToAccountRef: { value: undeposited.Id },
        PrivateNote: tag,
      }
      const payment = await write("Payment.create", paymentInput, (o) =>
        qb.payments.create(paymentInput, o)
      )
      defer("Payment.delete", async () => {
        const input = revision(await qb.payments.get(payment.Id))
        await write("Payment.delete", input, (o) => qb.payments.delete(input, o))
      })
      const linkedInput = {
        DepositToAccountRef: { value: bank.Id },
        PrivateNote: tag,
        Line: [
          { Amount: 5, LinkedTxn: [{ TxnId: payment.Id, TxnType: "Payment", TxnLineId: "0" }] },
        ],
      }
      const linked = await write("Deposit.create linked", linkedInput, (o) =>
        qb.deposits.create(linkedInput, o)
      )
      defer("Deposit.delete linked", async () => {
        const input = revision(await qb.deposits.get(linked.Id))
        await write("Deposit.delete", input, (o) => qb.deposits.delete(input, o))
      })
      expect(linked.TotalAmt).toBe(5)
      expect(linked.Line?.[0]?.LinkedTxn?.[0]?.TxnId).toBe(payment.Id)

      const transferInput = {
        FromAccountRef: { value: bank.Id },
        ToAccountRef: { value: target.Id },
        Amount: 2,
        PrivateNote: tag,
      }
      let transfer = await write("Transfer.create", transferInput, (o) =>
        qb.transfers.create(transferInput, o)
      )
      const transferId = transfer.Id
      defer("Transfer.delete", async () => {
        const input = revision(await qb.transfers.get(transferId))
        expect(
          (await write("Transfer.delete", input, (o) => qb.transfers.delete(input, o))).status
        ).toBe("Deleted")
        expect((await qb.transfers.list({ ids: [transferId] })).items).toHaveLength(0)
      })
      expect(transfer.Amount).toBe(2)
      // Transfer updates require both accounts and Amount (live error 2020 without them).
      const transferUpdate = {
        ...transferInput,
        ...revision(transfer),
        PrivateNote: `${tag}-updated`,
      }
      transfer = await write("Transfer.update", transferUpdate, (o) =>
        qb.transfers.update(transferUpdate, o)
      )
      expect(transfer.PrivateNote).toBe(transferUpdate.PrivateNote)
      expect(transfer.Amount).toBe(2)
      expect(transfer.ToAccountRef?.value).toBe(target.Id)

      const journalLine = (PostingType: "Debit" | "Credit", account: string, Amount: number) =>
        ({
          Amount,
          DetailType: "JournalEntryLineDetail",
          Description: tag,
          JournalEntryLineDetail: { PostingType, AccountRef: { value: account } },
        }) as const
      const journalInput = {
        PrivateNote: tag,
        Line: [journalLine("Debit", expense.Id, 4), journalLine("Credit", bank.Id, 4)],
      }
      let journal = await write("JournalEntry.create", journalInput, (o) =>
        qb.journalEntries.create(journalInput, o)
      )
      const journalId = journal.Id
      defer("JournalEntry.delete", async () => {
        const input = revision(await qb.journalEntries.get(journalId))
        expect(
          (await write("JournalEntry.delete", input, (o) => qb.journalEntries.delete(input, o)))
            .status
        ).toBe("Deleted")
        expect((await qb.journalEntries.list({ ids: [journalId] })).items).toHaveLength(0)
      })
      // QuickBooks reports TotalAmt 0 for journal entries; the lines carry the amounts.
      expect(journal.Line?.map((line) => line.Amount)).toEqual([4, 4])
      const ids = journal.Line?.map((line) => line.Id)
      const journalUpdate = {
        ...revision(journal),
        PrivateNote: `${tag}-updated`,
        Line: [
          { ...journalLine("Debit", expense.Id, 6), Id: ids?.[0] },
          { ...journalLine("Credit", bank.Id, 6), Id: ids?.[1] },
        ],
      }
      journal = await write("JournalEntry.update", journalUpdate, (o) =>
        qb.journalEntries.update(journalUpdate, o)
      )
      expect(journal.Line?.map((line) => line.Amount)).toEqual([6, 6])
      expect(journal.Line?.map((line) => line.Id)).toEqual(ids)
      expect(journal.PrivateNote).toBe(journalUpdate.PrivateNote)

      // Balancing is provider-validated; an unbalanced entry must be rejected without a record.
      const unbalanced = {
        PrivateNote: `${tag}-unbalanced`,
        Line: [journalLine("Debit", expense.Id, 4), journalLine("Credit", bank.Id, 3)],
      }
      const rejected = await write("JournalEntry.create unbalanced", unbalanced, async (o) => {
        const row = await qb.journalEntries.create(unbalanced, o)
        defer("JournalEntry.delete unexpected", async () => {
          const input = revision(await qb.journalEntries.get(row.Id))
          await write("JournalEntry.delete", input, (o) => qb.journalEntries.delete(input, o))
        })
        return row
      }).catch((error: unknown) => error)
      expect(rejected).toBeInstanceOf(QuickBooksApiError)
      await cdcChanges(qb, started, [
        ["Deposit", depositId],
        ["Deposit", linked.Id],
        ["Transfer", transferId],
        ["JournalEntry", journalId],
      ])
    })
  },
  5 * 60_000
)
