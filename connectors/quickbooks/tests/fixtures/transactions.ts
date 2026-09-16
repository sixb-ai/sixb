import type {
  QuickBooksBill,
  QuickBooksBillPayment,
  QuickBooksCreditMemo,
  QuickBooksInvoice,
  QuickBooksPayment,
  QuickBooksVendorCredit,
} from "../../src"

// Synthetic partial wire samples, not live sandbox captures. Entity reference URLs are in README.
export const invoice = {
  Id: "42",
  SyncToken: "3",
  TxnDate: "2026-09-01",
  DueDate: "2026-09-30",
  DocNumber: "INV-42",
  CustomerRef: { value: "9", name: "Example" },
  CurrencyRef: { value: "EUR" },
  ExchangeRate: 1.12,
  TotalAmt: 200,
  Balance: 75,
  HomeBalance: 84,
  PrivateNote: "Partial payment",
  BillAddr: { Line1: "1 Example St" },
  BillEmail: { Address: "billing@example.test" },
  CustomField: [{ DefinitionId: "1", Name: "PO", Type: "StringType", StringValue: "PO-9" }],
  LinkedTxn: [{ TxnId: "51", TxnType: "Payment" }],
  Line: [
    {
      Id: "1",
      DetailType: "SalesItemLineDetail",
      Amount: 200,
      SalesItemLineDetail: {
        ItemRef: { value: "3" },
        Qty: 2,
        UnitPrice: 100,
        TaxCodeRef: { value: "NON" },
      },
    },
    { DetailType: "SubTotalLineDetail", Amount: 200, SubTotalLineDetail: {} },
  ],
  TxnTaxDetail: { TotalTax: 0 },
  MetaData: { LastUpdatedTime: "2026-09-16T12:00:00Z" },
} as const satisfies QuickBooksInvoice

export const payment = {
  Id: "42",
  TxnDate: "2026-09-02",
  CustomerRef: { value: "9" },
  TotalAmt: 150,
  UnappliedAmt: 5,
  CurrencyRef: { value: "EUR" },
  ExchangeRate: 1.12,
  PaymentRefNum: "CHECK-10",
  DepositToAccountRef: { value: "4" },
  Line: [
    { Amount: 125, LinkedTxn: [{ TxnId: "42", TxnType: "Invoice" }] },
    { Amount: 20, LinkedTxn: [{ TxnId: "43", TxnType: "Invoice" }] },
    {
      Amount: 0,
      LinkedTxn: [
        { TxnId: "44", TxnType: "Invoice" },
        { TxnId: "8", TxnType: "CreditMemo" },
      ],
    },
  ],
} as const satisfies QuickBooksPayment

export const creditMemo = {
  Id: "42",
  TxnDate: "2026-09-03",
  CustomerRef: { value: "9" },
  TotalAmt: 25,
  RemainingCredit: 10,
  CurrencyRef: { value: "EUR" },
  ExchangeRate: 1.12,
  Line: [
    {
      Id: "1",
      Amount: 25,
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: { ItemRef: { value: "3" }, Qty: 1, UnitPrice: 25 },
    },
  ],
} as const satisfies QuickBooksCreditMemo

export const bill = {
  Id: "42",
  TxnDate: "2026-09-01",
  DueDate: "2026-09-30",
  VendorRef: { value: "7" },
  APAccountRef: { value: "8" },
  TotalAmt: 300,
  Balance: 100,
  CurrencyRef: { value: "USD" },
  SalesTermRef: { value: "3" },
  LinkedTxn: [{ TxnId: "60", TxnType: "BillPaymentCheck" }],
  Line: [
    {
      Id: "1",
      Amount: 100,
      DetailType: "AccountBasedExpenseLineDetail",
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: "15" },
        CustomerRef: { value: "9" },
        BillableStatus: "Billable",
        TaxCodeRef: { value: "NON" },
      },
    },
    {
      Id: "2",
      Amount: 200,
      DetailType: "ItemBasedExpenseLineDetail",
      ItemBasedExpenseLineDetail: { ItemRef: { value: "3" }, Qty: 2, UnitPrice: 100 },
      LinkedTxn: [{ TxnId: "12", TxnType: "PurchaseOrder", TxnLineId: "1" }],
    },
  ],
} as const satisfies QuickBooksBill

export const billPayment = {
  Id: "42",
  TxnDate: "2026-09-04",
  VendorRef: { value: "7" },
  PayType: "Check",
  TotalAmt: 200,
  CheckPayment: { BankAccountRef: { value: "4" }, PrintStatus: "NeedToPrint" },
  Line: [
    { Amount: 200, LinkedTxn: [{ TxnId: "42", TxnType: "Bill" }] },
    {
      Amount: 0,
      LinkedTxn: [
        { TxnId: "43", TxnType: "Bill" },
        { TxnId: "9", TxnType: "VendorCredit" },
      ],
    },
  ],
} as const satisfies QuickBooksBillPayment

export const vendorCredit = {
  Id: "42",
  TxnDate: "2026-09-05",
  VendorRef: { value: "7" },
  APAccountRef: { value: "8" },
  TotalAmt: 25,
  CurrencyRef: { value: "USD" },
  Line: [
    {
      Id: "1",
      Amount: 25,
      DetailType: "AccountBasedExpenseLineDetail",
      AccountBasedExpenseLineDetail: { AccountRef: { value: "15" }, TaxCodeRef: { value: "NON" } },
    },
  ],
} as const satisfies QuickBooksVendorCredit
