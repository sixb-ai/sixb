import { describe, expect, test } from "bun:test"
import type { ArtifactFile, AuthorizationContext } from "../src"
import {
  ArtifactRequestError,
  defineMarking,
  defineObjectType,
  defineOntology,
  link,
  prop,
  SixbHost,
} from "../src"
import { liveSheetColumns, liveSheetTable, parseWorkbook } from "../src/artifacts"
import type { ArtifactQuerySchema } from "../src/artifacts/queries"
import { artifactQuerySchema } from "../src/artifacts/run-query"
import { emptyGrantIndex } from "../src/authorization/types"
import { createAuthorizedOntologyView } from "../src/objects/authorized-ontology-view"
import { validateObjectQuery } from "../src/objects/query/validate"
import { OntologyRegistry } from "../src/ontology"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const projectId = "artifact-live-sheets"
const financial = defineMarking("financial")

const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [prop("id", "string", { primary: true, required: true }), prop("name", "string")],
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("number", "string", { primary: true, required: true }),
    prop(
      "status",
      { type: "enum", valueType: "string", values: ["open", "paid"] },
      { query: { searchable: true, facet: true } }
    ),
    prop("amount", "double", { markings: [financial] }),
    prop("dueDate", "date"),
    prop("disputed", "boolean"),
    prop("tags", { type: "array", items: "string" }),
  ],
  links: [link("customer", Customer, { cardinality: "one" })],
})

const start = { kind: "start", objectTypeId: "Invoice" }
const withCustomers = {
  kind: "expand",
  input: start,
  expansions: [{ linkId: "customer", direction: "outgoing" }],
}

const overdue = {
  name: "Overdue",
  query: "overdue",
  columns: {
    Invoice: { from: "number" },
    Customer: { from: "customer.name" },
    Status: { from: "status" },
    Amount: { from: "amount", type: "currency", currency: "EUR" },
    Due: { from: "dueDate" },
    Disputed: { from: "disputed" },
    Tags: { from: "tags" },
    Doubled: { type: "currency", formula: "[@Amount]*2" },
  },
  totals: { Amount: "sum", Invoice: "count" },
}

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: projectId,
    ontology: [Customer, Invoice],
    markings: [financial],
    ...deps,
  })

  const as = (id: string, options: { readonly cleared?: boolean } = {}) => {
    const authorization: AuthorizationContext = {
      principal: { type: "user", id },
      groupIds: [],
      roleIds: [],
      grants: { ...emptyGrantIndex(), "view:object": new Set(["Invoice", "Customer"]) },
      ...(options.cleared ? { clearances: new Set([financial.id]) } : {}),
    }
    return createTestSixb(host, { authorization })
  }

  const put = async (path: string, body: string): Promise<ArtifactFile> => ({
    path,
    file: await deps.blobStorage.put({
      body: new TextEncoder().encode(body),
      fileName: path.split("/").at(-1) ?? path,
    }),
  })

  /** A sheet of these workbook sheets and charts, with these queries and files. */
  const sheet = async (
    workbook: { readonly sheets: readonly unknown[]; readonly charts?: readonly unknown[] },
    queries: Record<string, unknown> = { overdue: withCustomers },
    files: Record<string, string> = {}
  ) => ({
    kind: "sheet" as const,
    title: "Overdue",
    files: [
      await put("workbook.json", JSON.stringify(workbook)),
      ...(await Promise.all(
        Object.entries(queries).map(([name, query]) =>
          put(`queries/${name}.json`, JSON.stringify(query))
        )
      )),
      ...(await Promise.all(Object.entries(files).map(([path, text]) => put(path, text)))),
    ],
  })

  return { host, as, put, sheet }
}

async function refused(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(ArtifactRequestError)
  return (error as ArtifactRequestError).message
}

/** The workbook's one sheet, parsed as the viewer parses it. */
function parsed(sheet: unknown) {
  const read = parseWorkbook(JSON.stringify({ sheets: [sheet] }))
  if ("error" in read) throw new Error(read.error)
  const [first] = read.workbook.sheets
  if (!first) throw new Error("Expected a sheet.")
  return first
}

describe("publishing a live sheet", () => {
  test("lays its columns out from its query's rows: their property's type, or the one it gives", async () => {
    const { as, sheet } = setup()
    const alice = as("alice", { cleared: true })

    const { artifact, version } = await alice.artifacts.create(await sheet({ sheets: [overdue] }))

    expect(version.outline).toEqual({
      kind: "sheet",
      sheets: [
        {
          name: "Overdue",
          rows: 0,
          columns: Object.keys(overdue.columns),
          query: "overdue",
        },
      ],
      charts: [],
    })

    const result = await alice.artifacts.query(artifact.id, "overdue")
    if (result?.kind !== "objects") throw new Error("Expected rows.")
    const layout = liveSheetColumns(parsed(overdue), result.schema)

    expect(layout.problem).toBeNull()
    expect(
      Object.fromEntries(
        Object.entries(layout.sheet.columns).map(([name, format]) => [name, format.type])
      )
    ).toEqual({
      Invoice: "text",
      Customer: "text",
      Status: "tag",
      Amount: "currency",
      Due: "date",
      Disputed: "boolean",
      Tags: "text",
      Doubled: "currency",
    })
    expect(layout.columns.map((column) => column.from)).toEqual([
      { propertyId: "number" },
      { linkId: "customer", propertyId: "name" },
      { propertyId: "status" },
      { propertyId: "amount" },
      { propertyId: "dueDate" },
      { propertyId: "disputed" },
      { propertyId: "tags" },
      undefined,
    ])
  })

  test("refuses a column that shows nothing, or both a property and a formula", () => {
    const columns = (value: unknown) =>
      parseWorkbook(
        JSON.stringify({ sheets: [{ name: "Overdue", query: "overdue", columns: value }] })
      )

    expect(columns({ Amount: { type: "currency" } })).toEqual({
      error:
        "workbook.json: sheet 'Overdue' column 'Amount' shows nothing: give it \"from\", the property it shows, or a \"formula\".",
    })
    expect(columns({ Amount: { from: "amount", type: "number", formula: "1+1" } })).toEqual({
      error:
        "workbook.json: sheet 'Overdue' column 'Amount' has both \"from\" and \"formula\": a column shows a property or computes, not both.",
    })
    expect(columns({ Amount: "currency" })).toEqual({
      error:
        'workbook.json: sheet \'Overdue\' column \'Amount\' is "currency"; a live sheet\'s column is an object, such as { "from": "amount", "type": "currency" }.',
    })
    // JSON would put it first, whatever order the workbook lists it in.
    expect(columns({ Region: { from: "region" }, 2024: { from: "total" } })).toEqual({
      error:
        "workbook.json: sheet 'Overdue' column '2024': a live sheet's columns come in the order \"columns\" lists them, and JSON puts a name of digits first. Name it with a letter, such as \"FY2024\".",
    })
  })

  // Guard proof: skip the `layout.problem` refusal in validate/sheet.ts's liveSheet; each version
  // below then publishes.
  test("refuses a property its query's rows do not hold, and a link it does not expand", async () => {
    const { as, sheet } = setup()
    const alice = as("alice", { cleared: true })
    const one = (columns: unknown) => sheet({ sheets: [{ ...overdue, columns, totals: {} }] })

    expect(await refused(alice.artifacts.create(await one({ Total: { from: "total" } })))).toBe(
      "[Sixb] workbook.json sheet 'Overdue' column 'Total' \"from\": query 'overdue' returns no property 'total'; it has number, status, amount, dueDate, disputed, tags."
    )

    expect(
      await refused(
        alice.artifacts.create(
          await sheet(
            {
              sheets: [
                {
                  name: "Overdue",
                  query: "overdue",
                  columns: { Customer: { from: "customer.name" } },
                },
              ],
            },
            { overdue: start }
          )
        )
      )
    ).toBe(
      "[Sixb] workbook.json sheet 'Overdue' column 'Customer' \"from\": query 'overdue' does not expand link 'customer': add it to the query's \"expand\" node, or show a property of the rows."
    )

    expect(
      await refused(alice.artifacts.create(await one({ Customer: { from: "customer.email" } })))
    ).toBe(
      "[Sixb] workbook.json sheet 'Overdue' column 'Customer' \"from\": link 'customer' reaches no property 'email'; it has id, name."
    )

    // A type the property's values can't be read as.
    expect(
      await refused(
        alice.artifacts.create(await one({ Customer: { from: "customer.name", type: "number" } }))
      )
    ).toBe(
      "[Sixb] workbook.json sheet 'Overdue' column 'Customer' is number, but 'customer.name' holds text: leave out \"type\" to show it as its property is, or show another property."
    )
  })

  test("refuses a facets query, a CSV beside its query, and a query the version lacks", async () => {
    const { as, sheet } = setup()
    const alice = as("alice", { cleared: true })
    const workbook = { sheets: [overdue] }

    expect(
      await refused(
        alice.artifacts.create(
          await sheet(workbook, {
            overdue: { query: withCustomers, facets: [{ propertyId: "status", limit: 10 }] },
          })
        )
      )
    ).toBe(
      "[Sixb] Sheet 'Overdue' reads query 'overdue', which counts facets: a sheet shows rows. A page shows facets; give the sheet a query of rows."
    )

    expect(
      await refused(
        alice.artifacts.create(
          await sheet(workbook, undefined, { "sheets/Overdue.csv": "Invoice\ninv_1\n" })
        )
      )
    ).toBe(
      "[Sixb] Sheet 'Overdue' reads its rows from query 'overdue', so it has no 'sheets/Overdue.csv': remove the CSV, or \"query\" to show it."
    )

    expect(await refused(alice.artifacts.create(await sheet(workbook, {})))).toBe(
      "[Sixb] Sheet 'Overdue' reads query 'overdue', which the version does not have: add 'queries/overdue.json'."
    )
  })

  test("refuses totals and charts on columns it does not declare, or can't total", async () => {
    const { as, sheet } = setup()
    const alice = as("alice", { cleared: true })

    expect(
      await refused(
        alice.artifacts.create(await sheet({ sheets: [{ ...overdue, totals: { Paid: "sum" } }] }))
      )
    ).toBe(
      "[Sixb] workbook.json sheet 'Overdue' names column 'Paid', which its \"columns\" does not list."
    )

    // Its property's type is text: there is nothing to sum.
    expect(
      await refused(
        alice.artifacts.create(
          await sheet({ sheets: [{ ...overdue, totals: { Customer: "sum" } }] })
        )
      )
    ).toBe(
      '[Sixb] workbook.json sheet \'Overdue\' totals column \'Customer\' with "sum", but it is text; only a number, currency, or percent column has a sum. Use "count", or give it a numeric type in "columns".'
    )

    expect(
      await refused(
        alice.artifacts.create(
          await sheet({
            sheets: [overdue],
            charts: [
              { name: "by-customer", type: "bar", sheet: "Overdue", x: "Customer", y: "Paid" },
            ],
          })
        )
      )
    ).toBe(
      "[Sixb] workbook.json chart 'by-customer' plots column 'Paid', which sheet 'Overdue' does not have."
    )

    // A chart plots a column typed by its property as it plots any other.
    await alice.artifacts.create(
      await sheet({
        sheets: [{ ...overdue, columns: { ...overdue.columns, Due: { from: "dueDate" } } }],
        charts: [
          {
            name: "by-customer",
            type: "bar",
            sheet: "Overdue",
            x: "Customer",
            y: "Amount",
            aggregate: "sum",
          },
        ],
      })
    )
  })
})

describe("showing a live sheet elsewhere", () => {
  // Guard proof: bound a live sheet's range by its `rows` again in resolve.ts; the document is
  // then refused, as its sheet had none.
  test("addresses a range as deep as its readers' rows go", async () => {
    const { as, sheet, put } = setup()
    const alice = as("alice", { cleared: true })
    const { artifact } = await alice.artifacts.create(await sheet({ sheets: [overdue] }))

    const document = await alice.artifacts.create({
      kind: "document",
      title: "Review",
      files: [
        await put(
          "document.md",
          `# Review\n\n![Overdue](artifact:${artifact.id}#Overdue!A1:D50)\n`
        ),
      ],
    })
    expect(document.version.references).toMatchObject([
      { address: `artifact:${artifact.id}#Overdue!A1:D50`, resolvedVersion: 1 },
    ])

    expect(
      await refused(
        alice.artifacts.create({
          kind: "document",
          title: "Review",
          files: [
            await put(
              "document.md",
              `# Review\n\n![Overdue](artifact:${artifact.id}#Overdue!A1:Z2)\n`
            ),
          ],
        })
      )
    ).toContain("has no range A1:Z2 in sheet 'Overdue'")
  })
})

/** Overdue's layout against the schema its query gives a reader who views both types. */
function layout() {
  const schema: ArtifactQuerySchema = {
    properties: {
      number: { type: "string" },
      status: { type: "enum", valueType: "string" },
      amount: { type: "double" },
      dueDate: { type: "date" },
      disputed: { type: "boolean" },
      tags: { type: "array" },
    },
    links: { customer: { properties: { id: { type: "string" }, name: { type: "string" } } } },
  }
  return liveSheetColumns(parsed(overdue), schema)
}

describe("a live sheet's rows", () => {
  test("hold each value as a CSV cell holds it", () => {
    const { table, locked } = liveSheetTable(layout(), [
      {
        properties: {
          number: "inv_1",
          status: "open",
          amount: 1250.5,
          dueDate: "2026-09-30",
          disputed: false,
          tags: ["late", "large"],
        },
        links: { customer: { properties: { id: "acme", name: "Acme" } } },
      },
      // Nothing linked, and values left empty.
      { properties: { number: "inv_2", amount: null }, links: { customer: null } },
      // A link that reaches several objects shows each one's value.
      {
        properties: { number: "inv_3" },
        links: {
          customer: [
            { properties: { name: "Acme" } },
            { properties: { name: "" } },
            { properties: { name: "Globex" } },
          ],
        },
      },
    ])

    expect(table).toEqual({
      header: Object.keys(overdue.columns),
      rows: [
        ["inv_1", "Acme", "open", "1250.5", "2026-09-30", "false", "late, large", ""],
        ["inv_2", "", "", "", "", "", "", ""],
        ["inv_3", "Acme, Globex", "", "", "", "", "", ""],
      ],
    })
    expect(locked.size).toBe(0)
  })

  // Guard proof: drop the `lockComputed` call in liveSheetTable; row 0's Doubled is then not
  // locked. Drop the redactions check in propertyCell, and nothing is.
  test("lock what the reader may not see, and what a formula computes from it", () => {
    const { table, locked } = liveSheetTable(layout(), [
      {
        properties: { number: "inv_1" },
        redactions: { amount: { reason: "missing_clearance" } },
        links: {
          customer: [
            { properties: { name: "Acme" } },
            { properties: {}, redactions: { name: { reason: "missing_clearance" } } },
          ],
        },
      },
      { properties: { number: "inv_2", amount: 10 } },
    ])

    expect(table.rows[0]).toEqual(["inv_1", "", "", "", "", "", "", ""])
    expect(locked).toEqual(new Map([[0, new Set([1, 3, 7])]]))
  })

  test("lock every cell of a column whose property the reader's rows do not hold", () => {
    const { amount: _amount, ...visible } = {
      number: { type: "string" },
      amount: { type: "double" },
    } as const
    const partial = liveSheetColumns(parsed(overdue), {
      properties: visible,
      links: { customer: { properties: { name: { type: "string" } } } },
    })

    // Publishing refuses it; a reader who can't see it sees it locked.
    expect(partial.problem).toContain("returns no property 'status'")
    const { locked } = liveSheetTable(partial, [{ properties: { number: "inv_1", amount: 3 } }])
    expect(locked.get(0)).toEqual(new Set([2, 3, 4, 5, 6, 7]))
  })

  test("are read by each reader: one not cleared for a value sees it locked", async () => {
    const { host, as, sheet } = setup()
    const alice = as("alice", { cleared: true })
    const { artifact } = await alice.artifacts.create(await sheet({ sheets: [overdue] }))

    const seeding = createTestSixb(host)
    const acme = await seeding
      .objects(Customer)
      .upsert({ properties: { id: "acme", name: "Acme" } })
    await seeding.objects(Invoice).upsert({ properties: { number: "inv_1", amount: 1250 } })
    await seeding.objects(Invoice).byId("inv_1").link(Invoice.l.customer, acme)

    const rows = async (reader: ReturnType<typeof as>) => {
      const result = await reader.artifacts.query(artifact.id, "overdue")
      if (result?.kind !== "objects") throw new Error("Expected rows.")
      return liveSheetTable(liveSheetColumns(parsed(overdue), result.schema), result.objects)
    }

    const cleared = await rows(alice)
    expect(cleared.table.rows[0]?.slice(0, 4)).toEqual(["inv_1", "Acme", "", "1250"])
    expect(cleared.locked.size).toBe(0)

    // Alice no longer cleared: the same artifact shows her what she may see now.
    const uncleared = await rows(as("alice"))
    expect(uncleared.table.rows[0]?.slice(0, 4)).toEqual(["inv_1", "Acme", "", ""])
    expect(uncleared.locked.get(0)).toEqual(new Set([3, 7]))
  })
})

describe("a query's schema", () => {
  // Guard proof: pass `registry` in place of `view`; the schema then names `amount`, which the
  // reader's view leaves out.
  test("names only what the reader's view of the ontology holds", () => {
    const registry = new OntologyRegistry({
      sources: [
        defineOntology({ id: projectId, version: "1.0.0", objectTypes: [Customer, Invoice] }),
      ],
    })

    const view = createAuthorizedOntologyView({
      ontology: registry,
      selection: {
        kind: "selected",
        scope: {
          kind: "selected",
          roots: [],
          objects: [
            { nodeId: 1, objectTypeId: "Invoice", propertyIds: ["number", "status"] },
            { nodeId: 2, objectTypeId: "Customer", propertyIds: ["name"] },
          ],
          steps: [],
        },
      },
    })
    const validated = validateObjectQuery(withCustomers as never, { ontology: registry })

    expect(artifactQuerySchema(view, validated)).toEqual({
      properties: { number: { type: "string" }, status: { type: "enum", valueType: "string" } },
      links: { customer: { properties: {} } },
    })
  })
})
