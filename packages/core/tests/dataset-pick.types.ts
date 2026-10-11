import { col, type DatasetColumnNameOf, type DatasetDefinition, defineDataset } from "../src"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const rawInvoices = defineDataset("raw_invoices", {
  schema: [col("id", "string"), col("title", "string"), col("amount", "decimal")],
  primaryKey: "id",
})

// A pick keeps the dataset id and types exactly the picked columns, in order.
const picked = rawInvoices.pick("title", "id")
type _pickedId = Expect<Equal<(typeof picked)["id"], "raw_invoices">>
type _pickedColumns = Expect<Equal<DatasetColumnNameOf<typeof picked>, "title" | "id">>
type _pickedOrder = Expect<Equal<(typeof picked)["schema"]["columns"][0]["name"], "title">>
const _asDefinition: DatasetDefinition = picked

// Derived datasets pick from their own columns.
const archive = defineDataset("archive").derive(rawInvoices, { pick: ["id", "amount"] })
archive.pick("amount")

// @ts-expect-error a pick names declared columns only
rawInvoices.pick("total")
// @ts-expect-error a pick names at least one column
rawInvoices.pick()
// @ts-expect-error the stored definition type has no pick
;(rawInvoices as DatasetDefinition).pick("id")
