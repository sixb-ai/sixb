# Contract fixtures

These are synthetic, deliberately partial examples of documented QuickBooks response envelopes,
not captured sandbox responses or evidence of live API verification.

- `customer-query.json`: entity-named array, provider fields, numeric balance, and pagination metadata.
- `empty-query.json`: an empty query can omit both the entity array and pagination metadata.
- `transactions.ts`: typed synthetic samples for all six transaction resources, including partial
  payments, multi-transaction allocations, credit links, expense lines, and currency metadata.

Sources: [Customer](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/customer)
and [queries](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries).

Add fuller resource fixtures with their contract tests, including line variants, linked payments,
Fault responses, CDC deletions, and verified webhook payloads.
