# @sixb/connector-quickbooks

QuickBooks Online Accounting API connector for Sixb: managed OAuth, typed reads of every
queryable US Accounting entity, writes for the entities applications commonly change, form
sending and PDFs, query filters for incremental and per-party syncs, change data capture,
verified CloudEvents webhooks, file attachments and the standard accounting reports.

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

| Option | Behavior |
| --- | --- |
| `clientId`, `clientSecret` | Required Intuit application credentials |
| `environment` | Required `sandbox` or `production`; use matching Intuit credentials |
| `minorVersion` | Defaults to 75; integer >= 75, newer versions require caller verification |
| `timeoutMs` | Optional per-attempt timeout |
| `minDelayMs` | Optional spacing between request starts |
| `retry` | Shared REST retry policy; defaults to two retries and honors provider throttling |
| `webhooks` | Optional `{ verifierToken, onEvent, idempotencyKey? }`; registers the `events` webhook |

The accounting scope is fixed. OAuth uses the framework's callback context and explicitly
disables PKCE for this provider flow.

## Resources

| Area | Resources |
| --- | --- |
| Company | `companyInfo`, `preferences` |
| Name lists | `customers`, `vendors`, `employees`, `accounts`, `items`, `terms`, `classes`, `departments`, `customerTypes`, `paymentMethods`, `budgets`, `companyCurrencies` |
| Tax and currency | `taxCodes`, `taxRates`, `taxAgencies`, `taxClassifications`, `taxPayments`, `exchangeRates` |
| Sales | `estimates`, `invoices`, `salesReceipts`, `refundReceipts`, `payments`, `creditMemos` |
| Purchases | `bills`, `billPayments`, `vendorCredits`, `purchases`, `purchaseOrders` |
| Banking, time and other | `deposits`, `transfers`, `journalEntries`, `creditCardPayments`, `timeActivities`, `inventoryAdjustments`, `reimburseCharges`, `recurringTransactions` |
| Sync, files and reports | `cdc`, `attachments`, `reports` |

Entity resources have `get(id)`, `list(options)` and `listAll(options)`; `exchangeRates.get`
takes `{ sourceCurrencyCode, asOfDate? }` because rates have no ID. Records keep their
provider shape and field names (addresses, references, lines, linked transactions, custom
fields, tax detail, currencies); optional data varies by locale, product and company settings,
and missing fields are not filled in. Monetary amounts are JSON numbers.

## Read and query

```ts
const customer = await qb.customers.get("42")

for await (const invoice of qb.invoices.listAll({
  customerIds: ["9"],
  txnDateFrom: "2026-09-01",
  txnDateTo: "2026-09-30",
  orderBy: { field: "TxnDate", direction: "ASC" },
})) {
  console.log(invoice.Id, invoice.TotalAmt, invoice.Balance)
}
```

`list` returns `{ items, startPosition?, maxResults?, totalCount?, time? }` with QuickBooks'
metadata; totals are never synthesized. `listAll` fetches lazily, advances by the returned count,
and stops on a short or empty page. Invalid envelopes, unexpected positions and repeated pages
reject instead of silently ending a sync. Unknown options reject before any request.

### Name lists

| Option | Contract |
| --- | --- |
| `startPosition`, `maxResults` | One-based position (default 1); 1–1,000 per page (default 100) |
| `active` | `true` (default), `false`, or `"all"` |
| `ids` | Nonempty ID array, `Id IN (...)` |
| `name` | Exact `DisplayName` (customers, vendors, employees) or `Name` (the others) |
| `updatedSince` | `Date`; `MetaData.LastUpdatedTime >=` |
| `orderBy` | `Id` (default) or the name field, `ASC`/`DESC` |

### Transactions

| Option | Contract |
| --- | --- |
| `startPosition`, `maxResults`, `ids`, `updatedSince` | As for name lists |
| `txnDateFrom`, `txnDateTo` | Inclusive `TxnDate` bounds, `YYYY-MM-DD` |
| `docNumber` | Exact `DocNumber` |
| `customerIds` | `CustomerRef IN (...)`: estimates, invoices, sales and refund receipts, payments, credit memos, time activities, reimburse charges |
| `vendorIds` | `VendorRef IN (...)`: bills, bill payments, vendor credits, purchase orders |
| `orderBy` | `Id` (default) or `TxnDate`, `ASC`/`DESC` |

Transaction queries have no Active predicate. Date bounds use the accounting date, not the due
date or modification time.

### Incremental reads

Read changes with `updatedSince` and the default `Id` order, starting a few seconds before the
last checkpoint and deduplicating by ID: QuickBooks can omit records stamped exactly at the bound
second. Timestamp sorting is not offered because offset pages over it skip records that are
updated mid-sync. Offset pagination is never a snapshot, so deletions can still shift pages; use
CDC for windows within 30 days and periodic full reconciliation beyond that.

### Provider quirks

| Resource | Behavior and workaround |
| --- | --- |
| `accounts` | `ORDERBY Id` returns a nonmonotonic order; sort by `Name` when order matters |
| `taxAgencies` | No Active flag, so no `active` option; `name` matches the display name |
| `companyCurrencies` | Exists only with multicurrency; no `name` filter, select by ID |
| `taxCodes` | US pseudo-codes `TAX`, `NON` and `CustomSalesTax` can't be read by ID and are never listed; reference them by value in `TaxCodeRef` |
| `taxClassifications` | QuickBooks ignores paging, so `list({ ids?, name?, level?, parentId? })` returns every match in one response |
| `exchangeRates` | No entity ID: `get({ sourceCurrencyCode, asOfDate? })`; `list` takes paging and `updatedSince` only |
| `payments` | No DocNumber; filter by `paymentRefNum` instead |
| `transfers`, `creditCardPayments` | QuickBooks does not store DocNumber, so there is no `docNumber` filter |
| `purchases` | The payee (`EntityRef`) is not queryable, so there is no party filter |
| `timeActivities` | No `docNumber` filter |
| `reimburseCharges` | No date or `docNumber` filters |
| `creditCardPayments` | The wire entity is `CreditCardPaymentTxn` (path `creditcardpayment`) |
| `recurringTransactions` | Records are wrapped as `{ Bill: { Id, RecurringInfo, ... } }`; the template `Id` identifies them; filter with `type` |
| `taxPayments` | Unavailable in US companies (error 5030) |
| `estimates` | `TxnStatus` is not queryable; filter statuses after listing |

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

// Link the estimate from a new invoice; QuickBooks marks the estimate Converted.
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
const { InvoiceLink } = await qb.invoices.get(invoice.Id)
```

- Writable estimate statuses are `Pending`, `Accepted`, `Closed` and `Rejected`. QuickBooks sets
  `Converted` itself when an invoice links the estimate. Estimates cannot be voided; delete them.
  Deleting the linked invoice unlinks the estimate.
- The invoice carries its own lines; QuickBooks does not copy them from the estimate.
- Invoice inputs also accept `ProjectRef`, for projects created through Intuit's Projects API.
- `InvoiceLink` is the customer-facing pay link. Reads by ID return it for eligible invoices;
  queries return it only with `list({ includeInvoiceLink: true })`. Intuit returns it for
  invoices with a customer email and online payment enabled.

## Write operations

| Resource | Write methods |
| --- | --- |
| `customers`, `vendors`, `employees`, `paymentMethods`, `classes`, `departments`, `accounts`, `terms`, `items` | `create`, `update`, `deactivate`, `reactivate` |
| `estimates`, `creditMemos` | `create`, `update`, `delete`, `send` |
| `invoices`, `salesReceipts`, `refundReceipts`, `payments` | `create`, `update`, `delete`, `void`, `send` |
| `purchaseOrders` | `create`, `update`, `delete`, `send` |
| `billPayments` | `create`, `update`, `delete`, `void` |
| `bills`, `vendorCredits`, `purchases`, `timeActivities`, `deposits`, `transfers`, `journalEntries` | `create`, `update`, `delete` |
| `companyInfo`, `preferences` | `update` |

The other resources are read-only. These methods record bookkeeping; none moves money.

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
```

- Input types expose writable fields separately from read models, and required creation fields
  are checked before sending. QuickBooks validates company-specific accounting, tax, currency and
  reference rules.
- `update` sends `sparse: true` with the caller's `Id` and `SyncToken`; omitted fields are kept.
  The connector never reads and overwrites a revision; a stale revision fails with `5010`.
- Line edits follow Intuit's line-ID semantics: keep `Id` on lines you change, omit it on new
  lines, and leave out lines to remove them.
- `delete` returns `{ Id, status: "Deleted" }`. Linked or deposited transactions can block
  deletes and voids; QuickBooks' error is returned unchanged.
- Name lists are deactivated, not deleted, and deactivated records stay in QuickBooks.
- `send(id, { sendTo? })` POSTs to `/{entity}/{id}/send`. Without `sendTo` QuickBooks uses the
  stored `BillEmail` (`POEmail` on purchase orders); payment receipts require `sendTo`. The
  response reports `EmailStatus` (refund receipts: `DeliveryInfo`), not inbox delivery.

### Fields QuickBooks requires on every update

Sparse updates still fail with error 2020 without these fields; the input types require them.

| Resource | Required besides `Id` and `SyncToken` |
| --- | --- |
| `bills`, `vendorCredits` | `VendorRef`, `Line` |
| `creditMemos` | `CustomerRef`, `Line` |
| `billPayments` | `VendorRef`, `TotalAmt`, `PayType` with its payment detail, `Line` |
| `purchases` | `PaymentType` |
| `deposits` | `DepositToAccountRef` |
| `transfers` | `FromAccountRef`, `ToAccountRef`, `Amount` |
| `classes`, `departments` | `Name`, including in `deactivate`/`reactivate` |
| `terms` | `DueDays` or `DayOfMonthDue` |
| `items` | `Type` in `deactivate`/`reactivate` |

### Resource notes

- **Voids:** invoices and refund receipts use `operation=void`; payments, bill payments and sales
  receipts use `operation=update&include=void`. QuickBooks accepts `include=void` on a refund
  receipt as a no-op update, so the routes are not interchangeable.
- **Payments:** omit `Line` to record an unapplied payment. Supplying `Line` on an update replaces
  all allocations; send `[]` to unapply them.
- **Bill payments:** `PayType` selects `CheckPayment.BankAccountRef` or
  `CreditCardPayment.CCAccountRef`.
- **Receipts:** a sales receipt can omit `CustomerRef`. Refund receipts require
  `DepositToAccountRef` (the account the refund is paid from); they keep billing, shipping and
  ship-from addresses but take no ship method, ship date or tracking number, which QuickBooks
  drops.
- **Purchases:** `PaymentType` is `Cash`, `Check` or `CreditCard`, paid from `AccountRef`; the
  payee is `EntityRef`; `Credit: true` records a card credit.
- **Purchase orders:** `POStatus` is `Open` or `Closed`.
- **Deposits:** lines name a source account (`DepositLineDetail.AccountRef`, amounts may be
  negative) or deposit a payment held in Undeposited Funds
  (`LinkedTxn: [{ TxnId, TxnType: "Payment", TxnLineId: "0" }]`).
- **Journal entries:** Debit/Credit lines with `AccountRef`. QuickBooks rejects unbalanced entries
  (2300) and reports `TotalAmt: 0`; the lines carry the amounts.
- **Time activities:** `NameOf` with the matching `EmployeeRef` or `VendorRef`, plus `Hours`/`Minutes`
  or `StartTime`/`EndTime`. Changing the worker on update requires `NameOf`.
- **Employees** require `GivenName` and `FamilyName`. **Payment methods** have `Type`
  `CREDIT_CARD` or `NON_CREDIT_CARD`. **Classes** and **departments** accept `SubClass`/
  `SubDepartment` with `ParentRef`.
- **Accounts** require a name and an account type or subtype.
- **Items:** `Service`, `NonInventory`, `Inventory` and `Category` are writable. Inventory needs
  income, expense and asset accounts, quantity tracking, `QtyOnHand` and `InvStartDate`;
  quantity adjustments need `InvStartDate`. Categories cannot be deactivated; bundles are
  read-only.
- **Terms:** supply `DueDays` or `DayOfMonthDue` on creation and edits.
- **CompanyInfo:** use the CompanyInfo entity ID from `get()`, not the realm ID.
- **Preferences:** send only the groups you change. `SalesFormsPrefs` and `OtherPrefs` are
  read-only here: QuickBooks can clear sales-form settings on a partial edit and refuse to restore
  them. Provider faults can arrive with HTTP 200 and are raised as `QuickBooksApiError`.

### Retries and recovery

Every write sends an Intuit `requestid`. Pass `{ requestId: "persisted-operation-key" }` (1–50
characters) to control recovery, or let the connector generate a UUID per call. Persist the key and
exact payload before sending when recovery matters, and reuse a key only for that same operation and
payload; see [Intuit's request-ID contract](https://help.developer.intuit.com/s/article/What-is-RequestId-and-its-usage).

Writes are **never retried automatically**, including on `401` and under custom REST retry
policies. Provider failures throw `QuickBooksApiError` with `writeRequestId`; lost or unusable
responses throw `QuickBooksWriteError` with `writeRequestId` and `cause`. An error does not prove
the write failed: reconcile before retrying, especially sends.

Reads retry transient failures (two retries by default, honoring `Retry-After`) and replay once
after a `401` with a fresh token. OAuth exchange and refresh are never replayed. Accounting
failures throw `QuickBooksApiError` with `status`, `requestId` (`intuit_tid`), `faultType` and
provider `errors`.

## Reports

```ts
const pnl = await qb.reports.profitAndLoss({
  dateMacro: "This Calendar Year",
  accountingMethod: "Cash",
  summarizeColumnBy: "Month",
})
const receivables = await qb.reports.agedReceivables({ reportDate: "2026-09-23", numPeriods: 4 })
const invoices = await qb.reports.transactionList({
  startDate: "2026-01-01",
  endDate: "2026-06-30",
  transactionType: "Invoice",
  columns: ["tx_date", "txn_type", "doc_num"],
})
```

One method per report: `agedReceivables`, `agedReceivableDetail`, `agedPayables`,
`agedPayableDetail`, `profitAndLoss`, `profitAndLossDetail`, `balanceSheet`, `cashFlow`,
`trialBalance`, `generalLedger`, `transactionList`, `transactionListByCustomer`,
`transactionListByVendor`, `transactionListWithSplits`, `journal`, `customerBalance`,
`customerBalanceDetail`, `customerIncome`, `customerSales`, `itemSales`, `vendorBalance`,
`vendorBalanceDetail`, `vendorExpenses`, `accountList`, `classSales`, `departmentSales`,
`inventoryValuationSummary` and `inventoryValuationDetail`. Each calls `GET /reports/{Name}`.

Options are camelCase and map to Intuit's parameters, for example `startDate` to `start_date`,
`customerIds` to a comma-separated `customer`, and `quickZoomUrl` to `qzurl`. Each method accepts
every option Intuit documents for that report, except documented options QuickBooks ignored live:
`quickZoomUrl` outside `agedReceivables`, `profitAndLoss` and `balanceSheet`, `customerIds` on
`agedPayables`, and explicit create-date ranges on the transaction lists. Two undocumented options
are also accepted: `agingPeriod`/`numPeriods` on the aging summaries, which QuickBooks honors, and
`agingMethod` on `agedPayableDetail`, kept for compatibility although QuickBooks ignores it.
Enumerations follow Intuit's per-report values; `groupBy` is narrower on
`transactionListWithSplits` and `inventoryValuationDetail`. Option types are named
`QuickBooks<Report>ReportOptions`, except `QuickBooksReceivableAgingOptions` and
`QuickBooksPayableAgingOptions` for the aging summaries.

QuickBooks silently ignores parameters it does not recognize, so anything else rejects locally, as
do invalid dates and enumerations, a start after its end, and a date macro combined with its
explicit range. `columns` and `sortBy` take
Intuit's column keys (such as `tx_date`), which vary by report. Invalid values that reach
QuickBooks can fail with HTTP 200 and a `SystemFault`, raised as `QuickBooksApiError`.

Reports keep the provider's `Header`, `Columns`, nested `Rows` and summaries. Amounts stay
strings and empty values stay empty strings; empty reports can omit rows. Read columns by their
`ColKey` metadata rather than position, and don't assume a stable row order. TaxSummary and
regional reports (BAS and the French variants) are not exposed.

## PDFs

```ts
const pdf = await qb.estimates.downloadPdf("77")
await Bun.write("estimate.pdf", pdf)
```

`downloadPdf(id)` on `invoices`, `estimates`, `salesReceipts`, `refundReceipts`, `creditMemos`,
`payments` and `purchaseOrders` returns `Uint8Array` bytes from `GET /{entity}/{id}/pdf`, using the
company's form styles. Faults throw `QuickBooksApiError`; a non-PDF response rejects.

## Attachments

```ts
for await (const attachment of qb.attachments.listAll({
  entity: { type: "Bill", value: "9" },
})) {
  console.log(attachment.Id, attachment.FileName, attachment.Note)
}
const bytes = await qb.attachments.download("42")

const uploaded = await qb.attachments.upload({
  file: Bun.file("supplier-invoice.pdf"),
  FileName: "supplier-invoice.pdf",
  ContentType: "application/pdf",
  AttachableRef: [{ EntityRef: { type: "Bill", value: "9" } }],
}, { requestId: "supplier-invoice-upload-42" })
```

`get`, `list` and `listAll` return `Attachable` metadata; list options are `entity`,
`startPosition` and `maxResults`. `download` reads fresh metadata for `TempDownloadUri` and fetches
the bytes without OAuth credentials; only HTTPS URLs without embedded credentials are accepted,
redirects reject, and note-only attachments have no file. Keep temporary URLs private.

`upload` sends one Blob and its metadata as multipart data to `/upload`. `ContentType` defaults to
the Blob's type; set `IncludeOnSend` on a reference to attach the file when the form is sent.
Uploads are never replayed. Faults inside `AttachableResponse` throw `QuickBooksApiError`; unusable
responses throw `QuickBooksWriteError` with `writeRequestId`. Editing metadata, standalone notes
and deletion are not exposed.

## Change data capture

```ts
const changes = await qb.cdc.get({
  entities: ["Customer", "Estimate", "Invoice"],
  changedSince: new Date("2026-09-15T12:00:00Z"), // within the last 30 days
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

`cdc.get` accepts Account, Attachable, Budget, Bill, BillPayment, Class, CompanyCurrency,
CreditCardPaymentTxn, CreditMemo, Customer, CustomerType, Department, Deposit, Employee,
Estimate, InventoryAdjustment, Invoice, Item, JournalEntry, Payment, PaymentMethod, Purchase,
PurchaseOrder, RecurringTransaction, RefundReceipt, ReimburseCharge, SalesReceipt, TaxCode,
TaxRate, Term, TimeActivity, Transfer, Vendor and VendorCredit. TaxAgency and TaxClassification
CDC requests fail at QuickBooks, TaxPayment is unavailable in US companies, exchange rates have no
IDs, and CompanyInfo and Preferences are read directly. Responses keep Intuit's groups, records
and `status: "Deleted"` tombstones; recurring changes keep their template wrapper, including
deletions. Selection must be nonempty and unique, and `changedSince` within the last 30 days.

QuickBooks caps CDC at 1,000 objects per request. At the cap the connector throws
`QuickBooksCdcLimitError`, whose `response` holds the partial payload. **Do not advance the
checkpoint on this error**: split the request by entity, and fall back to a full import if one
entity still hits the cap.

```text
1. Record the import start time; enumerate all resources (active: "all" for name lists).
2. Apply CDC from that start time to catch concurrent edits and deletions.
3. Use webhooks to schedule targeted refreshes; run periodic CDC for missed notifications.
4. Commit each checkpoint only after its records are durably applied.
5. Base the next checkpoint on the request start time with an overlap.
6. After an expired window or a cap hit, reconcile fully before resuming.
```

Workers should tolerate duplicates and out-of-order changes. CDC can omit name-list
deactivations, so reconcile name lists with `active: "all"` periodically.

## Webhooks

Enable the **CloudEvents** payload format in Intuit and configure the `events` route shown by
Sixb with the matching verifier token:

```ts
export const quickbooksConnector = defineConnector("quickbooks", quickbooks({
  clientId: process.env.INTUIT_CLIENT_ID!,
  clientSecret: process.env.INTUIT_CLIENT_SECRET!,
  environment: "sandbox",
  webhooks: {
    verifierToken: process.env.INTUIT_WEBHOOK_VERIFIER_TOKEN!,
    async onEvent({ body, connections }) {
      for (const realmId of new Set(body.map(event => event.intuitaccountid))) {
        for (const target of await connections.forAccount(realmId)) {
          await enqueueQuickBooksDelivery({ // application-owned durable queue
            connectionId: target.connection.id,
            events: body.filter(event => event.intuitaccountid === realmId),
          })
        }
      }
    },
  },
}))
```

The helper verifies HMAC-SHA256 over the original bytes using `intuit-signature`, then parses the
CloudEvents array, preserving event types (`qbo.<entity>.<operation>.v1`), data, extensions and
order. The handler also receives `request`, `rawBody`, `sixb` and `logger`; each target exposes
`.connection` and a lazy `.client()`. `quickbooksEventsWebhook(options)` is exported for direct
use as a `WebhookDefinition`.

Intuit requires **HTTP 200 within three seconds**. A handler returning nothing gets 200 when it
finishes, so accept work durably and return quickly. Deliveries can be retried, duplicated,
delayed or out of order, and no delivery key is fabricated: pass `idempotencyKey` only with a
stable application delivery identity.

## API baseline

| Setting | Contract |
| --- | --- |
| API | QuickBooks Online Accounting v3, `minorversion=75` on every request |
| Production | `https://quickbooks.api.intuit.com` |
| Sandbox | `https://sandbox-quickbooks.api.intuit.com` |
| Company base path | `/v3/company/{realmId}` |
| OAuth scope | `com.intuit.quickbooks.accounting` |

Intuit treats retired minor versions 1–74 as 75; 75 is this connector's baseline, not the latest
version. Entity reference: `https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/{entity}`.
Queries use `GET /query?query=SELECT * FROM {Entity} ...` with one-based positions and at most
1,000 results per page. Each resource reads `GET /{entity}/{id}` with the lowercased entity name,
except `exchangeRates` (`GET /exchangerate?sourcecurrencycode=..&asofdate=..`) and
`creditCardPayments`, whose envelope is `CreditCardPaymentTxn`.

## Scope and verification

[tests/README.md](tests/README.md) describes the deterministic tests, the opt-in sandbox suites,
and what they verified, including the provider behavior behind the quirks above.

Not covered: writes for read-only entities Intuit can also write (inventory adjustments,
recurring templates, tax agencies, TaxService tax codes, currencies, exchange-rate overrides,
budgets), attachment metadata edits and deletion, bundle writes, exact decimal-string amounts,
batch operations, the Entitlements endpoint, and the separate Payments, Payroll and Projects APIs.
