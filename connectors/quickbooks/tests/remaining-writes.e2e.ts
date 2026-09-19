import { expect, test } from "bun:test"
import type {
  QuickBooksBillPaymentCreate,
  QuickBooksExpenseWriteLine,
  QuickBooksInvoiceLine,
  QuickBooksPreferences,
} from "../src"
import { revision, withJournal } from "./live"

const live = test.skipIf(process.env.QUICKBOOKS_LIVE !== "remaining-writes")
const sendTo = process.env.QUICKBOOKS_SEND_TO ?? "sixb-receipt-test@example.com"

live(
  "remaining receivable/payable write lifecycles and allocation preservation",
  async () => {
    await withJournal("transactions", async ({ qb, tag, write, defer }) => {
      const customerInput = { DisplayName: `${tag}-customer` }
      const customer = await write("Customer.create", customerInput, (o) =>
        qb.customers.create(customerInput, o)
      )
      defer("Customer.deactivate", async () => {
        const input = revision(await qb.customers.get(customer.Id))
        await write("Customer.deactivate", input, (o) => qb.customers.deactivate(input, o))
        expect((await qb.customers.get(customer.Id)).Active).toBe(false)
      })
      const vendorInput = { DisplayName: `${tag}-vendor` }
      const vendor = await write("Vendor.create", vendorInput, (o) =>
        qb.vendors.create(vendorInput, o)
      )
      defer("Vendor.deactivate", async () => {
        const input = revision(await qb.vendors.get(vendor.Id))
        await write("Vendor.deactivate", input, (o) => qb.vendors.deactivate(input, o))
        expect((await qb.vendors.get(vendor.Id)).Active).toBe(false)
      })
      const accounts = []
      for await (const row of qb.accounts.listAll()) accounts.push(row)
      const expense = accounts.find((a) => a.AccountType === "Expense")
      const bank = accounts.find((a) => a.AccountType === "Bank")
      const card = accounts.find((a) => a.AccountType === "Credit Card")
      const items = []
      for await (const row of qb.items.listAll()) items.push(row)
      const item = items.find((i) => i.Type === "Service" && i.IncomeAccountRef)
      if (!expense || !bank || !card || !item)
        throw new Error(
          "[QuickBooksLive] Need expense, bank, credit card accounts and a service item"
        )
      const sales: readonly QuickBooksInvoiceLine[] = [
        {
          Amount: 4,
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: { ItemRef: { value: item.Id }, Qty: 1, UnitPrice: 4 },
        },
      ]
      const expenses: readonly QuickBooksExpenseWriteLine[] = [
        {
          Amount: 4,
          DetailType: "AccountBasedExpenseLineDetail",
          AccountBasedExpenseLineDetail: { AccountRef: { value: expense.Id } },
        },
      ]

      // LIFO cleanup releases allocations before deleting their targets.
      const invoiceInput = { CustomerRef: { value: customer.Id }, Line: sales, PrivateNote: tag }
      const invoice = await write("Invoice.create", invoiceInput, (o) =>
        qb.invoices.create(invoiceInput, o)
      )
      defer("Invoice.delete", async () => {
        const input = revision(await qb.invoices.get(invoice.Id))
        expect(
          (await write("Invoice.delete", input, (o) => qb.invoices.delete(input, o))).status
        ).toBe("Deleted")
      })
      const paymentInput = {
        CustomerRef: { value: customer.Id },
        TotalAmt: 4,
        Line: [{ Amount: 4, LinkedTxn: [{ TxnId: invoice.Id, TxnType: "Invoice" }] }],
        PrivateNote: tag,
      }
      let payment = await write("Payment.create", paymentInput, (o) =>
        qb.payments.create(paymentInput, o)
      )
      const paymentId = payment.Id
      defer("Payment.delete", async () => {
        const input = revision(await qb.payments.get(paymentId))
        expect(
          (await write("Payment.delete", input, (o) => qb.payments.delete(input, o))).status
        ).toBe("Deleted")
        expect((await qb.payments.list({ ids: [paymentId] })).items).toHaveLength(0)
      })
      expect((await qb.invoices.get(invoice.Id)).Balance).toBe(0)
      const paymentUpdate = { ...revision(payment), PrivateNote: `${tag}-updated` }
      payment = await write("Payment.update", paymentUpdate, (o) =>
        qb.payments.update(paymentUpdate, o)
      )
      expect(payment.PrivateNote).toBe(`${tag}-updated`)
      expect(payment.Line?.[0]?.LinkedTxn?.[0]?.TxnId).toBe(invoice.Id)
      expect(
        (
          await write("Payment.send", { id: payment.Id, sendTo }, (o) =>
            qb.payments.send(payment.Id, { ...o, sendTo })
          )
        ).Id
      ).toBe(payment.Id)
      const unapply = { ...revision(await qb.payments.get(payment.Id)), Line: [] }
      payment = await write("Payment.unapply", unapply, (o) => qb.payments.update(unapply, o))
      expect(payment.UnappliedAmt).toBe(4)
      expect((await qb.invoices.get(invoice.Id)).Balance).toBe(4)
      const voidPayment = revision(payment)
      payment = await write("Payment.void", voidPayment, (o) => qb.payments.void(voidPayment, o))
      expect(payment.TotalAmt).toBe(0)

      // A different customer prevents auto-apply-credit preferences linking this to the invoice.
      const creditCustomerInput = { DisplayName: `${tag}-credit` }
      const creditCustomer = await write("Customer.create credit", creditCustomerInput, (o) =>
        qb.customers.create(creditCustomerInput, o)
      )
      defer("Customer.credit deactivate", async () => {
        const input = revision(await qb.customers.get(creditCustomer.Id))
        await write("Customer.deactivate", input, (o) => qb.customers.deactivate(input, o))
      })
      const creditInput = {
        CustomerRef: { value: creditCustomer.Id },
        Line: sales,
        PrivateNote: tag,
      }
      let credit = await write("CreditMemo.create", creditInput, (o) =>
        qb.creditMemos.create(creditInput, o)
      )
      const creditId = credit.Id
      defer("CreditMemo.delete", async () => {
        const input = revision(await qb.creditMemos.get(creditId))
        expect(
          (await write("CreditMemo.delete", input, (o) => qb.creditMemos.delete(input, o))).status
        ).toBe("Deleted")
        expect((await qb.creditMemos.list({ ids: [creditId] })).items).toHaveLength(0)
      })
      const creditUpdate = {
        ...creditInput,
        ...revision(credit),
        PrivateNote: `${tag}-updated`,
        Line: sales.map((line) => ({ ...line, Id: credit.Line?.[0]?.Id })),
      }
      credit = await write("CreditMemo.update", creditUpdate, (o) =>
        qb.creditMemos.update(creditUpdate, o)
      )
      expect(credit.PrivateNote).toBe(`${tag}-updated`)
      expect(credit.TotalAmt).toBe(4)
      credit = await write("CreditMemo.send", { id: credit.Id, sendTo }, (o) =>
        qb.creditMemos.send(credit.Id, { ...o, sendTo })
      )
      expect(credit.EmailStatus).toBe("EmailSent")
      expect(
        (
          await write("CreditMemo.send stored", { id: credit.Id }, (o) =>
            qb.creditMemos.send(credit.Id, o)
          )
        ).EmailStatus
      ).toBe("EmailSent")

      const billInput = { VendorRef: { value: vendor.Id }, Line: expenses, PrivateNote: tag }
      let bill = await write("Bill.create", billInput, (o) => qb.bills.create(billInput, o))
      const billId = bill.Id
      defer("Bill.delete", async () => {
        const input = revision(await qb.bills.get(billId))
        expect((await write("Bill.delete", input, (o) => qb.bills.delete(input, o))).status).toBe(
          "Deleted"
        )
        expect((await qb.bills.list({ ids: [billId] })).items).toHaveLength(0)
      })
      const billUpdate = {
        ...billInput,
        ...revision(bill),
        PrivateNote: `${tag}-updated`,
        Line: expenses.map((line) => ({ ...line, Id: bill.Line?.[0]?.Id })),
      }
      bill = await write("Bill.update", billUpdate, (o) => qb.bills.update(billUpdate, o))
      expect(bill.PrivateNote).toBe(`${tag}-updated`)
      expect(bill.TotalAmt).toBe(4)
      for (const PayType of ["Check", "CreditCard"] as const) {
        const input: QuickBooksBillPaymentCreate = {
          VendorRef: { value: vendor.Id },
          TotalAmt: 4,
          Line: [{ Amount: 4, LinkedTxn: [{ TxnId: billId, TxnType: "Bill" }] }],
          ...(PayType === "Check"
            ? { PayType, CheckPayment: { BankAccountRef: { value: bank.Id } } }
            : { PayType, CreditCardPayment: { CCAccountRef: { value: card.Id } } }),
        }
        let row = await write(`BillPayment.${PayType}.create`, input, (o) =>
          qb.billPayments.create(input, o)
        )
        const id = row.Id
        defer(`BillPayment.${PayType}.delete`, async () => {
          const input = revision(await qb.billPayments.get(id))
          expect(
            (await write("BillPayment.delete", input, (o) => qb.billPayments.delete(input, o)))
              .status
          ).toBe("Deleted")
          expect((await qb.billPayments.list({ ids: [id] })).items).toHaveLength(0)
        })
        expect((await qb.bills.get(billId)).Balance).toBe(0)
        const update = { ...input, ...revision(row), PrivateNote: tag }
        row = await write("BillPayment.update", update, (o) => qb.billPayments.update(update, o))
        expect(row.PrivateNote).toBe(tag)
        expect(row.PayType).toBe(PayType)
        const voidInput = revision(row)
        row = await write("BillPayment.void", voidInput, (o) => qb.billPayments.void(voidInput, o))
        expect(row.TotalAmt).toBe(0)
        expect((await qb.bills.get(billId)).Balance).toBe(4)
      }
      let vendorCredit = await write("VendorCredit.create", billInput, (o) =>
        qb.vendorCredits.create(billInput, o)
      )
      const vendorCreditId = vendorCredit.Id
      defer("VendorCredit.delete", async () => {
        const input = revision(await qb.vendorCredits.get(vendorCreditId))
        expect(
          (await write("VendorCredit.delete", input, (o) => qb.vendorCredits.delete(input, o)))
            .status
        ).toBe("Deleted")
        expect((await qb.vendorCredits.list({ ids: [vendorCreditId] })).items).toHaveLength(0)
      })
      const vendorCreditUpdate = {
        ...billInput,
        ...revision(vendorCredit),
        PrivateNote: `${tag}-updated`,
        Line: expenses.map((line) => ({ ...line, Id: vendorCredit.Line?.[0]?.Id })),
      }
      vendorCredit = await write("VendorCredit.update", vendorCreditUpdate, (o) =>
        qb.vendorCredits.update(vendorCreditUpdate, o)
      )
      expect(vendorCredit.PrivateNote).toBe(`${tag}-updated`)
      expect((await qb.vendorCredits.get(vendorCreditId)).TotalAmt).toBe(4)
    })
  },
  5 * 60_000
)

live(
  "account, item and term maintenance with activation and cleanup",
  async () => {
    await withJournal("references", async ({ qb, tag, write, defer }) => {
      const accountInput = {
        Name: tag,
        AccountType: "Income",
        AccountSubType: "SalesOfProductIncome",
      }
      let account = await write("Account.create", accountInput, (o) =>
        qb.accounts.create(accountInput, o)
      )
      const accountId = account.Id
      defer("Account.deactivate", async () => {
        const input = revision(await qb.accounts.get(accountId))
        await write("Account.deactivate", input, (o) => qb.accounts.deactivate(input, o))
        expect((await qb.accounts.get(accountId)).Active).toBe(false)
      })
      const accountUpdate = { ...revision(account), Description: "Sixb sandbox test" }
      account = await write("Account.update", accountUpdate, (o) =>
        qb.accounts.update(accountUpdate, o)
      )
      expect((await qb.accounts.get(account.Id)).Description).toBe("Sixb sandbox test")
      let input = revision(account)
      account = await write("Account.deactivate", input, (o) => qb.accounts.deactivate(input, o))
      expect(account.Active).toBe(false)
      input = revision(account)
      account = await write("Account.reactivate", input, (o) => qb.accounts.reactivate(input, o))
      expect(account.Active).toBe(true)
      for (const Type of ["Service", "NonInventory"] as const) {
        const create = {
          Name: `${tag}-${Type}`,
          Type,
          IncomeAccountRef: { value: accountId },
          UnitPrice: 1,
        }
        let item = await write("Item.create", create, (o) => qb.items.create(create, o))
        const itemId = item.Id
        defer(`Item.${Type}.deactivate`, async () => {
          const input = { ...revision(await qb.items.get(itemId)), Type }
          await write("Item.deactivate", input, (o) => qb.items.deactivate(input, o))
          expect((await qb.items.get(itemId)).Active).toBe(false)
        })
        const update = { ...revision(item), Type, UnitPrice: 2 }
        item = await write("Item.update", update, (o) => qb.items.update(update, o))
        expect((await qb.items.get(itemId)).UnitPrice).toBe(2)
        const inactive = { ...revision(item), Type }
        item = await write("Item.deactivate", inactive, (o) => qb.items.deactivate(inactive, o))
        expect(item.Active).toBe(false)
        const active = { ...revision(item), Type }
        item = await write("Item.reactivate", active, (o) => qb.items.reactivate(active, o))
        expect(item.Active).toBe(true)
      }
      const accounts = []
      for await (const row of qb.accounts.listAll()) accounts.push(row)
      const asset = accounts.find((row) => row.AccountSubType === "Inventory")
      const cogs = accounts.find((row) => row.AccountType === "Cost of Goods Sold")
      if (!asset || !cogs)
        throw new Error("[QuickBooksLive] Need inventory asset and cost-of-goods accounts")
      const inventoryInput = {
        Name: `${tag}-inventory`,
        Type: "Inventory" as const,
        IncomeAccountRef: { value: accountId },
        ExpenseAccountRef: { value: cogs.Id },
        AssetAccountRef: { value: asset.Id },
        TrackQtyOnHand: true as const,
        QtyOnHand: 0,
        InvStartDate: new Date().toISOString().slice(0, 10),
        PurchaseCost: 0,
      }
      let inventory = await write("Item.inventory.create", inventoryInput, (o) =>
        qb.items.create(inventoryInput, o)
      )
      const inventoryId = inventory.Id
      defer("Item.inventory.deactivate", async () => {
        const current = await qb.items.get(inventoryId)
        const input = { ...inventoryInput, ...revision(current), QtyOnHand: 0, Active: false }
        await write("Item.inventory.cleanup", input, (o) => qb.items.update(input, o))
        const final = await qb.items.get(inventoryId)
        expect(final.Active).toBe(false)
        expect(final.QtyOnHand).toBe(0)
      })
      const inventoryUpdate = { ...inventoryInput, ...revision(inventory), QtyOnHand: 1 }
      inventory = await write("Item.inventory.update", inventoryUpdate, (o) =>
        qb.items.update(inventoryUpdate, o)
      )
      expect(inventory.QtyOnHand).toBe(1)
      expect((await qb.items.get(inventoryId)).QtyOnHand).toBe(1)

      for (const due of [{ DueDays: 10 }, { DayOfMonthDue: 15 }] as const) {
        const create = { Name: `${tag}-${"DueDays" in due ? "net" : "date"}`, ...due }
        let term = await write("Term.create", create, (o) => qb.terms.create(create, o))
        const id = term.Id
        defer("Term.deactivate", async () => {
          const input = revision(await qb.terms.get(id))
          await write("Term.deactivate", input, (o) => qb.terms.deactivate(input, o))
          expect((await qb.terms.get(id)).Active).toBe(false)
        })
        const update = { ...revision(term), ...due, Name: `${create.Name}-u` }
        term = await write("Term.update", update, (o) => qb.terms.update(update, o))
        expect((await qb.terms.get(id)).Name).toBe(update.Name)
        let input = revision(term)
        term = await write("Term.deactivate", input, (o) => qb.terms.deactivate(input, o))
        expect(term.Active).toBe(false)
        input = revision(term)
        expect(
          (await write("Term.reactivate", input, (o) => qb.terms.reactivate(input, o))).Active
        ).toBe(true)
      }
    })
  },
  5 * 60_000
)

live(
  "company and preference updates restore their original settings",
  async () => {
    await withJournal("settings", async ({ qb, tag, write, defer }) => {
      const company = await qb.companyInfo.get()
      const originalName = company.CompanyName
      defer("CompanyInfo.restore", async () => {
        const input = { ...revision(await qb.companyInfo.get()), CompanyName: originalName }
        await write("CompanyInfo.restore", input, (o) => qb.companyInfo.update(input, o))
        expect((await qb.companyInfo.get()).CompanyName).toBe(originalName)
      })
      const companyInput = { ...revision(company), CompanyName: tag }
      expect(
        (
          await write("CompanyInfo.update", { originalName, input: companyInput }, (o) =>
            qb.companyInfo.update(companyInput, o)
          )
        ).CompanyName
      ).toBe(tag)
      expect((await qb.companyInfo.get()).CompanyName).toBe(tag)

      const before = await qb.preferences.get()
      const basis = before.ReportPrefs?.ReportBasis
      if (basis !== "Cash" && basis !== "Accrual")
        throw new Error("[QuickBooksLive] Unknown report basis")
      const restore = { ...revision(before), ReportPrefs: { ReportBasis: basis } } as const
      defer("Preferences.restore", async () => {
        const input = { ...restore, ...revision(await qb.preferences.get()) }
        await write("Preferences.restore", input, (o) => qb.preferences.update(input, o))
        expect(preferenceSettings(await qb.preferences.get())).toEqual(preferenceSettings(before))
      })
      // The original snapshot is journalled even if the update response is lost.
      const input = {
        ...restore,
        ReportPrefs: {
          ...restore.ReportPrefs,
          ReportBasis: basis === "Cash" ? ("Accrual" as const) : ("Cash" as const),
        },
      }
      const result = await write("Preferences.update", { original: before, restore, input }, (o) =>
        qb.preferences.update(input, o)
      )
      expect(result.ReportPrefs?.ReportBasis).toBe(input.ReportPrefs.ReportBasis)
      expect((await qb.preferences.get()).ReportPrefs?.ReportBasis).toBe(
        input.ReportPrefs.ReportBasis
      )
      expect(result.SalesFormsPrefs?.CustomTxnNumbers).toBe(
        before.SalesFormsPrefs?.CustomTxnNumbers
      )
      expect(preferenceSettings(result)).toEqual(
        preferenceSettings({
          ...before,
          ReportPrefs: { ...before.ReportPrefs, ReportBasis: input.ReportPrefs.ReportBasis },
        })
      )
    })
  },
  5 * 60_000
)

function preferenceSettings({
  Id: _id,
  SyncToken: _token,
  MetaData: _meta,
  sparse: _sparse,
  ...settings
}: QuickBooksPreferences) {
  return settings
}
