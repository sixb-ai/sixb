# Querying Data

Read your domain model in React with `useObjectsQuery`. Build a query with
`objects(Type).query()` and pass it to the hook to get typed results, loading state, and errors.

Define ontology types imported by your app with the browser-safe `@sixb/core/ontology` entrypoint.
Sixb configures the client and query provider for apps automatically.

## Display objects

This page lists invoices from an existing `Invoice` object type. Each result has a `primaryId` and
`properties` inferred from that type.

File: `app/invoices/page.tsx`

```tsx
import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Invoice } from "../../ontology/invoice"

export default function InvoicesPage() {
  const invoices = useObjectsQuery(objects(Invoice).query().limit(50))

  if (invoices.isPending) return <p>Loading invoices...</p>
  if (invoices.isError) return <p role="alert">{invoices.error.message}</p>
  if (invoices.data.objects.length === 0) return <p>No invoices found.</p>

  return (
    <ul>
      {invoices.data.objects.map((invoice) => (
        <li key={invoice.primaryId}>
          {invoice.properties.number}: {invoice.properties.status}
        </li>
      ))}
    </ul>
  )
}
```

## Filter results

Import `useState` from `react`, then replace the query inside your component with a filter driven
by state. Changing the state updates the results.

```tsx
const [onlyUnpaid, setOnlyUnpaid] = useState(false)
const allInvoices = objects(Invoice).query()
const invoices = useObjectsQuery(
  (onlyUnpaid
    ? allInvoices.where((invoice) => invoice.p.status.in(["sent", "overdue"]))
    : allInvoices
  ).limit(50)
)
```

Add a control above the results. Keep it visible when no invoices match the filter:

```tsx
<label>
  <input
    type="checkbox"
    checked={onlyUnpaid}
    onChange={(event) => setOnlyUnpaid(event.target.checked)}
  />
  Only unpaid invoices
</label>
```

Queries use the same [filters, sorting, and relationships](../objects/querying.md) as backend code.
Properties used for filtering, sorting, or search need the corresponding
[query metadata](../ontology/properties.md#enable-queries).

## Load more results

Use `useObjectsInfinite` to fetch results in pages. It manages the page tokens; combine the rows
from `data.pages` and call `fetchNextPage` when the user asks for more.

File: `app/invoices/page.tsx`

```tsx
import { useObjectsInfinite } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Invoice } from "../../ontology/invoice"

export default function InvoicesPage() {
  const invoices = useObjectsInfinite(objects(Invoice).query(), { pageSize: 25 })

  if (invoices.isPending) return <p>Loading invoices...</p>
  if (invoices.isError) return <p role="alert">{invoices.error.message}</p>

  const rows = invoices.data.pages.flatMap((page) => page.objects)
  if (rows.length === 0) return <p>No invoices found.</p>

  return (
    <>
      <ul>
        {rows.map((invoice) => (
          <li key={invoice.primaryId}>{invoice.properties.number}</li>
        ))}
      </ul>
      {invoices.hasNextPage && (
        <button
          type="button"
          disabled={invoices.isFetchingNextPage}
          onClick={() => invoices.fetchNextPage()}
        >
          {invoices.isFetchingNextPage ? "Loading..." : "Load more"}
        </button>
      )}
    </>
  )
}
```

For counts, grouped results, and hook options, see the [hook reference](../client/typed-queries.md#react-hooks).
To refresh data after a user changes it, see [Running actions](actions.md#refresh-data). For updates
from other users or background processes, see [Client events](../client/events.md).
