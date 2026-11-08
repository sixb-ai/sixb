# QuickBooks verification

## Deterministic tests

`bun test connectors/quickbooks/tests/` runs unit tests against synthetic, anonymized fixtures and
mocked provider traffic. Keep them that way: fault, token rotation, pagination and signature tests
must not depend on a live company. The CompanyInfo fixture deliberately has entity ID `1` and a
different realm ID, matching the provider contract.

Each area has one file: OAuth and transport (`oauth-http`), name lists and queries (`resources`,
`query-filters`, `reference-reads`), transactions (`transactions`, `transaction-reads`), each write
area (`writes`, `remaining-writes`, `estimates`, `invoice-links`, `reference-writes`, `receipts`,
`purchases`, `banking`), PDFs and attachments (`invoice-pdf`, `attachments-reports`), `reports`,
`cdc` and `webhooks`. Together they cover wire paths, query serialization, pagination, envelope
parsing, HTTP and HTTP-200 faults, write request IDs without replay, and local validation. Guards
for provider constraints found live say beside them how to reproduce their removal proof.

`packages/server/tests/quickbooks-webhooks.test.ts` exercises the real adapter through Sixb HTTP
dispatch, signature verification, selected-account lookup, lazy clients and encrypted credential
refresh, with Intuit responses mocked.

## Sandbox suites

Run from the repository root with a private environment file:

```sh
QUICKBOOKS_LIVE=read bun --env-file=.env.test test ./connectors/quickbooks/tests/sandbox.e2e.ts
QUICKBOOKS_LIVE=read QUICKBOOKS_EXHAUSTIVE=1 bun --env-file=.env.test test ./connectors/quickbooks/tests/sandbox.e2e.ts
QUICKBOOKS_LIVE=mutate QUICKBOOKS_JOURNAL=.local/qb-run-unique.json bun --env-file=.env.test test ./connectors/quickbooks/tests/sandbox.e2e.ts
QUICKBOOKS_LIVE=webhook bun --env-file=.env.test test ./connectors/quickbooks/tests/sandbox.e2e.ts
QUICKBOOKS_LIVE=writes QUICKBOOKS_JOURNAL=.local/qb-writes-unique.json bun --env-file=.env.test test ./connectors/quickbooks/tests/sandbox.e2e.ts
QUICKBOOKS_LIVE=remaining-writes QUICKBOOKS_JOURNAL=.local/qb-final-unique bun --env-file=.env.test test ./connectors/quickbooks/tests/remaining-writes.e2e.ts
QUICKBOOKS_LIVE=accounting-writes QUICKBOOKS_JOURNAL=.local/qb-accounting-unique bun --env-file=.env.test test ./connectors/quickbooks/tests/accounting-writes.e2e.ts
```

Required variables: `CLIENT_ID`, `CLIENT_SECRET`, `QUICKBOOKS_REALM_ID` and a fresh
`QUICKBOOKS_ACCESS_TOKEN` from authorizing a **sandbox** company. The suites fix the host to
sandbox, never refresh or persist credentials, and fail if an enabled mode lacks configuration.
Without `QUICKBOOKS_LIVE` every live test skips, including in repository-wide E2E jobs.

| Mode | What it does |
| --- | --- |
| `read` | Samples up to five records from every paged resource and reads each by ID; sends every supported predicate (including `ids`) and sort once even when a dataset is empty; runs CDC over every accepted entity; reads invoice pay links, tax classifications, exchange rates, recurring templates and every PDF route; runs every report and checks that options change the output where the sandbox has data (the options it can only show are accepted are listed below) |
| `read` + `QUICKBOOKS_EXHAUSTIVE=1` | Also enumerates every record (bounded to 10,000 and 15 minutes), checks ID batches, names, active selection, date bounds, document and reference numbers, customer/vendor filters and `updatedSince`, and compares two page sizes. Keep the sandbox unchanged while it runs |
| `mutate` | Raw-request customer, invoice, bill and vendor-credit lifecycle with CDC checks |
| `webhook` | Replays a captured delivery: set `WEBHOOK_VERIFIER_TOKEN`, `QUICKBOOKS_WEBHOOK_BODY` (raw-body file) and `QUICKBOOKS_WEBHOOK_SIGNATURE` (original header file); never reserialize the JSON |
| `writes` | Customer and vendor lifecycle, request-ID deduplication, a stale revision, and invoice create/update/send/void/delete |
| `remaining-writes` | Payments, credit memos, bills, vendor credits and bill payments; accounts, items and terms; company name and report-basis changes with restoration |
| `accounting-writes` | Estimates through conversion to a linked invoice; employees, classes, departments and payment methods; sales and refund receipts; purchases and purchase orders; time activities; deposits, transfers and journal entries; CDC for every entity written |

Write modes need `QUICKBOOKS_JOURNAL`; the journal (or each `.<test>.json` file for the multi-test
suites) must not exist yet. Tests label records, journal request IDs before each write and returned
IDs after, and run cleanup LIFO in `finally`, attempting every step. Transactions are deleted;
customers, vendors, employees, classes, departments, payment methods, accounts, items and terms
remain inactive because QuickBooks cannot delete them. After an interrupted run, inspect the
journal and reconcile the labelled records before the next run. Writes are never retried. Sends go
to `QUICKBOOKS_SEND_TO` or the reserved `sixb-invoice-test@example.com`, and success means
QuickBooks reported the send, not that a mailbox received it. Never commit credentials, journals or
raw captures; keep them under `.local/`.

### Seed for full coverage

The sandbox lacked data for some positive cases. To exercise them, seed: a credit-card payment, a
transfer, a vendor credit, a budget, a customer type, a recurring template other than a bill,
multicurrency with a second currency (company currencies), and bills, deposits and journal entries
with document numbers. Customer types and budgets cannot be created through the API.

## Recorded runs

- **2026-09-16:** exhaustive reads of the original eleven list resources (245 records, 747
  assertions); `mutate` (24 assertions); webhook replay of a freshly captured payload (2
  assertions); `writes` (23 assertions).
- **2026-09-17:** `remaining-writes` (3 tests, 72 assertions). Earlier diagnostic runs exposed
  the inventory income-account subtype requirement, the required due-date rule on term edits,
  HTTP-200 preference faults and the sales-form preference limitation.
- **Webhook delivery (original connector):** an HTTPS tunnel received 12 signed CloudEvents
  deliveries (customer create/update including deactivation, and invoice, bill and vendor-credit
  create/update/delete). Every payload verified and parsed; unsigned and wrong-signature probes
  got 401. The managed Sixb dispatch, provider retries and CDC cap recovery under load were not
  exercised live.
- **2026-11-08, full accounting coverage:** exhaustive reads of 33 paged resources (420
  records, 1,919 assertions); irregular reads and reports (99 assertions); `accounting-writes`
  (6 tests, 131 assertions); `writes` (23) and `remaining-writes` (72) as regression checks.
- **2026-11-08, after review:** the card-payment fix was verified through the connector on one
  labelled card payment (get, list, date filter, CDC change and tombstone, absence after
  delete). Exhaustive `read` mode, now including empty-dataset predicates, irregular reads and
  the added report checks, passed (3 tests, 2,298 assertions, 444 records, ~516 seconds), as did
  `accounting-writes` (6 tests, 131 assertions), `writes` (23) and `remaining-writes` (3 tests,
  72). Every cleanup step completed.
- **2026-11-08, after the second review:** the report options added from Intuit's per-report
  reference were checked live as described below, and read mode gained CDC over every accepted
  entity and the remaining empty-dataset predicates. Exhaustive `read` mode passed (3 tests, 2,451
  assertions, 467 records, ~550 seconds), as did `accounting-writes` (6 tests, 131 assertions),
  `writes` (23) and `remaining-writes` (3 tests, 72). Every cleanup step completed.

## Provider behavior observed

These observations back the quirks in the package README. They describe what this sandbox
returned at minor version 75, not guarantees for every company or locale.

- **Query support.** Predicates on unindexed properties fail with 4001 ("not found" or "not
  queryable"): `TxnStatus` on estimates (also at minor versions 76 and 80), `EntityRef` on
  purchases, `DocNumber` on time activities, `TxnDate` and `DocNumber` on reimburse charges.
  Creating payments, transfers and card payments with `DocNumber` did not store it, while a
  `PaymentRefNum` filter matched the payment. Exchange-rate queries accepted `SourceCurrencyCode`
  and `AsOfDate` predicates and ignored them; past `asOfDate` reads (2010, a Sunday) returned
  that exact date.
- **Paging and sorting.** TaxClassification ignored `STARTPOSITION`/`MAXRESULTS` and returned
  all 2,106 rows. Unfiltered TaxCode pages prepended `TAX`, `NON` and `CustomSalesTax` beyond
  `MAXRESULTS` and later offsets skipped codes; reading them by ID failed with 2030. Account
  `ORDERBY Id` and `ORDERBY MetaData.LastUpdatedTime` were nonmonotonic (13 inversions across 97
  accounts). `MetaData.LastUpdatedTime >=` dropped two system accounts displayed at exactly the
  bound second while including the oldest invoice; `<=` returned nothing and `=` matched
  everything.
- **Entity names.** Card payments come back as `CreditCardPaymentTxn` in reads, queries, CDC
  groups and tombstones (Intuit's XSD and SDKs name it so; the URL path is `creditcardpayment`);
  CDC accepts either entity name. Exchange-rate queries name the array `ExchangeRate`.
  Recurring templates, including CDC changes and tombstones, are wrapped under their entity name.
- **CDC.** TaxAgency and TaxClassification requests failed with 4001, TaxPayment with 5030, and
  Exchangerate returned up to 1,000 rate rows without IDs. A customer deactivation appeared in
  reads but not in CDC two minutes later, though a webhook reported it.
- **Writes.** Sparse updates still required `Name` on classes and departments, `PaymentType` on
  purchases, `DepositToAccountRef` on deposits, and both accounts plus `Amount` on transfers
  (2020). Employees needed both `GivenName` and `FamilyName`. Refund receipts kept `ShipAddr` and
  `ShipFromAddr` but dropped `ShipMethodRef`, `ShipDate` and `TrackingNum`; `include=void` on a refund receipt returned HTTP 200 without voiding, while
  `operation=void` zeroed it and prefixed `PrivateNote` with "Voided". Linking an invoice set the
  estimate to `Converted`. Journal entries reported `TotalAmt: 0`; an unbalanced entry failed
  with 2300. A customer created moments earlier briefly failed as a time-activity reference
  (2500); the suite waits until new names are queryable.
- **Invoice links.** Reads by ID returned `InvoiceLink` without `include`; queries needed
  `include=invoiceLink`. The link appeared for invoices with `BillEmail` even with online
  payments off, and pointed at an Intuit placeholder page.
- **Reports.** Unknown parameters were ignored silently and an invalid date returned HTTP 200 with
  a `SystemFault`. Every `Report.xsd` date macro and `FiscalYear`/`FiscalQuarter` summaries
  worked. Documented options with no effect are not accepted: `qzurl` outside AgedReceivables,
  ProfitAndLoss and BalanceSheet; `customer` on AgedPayables; `start_createdate`/`end_createdate`
  on the transaction lists. `aging_method` on AgedPayableDetail is undocumented and ignored (even
  an invalid value was accepted) but stays accepted for compatibility.
  - Changed the output: `shipvia` emptied AgedReceivableDetail and CustomerBalanceDetail for an
    unknown ship method; InventoryValuationDetail `group_by` regrouped it and its service-date
    range filtered it; TransactionListWithSplits `group_by` regrouped it (it rejected `Customer`
    with 6000, and accepted the undocumented `Month`; InventoryValuationDetail accepted the
    undocumented `Fiscal Year`); GeneralLedger `account_type` limited sections to that type;
    `transaction_type=Estimate` listed estimates.
  - Accepted but not positively verified, for lack of sandbox data: `custom1`–`custom3` on
    AgedReceivableDetail, AgedPayableDetail and CustomerBalanceDetail; `shipvia` and
    `accounting_method` (validated: an invalid value fails with 2170) on AgedPayableDetail;
    `source_account_type=NonPosting` (listed nothing); `journal_code` (QuickBooks looks codes up
    and fails unknown ones with 610, but US companies have none).
  - TaxSummary, AccountListDetail and BAS were denied (5020). InventoryValuationDetail always leads
    with a Product/Service column without a `ColKey`.
- **Probes outside the suites.** Each used one labelled record, deleted immediately (an employee
  was deactivated): a recurring bill template, a purchase, a deposit, two transfers, two journal
  entries, three refund receipts, a payment, two card payments and one employee. One early run's
  class cleanup failed on the `Name` requirement; that class was deactivated by hand.
