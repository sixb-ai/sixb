# Organizing Your Project

Sixb discovers definitions recursively within its convention directories. Inside those directories,
you can organize files to suit your project.

This guide shows an approach we use in our own projects, with examples of how the structure can
evolve as the codebase grows. Adopt the parts that help your team; filenames and intermediate
directories are yours to choose.

## How discovery shapes the layout

[Project Structure](project-structure.md) lists the directories recognized by `createSixb()` and the
definitions each one accepts. Within those directories, discovery matches exported values. File
names and nesting do not determine a definition's ID or execution order.

There are a few practical consequences when organizing backend code:

- A definition can move within its primitive's directory without changing its ID. Keeping the ID
  preserves its identity; changing it is a separate change from reorganizing files. Update imports
  that refer to the old path.
- Sixb imports every supported module in the discovered directories, including helper modules.
  Helper exports that are not definitions are ignored, but code at module scope still executes.
  Helpers kept here should have no import-time side effects.
- Tests and scripts belong outside backend discovery directories so they are not loaded at startup.
  Root-level `tests/` and `scripts/` are convenient places for them; naming a nested directory
  `tests/` or prefixing it with `_` does not exclude it from backend discovery.

The `app/` directory uses separate [routing conventions](../apps/overview.md). It is not part of
backend discovery.

## Workflows

Grouping [workflows](../workflows/overview.md) by business process keeps their orchestration and
steps easy to navigate. A simple workflow can live in one file; a larger one can have its own
directory. The main file composes the steps, and execution order is defined in the workflow, so
filenames do not need numbering. Actions referenced by a discovered workflow stay in `actions/`
for action discovery.

Example:

```txt
workflows/
├── sendPaymentReceipt.ts
└── invoice-reminder/
    ├── invoiceReminder.ts
    └── steps/
        ├── loadInvoiceContext.ts
        └── composeReminder.ts
```

## Actions

Grouping [actions](../actions/overview.md) by business object helps readers find what can be done
with that object. A subdirectory can group operations on a related object when that relationship
is useful for navigation.

Names such as `markInvoicePaid` or `sendReminder` describe the business intent. The available
actions follow the operations the application needs; a full set of CRUD actions for every object
is not necessary.

Example:

```txt
actions/
└── invoice/
    ├── markInvoicePaid.ts
    ├── sendReminder.ts
    └── invoice-line/
        └── applyDiscount.ts
```

## Connectors

Grouping [connectors](../data/connectors.md) by external system makes integration code easy to
find. An additional product level can help when one provider exposes several products. A custom
connector can have its own directory when its definition, client, and types benefit from separate
files.

Example:

```txt
connectors/
├── payment-gateway.ts
├── acme/
│   ├── accounting.ts
│   └── crm.ts
└── legacy-erp/
    ├── legacy-erp.ts
    ├── client.ts
    └── types.ts
```

## Datasets

For ingested data, grouping [datasets](../data/datasets.md) by source makes their origin visible.
For derived data, a business domain often gives a more useful grouping. A dataset file describes
a table's contract; retrieval and transformation live in syncs and pipelines.

Example:

```txt
datasets/
├── legacy-erp/
│   ├── customers.ts
│   └── invoices.ts
└── billing/
    └── overdue-invoices.ts
```

## Syncs

Matching [sync](../data/syncs.md) paths to the datasets they populate makes it easier to move
between a table's contract and its ingestion code. Reading and mapping can stay in the sync file
until their complexity makes separate helpers useful.

Example:

```txt
syncs/
└── legacy-erp/
    ├── customers.ts
    └── invoices/
        ├── invoices.ts
        ├── read-invoices.ts
        └── map-invoice-row.ts
```

## Pipelines

Source-based grouping works well for provider-specific transformations; domain-based grouping
works well for business processing. A short [pipeline](../data/pipelines.md) can keep its steps
and SQL in one file. Larger queries can be easier to maintain as separate SQL files, with a
`sql.ts` helper to load or compose them when needed.

Example:

```txt
pipelines/
├── normalize-customers.ts
└── billing/
    └── overdue-invoices/
        ├── overdue-invoices.ts
        ├── sql/
        │   ├── unpaid-invoices.sql
        │   └── payment-totals.sql
        └── sql.ts
```

## Ontology

One file per [object type](../ontology/object-types.md) keeps its properties, links, and telemetry
declarations together. Domain directories can help as the ontology grows. A `value-types/`
directory gives shared [value types](../ontology/value-types.md) a recognizable home; a value type
used by one object can stay with that object.

Example:

```txt
ontology/
├── customer.ts
├── billing/
│   ├── invoice.ts
│   └── invoice-line.ts
└── value-types/
    └── currency-code.ts
```

## Projections

Following the ontology's organization makes [projections](../data/projections.md) easy to find
from their target business object. Foreign-key links can stay within the object projection using
`.withLinks(...)`. Dedicated files help distinguish separate link or telemetry projections from
the projection that materializes the object itself.

Example:

```txt
projections/
├── customer.ts
└── billing/
    ├── invoice.ts
    ├── invoice-line.ts
    ├── invoice-reviewers.ts
    └── invoice-balance-telemetry.ts
```

## Security

Sixb discovers security definitions in `security/groups/`, `security/roles/`, and
`security/policies/`. Groups collect principals, roles define access grants, and membership
policies define who can administer group membership. These directories have framework-defined
roles; filenames and further grouping within them are up to the project.

Example:

```txt
security/
├── groups/
│   └── billing-team.ts
├── roles/
│   └── billing-access.ts
└── policies/
    └── billing-membership.ts
```

See [Authorization](../auth/authorization.md) for how the definitions work together.

## App

Grouping UI code by user-facing feature keeps components and data access close to the screens
that use them. In this layout, each `page.tsx` composes features for its route, and `_features/`
holds the feature implementations. The name `_features` is a choice: the `_` prefix is what
excludes the directory from routing.

A small feature can start with one component. Separate `components/`, `utils/`, `hooks/`,
`queries.ts`, or `mutations.ts` become useful when there is enough code to group. A sub-feature
can use the same approach as it grows.

Example:

```txt
app/
├── layout.tsx
├── invoices/
│   └── page.tsx
└── _features/
    └── billing/
        ├── components/
        │   └── InvoiceTable.tsx
        ├── queries.ts
        ├── mutations.ts
        └── payment-history/
            ├── components/
            │   └── PaymentHistory.tsx
            └── queries.ts
```

See [Building Apps](../apps/overview.md) for routing, styles, and the available UI packages.
