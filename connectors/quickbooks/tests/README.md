# QuickBooks verification

`bun test connectors/quickbooks/tests/` runs deterministic unit tests with synthetic fixtures.
Keep fixtures anonymized and representative; do not replace fault, token rotation, pagination or
signature tests with live dependencies. The CompanyInfo fixture deliberately has entity ID `1`
and a different realm ID, matching the provider contract discovered in the sandbox.

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

The recorded local verification in the package README describes additional live CDC, transaction,
and webhook experiments. It is evidence of that run, not a guarantee about every company or locale.

On 2026-09-16 all maintained modes were explicitly executed successfully: exhaustive reads
(245 records, 747 assertions), mutations with cleanup (24 assertions), and replay of a freshly
captured Intuit payload with its original signature (2 assertions). Each mode ran separately;
the other two modes intentionally skipped in each invocation.
