# @sixb/connector-quickbooks

QuickBooks Online Accounting API connector for Sixb. Managed OAuth, verified company discovery,
CompanyInfo and Preferences, plus typed reads of every queryable US Accounting entity: name lists
(customers, vendors, employees, accounts, items, terms, classes, departments, customer types,
payment methods, budgets, currencies), tax data (codes, rates, agencies, classifications, exchange
rates) and transactions (estimates, invoices, sales and refund receipts, payments, credit memos,
bills, bill payments, vendor credits, purchases, purchase orders, time activities, deposits,
transfers, journal entries, card payments, inventory adjustments, reimburse charges and
recurring templates). Typed writes cover the resources applications commonly change, including
the estimate-to-invoice flow, form sending and PDFs. Queries support modification, document
number and customer/vendor filters where QuickBooks accepts them. CDC, verified CloudEvents
webhooks, file attachments and the standard accounting reports complete the connector.

## Register

```ts
import { defineConnector } from "@sixb/core"
import { quickbooks } from "@sixb/connector-quickbooks"

export const quickbooksConnector = defineConnector("quickbooks", quickbooks({
  clientId: process.env.INTUIT_CLIENT_ID!,
  clientSecret: process.env.INTUIT_CLIENT_SECRET!,
  environment: "sandbox",
}))
```

Place the definition in the app's `connectors/` directory. Sixb discovers it and manages
authorization, account selection, encrypted credentials, and refresh coordination.
Configure the callback URL shown by Sixb in your Intuit app.

Authorize the customer's company and select it for an application-defined project connection slot.
Discovery verifies the callback's `realmId` through an authenticated CompanyInfo read. In a trusted
execution, resolve that selected slot to obtain the typed client:

```ts
const qb = await sixb.connector(quickbooksConnector, {
  owner: { type: "project" },
  slot: "accounting",
})
const company = await qb.companyInfo.get()
console.log(company.Id, company.CompanyName)
```

`CompanyInfo.Id` is an entity ID and can differ from the OAuth `realmId`. The selected connection
uses the realm ID; accounting requests are scoped by that realm in their URL.

## Read reference data

```ts
const preferences = await qb.preferences.get()
const customer = await qb.customers.get("42")
const employee = await qb.employees.get("55")
const taxCode = await qb.taxCodes.get("2")

// Every name-list resource has get, list, and listAll.
const page = await qb.customers.list({
  active: "all",
  name: "Adam's Candy Shop",
  maxResults: 100,
  orderBy: { field: "DisplayName", direction: "ASC" },
})

for await (const customer of qb.customers.listAll({
  active: "all",
  updatedSince: new Date("2026-09-01T00:00:00Z"),
  orderBy: { field: "MetaData.LastUpdatedTime" },
})) {
  console.log(customer.Id, customer.DisplayName, customer.ParentRef, customer.Balance)
}
```

Name lists: `customers`, `vendors`, `employees`, `accounts`, `items`, `terms`, `classes`,
`departments`, `customerTypes`, `paymentMethods`, `taxCodes`, `taxRates`, `taxAgencies`, `budgets`
and `companyCurrencies`.

| List option | Contract |
| --- | --- |
| `startPosition` | One-based position; default 1 |
| `maxResults` | 1–1,000 records per page; default 100 |
| `active` | `true` (default), `false`, or `"all"`; not available on `taxAgencies` (no Active flag) |
| `ids` | Nonempty string ID array, serialized as `Id IN (...)` |
| `name` | Exact `DisplayName` equality for customers/vendors/employees; `Name` elsewhere (tax agencies match their display name); not available on `companyCurrencies` |
| `updatedSince` | `Date`; `MetaData.LastUpdatedTime >=` bound (see the boundary caveat under transactions) |
| `orderBy` | `Id`, `MetaData.LastUpdatedTime` or the name field, with `ASC`/`DESC`; defaults to `Id ASC` |

These options are the supported query subset; unknown options reject before any request. Strings are escaped for the QBO query language,
then URL-encoded. Entity records retain their provider shape, including addresses, customer
hierarchies, reference objects, inventory/group details, currencies, and returned custom fields.
Optional data varies by locale, product, and company settings; missing fields are not filled in.

`list` returns `{ items, startPosition?, maxResults?, totalCount?, time? }`. Metadata comes from
QuickBooks; `maxResults` in a response describes the returned page, and totals are not synthesized.
`listAll` fetches lazily, advances by the returned count, and stops on a short or empty page. A full
final page requires one more request. Invalid envelopes, unexpected positions, and repeated pages
reject instead of silently claiming completion. Offset pagination is not a snapshot: concurrent
provider edits can move records between pages, so syncs still need reconciliation.

Sorting is executed by QuickBooks. In live sandbox checks, Account queries accepted `ORDERBY Id`
but returned nonmonotonic entity IDs; descending results were not the reverse of ascending results.
`ORDERBY MetaData.LastUpdatedTime` on accounts was also nonmonotonic (13 inversions across 97
accounts at page sizes 7 and 1,000); customers, items and invoices sorted correctly.
The connector preserves that provider order. Use Account `Name` sorting when name order is needed,
and do not use the last Account ID as a high-water mark. Equal sort values can also have unstable
relative order; offset pagination does not establish a snapshot or a completeness guarantee.

On `401`, the transport invalidates the exact rejected token and replays the read once with a
fresh token. Reads default to two transient-failure retries and honor `Retry-After` through the
shared REST transport. OAuth code exchange and refresh are never automatically replayed: a lost
response can contain rotated credentials. OAuth errors use Sixb's terminal/retryable/ambiguous
classification without including provider response bodies or credentials in their messages.

Accounting failures throw `QuickBooksApiError` with `status`, `requestId` (`intuit_tid`),
`faultType`, and provider `errors` (`code`, `Message`, `Detail`, `element`).

Tax data and rates have provider quirks the resources model directly:

- `taxCodes` and `taxRates` are read-only. US pseudo-codes `TAX`, `NON` and `CustomSalesTax` have
  no Active flag or numeric ID: `get` rejects them (error 2030) and they are never returned by
  `list`, which always sends an Active predicate. Without one, QuickBooks prepends them to the
  first page beyond `MAXRESULTS` and later offsets skip codes. Reference them by value in
  `TaxCodeRef`. QuickBooks creates tax codes and rates through TaxService, which makes permanent
  records and is not exposed.
- `taxClassifications.list({ ids?, name?, level?, parentId? })` returns every match in one
  response. QuickBooks ignores `STARTPOSITION`/`MAXRESULTS` here (2,106 rows unfiltered in the
  sandbox), so the resource is not paged.
- `exchangeRates.get({ sourceCurrencyCode, asOfDate? })` reads a rate to the home currency.
  Rates have no entity ID. `list` supports pagination and `updatedSince` only, in provider order:
  QuickBooks accepts but ignores `SourceCurrencyCode`/`AsOfDate` predicates and cannot sort by date.
- `companyCurrencies` exist only when multicurrency is enabled; `budgets` are read-only.

## Download PDFs

```ts
const pdf = await qb.invoices.downloadPdf("42") // Invoice.Id
await Bun.write("invoice.pdf", pdf)
const quote = await qb.estimates.downloadPdf("77") // Estimate.Id
await Bun.write("estimate.pdf", quote)
```

`downloadPdf(id)` returns `Uint8Array` bytes from `GET /{entity}/{id}/pdf` on `invoices`,
`estimates`, `salesReceipts`, `refundReceipts`, `creditMemos`, `payments` and `purchaseOrders`,
formatted using the company's custom form styles. Other transactions have no PDF route
(QuickBooks returns 400). It uses the selected company, managed authentication,
and the same retry settings as other reads. The caller chooses where to save or serve the file.
Provider faults throw `QuickBooksApiError`; unexpected non-PDF responses reject.

## Attachments

```ts
for await (const attachment of qb.attachments.listAll({
  entity: { type: "Bill", value: "9" },
})) {
  console.log(attachment.Id, attachment.FileName, attachment.Note)
}
const metadata = await qb.attachments.get("42")
const bytes = await qb.attachments.download("42")
await Bun.write("supplier-invoice.pdf", bytes)

const uploaded = await qb.attachments.upload({
  file: Bun.file("supplier-invoice.pdf"),
  FileName: "supplier-invoice.pdf",
  ContentType: "application/pdf",
  Note: "Supplier invoice",
  AttachableRef: [{ EntityRef: { type: "Bill", value: "9" } }],
}, { requestId: "supplier-invoice-upload-42" })
```

`get`, `list`, and `listAll` return QuickBooks `Attachable` metadata, including notes and entity
references. List options are `entity`, `startPosition`, and `maxResults`, with the same pagination
bounds as other resources. Omit `entity` to list the company's attachments. Pagination is not a
snapshot; concurrent changes can affect enumeration.

`download` reads fresh metadata to obtain `TempDownloadUri`, then returns file bytes. Temporary
URLs are not cached, and file requests carry no OAuth credentials. Only HTTPS URLs without
embedded credentials are accepted; redirects reject. Note-only attachments have no downloadable
file and reject. Keep temporary URLs private because they grant temporary access to the file.

`upload` sends one Blob (including Bun files) and its metadata as multipart data to `/upload`.
`ContentType` defaults to the Blob's media type. Omit `AttachableRef` to upload an unlinked file;
set a reference's `IncludeOnSend` to include the attachment when QuickBooks sends the linked form.
QuickBooks validates supported file types, sizes, and link targets. Creating standalone notes,
editing metadata, and deleting attachments are not exposed by this resource.

Uploads are never automatically replayed, including after a 401 or transient failure. Provider
faults throw `QuickBooksApiError`, including faults inside `AttachableResponse`. An unusable
response throws `QuickBooksWriteError` with `writeRequestId`; inspect the company's attachments
before deciding how to retry an upload whose outcome is unknown.

Protocol references: [attachment API](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/attachable),
[Intuit's multipart upload example](https://www.postman.com/intuit-developer/intuit-developer-quickbooks-online-accounting-api/documentation/4884662-e6c576f1-f6d3-440f-b090-da9ff1ac519d).

## Reports

```ts
const pnl = await qb.reports.profitAndLoss({
  startDate: "2026-01-01",
  endDate: "2026-06-30",
  accountingMethod: "Cash",
  summarizeColumnBy: "Month",
})
const sheet = await qb.reports.balanceSheet({ dateMacro: "Last Fiscal Year" })
const jobs = await qb.reports.customerIncome({ startDate: "2026-01-01", customerIds: ["9"] })
const receivables = await qb.reports.agedReceivables({
  reportDate: "2026-09-23",
  agingMethod: "Report_Date",
  agingPeriod: 30,
  numPeriods: 4,
})
const invoices = await qb.reports.transactionList({
  dateMacro: "This Fiscal Year",
  transactionType: "Invoice",
  columns: ["tx_date", "txn_type", "doc_num"],
})
```

| Method | Route |
| --- | --- |
| `profitAndLoss`, `profitAndLossDetail` | `ProfitAndLoss`, `ProfitAndLossDetail` |
| `balanceSheet`, `cashFlow`, `trialBalance`, `generalLedger` | Same names |
| `transactionList`, `transactionListByCustomer`, `transactionListByVendor`, `transactionListWithSplits`, `journalReport` | Same names |
| `customerBalance`, `customerBalanceDetail`, `customerIncome`, `customerSales` | Same names |
| `vendorBalance`, `vendorBalanceDetail`, `vendorExpenses` | Same names |
| `itemSales`, `classSales`, `departmentSales`, `inventoryValuationSummary`, `accountList` | Same names |
| `agedReceivables`, `agedReceivableDetail`, `agedPayables`, `agedPayableDetail` | Same names |

Options are camelCase and map to Intuit's parameters: `startDate`/`endDate` (`start_date`/
`end_date`), `dateMacro`, `reportDate`, `accountingMethod`, `summarizeColumnBy`, `sortBy`,
`sortOrder`, `columns`, ID filters (`customerIds`, `vendorIds`, `employeeIds`, `itemIds`,
`classIds`, `departmentIds`, `accountIds`, `sourceAccountIds`, `termIds`, sent as comma lists),
`accountType`, `adjustedGainLoss`, `quickZoomUrl` (`qzurl`), aging options, and the transaction
list filters (due/modified/created date ranges and macros, `transactionType`, `docNumber`
(`docnum`), `paymentMethod`, `name`, `groupBy`, `arPaid`/`apPaid`, `cleared`, `printed`,
`bothAmount`). Each method's option type is the subset Intuit documents for that report.

QuickBooks silently ignores parameters it does not recognize, so the connector rejects any option
a report does not document, validates dates and enumerations, rejects `startDate` after
`endDate`, and rejects a date macro combined with its explicit range. Omitted options use
QuickBooks defaults; pass explicit dates and accounting method when reproducibility matters.
`columns` and `sortBy` take Intuit's column keys (for example `tx_date`, `doc_num`), which vary by
report. Invalid values that reach QuickBooks can fail with HTTP 200 and a `SystemFault`; these
are raised as `QuickBooksApiError`.

Reports preserve the provider's `Header`, `Columns`, nested `Rows`, and summaries. Amounts remain
strings and missing values remain empty strings. Empty reports can omit rows (TransactionList
returned `Rows: {}` with `NoReportData: true`). Interpret columns using their metadata (`ColKey`)
instead of hardcoding positions or titles, and do not assume a stable row order. These are report
snapshots, not paginated entity lists. TaxSummary, AccountListDetail and region-specific reports
(BAS, the FR variants) are not exposed: the US sandbox denied them (5020) or they apply to other
locales.

See [Intuit's report modernization guidance](https://medium.com/intuitdev/upcoming-changes-to-reports-apis-5083ec9aadce)
for response conventions.

## Estimates, invoices and pay links

```ts
const estimate = await qb.estimates.create({
  CustomerRef: { value: customer.Id },
  BillEmail: { Address: "customer@example.com" },
  ExpirationDate: "2026-10-31",
  Line: [{
    Amount: 2400,
    DetailType: "SalesItemLineDetail",
    SalesItemLineDetail: { ItemRef: { value: "3" }, Qty: 8, UnitPrice: 300 },
  }],
})
await qb.estimates.send(estimate.Id) // uses BillEmail
if (!estimate.SyncToken) throw new Error("Missing estimate revision")
const accepted = await qb.estimates.update({
  Id: estimate.Id,
  SyncToken: estimate.SyncToken,
  TxnStatus: "Accepted",
  AcceptedBy: "Customer name",
  AcceptedDate: "2026-09-20",
})

// Converting: link the estimate from a new invoice; QuickBooks marks it Converted.
const invoice = await qb.invoices.create({
  CustomerRef: { value: customer.Id },
  BillEmail: { Address: "customer@example.com" },
  LinkedTxn: [{ TxnId: accepted.Id, TxnType: "Estimate" }],
  Line: [{
    Amount: 2400,
    DetailType: "SalesItemLineDetail",
    SalesItemLineDetail: { ItemRef: { value: "3" }, Qty: 8, UnitPrice: 300 },
  }],
})
const payable = await qb.invoices.get(invoice.Id, { includeInvoiceLink: true })
console.log(payable.InvoiceLink)
```

- `estimates` support `get`, `list`, `listAll` (customer, document number, date and modification
  filters), `create`, sparse `update`, `delete`, `send` and `downloadPdf`. Estimates cannot be
  voided. Writable statuses are `Pending`, `Accepted`, `Closed` and `Rejected`; QuickBooks sets
  `Converted` (not documented by Intuit, observed live) when an invoice links the estimate.
- There is no status filter: QuickBooks rejects `TxnStatus` predicates (4001 "not queryable" at
  minor versions 75, 76 and 80). Filter `TxnStatus` in application code after listing.
- Line edits follow Intuit's line-ID semantics: keep `Id` on lines you change, omit it on new
  lines, and leave out lines to remove them. The invoice copies lines explicitly; QuickBooks does
  not copy them from the estimate. Deleting the invoice unlinks it so the estimate can be deleted.
- Invoice inputs accept `LinkedTxn` and `ProjectRef`. Projects themselves come from the separate
  Projects API; `ProjectRef` is deterministic-only here because the sandbox has no projects.
- `includeInvoiceLink` sends `include=invoiceLink` on `get` and `list`. Queries return
  `InvoiceLink` only with it. Reads by ID returned it for eligible invoices either way. In the
  sandbox, an invoice was eligible when it had `BillEmail`, even with online card/ACH payment
  disabled; Intuit documents online payments as a further production requirement. The sandbox
  link points at an Intuit placeholder page. Ineligible invoices omit the field.

## Write operations

| Resource | Write methods |
| --- | --- |
| `customers`, `vendors`, `employees`, `paymentMethods` | `create(input, options?)`, `update(input, options?)`, `deactivate(revision, options?)`, `reactivate(revision, options?)` |
| `classes`, `departments` | `create`, `update`, `deactivate`, `reactivate` (each requires `Name`, see below) |
| `invoices` | `create(input, options?)`, `update(input, options?)`, `delete(revision, options?)`, `void(revision, options?)`, `send(id, options?)` |
| `estimates` | `create`, `update`, `delete`, `send` |
| `salesReceipts`, `refundReceipts` | `create`, `update`, `delete`, `void`, `send` |
| `payments` | `create`, `update`, `delete`, `void`, `send(id, { sendTo, requestId? })` |
| `creditMemos` | `create`, `update`, `delete`, `send` |
| `bills`, `vendorCredits`, `purchases`, `timeActivities`, `deposits`, `transfers`, `journalEntries` | `create`, `update`, `delete` |
| `purchaseOrders` | `create`, `update`, `delete`, `send` |
| `billPayments` | `create`, `update`, `delete`, `void` |
| `accounts`, `terms` | `create`, `update`, `deactivate`, `reactivate` |
| `items` | `create`, `update`, `deactivate`, `reactivate` (type-specific restrictions below) |
| `companyInfo` | `update` (sparse, using the entity ID from `get()`) |
| `preferences` | `update` (sparse; supported groups only) |

Read-only: `customerTypes`, `taxCodes`, `taxRates`, `taxAgencies`, `taxClassifications`,
`budgets`, `companyCurrencies`, `exchangeRates`, `reimburseCharges`, `creditCardPayments`,
`inventoryAdjustments`, `recurringTransactions` and `taxPayments`. Intuit offers writes for some
of these (for example inventory adjustments and recurring templates); they are follow-ups.

```ts
const customer = await qb.customers.create({
  DisplayName: "Acme",
  PrimaryEmailAddr: { Address: "billing@acme.example" },
})
if (!customer.SyncToken) throw new Error("Missing customer revision")
await qb.customers.update({
  Id: customer.Id,
  SyncToken: customer.SyncToken,
  PrimaryPhone: { FreeFormNumber: "555-0100" },
})

const invoice = await qb.invoices.create({
  CustomerRef: { value: customer.Id },
  Line: [{
    Amount: 100,
    DetailType: "SalesItemLineDetail",
    SalesItemLineDetail: { ItemRef: { value: "3" }, Qty: 1, UnitPrice: 100 },
  }],
})
const sent = await qb.invoices.send(invoice.Id, { sendTo: "billing@acme.example" })
console.log(sent.EmailStatus, sent.DeliveryInfo)
```

- Input types expose writable fields separately from read models. Contact creation requires
  `DisplayName`; invoice creation requires `CustomerRef` and nonempty `Line`. Intuit validates
  company-specific accounting, tax, currency, and reference constraints.
- Entity `update` methods send `sparse: true`. Supply the current `Id` and `SyncToken`; omitted fields
  are preserved. The connector never reads and overwrites a revision automatically. Intuit's
  stale-object error (`5010`) is surfaced for the application to reconcile.
- Invoice line updates follow Intuit's line-ID semantics. Read the invoice first, retain IDs on
  existing lines, and supply the intended line collection. A new line has no `Id`.
- Customers/vendors are deactivated, not deleted. Activation methods send only the revision,
  `Active`, and `sparse`. Invoices can be deleted (returns `{ Id, status: "Deleted" }`) or voided
  (returns the retained invoice with zero amounts). Intuit may require unlinking transactions first.
- `send` POSTs to `/invoice/{id}/send` using `application/octet-stream`. `sendTo` is optional;
  omit it to use the invoice's `BillEmail.Address`. An explicit recipient can update that address.
  Sending returns the provider invoice, including `EmailStatus`/`DeliveryInfo`, rather than proof
  of inbox delivery. Some company preferences can also cause invoices to be emailed on creation.

### Receivables and payables

```ts
const payment = await qb.payments.create({
  CustomerRef: { value: customer.Id },
  TotalAmt: 100,
  Line: [{
    Amount: 100,
    LinkedTxn: [{ TxnId: invoice.Id, TxnType: "Invoice" }],
  }],
})
await qb.payments.send(payment.Id, { sendTo: "billing@acme.example" })

const bill = await qb.bills.create({
  VendorRef: { value: "17" },
  Line: [{
    Amount: 50,
    DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: { AccountRef: { value: "8" } },
  }],
})
await qb.billPayments.create({
  VendorRef: { value: "17" },
  TotalAmt: 50,
  PayType: "Check",
  CheckPayment: { BankAccountRef: { value: "5" } },
  Line: [{ Amount: 50, LinkedTxn: [{ TxnId: bill.Id, TxnType: "Bill" }] }],
})
```

These methods record accounting transactions; they do not initiate a bank transfer or card charge.
`payments.create` can omit `Line` to record an unapplied payment. Supplying `Line` on a Payment
update replaces **all allocations**, even with sparse updates; send `[]` to unapply them.
BillPayment inputs distinguish `CheckPayment.BankAccountRef` from
`CreditCardPayment.CCAccountRef` with the `PayType` discriminator.

Bill, VendorCredit, CreditMemo, and BillPayment updates require their party, line, and other required
creation fields along with the current revision. Retain existing line IDs when editing those lines.
Sparse updates do not remove these provider requirements. Deletes return `{ Id, status: "Deleted" }`.
Payment/BillPayment voids use `operation=update&include=void` and `sparse: true`, unlike Invoice voids.
Linked/deposited transactions can prevent deletion or voiding; Intuit's error is returned unchanged.

Credit memo sending accepts an optional `sendTo`, like invoices. Payment receipt sending requires
an explicit `sendTo`. Both use the provider's octet-stream send endpoint and the same no-retry policy.

Sales receipts record a sale paid at the time of sale (`CustomerRef` optional,
`DepositToAccountRef` for where the money went). Refund receipts require `DepositToAccountRef`
(the account the refund is paid from). Voiding differs: sales receipts void with
`operation=update&include=void`, refund receipts with `operation=void`. QuickBooks accepts
`include=void` on a refund receipt as a no-op update (HTTP 200, amounts unchanged), so the
connector does not use it there. A refund-receipt send returns `DeliveryInfo` rather than
`EmailStatus`; voiding prefixes `PrivateNote` with "Voided".

### Purchases, banking and time

- `purchases` record cash, check or card expenses (`PaymentType` with the paying `AccountRef`).
  `Credit: true` records a card credit. The payee is `EntityRef` (vendor, customer or employee).
- `purchaseOrders` take `VendorRef` and expense lines; `POStatus` is `Open` or `Closed`.
  `send` uses `POEmail` when `sendTo` is omitted.
- `deposits` take `DepositToAccountRef` and lines that either name a source account
  (`DepositLineDetail.AccountRef`, amounts may be negative) or deposit a payment held in
  Undeposited Funds (`LinkedTxn: [{ TxnId, TxnType: "Payment", TxnLineId: "0" }]`).
- `transfers` move amounts between balance-sheet accounts; `journalEntries` take Debit/Credit
  lines with `AccountRef`. QuickBooks rejects unbalanced entries (2300) and reports `TotalAmt: 0`
  for journal entries; the lines carry the amounts.
- `timeActivities` need `NameOf` with the matching `EmployeeRef` or `VendorRef`, and either
  `Hours`/`Minutes` or `StartTime`/`EndTime`. A name created moments earlier can briefly fail as a
  reference (error 2500 "Names element id not found"); the live suite waits until it is queryable.

These record bookkeeping only; none moves money.

### Fields QuickBooks requires on sparse updates

Sparse updates preserve omitted fields, but QuickBooks still requires some fields on every update
(error 2020). The input types require them and the connector checks them before sending:

| Resource | Required on update (besides `Id`/`SyncToken`) |
| --- | --- |
| `bills`, `vendorCredits` | `VendorRef`, `Line` |
| `creditMemos` | `CustomerRef`, `Line` |
| `billPayments` | `VendorRef`, `TotalAmt`, `PayType` and its payment detail, `Line` |
| `purchases` | `PaymentType` |
| `deposits` | `DepositToAccountRef` |
| `transfers` | `FromAccountRef`, `ToAccountRef`, `Amount` |
| `classes`, `departments` | `Name` (activation methods take `{ Id, SyncToken, Name }`) |
| `terms` | `DueDays` or `DayOfMonthDue` |
| `items` (activation) | `Type` |

Estimates, invoices, sales and refund receipts, payments, purchase orders, time activities,
journal entries, customers, vendors, employees, payment methods and accounts accepted sparse
updates without additional fields in the sandbox.

### Reference data and company settings

- Accounts require a name and account type or subtype. Provider account rules govern edits and activation.
- Employees require `DisplayName`, `GivenName` or `FamilyName`; QuickBooks enforces unique display
  names across people. Payment method `Type` is `CREDIT_CARD` or `NON_CREDIT_CARD`. Classes and
  departments (Locations in the UI) accept `SubClass`/`SubDepartment` with `ParentRef`.
  Deactivated employees, classes, departments and payment methods remain in QuickBooks.
- Item creation supports `Service`, `NonInventory`, `Inventory`, and `Category`. Inventory inputs
  require income/expense/asset accounts, quantity tracking, quantity, and an inventory start date.
  Quantity adjustments require `InvStartDate` (the adjustment date) even on sparse updates.
  Activation methods require the item `Type`; Categories cannot be deactivated through this API.
  Bundles (`Group`) remain readable; bundle writes are not exposed.
- Terms support day-count or date-driven due rules. Type is provider-derived; supply `DueDays` or
  `DayOfMonthDue` on both creation and edits. Activation methods only need the revision.
  Deactivated reference records remain in QuickBooks.
- CompanyInfo updates use the **CompanyInfo entity ID** from `get()`, not the OAuth realm ID.
- Preferences updates are sparse. Send only the supported groups you intend to edit; do not send
  the entire read response. `SalesFormsPrefs` and `OtherPrefs` writes are excluded: live Intuit
  testing found that a sales-form edit cleared `DefaultCustomerMessage` even with `sparse: true`,
  while attempts to restore that field returned error 2010. The remaining input groups are
  email messages, product/services, reports, accounting, vendors/purchases, and time tracking.
  Availability still depends on company locale and subscription. Provider validation faults can
  arrive with HTTP 200; these are still raised as `QuickBooksApiError`.

### Write retries and recovery

Every write sends an Intuit `requestid`. Pass `{ requestId: "persisted-operation-key" }` (1–50
characters) to retain control of recovery, or let the connector generate a UUID for that call.
Persist the key and exact operation/payload before sending when recovery is required. Reuse a key
only for that same operation and payload in the same company, according to Intuit's deduplication
contract; a new key represents a new request. See [Intuit's request-ID contract](https://help.developer.intuit.com/s/article/What-is-RequestId-and-its-usage).

Writes have **no automatic retries**, including `401` replay and custom REST retry policies.
Managed tokens are still acquired before each request. Provider failures retain the normal
`QuickBooksApiError` details and add `writeRequestId` (distinct from the `intuit_tid` trace ID).
Lost or unusable responses throw `QuickBooksWriteError` with `writeRequestId` and `cause`.
An error does not establish that the write failed: reconcile an ambiguous outcome before retrying,
especially invoice sends. No new request ID is silently generated for a retry.

## API baseline

| Setting | Contract |
| --- | --- |
| API | QuickBooks Online Accounting v3 |
| Minor version | Explicit `minorversion=75` on accounting requests |
| Production | `https://quickbooks.api.intuit.com` |
| Sandbox | `https://sandbox-quickbooks.api.intuit.com` |
| Company base path | `/v3/company/{realmId}` |
| OAuth scope | `com.intuit.quickbooks.accounting` |
| Data format | JSON; preserve QuickBooks field names and numeric monetary amounts |

Intuit retired minor versions 1–74 and treats them as 75. Version 75 is the initial contract
baseline, not a claim that it is the latest available minor version.
See [Intuit's migration announcement](https://medium.com/intuitdev/changes-to-our-accounting-api-that-may-impact-your-application-c330bd1a06f5).

## Read transactions

```ts
const invoice = await qb.invoices.get("42")
const estimate = await qb.estimates.get("77")
const receipt = await qb.salesReceipts.get("51")

for await (const invoice of qb.invoices.listAll({
  customerIds: ["9"],
  txnDateFrom: "2026-09-01",
  txnDateTo: "2026-09-30",
  maxResults: 100,
  orderBy: { field: "TxnDate", direction: "ASC" },
})) {
  console.log(invoice.Id, invoice.TotalAmt, invoice.Balance, invoice.DueDate)
  for (const line of invoice.Line ?? []) {
    if (line.DetailType === "SalesItemLineDetail") {
      console.log(line.SalesItemLineDetail?.ItemRef, line.SalesItemLineDetail?.Qty)
    }
  }
}

// Incremental sync by modification time.
for await (const bill of qb.bills.listAll({
  updatedSince: checkpoint,
  orderBy: { field: "MetaData.LastUpdatedTime" },
})) {
  console.log(bill.Id, bill.MetaData?.LastUpdatedTime)
}
```

Every transaction resource exposes `get`, `list`, and `listAll` with this query subset:

| Option | Contract |
| --- | --- |
| `ids` | Nonempty string ID array, serialized as `Id IN (...)` |
| `txnDateFrom`, `txnDateTo` | Inclusive `TxnDate` bounds; valid `YYYY-MM-DD` dates |
| `docNumber` | Exact `DocNumber` |
| `customerIds` / `vendorIds` | `CustomerRef IN (...)` / `VendorRef IN (...)` where supported (below) |
| `updatedSince` | `Date`; `MetaData.LastUpdatedTime >=` bound (boundary caveat below) |
| `orderBy` | `Id`, `TxnDate` or `MetaData.LastUpdatedTime`, with `ASC`/`DESC`; default `Id ASC` |
| `startPosition`, `maxResults` | Same one-based pagination and bounds as reference resources |

Support differs by entity because QuickBooks rejects predicates on properties it does not index
(4001 "not found"/"not queryable"); unsupported options reject locally instead:

| Resources | Party filter | Not supported |
| --- | --- | --- |
| `estimates`, `invoices`, `salesReceipts`, `refundReceipts`, `payments`, `creditMemos` | `customerIds` | |
| `bills`, `billPayments`, `vendorCredits`, `purchaseOrders` | `vendorIds` | |
| `timeActivities` | `customerIds` | `docNumber` |
| `reimburseCharges` | `customerIds` | `txnDateFrom`/`txnDateTo`, `docNumber`, `TxnDate` sort |
| `purchases` | none (`EntityRef` is not queryable) | |
| `deposits`, `transfers`, `journalEntries`, `creditCardPayments`, `inventoryAdjustments` | none | |
| `recurringTransactions` | none; `type` filters the template entity | dates, `docNumber`, `TxnDate` sort |
| `taxPayments` | none | dates, `docNumber`; US companies reject the entity (5030) |

`invoices` also accept `includeInvoiceLink`. Transaction queries have no `Active` predicate. Date
bounds refer to the transaction's accounting date, not its due date or last modification time.
No sandbox payment carried a `DocNumber`, so that positive case is unexercised for payments.

`updatedSince` (on name lists and transactions) sends `MetaData.LastUpdatedTime >=`. QuickBooks
never returned older records and always returned newer ones, but it can drop records displayed
at exactly the bound second: in the sandbox two system accounts at the bound were excluded while
the oldest invoice was included. Displayed timestamps have one-second precision. Start each
incremental read a few seconds before the last checkpoint and deduplicate by ID. QuickBooks'
other timestamp comparisons were unreliable (`<=` returned nothing, `=` matched everything), so
no upper bound is exposed. CDC remains the source for deletions.

- Invoices, estimates, receipts and credit memos retain sales-item, discount, subtotal,
  description and group lines.
- Bills, vendor credits, purchases and purchase orders retain account-based and item-based
  expense lines; deposits and journal entries retain their own line details.
- Payments retain every `Line.LinkedTxn` allocation and `UnappliedAmt`, including empty allocations.
- Bill payments retain linked bills/credits and `CheckPayment`/`CreditCardPayment` account details.
- `recurringTransactions` return QuickBooks' wrapper, e.g. `{ Bill: { Id, RecurringInfo, ... } }`.
  The template's `Id` is the recurring transaction ID; it differs from `RecurDataRef` values on
  generated transactions.
- References, returned custom fields, tax details, balances, currency and exchange-rate values
  pass through without recalculation. An absent balance remains absent; zero remains zero.

Accounting `Payment`/`BillPayment` records describe bookkeeping activity. This connector does not
process money through the separate QuickBooks Payments API. Current balances and linked transactions
also do not reconstruct historical aging on their own; use provider aging reports for reconciliation.
See [Intuit's linked-transaction workflow](https://developer.intuit.com/app/developer/qbo/docs/workflows/manage-linked-transactions).

## Configuration

Each Sixb deployment supplies its own Intuit app credentials. Sixb manages authorization and
rotating tokens; the selected connection binds the client to one company.

| Option | Behavior |
| --- | --- |
| `clientId`, `clientSecret` | Required Intuit application credentials |
| `environment` | Required `sandbox` or `production`; use matching Intuit credentials |
| `minorVersion` | Defaults to 75; integer >= 75, newer versions require caller verification |
| `timeoutMs` | Optional per-attempt timeout |
| `minDelayMs` | Optional spacing between request starts |
| `retry` | Shared REST retry policy; defaults to two retries and honors provider throttling |
| `webhooks` | Optional `{ verifierToken, onEvent, idempotencyKey? }`; registers the `events` webhook |

The accounting scope is fixed for this initial connector. The callback `realmId` is verified
through authenticated CompanyInfo before becoming a selected account. OAuth uses the framework's
callback context and explicitly disables PKCE for this provider flow.

## Change data capture

```ts
const changes = await qb.cdc.get({
  entities: ["Customer", "Invoice", "Payment"],
  changedSince: new Date("2026-09-15T12:00:00Z"), // checkpoint within the last 30 days
})

for (const batch of changes.CDCResponse) {
  for (const group of batch.QueryResponse) {
    for (const invoice of group.Invoice ?? []) {
      if (invoice.status === "Deleted") {
        // Apply the deletion by company + entity type + invoice.Id.
      } else {
        console.log(invoice.Id, invoice.Balance)
      }
    }
  }
}
```

`cdc.get` supports the 34 entity names QuickBooks accepted in the sandbox: Account, Attachable,
Budget, Class, CompanyCurrency, Customer, CustomerType, Department, Employee, Item,
PaymentMethod, TaxCode, TaxRate, Term, Vendor, Bill, BillPayment, CreditCardPayment, CreditMemo,
Deposit, Estimate, InventoryAdjustment, Invoice, JournalEntry, Payment, Purchase, PurchaseOrder,
RecurringTransaction, RefundReceipt, ReimburseCharge, SalesReceipt, TimeActivity, Transfer and
VendorCredit. Excluded: TaxAgency and TaxClassification (QuickBooks fails the request with 4001),
TaxPayment (5030 in US companies), Exchangerate (returns up to 1,000 Id-less rate rows), and
CompanyInfo/Preferences (read directly). It preserves Intuit's `CDCResponse` / `QueryResponse`
groups, metadata, timestamps, full records and `status: "Deleted"` tombstones.
RecurringTransaction changes keep their template wrapper, including deletions
(`{ Bill: { Id, status: "Deleted" } }`). Selection must be nonempty and unique; `changedSince`
must be a valid `Date` within the last 30 days.

Intuit caps CDC at 1,000 objects across the request. At that threshold—or when count metadata
indicates it—the connector throws `QuickBooksCdcLimitError`. Its `response` contains the potentially
partial payload for inspection. **Do not advance the checkpoint on this error.** Split a multi-entity
request into individual entities, keeping the original checkpoint. If an individual entity still
hits the cap, use a complete import/reconciliation. Moving `changedSince` forward merely to get
under the cap can skip older changes; CDC has no upper-bound parameter for paging time windows.

Suggested application sync sequence:

```text
1. Record import start time; enumerate all resources (active: "all" for name lists).
2. Apply CDC from that start time to catch concurrent edits/deletions.
3. Use notifications to schedule targeted refreshes; run periodic CDC for missed notifications.
4. Commit each checkpoint only after all corresponding records are durably applied.
5. Base the next checkpoint on request start time with an overlap, not the latest event seen.
6. On an expired window or cap hit, perform complete reconciliation before resuming incremental sync.
```

Workers should tolerate duplicates and out-of-order delivery. For full reconciliation, account for
records that have disappeared as well as those returned; CDC cannot supply deletions older than its
look-back window. CompanyInfo and Preferences can be refreshed periodically using their reads.

Periodically reconcile name-list resources with `active: "all"` as well. In controlled sandbox
testing, a customer's deactivation appeared immediately in direct reads and inactive queries but
was absent from subsequent CDC responses, including a raw 29-day request about two minutes later.
Customer creation/updates and transaction deletion markers were observed. Do not rely solely on
CDC to discover inactive customers; this observation does not establish a delivery-time guarantee.
In a subsequent live webhook test, customer deactivation generated a `qbo.customer.updated.v1`
notification; a current-state read confirmed `Active: false`.

## Webhooks

Enable **CloudEvents** payload format in Intuit and configure the `events` route shown by Sixb.
Supply the verifier token for the matching sandbox/production webhook configuration:

```ts
import { defineConnector } from "@sixb/core"
import { quickbooks } from "@sixb/connector-quickbooks"
import { enqueueQuickBooksDelivery } from "../jobs/quickbooks" // your durable queue adapter

export const quickbooksConnector = defineConnector("quickbooks", quickbooks({
  clientId: process.env.INTUIT_CLIENT_ID!,
  clientSecret: process.env.INTUIT_CLIENT_SECRET!,
  environment: "sandbox",
  webhooks: {
    verifierToken: process.env.INTUIT_WEBHOOK_VERIFIER_TOKEN!,
    async onEvent({ body, connections }) {
      // The whole array is available; account lookup and iteration are application decisions.
      for (const realmId of new Set(body.map(event => event.intuitaccountid))) {
        for (const target of await connections.forAccount(realmId)) {
          await enqueueQuickBooksDelivery({
            connectionId: target.connection.id,
            events: body.filter(event => event.intuitaccountid === realmId),
          })
        }
      }
    },
  },
}))
```

`enqueueQuickBooksDelivery` above is application-owned and must durably accept work before resolving.
The handler also has the ordinary `request`, `rawBody`, `sixb`, and `logger` context.
Each selected target exposes `.connection` metadata and lazy `.client()` for typed reads when needed.
An unknown or disconnected realm yields no targets. Storage/handler failures propagate.

The helper verifies HMAC-SHA256 over the original bytes using `intuit-signature`, then parses the
CloudEvents array. It preserves event types, data, extensions, and order; it does not split events
or resolve clients automatically. Event types follow `qbo.<entity>.<operation>.v1` for every
entity, so new entities such as estimates (`qbo.estimate.created.v1`) need no parser changes;
estimate events are covered by deterministic tests, not a live delivery. `quickbooksEventsWebhook(options)` is also exported for direct
use as an ordinary `WebhookDefinition`.

Intuit requires **HTTP 200 within three seconds**. A handler returning nothing gets 200 only after
it finishes. Keep the handler's work short; there is no automatic background acceptance or hidden
queue. Return an ordinary webhook response to customize status, headers, or body. Failed or timed-out
acknowledgements can be retried, and notifications can be duplicated, delayed, or out of order.

No delivery deduplication key is fabricated. CloudEvent `id` identifies an event, not necessarily a
whole HTTP delivery. The optional `idempotencyKey` uses the existing request-level Sixb resolver;
provide it only with a stable application delivery identity. Workers can deduplicate individual
events using company/source/event identity while still applying recovery imports and CDC idempotently.

Protocol references: [Intuit CloudEvents sample](https://github.com/IntuitDeveloper/SampleApp-Webhooks-Java-Cloudevents),
[acknowledgement guidance](https://help.developer.intuit.com/s/question/0D5TR00000zOyHd0AK/webhook),
and [webhook guide](https://developer.intuit.com/app/developer/qbo/docs/develop/webhooks).

## Resource contracts

All paths below are relative to `/v3/company/{realmId}`. `list` and `listAll` use
`GET /query?query=SELECT ... FROM {Entity} STARTPOSITION ... MAXRESULTS ...`.
Query positions are one-based; the maximum page size is 1,000.

| Resource | Read path | Query entity | Intuit reference |
| --- | --- | --- | --- |
| `companyInfo` | `/companyinfo/{realmId}` | — | [CompanyInfo](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/companyinfo) |
| `preferences` | `/preferences` | — | [Preferences](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/preferences) |
| `customers` | `/customer/{id}` | `Customer` | [Customer](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/customer) |
| `vendors` | `/vendor/{id}` | `Vendor` | [Vendor](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/vendor) |
| `accounts` | `/account/{id}` | `Account` | [Account](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account) |
| `items` | `/item/{id}` | `Item` | [Item](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/item) |
| `terms` | `/term/{id}` | `Term` | [Term](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/term) |
| `invoices` | `/invoice/{id}` | `Invoice` | [Invoice](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice) |
| `payments` | `/payment/{id}` | `Payment` | [Payment](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/payment) |
| `creditMemos` | `/creditmemo/{id}` | `CreditMemo` | [CreditMemo](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/creditmemo) |
| `bills` | `/bill/{id}` | `Bill` | [Bill](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill) |
| `billPayments` | `/billpayment/{id}` | `BillPayment` | [BillPayment](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/billpayment) |
| `vendorCredits` | `/vendorcredit/{id}` | `VendorCredit` | [VendorCredit](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/vendorcredit) |
| `estimates` | `/estimate/{id}` | `Estimate` | [Estimate](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/estimate) |
| `salesReceipts` | `/salesreceipt/{id}` | `SalesReceipt` | [SalesReceipt](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/salesreceipt) |
| `refundReceipts` | `/refundreceipt/{id}` | `RefundReceipt` | [RefundReceipt](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/refundreceipt) |
| `purchases` | `/purchase/{id}` | `Purchase` | [Purchase](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/purchase) |
| `purchaseOrders` | `/purchaseorder/{id}` | `PurchaseOrder` | [PurchaseOrder](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/purchaseorder) |
| `timeActivities` | `/timeactivity/{id}` | `TimeActivity` | [TimeActivity](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/timeactivity) |
| `deposits` | `/deposit/{id}` | `Deposit` | [Deposit](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/deposit) |
| `transfers` | `/transfer/{id}` | `Transfer` | [Transfer](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/transfer) |
| `journalEntries` | `/journalentry/{id}` | `JournalEntry` | [JournalEntry](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/journalentry) |
| `creditCardPayments` | `/creditcardpayment/{id}` | `CreditCardPayment` | [CreditCardPayment](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/creditcardpayment) |
| `inventoryAdjustments` | `/inventoryadjustment/{id}` | `InventoryAdjustment` | [InventoryAdjustment](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/inventoryadjustment) |
| `reimburseCharges` | `/reimbursecharge/{id}` | `ReimburseCharge` | [ReimburseCharge](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/reimbursecharge) |
| `recurringTransactions` | `/recurringtransaction/{id}` | `RecurringTransaction` | [RecurringTransaction](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/recurringtransaction) |
| `taxPayments` | `/taxpayment/{id}` | `TaxPayment` | [TaxPayment](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/taxpayment) |
| `employees` | `/employee/{id}` | `Employee` | [Employee](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/employee) |
| `classes` | `/class/{id}` | `Class` | [Class](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/class) |
| `departments` | `/department/{id}` | `Department` | [Department](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/department) |
| `customerTypes` | `/customertype/{id}` | `CustomerType` | [CustomerType](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/customertype) |
| `paymentMethods` | `/paymentmethod/{id}` | `PaymentMethod` | [PaymentMethod](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/paymentmethod) |
| `taxCodes` | `/taxcode/{id}` | `TaxCode` | [TaxCode](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/taxcode) |
| `taxRates` | `/taxrate/{id}` | `TaxRate` | [TaxRate](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/taxrate) |
| `taxAgencies` | `/taxagency/{id}` | `TaxAgency` | [TaxAgency](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/taxagency) |
| `taxClassifications` | `/taxclassification/{id}` | `TaxClassification` (unpaged) | [TaxClassification](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/taxclassification) |
| `budgets` | `/budget/{id}` | `Budget` | [Budget](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/budget) |
| `companyCurrencies` | `/companycurrency/{id}` | `CompanyCurrency` | [CompanyCurrency](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/companycurrency) |
| `exchangeRates` | `/exchangerate?sourcecurrencycode=..&asofdate=..` | `Exchangerate` (array `ExchangeRate`) | [Exchangerate](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/exchangerate) |

Single reads return an entity-named envelope; query responses contain a `QueryResponse` envelope
with an entity-named array and pagination metadata. Empty query responses can omit that array.
The client unwraps reads and exposes typed pages plus async iterators.

Supported filters and sorting are entity-specific. Name-list queries default to active records;
inactive records require explicit selection. IDs are scoped by company and entity type.
Preserve `Line`, `LinkedTxn`, currency references, optional custom fields, and provider metadata.

- [Query operations](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries)
- [CDC](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/changedatacapture):
  `GET /cdc?entities=...&changedSince=...`; supported entities only, 30-day look-back and 1,000-object cap.
- [Webhooks](https://developer.intuit.com/app/developer/qbo/docs/develop/webhooks):
  verify the raw body using `intuit-signature`; handlers receive the complete payload.

OAuth protocol references: [Intuit discovery document](https://developer.api.intuit.com/.well-known/openid_configuration/)
and [official OAuth client](https://github.com/intuit/oauth-jsclient/blob/master/src/OAuthClient.js).

Additional schema/query references: [Intuit query deep dive](https://medium.com/intuitdev/deep-dive-into-quickbooks-online-data-queries-b77034bdc144),
[Customer schema](https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/master/src/Data/IPPCustomer.php),
and [Term field definitions](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippphpdevkitv3/entities/files/IPPTerm.html).
## Scope and verification

See [tests/README.md](tests/README.md) in the repository for deterministic integration coverage and
opt-in sandbox commands. `bun run test:e2e` skips live tests unless `QUICKBOOKS_LIVE` selects a mode.

Writes cover the operations listed above. Follow-ups: writes for the read-only entities Intuit
can also write (inventory adjustments, recurring templates, tax agencies, TaxService, company
currencies, exchange-rate overrides, budgets), attachment metadata writes/deletion, bundle
writes, the Entitlements endpoint (outside the company path), exact decimal-string amounts,
batch operations, and the separate Payments, Payroll and Projects APIs. JournalCode and the
FR/AU reports are region-specific and not exposed.
Tax, inventory, multicurrency, and custom-field
availability depend on the company's locale, subscription, and preferences; returned values are
preserved without inventing defaults or deriving accounting totals.

Tests use synthetic, partial wire examples and mocked provider traffic. They cover OAuth, token
invalidation, paths, queries, pagination, transaction variants, CDC limits, and webhook signatures.
The `accounting-writes` live mode and the extended `read` mode cover the resources, filters,
writes, CDC entities and reports added with estimates; see [tests/README.md](tests/README.md)
for what ran and what the provider rejected.
Live sandbox checks passed for OAuth code exchange, authenticated company discovery, CompanyInfo,
Preferences, the 24-hour CDC request, token refresh, and a read with the refreshed token.
A subsequent full enumeration covered 241 records across all eleven list resources, compared
7-record iterator pages with manual 100-record pages, and read every returned record individually.
Checks covered all returned IDs in filter batches, every distinct name, active/inactive selection,
name/date sorting, inclusive date boundaries and combined filters. Account ID ordering has the
provider limitation described above; follow-up Account queries returned the same 90 records with
ID/name ordering in both directions at page sizes 7, 13, and 100. Supported linked transactions
were resolved, including `BillPaymentCheck` links to BillPayment records.

Controlled sandbox tests then created disposable Customer, Invoice, Bill and VendorCredit records.
Customer creation/updates and transaction creation/updates/deletions were verified through reads
and CDC; transaction ID/date filters and deletion query absence also passed. This covered the
previously empty VendorCredit resource. Customer deactivation passed direct reads and active/inactive
filters, with the CDC caveat above. Test transactions were deleted and test customers left inactive.
Those initial writes used a local test harness. The maintained `writes` E2E mode exercises the
public customer/vendor lifecycle and invoice create/update/send/void/delete methods.
That mode passed in the sandbox on 2026-09-16: create deduplication, stale-revision rejection,
contact activation cycles, both invoice send variants, and void/delete cleanup (23 assertions).
Sending used a reserved example address and verified Intuit's response, not mailbox delivery.
The maintained `remaining-writes` suite subsequently passed all three tests (72 assertions):
receivable/payable lifecycles, account/item/term maintenance including zero-cost inventory quantity
adjustments, and company-name/report-basis updates with restoration. Payment allocations, check and
card bill payments, payment receipts and both credit-memo send variants were exercised. The final
suite deleted transactions, deactivated reference records, restored quantity to zero and compared
the complete preference settings before/after restoration. Category writes remain deterministic-only.
Live Intuit webhook tests through an ngrok HTTPS endpoint received 12 signed CloudEvents deliveries:
customer creation/updates (including deactivation), plus invoice, bill and vendor-credit
creation/updates/deletions. The connector verifier and parser accepted each complete payload,
and event realm/entity IDs matched the authorized sandbox and test records. The local listener
persisted each payload before HTTP 200, with measured local processing times of 1–6 ms. Public
unsigned and wrong-signature probes returned 401. These checks used a standalone listener;
the full managed Sixb OAuth/webhook dispatch and connection lookup flow, provider retries,
and CDC cap/recovery under load still need separate live verification.

The coverage added with estimates was verified in the sandbox on 2026-11-08: exhaustive reads
of all 33 paged resources (420 records) with every new filter, irregular reads, all 27 report
methods with parameter-effect checks, every PDF route, and the `accounting-writes` lifecycles
for every new write method, each confirmed through CDC. Empty sandbox datasets (customer types,
budgets, company currencies, vendor credits, transfers, card payments) and US-unavailable tax
payments remain deterministic-only, as do `ProjectRef`, estimate webhooks and the CDC entities
no test changed (Attachable, Budget, CompanyCurrency, CustomerType, TaxCode, TaxRate,
ReimburseCharge, CreditCardPayment, InventoryAdjustment), which QuickBooks accepted with empty
results.
