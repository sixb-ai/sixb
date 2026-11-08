# QuickBooks verification

`bun test connectors/quickbooks/tests/` runs deterministic unit tests with synthetic fixtures.
Keep fixtures anonymized and representative; do not replace fault, token rotation, pagination or
signature tests with live dependencies. The CompanyInfo fixture deliberately has entity ID `1`
and a different realm ID, matching the provider contract discovered in the sandbox.

`invoice-pdf.test.ts` and `attachments-reports.test.ts` cover binary PDF preservation, attachment
queries and pagination, multipart uploads and nested faults, upload non-replay, credential-free
temporary URL downloads, and the four aging report routes with nested/empty report responses.
Attachments remain unverified against a live sandbox; PDFs and reports are covered by the live
modes below. Regression-removal instructions are beside the relevant tests.

The coverage added with estimates has one deterministic file per area: `query-filters`
(modification, document number and party predicates), `estimates`, `invoice-links`,
`reference-reads` (tax data, exchange rates, budgets, currencies), `reference-writes` (employees,
classes, departments, payment methods), `receipts`, `purchases`, `banking` (time activities,
deposits, transfers, journal entries), `transaction-reads` (read-only transactions and recurring
wrappers), `reports` (every report's documented parameters) and the extended `cdc` and
`webhooks` files. Each file covers wire paths, query serialization, pagination, envelope
parsing, HTTP and HTTP-200 faults, write request IDs without replay, and local input
validation. Constraints discovered live are guarded locally; the guards for refund-receipt voids,
recurring CDC wrappers, Purchase `PaymentType`, Transfer accounts and report allowlists were each
removed and their tests observed failing before restoration.

`packages/server/tests/quickbooks-webhooks.test.ts` exercises the real QuickBooks adapter through
Sixb HTTP dispatch, signature verification, selected-account lookup, lazy clients and encrypted
credential refresh. Intuit HTTP responses are mocked. Generic OAuth authorization/selection and
storage failure cases remain in the core/server OAuth suites.

## Optional sandbox E2E

Run from the repository root (Bun loads the specified private environment file):

```sh
QUICKBOOKS_LIVE=read bun --env-file=.env.test test ./connectors/quickbooks/tests/sandbox.e2e.ts
QUICKBOOKS_LIVE=read QUICKBOOKS_EXHAUSTIVE=1 bun --env-file=.env.test test ./connectors/quickbooks/tests/sandbox.e2e.ts
```

Required variables: `CLIENT_ID`, `CLIENT_SECRET`, `QUICKBOOKS_REALM_ID`, and
`QUICKBOOKS_ACCESS_TOKEN`. Use a fresh access token from authorization of a **sandbox** company.
The keys alone cannot authorize company access. The suite fixes the API host to sandbox, does not
refresh or persist credentials, and fails explicitly if an enabled mode lacks configuration.
Without `QUICKBOOKS_LIVE`, all live tests skip, including in repository-wide E2E jobs.

Read mode samples up to five records per resource across every paged list resource. Exhaustive
mode enumerates all records, reads every ID, verifies ID-filter batches, exact names, active
selection, date bounds, document numbers, customer/vendor filters (up to ten parties each, plus a
multi-party filter), `updatedSince` bounds with timestamp ordering, and compares two page sizes
(bounded to 10,000 records and 15 minutes). Keep the sandbox unchanged while comparing results.
Empty datasets report unexercised positive cases. Provider ordering is preserved: Account Id and
timestamp ordering are not reliably monotonic. Read mode also runs two shorter tests: irregular
reads (invoice pay links, unpaged tax classifications, exchange rates by key and page, recurring
templates by type, and every PDF route on an existing record) and report contracts (every report
method, plus checks that dates, accounting basis, column summaries, customer/vendor/account
filters, transaction types, column selection and aging periods change the provider's output).

Mutation mode is an independent opt-in:

```sh
QUICKBOOKS_LIVE=mutate QUICKBOOKS_JOURNAL=.local/qb-run-unique.json bun --env-file=.env.test test ./connectors/quickbooks/tests/sandbox.e2e.ts
```

The journal must not already exist. Tests label disposable records, retain their IDs, and attempt
cleanup in `finally`. It creates/updates a Customer, Invoice, Bill and VendorCredit, checks
transaction CDC updates/deletions, deletes transactions and deactivates the customer. Inactive
customers remain in QuickBooks. If a run fails or is interrupted,
inspect the journal and reconcile the labelled records before starting another run. Network-lost
writes are not automatically retried. Never commit credentials, journals, or raw provider captures.

Webhook replay mode validates a captured provider signature against **original raw bytes**:

```sh
QUICKBOOKS_LIVE=webhook bun --env-file=.env.test test ./connectors/quickbooks/tests/sandbox.e2e.ts
```

Set `WEBHOOK_VERIFIER_TOKEN`, `QUICKBOOKS_WEBHOOK_BODY` (raw-body file path), and
`QUICKBOOKS_WEBHOOK_SIGNATURE` (file containing the original `intuit-signature` header).
Do not reserialize JSON before verification. Replay is not a public delivery/latency test; actual
Intuit deliveries require a separately running endpoint configured in the development portal.

Public write API mode is a separate lifecycle test:

```sh
QUICKBOOKS_LIVE=writes QUICKBOOKS_JOURNAL=.local/qb-writes-unique.json bun --env-file=.env.test test ./connectors/quickbooks/tests/sandbox.e2e.ts
```

It creates a disposable customer and vendor, updates and deactivates/reactivates both, verifies
request-ID create deduplication and a stale customer revision, and creates/updates/sends/voids/deletes
an invoice. It exercises both explicit-recipient and stored-BillEmail sending. The default recipient
is the reserved `sixb-invoice-test@example.com`; set `QUICKBOOKS_SEND_TO` to a mailbox you control
for manual inbox verification. API success checks `EmailStatus`/`DeliveryInfo`, not inbox receipt.
Cleanup attempts each resource independently, deletes the invoice, and leaves both contacts inactive.
The exclusive journal records request IDs before operations and returned entity IDs for recovery;
inspect it after any interruption. This mode uses only public connector methods for writes.

Remaining resource writes have a separate suite:

```sh
QUICKBOOKS_LIVE=remaining-writes QUICKBOOKS_JOURNAL=.local/qb-final-unique bun --env-file=.env.test test ./connectors/quickbooks/tests/remaining-writes.e2e.ts
```

It runs three bounded tests:
- Receivables/payables: payment application/unapplication and receipts, credit memo update/send,
  bill and vendor-credit updates, check and card bill payments, voids and deletions.
- Reference maintenance: an account; service, non-inventory and inventory items; day-count and
  date-driven terms. Exercises updates, activation and cleanup. Inventory adjustments use zero cost
  and return quantity to zero. Category wire contracts are deterministic-only because the provider
  does not expose category deactivation; the live suite does not leave a permanent test category.
- Company settings: temporarily changes the company name and report basis, then restores them.
  Preference updates send only the report basis with `sparse: true`; the test compares all preference
  settings after restoration. Original settings and request IDs are journalled before mutation so
  an interrupted run can be reconciled. Sales-form preference writes are excluded after live
  testing exposed provider-side clearing of the default customer message.

The journal prefix produces `.transactions.json`, `.references.json`, and `.settings.json` files;
none may already exist. Cleanup executes in reverse dependency order and attempts every registered
cleanup even if another fails. Transactions are deleted; reference records remain inactive.
Run against an otherwise idle sandbox. `QUICKBOOKS_SEND_TO` has the same meaning as in `writes` mode;
successful API receipt sending does not establish inbox delivery.

Coverage added with estimates has its own journaled suite:

```sh
QUICKBOOKS_LIVE=accounting-writes QUICKBOOKS_JOURNAL=.local/qb-accounting-unique bun --env-file=.env.test test ./connectors/quickbooks/tests/accounting-writes.e2e.ts
```

It runs six bounded tests with separate journals (`.estimates.json`, `.references.json`,
`.receipts.json`, `.purchases.json`, `.time.json`, `.banking.json`; none may already exist):
- Estimates: create; customer, document number and modification filters; sparse acceptance;
  a line edit that keeps one line ID and adds a line; explicit and stored-BillEmail sends; PDF;
  conversion to an invoice through `LinkedTxn`; `includeInvoiceLink` on get and list; Closed and
  Rejected statuses; CDC update and deletion markers.
- References: employee, class, department and payment method create, update, name filter,
  deactivate and reactivate.
- Receipts: sales and refund receipt create, customer filter, sparse update, send, PDF, void and
  delete.
- Purchases: cash, check and card purchases with a DocNumber filter; purchase order create,
  vendor filter, sparse close, explicit and stored-POEmail sends, PDF and delete.
- Time: time activities by duration and by start/end time for a new employee and customer.
- Banking: a direct deposit, a deposit of an undeposited payment through `LinkedTxn`, a
  transfer, a journal entry with a line edit, and an unbalanced entry QuickBooks must reject.

Every test checks multi-entity CDC for each entity it writes. Cleanup runs LIFO and attempts every
step; transactions are deleted, and the customers, vendors, employees, classes, departments and
payment methods it creates remain inactive. Sends use `QUICKBOOKS_SEND_TO` or the reserved
`sixb-invoice-test@example.com`.

The recorded local verification in the package README describes additional live CDC, transaction,
and webhook experiments. It is evidence of that run, not a guarantee about every company or locale.

On 2026-09-16 the initial three modes were explicitly executed successfully: exhaustive reads
(245 records, 747 assertions), mutations with cleanup (24 assertions), and replay of a freshly
captured Intuit payload with its original signature (2 assertions). Each mode ran separately;
the other two modes intentionally skipped in each invocation.

The public `writes` mode subsequently passed against the sandbox (23 assertions, ~13 seconds),
including both send variants. The journal confirmed invoice deletion and both contacts inactive.
Deterministic coverage includes the hard no-retry gate under custom policies, HTTP/transport
failures, malformed responses, payload validation and provider wire contracts. Removing the gate
was verified to fail the regression test by observing three POSTs instead of one.

The final `remaining-writes` suite passed on 2026-09-17 UTC (three tests, 72 assertions, ~54 seconds).
All final-suite cleanup markers were complete. Earlier diagnostic runs exposed an inventory income
account subtype requirement, a required due-date rule on term edits, HTTP 200 preference faults,
and the sales-form preference limitation documented in the package README. The Term and Preferences
guards were each removed temporarily and the regression test failed before they were restored.

On 2026-11-08 the coverage added with estimates ran against the sandbox company at minor
version 75. Exhaustive read mode passed (420 records across the 33 paged resources, 1,919
assertions, ~400 seconds); customer types, budgets, company currencies, vendor credits, transfers
and card payments were empty, and DocNumber was unexercised for payments, bills, deposits and
journal entries. The irregular-read and report tests passed (99 assertions: 31 linked invoices,
2,106 tax classifications, 150 exchange rates, 2 recurring templates, 7 PDF routes, 27 report
methods). The final `accounting-writes` run passed all six tests (131 assertions, ~74 seconds)
with every cleanup step complete. The existing `writes` (23 assertions) and `remaining-writes`
(72 assertions) modes were rerun as regression checks and passed.

Provider behaviour found during those runs, and how the connector handles it:
- Estimate `TxnStatus` is not queryable (4001 at minor versions 75, 76 and 80): no status filter.
- Linking an invoice sets the estimate's `TxnStatus` to `Converted`, a value Intuit does not
  document: added to the read type, rejected as a write value.
- `GET /invoice/{id}` returned `InvoiceLink` for eligible invoices without `include`; queries
  needed `include=invoiceLink`. Eligibility in the sandbox required `BillEmail` only.
- Sparse updates still required `Name` on Class and Department, `PaymentType` on Purchase,
  `DepositToAccountRef` on Deposit, and both accounts plus `Amount` on Transfer (2020): the
  input types require them and they are checked before sending. An early run's class cleanup
  failed on this before the fix; the leftover test class was deactivated by hand.
- `refundreceipt?operation=update&include=void` returned HTTP 200 without voiding; refund
  receipts use `operation=void`. Refund receipt sends return `DeliveryInfo`, not `EmailStatus`.
- Journal entries report `TotalAmt: 0`; an unbalanced entry fails with 2300.
- A time activity referencing a customer created moments earlier failed once with 2500 ("Names
  element id not found") and passed when the test waited until the name was queryable.
- `updatedSince` dropped system accounts displayed at exactly the bound second while including
  records at the bound elsewhere; `<=` and `=` timestamp predicates were unreliable. Account
  `ORDERBY MetaData.LastUpdatedTime` was nonmonotonic.
- Probes outside the suites, each on one labelled record deleted immediately afterwards: a
  recurring bill template (to capture CDC wrapper shapes), and a purchase, deposit, transfer,
  journal entry and refund receipt (to find required update fields and the void route).
