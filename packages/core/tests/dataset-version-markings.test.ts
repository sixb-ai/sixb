import { describe, expect, test } from "bun:test"
import {
  can,
  col,
  type DatasetDefinition,
  type DatasetRow,
  defineDataset,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineProjection,
  defineRole,
  type MarkingDefinition,
  prop,
  resolveAuthorizationContext,
  SixbHost,
} from "../src"
import { lakeDatasetDefinition } from "../src/datasets/write"
import {
  type DatasetColumnLineage,
  type DatasetVersion,
  InMemoryLakeStorage,
} from "../src/lake-storage"
import { createDatasetVersionMarkings } from "../src/security/dataset-version-markings"
import {
  assertProjectionVersionMarkings,
  getDatasetVersionMarkings,
} from "../src/security/internal"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const financial = defineMarking("financial")
const pii = defineMarking("pii")

const rawInvoices = defineDataset("raw_invoices", {
  schema: [
    col("id", "string"),
    col("title", "string"),
    col("amount", "decimal", { markings: [financial] }),
    col("customer_tax_id", "string", { markings: [pii] }),
  ],
})
const normalizedInvoices = defineDataset("normalized_invoices", {
  schema: [col("id", "string"), col("title", "string"), col("amount", "decimal")],
})
const invoiceTitles = defineDataset("invoice_titles", {
  schema: [col("id", "string"), col("title", "string")],
})

// A column named like an Object.prototype member.
const notes = defineDataset("notes", {
  schema: [col("id", "string"), col("constructor", "string")],
})
const datasets = [rawInvoices, normalizedInvoices, invoiceTitles, notes]

const ref = (datasetId: string, column: string) => ({ datasetId, column })
const raw = (column: string) => ref("raw_invoices", column)
const normalized = (column: string) => ref("normalized_invoices", column)

/** Commit one version the way a sync (no lineage) or a pipeline step would. */
async function commit(
  lakeStorage: InMemoryLakeStorage,
  dataset: DatasetDefinition,
  rows: readonly DatasetRow[],
  pipeline?: {
    readonly lineage?: DatasetColumnLineage
    readonly inputs?: readonly DatasetVersion[]
  }
): Promise<DatasetVersion> {
  const definition = lakeDatasetDefinition(dataset)
  await lakeStorage.createDataset(definition)
  const session = await lakeStorage.beginWrite({
    dataset: definition,
    mode: "snapshot",
    producer: pipeline ? { kind: "pipeline", id: "invoices" } : { kind: "sync", id: "erp" },
    // The raw invoices hold what they declare, so a lineage over them is resolved already.
    ...(pipeline?.lineage && { lineage: pipeline.lineage }),
    ...(pipeline?.inputs && {
      inputs: pipeline.inputs.map(({ datasetId, versionId }) => ({ datasetId, versionId })),
    }),
  })
  await session.writeRows(rows)
  const { outcome: _outcome, ...version } = await session.commit()
  return version
}

const invoiceRow = { id: "inv-1", title: "July", amount: "120.00" }

async function seedRaw(lakeStorage = new InMemoryLakeStorage()) {
  const rawVersion = await commit(lakeStorage, rawInvoices, [
    { ...invoiceRow, customer_tax_id: "FR-1" },
  ])
  return { lakeStorage, rawVersion }
}

/** Classifies versions of a lake that records lineage on every version it commits. */
const recording = { recordsLineage: true }
const classifier = () =>
  createDatasetVersionMarkings({ datasets: { list: () => datasets }, lakeStorage: recording })

/** Column markings as plain data, sorted, for assertions. */
function markingsOf(version: DatasetVersion): Record<string, string[]> {
  const { columns } = classifier().classify(version)
  return Object.fromEntries([...columns].map(([column, ids]) => [column, [...ids].sort()]))
}

/** A version of `dataset` as a lake stores it, without reading the lake. */
function stored(dataset: DatasetDefinition, fields: Partial<DatasetVersion>): DatasetVersion {
  return {
    datasetId: dataset.id,
    versionId: "v1",
    mode: "snapshot",
    createdAt: new Date(0),
    schema: lakeDatasetDefinition(dataset).schema,
    ...fields,
  }
}

const everyMarking = ["financial", "pii"]

describe("dataset version markings", () => {
  test("a source version carries the markings its dataset declares", async () => {
    const { rawVersion } = await seedRaw()

    expect(markingsOf(rawVersion)).toEqual({
      id: [],
      title: [],
      amount: ["financial"],
      customer_tax_id: ["pii"],
    })
  })

  // Reproduce: drop the unregistered-dataset branch from classify; every column is unmarked.
  test("a version of a dataset no longer registered carries every declared marking", async () => {
    const lakeStorage = new InMemoryLakeStorage()
    const legacy = defineDataset("legacy_invoices", {
      schema: [col("id", "string"), col("title", "string")],
    })
    const version = await commit(lakeStorage, legacy, [{ id: "inv-1", title: "120" }])

    expect(classifier().classify(version).conservative).toBe(
      "dataset 'legacy_invoices' is not registered"
    )
    expect(markingsOf(version)).toEqual({ id: everyMarking, title: everyMarking })
  })

  test("a pipeline column carries the markings of its value and row dependencies", async () => {
    const { lakeStorage } = await seedRaw()
    // SELECT id, title, amount FROM invoices WHERE customer_tax_id IS NOT NULL
    const version = await commit(lakeStorage, normalizedInvoices, [invoiceRow], {
      lineage: {
        rows: [raw("customer_tax_id")],
        columns: { id: [raw("id")], title: [raw("title")], amount: [raw("amount")] },
      },
    })

    expect(markingsOf(version)).toEqual({
      id: ["pii"],
      title: ["pii"],
      amount: ["financial", "pii"],
    })
  })

  // Reproduce: classify a column the lineage does not list from the rows alone.
  test("a column the lineage does not list could hold anything", async () => {
    const { lakeStorage } = await seedRaw()
    const version = await commit(lakeStorage, normalizedInvoices, [invoiceRow], {
      lineage: { rows: [], columns: { id: [raw("id")], amount: [raw("amount")] } },
    })

    expect(markingsOf(version)).toEqual({ id: [], title: everyMarking, amount: ["financial"] })
    expect(classifier().classify(version).conservative).toBe(
      `version '${version.versionId}' of 'normalized_invoices' recorded no lineage for column 'title'`
    )

    // A column named like an Object.prototype member is not listed either.
    const unlisted = await commit(lakeStorage, notes, [{ id: "inv-1", constructor: "x" }], {
      lineage: { rows: [], columns: { id: [raw("id")] } },
    })
    expect(markingsOf(unlisted)).toEqual({ id: [], constructor: everyMarking })
  })

  test("a column computed from a dataset no longer registered could hold any marking", () => {
    // Reproduce: classify an unregistered ref like a registered column, which declares nothing.
    const hr = defineMarking("hr")
    const salaries = defineDataset("salaries", {
      schema: [col("id", "string"), col("salary", "decimal", { markings: [hr] })],
    })
    const version = stored(invoiceTitles, {
      producer: { kind: "pipeline", id: "invoices" },
      lineage: {
        rows: [],
        columns: { id: [raw("id")], title: [ref("legacy_invoices", "title")] },
      },
    })
    const markings = createDatasetVersionMarkings({
      datasets: { list: () => [...datasets, salaries] },
      lakeStorage: recording,
    }).classify(version)

    // The code that wrote it may have read `salaries`, which today's pipelines no longer read.
    expect(markings.columns.get("title")).toEqual(new Set(["financial", "hr", "pii"]))
    expect(markings.columns.get("id")).toEqual(new Set())
    expect(markings.conservative).toBe("dataset 'legacy_invoices' is not registered")
  })

  test("classifies from the version's own record, reading no other version", () => {
    // Computed from `raw_invoices.amount` two hops upstream; neither its inputs nor its parent
    // need to exist anywhere.
    const version = stored(invoiceTitles, {
      mode: "append",
      parentVersionId: "gone",
      inputs: [{ datasetId: normalizedInvoices.id, versionId: "gone" }],
      producer: { kind: "pipeline", id: "invoices" },
      lineage: {
        rows: [],
        columns: {
          id: [normalized("id"), raw("id")],
          title: [normalized("title"), raw("amount")],
        },
      },
    })

    expect(markingsOf(version)).toEqual({ id: [], title: ["financial"] })
    expect(classifier().classify(version).conservative).toBeUndefined()
  })

  // Reproduce: return no row markings from classify; `rows` is empty.
  test("what decided the rows marks the rows, and every column", () => {
    // SELECT id FROM raw_invoices WHERE customer_tax_id IS NOT NULL
    const version = stored(invoiceTitles, {
      producer: { kind: "pipeline", id: "invoices" },
      lineage: { rows: [raw("customer_tax_id")], columns: { id: [raw("id")], title: [] } },
    })

    expect(classifier().classify(version).rows).toEqual(new Set(["pii"]))
    expect(markingsOf(version)).toEqual({ id: ["pii"], title: ["pii"] })
    // A version whose lineage is unknown may have had its rows decided by anything.
    const unknown = stored(invoiceTitles, { producer: { kind: "pipeline", id: "invoices" } })
    expect(classifier().classify(unknown).rows).toEqual(new Set(everyMarking))
  })

  test("a version whose lineage is recorded as unknown could hold anything", () => {
    const version = stored(invoiceTitles, {
      producer: { kind: "sync", id: "erp" },
      lineage: { unknown: "version 'v0' of 'normalized_invoices' recorded no column lineage" },
    })

    expect(markingsOf(version)).toEqual({ id: everyMarking, title: everyMarking })
    expect(classifier().classify(version).conservative).toBe(
      "the lineage of version 'v1' of 'invoice_titles' is unknown: version 'v0' of 'normalized_invoices' recorded no column lineage"
    )
  })
})

describe("versions that record no lineage", () => {
  test("a pipeline version could hold anything", async () => {
    // Reproduce: read a pipeline version without lineage like a sync one; it carries nothing.
    const { lakeStorage } = await seedRaw()
    const version = await commit(lakeStorage, normalizedInvoices, [invoiceRow], {})

    expect(version.lineage).toBeUndefined()
    expect(markingsOf(version)).toEqual({
      id: everyMarking,
      title: everyMarking,
      amount: everyMarking,
    })
    expect(classifier().classify(version).conservative).toBe(
      `version '${version.versionId}' of 'normalized_invoices' recorded no column lineage`
    )
  })

  test("versions written outside pipelines carry only what their dataset declares", () => {
    // Written before Sixb recorded lineage. Their parents' rows are classified the same way, so
    // their history is not read.
    for (const fields of [
      { producer: { kind: "sync" as const, id: "erp" }, mode: "merge" as const },
      { producer: { kind: "ingest" as const, id: "exec-1" }, mode: "append" as const },
      { mode: "snapshot" as const },
    ]) {
      expect(markingsOf(stored(rawInvoices, { ...fields, parentVersionId: "gone" }))).toEqual({
        id: [],
        title: [],
        amount: ["financial"],
        customer_tax_id: ["pii"],
      })
    }
  })

  // Reproduce: drop the recordsLineage check from versionLineage; the merge carries only what
  // `invoice_titles` declares.
  test("a version of a provider that does not record lineage could hold anything", () => {
    // A sync merge on top of a pipeline version holds the pipeline's rows. A provider that drops
    // the lineage it is given stores none, as if the merge predated lineage.
    const version = stored(invoiceTitles, {
      producer: { kind: "sync", id: "erp" },
      mode: "merge",
      parentVersionId: "pipeline-version",
    })
    const markings = createDatasetVersionMarkings({
      datasets: { list: () => datasets },
      lakeStorage: {},
    }).classify(version)

    expect(markings.columns).toEqual(
      new Map([
        ["id", new Set(everyMarking)],
        ["title", new Set(everyMarking)],
      ])
    )
    expect(markings.conservative).toBe(
      "version 'v1' of 'invoice_titles' recorded no column lineage, and its lake provider does not declare that it records lineage"
    )
  })

  test("a lineage Sixb cannot read could hold anything", () => {
    // Reproduce: read a malformed lineage as absent; the sync version carries what it declares.
    const version = stored(invoiceTitles, {
      producer: { kind: "sync", id: "erp" },
      lineage: { rows: [], columns: { title: "amount" } } as unknown as DatasetColumnLineage,
    })

    expect(markingsOf(version)).toEqual({ id: everyMarking, title: everyMarking })
    expect(classifier().classify(version).conservative).toBe(
      "version 'v1' of 'invoice_titles' records a column lineage Sixb cannot read"
    )
  })
})

describe("dataset rows of pipeline versions", () => {
  const analysts = defineGroup("analysts")
  const reader = defineRole("normalized-reader", {
    grantedTo: [analysts],
    grants: [can.view(normalizedInvoices)],
  })

  async function seed(
    options: {
      readonly clearances?: readonly MarkingDefinition[]
      readonly datasets?: readonly DatasetDefinition[]
    } = {}
  ) {
    const deps = createTestRuntimeDeps()
    const clearances = options.clearances ?? []
    const host = new SixbHost({
      id: "dataset-version-markings",
      ontology: [],
      datasets: options.datasets ?? datasets,
      ...(options.datasets ? {} : { markings: [financial, pii] }),
      groups: [analysts],
      roles: [
        reader,
        ...(clearances.length > 0
          ? [defineRole("analyst-clearance", { grantedTo: [analysts], clearances })]
          : []),
      ],
      ...deps,
    })
    const { rawVersion } = await seedRaw(deps.lakeStorage)
    const analyst = createTestSixb(host, {
      authorization: resolveAuthorizationContext({
        principal: { type: "user", id: "analyst" },
        groupIds: [analysts.id],
        roles: host.definitions.security.listResolvedRoles(),
      }),
    })
    const calls = { classify: 0, versionLookups: [] as string[] }
    const markings = getDatasetVersionMarkings(host)
    const classify = markings.classify
    markings.classify = (version) => {
      calls.classify += 1
      return classify(version)
    }
    // A read looks up the version it reads; classifying it looks up no other.
    const lake = deps.lakeStorage
    const getVersion = lake.getVersion.bind(lake)
    const listVersions = lake.listVersions.bind(lake)
    lake.getVersion = (datasetId, versionId) => {
      calls.versionLookups.push(`${datasetId}/${versionId}`)
      return getVersion(datasetId, versionId)
    }
    lake.listVersions = (datasetId, limit) => {
      calls.versionLookups.push(`${datasetId}/*`)
      return listVersions(datasetId, limit)
    }
    return { host, lakeStorage: lake, rawVersion, analyst, calls }
  }

  /** A pipeline version without lineage: classified with every marking. */
  const unanalyzed = (lakeStorage: InMemoryLakeStorage) =>
    commit(lakeStorage, normalizedInvoices, [invoiceRow], {})

  test("a reader cleared for every declared marking reads without classifying", async () => {
    // Reproduce: drop the early return on `everyMarking()` in `redactedColumns`.
    const { lakeStorage, analyst, calls } = await seed({ clearances: [financial, pii] })
    await unanalyzed(lakeStorage)

    const result = await analyst.datasets.readRows(normalizedInvoices)
    expect(result?.columns).toEqual(["id", "title", "amount"])
    expect(result?.redactions).toBeUndefined()
    expect(calls.classify).toBe(0)
  })

  test("a project that marks no column reads without classifying", async () => {
    const unmarkedRaw = defineDataset("raw_invoices", {
      schema: rawInvoices.schema.columns.map(({ markings: _markings, ...column }) => column),
    })
    const { lakeStorage, analyst, calls } = await seed({
      datasets: [unmarkedRaw, normalizedInvoices, invoiceTitles],
    })
    await unanalyzed(lakeStorage)

    const result = await analyst.datasets.readRows(normalizedInvoices)
    expect(result?.redactions).toBeUndefined()
    expect(calls.classify).toBe(0)
  })

  test("a reader cleared for some markings classifies the version, reading no other", async () => {
    // Reproduce: classify a version from the versions it was computed from; the lake is asked
    // for them.
    const { lakeStorage, rawVersion, analyst, calls } = await seed({ clearances: [financial] })
    // SELECT id, title, amount FROM invoices WHERE customer_tax_id IS NOT NULL
    const version = await commit(lakeStorage, normalizedInvoices, [invoiceRow], {
      inputs: [rawVersion],
      lineage: {
        rows: [raw("customer_tax_id")],
        columns: { id: [raw("id")], title: [raw("title")], amount: [raw("amount")] },
      },
    })

    // Which rows it holds reveals tax ids, which the reader is not cleared for.
    await expect(analyst.datasets.readRows(normalizedInvoices)).rejects.toThrow(
      `[Sixb] Cannot read the rows of version '${version.versionId}' of dataset 'normalized_invoices': which rows it holds was decided by columns that require clearance for marking 'pii'.`
    )
    expect(calls.classify).toBe(1)
    expect(new Set(calls.versionLookups)).toEqual(
      new Set([`${normalizedInvoices.id}/${version.versionId}`])
    )
  })

  test("redaction follows the markings of the version read", async () => {
    const { lakeStorage, analyst } = await seed()
    const before = await unanalyzed(lakeStorage)
    const after = await commit(lakeStorage, normalizedInvoices, [invoiceRow], {
      lineage: {
        rows: [],
        columns: { id: [raw("id")], title: [raw("title")], amount: [raw("amount")] },
      },
    })

    // Recorded no lineage: anything may have decided its rows.
    await expect(
      analyst.datasets.readRows(normalizedInvoices, { versionId: before.versionId })
    ).rejects.toMatchObject({ name: "AuthorizationError", grantKey: "clearance:marking:financial" })

    const latest = await analyst.datasets.readRows(normalizedInvoices)
    expect(latest?.version.versionId).toBe(after.versionId)
    expect(latest?.columns).toEqual(["id", "title"])
    expect(latest?.redactions).toEqual({ amount: { reason: "missing_clearance" } })
  })

  test("trusted reads do not classify", async () => {
    const { host, lakeStorage, calls } = await seed()
    await unanalyzed(lakeStorage)

    const result = await createTestSixb(host).datasets.readRows(normalizedInvoices)
    expect(result?.redactions).toBeUndefined()
    expect(result?.columns).toEqual(["id", "title", "amount"])
    expect(calls.classify).toBe(0)
  })
})

describe("projection version markings", () => {
  const Invoice = defineObjectType({
    id: "Invoice",
    name: "Invoice",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("title", "string"),
      prop("amount", "decimal", { markings: [financial] }),
    ],
  })
  const projection = defineProjection("invoices", Invoice)
    .fromDataset(normalizedInvoices)
    .properties({ id: "id", title: "title", amount: "amount" })

  async function seed() {
    const deps = createTestRuntimeDeps()
    const host = new SixbHost({
      id: "projection-version-markings",
      ontology: [Invoice],
      datasets,
      projections: [projection],
      markings: [financial, pii],
      ...deps,
    })
    await seedRaw(deps.lakeStorage)
    const check = async (version: DatasetVersion) =>
      assertProjectionVersionMarkings({
        projection: host.definitions.projections.getById("invoices")!,
        ontology: host.definitions.ontology,
        version,
        classification: getDatasetVersionMarkings(host).classify(version),
      })
    return { lakeStorage: deps.lakeStorage, check }
  }

  test("a version whose columns carry no more than the properties declare is projected", async () => {
    const { lakeStorage, check } = await seed()
    const version = await commit(lakeStorage, normalizedInvoices, [invoiceRow], {
      lineage: {
        rows: [],
        columns: { id: [raw("id")], title: [raw("title")], amount: [raw("amount")] },
      },
    })

    await check(version)
  })

  test("a version whose property column carries undeclared markings is refused", async () => {
    const { lakeStorage, check } = await seed()
    const version = await commit(lakeStorage, normalizedInvoices, [invoiceRow], {
      lineage: {
        rows: [],
        columns: { id: [raw("id")], title: [raw("customer_tax_id")], amount: [raw("amount")] },
      },
    })

    await expect(check(version)).rejects.toThrow(
      `[Sixb] Projection 'invoices' cannot read version '${version.versionId}' of dataset 'normalized_invoices': property 'Invoice.title' is projected from column 'normalized_invoices.title', which carries [pii] in this version. Add markings: [pii] to the property. If the code that writes 'normalized_invoices' no longer derives these markings, rerun its pipeline.`
    )
  })

  test("a version whose id column carries markings is refused", async () => {
    const { lakeStorage, check } = await seed()
    const version = await commit(lakeStorage, normalizedInvoices, [invoiceRow], {})

    await expect(check(version)).rejects.toThrow(
      `[Sixb] Projection 'invoices' cannot read version '${version.versionId}' of dataset 'normalized_invoices': column 'normalized_invoices.id' becomes the id of 'Invoice' and cannot carry markings, but carries [financial, pii] in this version. The version was classified with every marking its sources could hold, because version '${version.versionId}' of 'normalized_invoices' recorded no column lineage. If the code that writes 'normalized_invoices' no longer derives these markings, rerun its pipeline.`
    )
  })
})
