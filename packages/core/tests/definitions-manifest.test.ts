import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { col, createSixb, defineDataset } from "../src"
import { buildDefinitionsManifest, type DefinitionsManifest, diffManifests } from "../src/manifest"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const CORE = resolve(import.meta.dir, "../src/index.ts")
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** One version of a small project, each file's contents keyed by its path. */
type Project = Record<string, string>

const invoice = (extraProperty = "") => `
import { defineObjectType, prop } from "${CORE}"
export const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("amount", "double"),${extraProperty}
  ],
})
`

const vendor = `
import { defineObjectType, link, prop } from "${CORE}"
import { Invoice } from "./invoice"
export const Vendor = defineObjectType({
  id: "Vendor",
  name: "Vendor",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link("invoices", Invoice, { cardinality: "many" })],
})
`

const action = (id: string, body = "return") => `
import { defineAction } from "${CORE}"
import { Invoice } from "../ontology/invoice"
export const ${id} = defineAction("${id}")
  .on(Invoice)
  .params({})
  .edits(() => {
    ${body}
  })
`

const bills = (extraColumn = "") => `
import { col, defineDataset } from "${CORE}"
export const bills = defineDataset("bills", {
  schema: [col("bill_id", "string"), col("amount", "float64")${extraColumn}],
  primaryKey: "bill_id",
})
`

const invoicesProjection = `
import { defineProjection } from "${CORE}"
import { bills } from "../datasets/bills"
import { Invoice } from "../ontology/invoice"
export const invoices = defineProjection("invoices", Invoice)
  .fromDataset(bills)
  .properties({ id: "bill_id", amount: "amount" })
`

const objectType = (id: string) => `
import { defineObjectType, prop } from "${CORE}"
export const ${id} = defineObjectType({
  id: "${id}",
  name: "${id}",
  properties: [prop("id", "string", { required: true, primary: true })],
})
`

const production: Project = {
  "ontology/invoice.ts": invoice(),
  "ontology/vendor.ts": vendor,
  "ontology/legacy.ts": objectType("Legacy"),
  "actions/approve.ts": action("approveInvoice"),
  "actions/hold.ts": action("holdInvoice"),
  "datasets/bills.ts": bills(),
  "projections/invoices.ts": invoicesProjection,
}

const branch: Project = {
  "ontology/invoice.ts": invoice(`\n    prop("heldAt", "timestamp"),`),
  "ontology/vendor.ts": vendor,
  "ontology/site.ts": objectType("Site"),
  "actions/approve.ts": action("approveInvoice", "// Held invoices stay held.\n    return"),
  "actions/hold.ts": action("holdInvoice"),
  "datasets/bills.ts": bills(`, col("vendor_tax_id", "string", { nullable: true })`),
  "projections/invoices.ts": invoicesProjection,
}

async function manifestOf(project: Project, commit: string | null = null) {
  const root = await mkdtemp(join(tmpdir(), "sixb-manifest-"))
  roots.push(root)
  for (const [path, contents] of Object.entries(project)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  const host = await createSixb({ projectRoot: root, ...createTestRuntimeDeps() })
  return buildDefinitionsManifest(host, { commit })
}

test("a manifest names each definition's file and its deploy's commit", async () => {
  const manifest = await manifestOf(production, "a41f9c2")

  expect(manifest.commit).toBe("a41f9c2")
  expect(
    manifest.definitions
      .filter((definition) => definition.kind !== "valueType")
      .map(({ kind, id, file }) => [kind, id, file])
  ).toEqual([
    ["action", "approveInvoice", "actions/approve.ts"],
    ["action", "holdInvoice", "actions/hold.ts"],
    ["dataset", "bills", "datasets/bills.ts"],
    ["objectType", "Invoice", "ontology/invoice.ts"],
    ["objectType", "Legacy", "ontology/legacy.ts"],
    ["objectType", "Vendor", "ontology/vendor.ts"],
    ["projection", "invoices", "projections/invoices.ts"],
  ])
  expect(manifest.projections.map((projection) => projection.id)).toEqual(["invoices"])
  expect(manifest.datasets.map((dataset) => dataset.id)).toEqual(["bills"])
})

test("one project built twice has the same manifest", async () => {
  const [first, second] = await Promise.all([manifestOf(production), manifestOf(production)])
  expect(second.hash).toBe(first.hash)
  expect(diffManifests(first, second)).toEqual({
    changes: [],
    plan: { projections: [], datasets: [] },
  })
})

test("a diff lists what a branch changed and what shipping it rebuilds", async () => {
  const [base, head] = await Promise.all([manifestOf(production), manifestOf(branch)])
  const { changes, plan } = diffManifests(base, head)

  // holdInvoice is bound to Invoice and unchanged: a nested definition is compared by id, not
  // inlined. Inline it (drop the `$ref` branch in `fingerprint`) and holdInvoice shows as changed.
  // approveInvoice declares the same values in both: only the code in its file changed, which
  // shows only while `code` hashes the file.
  expect(changes.map(({ kind, id, change }) => [kind, id, change])).toEqual([
    ["action", "approveInvoice", "changed"],
    ["dataset", "bills", "changed"],
    ["objectType", "Invoice", "changed"],
    ["objectType", "Legacy", "removed"],
    ["objectType", "Site", "added"],
  ])
  expect(changes.find((change) => change.id === "Legacy")?.file).toBe("ontology/legacy.ts")
  expect(plan).toEqual({
    projections: [{ id: "invoices", change: "rebuild" }],
    datasets: [{ id: "bills", change: "addColumns", columns: ["vendor_tax_id"] }],
  })
})

test("a dataset change the lake refuses shows in the plan instead of failing the diff", () => {
  const schema = [col("bill_id", "string"), col("vendor_id", "string")]
  const before = defineDataset("bills", { schema, primaryKey: "bill_id" })
  const after = defineDataset("bills", { schema, primaryKey: "vendor_id" })
  const manifest = (dataset: typeof before | typeof after): DefinitionsManifest => ({
    commit: null,
    hash: "",
    definitions: [],
    projections: [],
    datasets: [dataset],
  })

  const [step] = diffManifests(manifest(before), manifest(after)).plan.datasets
  expect(step?.change).toBe("refused")
})

test("a definition passed to createSixb directly has no file", async () => {
  const root = await mkdtemp(join(tmpdir(), "sixb-manifest-"))
  roots.push(root)
  await mkdir(join(root, "ontology"))
  await writeFile(join(root, "ontology/invoice.ts"), invoice())
  const extra = defineDataset("extra", { schema: [col("id", "string")] })
  const host = await createSixb({
    projectRoot: root,
    datasets: [extra],
    ...createTestRuntimeDeps(),
  })

  const manifest = await buildDefinitionsManifest(host)
  expect(manifest.definitions.find((definition) => definition.id === "extra")?.file).toBeNull()
})
