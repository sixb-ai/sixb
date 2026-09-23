# QuickBooks verification

`bun test connectors/quickbooks/tests/` runs deterministic unit tests with synthetic fixtures.
Keep fixtures anonymized and representative; do not replace fault, token rotation, pagination or
signature tests with live dependencies. The CompanyInfo fixture deliberately has entity ID `1`
and a different realm ID, matching the provider contract discovered in the sandbox.

`invoice-pdf.test.ts` and `attachments-reports.test.ts` cover binary PDF preservation, attachment
queries and pagination, multipart uploads and nested faults, upload non-replay, credential-free
temporary URL downloads, and the four aging report routes with nested/empty report responses.
These use synthetic provider responses; PDFs, attachments, and aging reports have not yet been
verified against a live sandbox. Regression-removal instructions are beside the relevant tests.

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

Read mode samples up to five records per resource. Exhaustive mode enumerates all records, reads
every ID, verifies ID-filter batches, exact names, active selection, date bounds and compares two page sizes (bounded to 10,000 records and
15 minutes). Keep the sandbox unchanged while comparing results. Empty datasets report unexercised
positive cases. Provider ordering is preserved: Account Id ordering is not reliably monotonic.

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
