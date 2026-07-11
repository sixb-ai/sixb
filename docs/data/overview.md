# Data

Sixb's data plane brings table-shaped data in from the outside world, cleans it, and turns it
into app objects. Reach for it when your objects originate in another system — an ERP, a
database, an API — rather than being created in-app.

Five pieces work together. Each has one job, and they chain in a fixed order:

```txt
connector ──▶ sync ──▶ dataset ──▶ pipeline ──▶ projection ──▶ objects
  reach        pull      store       shape        publish        + links
  external     rows      typed       rows into    rows into      + telemetry
  system       in        table       rows         the ontology
```

A [connector](./connectors.md) reaches an external system. A [sync](./syncs.md) reads from it and
writes rows into a [dataset](./datasets.md). A [pipeline](./pipelines.md) transforms datasets into
cleaner datasets. A [projection](./projections.md) maps dataset rows onto
[ontology](../ontology/overview.md) objects, links, and telemetry.

## The pieces

| Piece | One line | Page |
| --- | --- | --- |
| Connector | A reusable connection to an external system | [connectors.md](./connectors.md) |
| Sync | Pulls rows from a connector into a dataset | [syncs.md](./syncs.md) |
| Dataset | A named, typed table contract | [datasets.md](./datasets.md) |
| Pipeline | Transforms datasets into other datasets | [pipelines.md](./pipelines.md) |
| Projection | Maps dataset rows onto objects, links, and telemetry | [projections.md](./projections.md) |

## End-to-end example

This is the canonical Acme flow: pull invoices from the ERP, store them in a dataset, then
project the rows onto `Invoice` objects. Each piece references the ones before it by definition,
so the shape stays consistent.

```ts
import { col, defineConnector, defineDataset, defineProjection, defineSync } from "@sixb/core"
import { createAcmeErpClient } from "../lib/acme-erp"
import { Customer } from "../ontology/customer"
import { Invoice } from "../ontology/invoice"

// connector: how to reach the external system
export const acmeErpConnector = defineConnector("acme-erp", {
  type: "acme-erp",
  connect() {
    return createAcmeErpClient()
  },
})

// dataset: the table contract (raw ERP column names)
export const erpInvoicesDataset = defineDataset("erp.invoices", {
  schema: [
    col("id", "string"),
    col("number", "string"),
    col("amount", "decimal"),
    col("currency", "string"),
    col("status", "string"),
    col("issuedAt", "timestamp"),
    col("dueDate", "date"),
    col("customer_id", "string"),
  ],
})

// sync: connector in, dataset out
export const syncErpInvoices = defineSync("sync-erp-invoices")
  .from(acmeErpConnector)
  .read((client) => client.listInvoices())
  .intoDataset(erpInvoicesDataset)

// projection: dataset rows out, Invoice objects + links in
export const invoiceProjection = defineProjection("invoice-proj", Invoice)
  .fromDataset(erpInvoicesDataset)
  .properties({
    id: "id",
    number: "number",
    amount: "amount",
    currency: "currency",
    status: "status",
    issuedAt: "issuedAt",
    dueDate: "dueDate",
  })
  .withLinks({
    customer: { link: Invoice.l.customer, sourceField: "customer_id", target: Customer },
  })
```

Add a [pipeline](./pipelines.md) between the dataset and projection when you need to clean,
filter, rename, or join rows before they become objects.

## Mental model

- **Datasets are tables. Ontology types are objects.** The data plane gets rows into tables;
  projections cross the gap from tables to objects, links, and telemetry.
- **Each step has one source and one target.** A sync writes one dataset, a pipeline step writes
  one dataset, and a projection writes one object type.
- **Definitions are reused, not redeclared.** A dataset is defined once and referenced by syncs,
  pipelines, and projections so the schema stays in sync.
- **Steps are event-driven.** Use named [schedules](../schedules/overview.md) with `.when(...)`;
  `events.sync(sync).succeeded()` and `events.dataset(dataset).updated()` describe chained work.

## When to use what

| Goal | Use |
| --- | --- |
| Talk to a database or API | [Connector](./connectors.md) |
| Pull rows from a source into Sixb | [Sync](./syncs.md) |
| Give table data a stable, typed shape | [Dataset](./datasets.md) |
| Clean, filter, rename, or join tables | [Pipeline](./pipelines.md) |
| Make rows show up as app objects | [Projection](./projections.md) |

## Discovery

`createSixb()` auto-discovers the `connectors/`, `datasets/`, `syncs/`, `pipelines/`, and
`projections/` directories. Export a definition from a file in the matching folder and the runtime
registers it. See [runtime](../runtime/overview.md) and
[project structure](../fundamentals/project-structure.md).
