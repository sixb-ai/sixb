import { describe, expect, test } from "bun:test"
import { col, type DatasetDefinition, type DatasetRow, defineDataset, defineMarking } from "../src"
import {
  type BeginDatasetWriteInput,
  type DatasetColumnLineage,
  type DatasetVersion,
  hasDatasetProvenanceChanges,
  InMemoryLakeStorage,
  lineageAtCommit,
  resolveStepLineage,
} from "../src/lake-storage"
import { createDatasetVersionMarkings } from "../src/security/dataset-version-markings"

const financial = defineMarking("financial")

// The worked example: a sync merges invoices, a SQL step normalizes them, and an append step
// keeps a history of the normalized titles.
const rawInvoices = defineDataset("raw_invoices", {
  schema: [
    col("id", "string"),
    col("title", "string"),
    col("amount", "decimal", { markings: [financial] }),
  ],
  primaryKey: "id",
})
const normalized = defineDataset("normalized", {
  schema: [col("id", "string"), col("title", "string")],
})
const history = defineDataset("history", {
  schema: [col("id", "string"), col("title", "string")],
})
const datasets = [rawInvoices, normalized, history]

const ref = (datasetId: string, column: string) => ({ datasetId, column })
const raw = (column: string) => ref("raw_invoices", column)
const norm = (column: string) => ref("normalized", column)
const pipeline = { kind: "pipeline", id: "invoices" } as const

/** `SELECT id, <title> AS title FROM normalized` or from raw_invoices, as a provider analyzes it. */
const selects = (datasetId: string, title: string): DatasetColumnLineage => ({
  rows: [],
  columns: { id: [ref(datasetId, "id")], title: [ref(datasetId, title)] },
})

async function commit(
  lake: InMemoryLakeStorage,
  dataset: DatasetDefinition,
  rows: readonly DatasetRow[],
  write: Omit<BeginDatasetWriteInput, "dataset"> = {}
): Promise<DatasetVersion> {
  await lake.createDataset(dataset)
  const session = await lake.beginWrite({ dataset, ...write })
  await session.writeRows(rows)
  const { outcome: _outcome, ...version } = await session.commit()

  return version
}

/** Runs a pipeline step the way the worker does: its own lineage, resolved through its inputs. */
function step(
  lake: InMemoryLakeStorage,
  dataset: DatasetDefinition,
  rows: readonly DatasetRow[],
  own: DatasetColumnLineage,
  inputs: readonly DatasetVersion[],
  mode: "snapshot" | "append" = "snapshot"
) {
  return commit(lake, dataset, rows, {
    mode,
    producer: pipeline,
    inputs: inputs.map(({ datasetId, versionId }) => ({ datasetId, versionId })),
    lineage: resolveStepLineage(own, inputs),
  })
}

const classify = (version: DatasetVersion) =>
  Object.fromEntries(
    [
      ...createDatasetVersionMarkings({
        datasets: { list: () => datasets },
        lakeStorage: { recordsLineage: true },
      }).classify(version).columns,
    ].map(([column, markings]) => [column, [...markings]])
  )

async function syncRawInvoices(lake: InMemoryLakeStorage, id: string) {
  await lake.createDataset(rawInvoices)
  const merge = await lake.beginMerge({
    dataset: rawInvoices,
    producer: { kind: "sync", id: "erp" },
  })
  await merge.writeChanges([
    { kind: "upsert", row: { id, title: `Invoice ${id}`, amount: "120.00" } },
  ])

  const result = await merge.commit()
  if (result.outcome !== "created") throw new Error("Expected the sync to commit a version.")
  return result.version
}

describe("resolved lineage of the worked example", () => {
  // Reproduce: in lineageAtCommit, return the written lineage for an append. Day 2 of the
  // history loses `raw_invoices.amount` and its title is no longer marked.
  test("an append history keeps the markings of what it holds until rewritten in snapshot mode", async () => {
    const lake = new InMemoryLakeStorage()

    // Day 1: the step writes the amount into the title.
    const raw1 = await syncRawInvoices(lake, "inv-1")
    const normalized1 = await step(
      lake,
      normalized,
      [{ id: "inv-1", title: "120.00" }],
      selects("raw_invoices", "amount"),
      [raw1]
    )
    expect(normalized1.lineage).toEqual({
      rows: [],
      columns: { id: [raw("id")], title: [raw("amount")] },
    })

    const history1 = await step(
      lake,
      history,
      [{ id: "inv-1", title: "120.00" }],
      selects("normalized", "title"),
      [normalized1],
      "append"
    )
    expect(history1.lineage).toEqual({
      rows: [],
      columns: { id: [norm("id"), raw("id")], title: [norm("title"), raw("amount")] },
    })

    // Day 2: the step is fixed.
    const raw2 = await syncRawInvoices(lake, "inv-2")
    const normalized2 = await step(
      lake,
      normalized,
      [
        { id: "inv-1", title: "Invoice inv-1" },
        { id: "inv-2", title: "Invoice inv-2" },
      ],
      selects("raw_invoices", "title"),
      [raw2]
    )
    expect(normalized2.lineage).toEqual({
      rows: [],
      columns: { id: [raw("id")], title: [raw("title")] },
    })

    const history2 = await step(
      lake,
      history,
      [{ id: "inv-2", title: "Invoice inv-2" }],
      selects("normalized", "title"),
      [normalized2],
      "append"
    )
    // The rows appended on day 1 still hold amounts.
    expect(history2.lineage).toEqual({
      rows: [],
      columns: {
        id: [norm("id"), raw("id")],
        title: [norm("title"), raw("amount"), raw("title")],
      },
    })

    expect(classify(normalized2)).toEqual({ id: [], title: [] })
    expect(classify(history2)).toEqual({ id: [], title: ["financial"] })

    // Rewritten in snapshot mode, the history holds no amount anymore.
    const rewritten = await step(
      lake,
      history,
      [{ id: "inv-2", title: "Invoice inv-2" }],
      selects("normalized", "title"),
      [normalized2]
    )
    expect(classify(rewritten)).toEqual({ id: [], title: [] })
  })

  test("classifies each version from its own record, whatever the lake still holds", async () => {
    const lake = new InMemoryLakeStorage()
    const raw1 = await syncRawInvoices(lake, "inv-1")
    const normalized1 = await step(lake, normalized, [], selects("raw_invoices", "amount"), [raw1])
    const history1 = await step(lake, history, [], selects("normalized", "title"), [normalized1])

    // A lake that dropped every other version, as cleanup may: the record is all there is.
    const { inputs: _inputs, ...alone } = history1
    expect(classify(alone)).toEqual({ id: [], title: ["financial"] })
  })
})

describe("lineage at commit", () => {
  const schema = normalized.schema
  const known = (title: readonly ReturnType<typeof ref>[]) => ({
    rows: [],
    columns: { id: [raw("id")], title },
  })
  const version = (fields: Partial<DatasetVersion>): DatasetVersion => ({
    datasetId: normalized.id,
    versionId: "parent",
    mode: "snapshot",
    createdAt: new Date(0),
    schema,
    ...fields,
  })

  test("a snapshot records what was written and nothing of its parent", () => {
    // Reproduce: merge the parent's lineage for every mode; the snapshot keeps `amount`.
    const parent = version({ producer: pipeline, lineage: known([raw("amount")]) })
    expect(
      lineageAtCommit({
        mode: "snapshot",
        schema,
        producer: pipeline,
        written: known([raw("title")]),
        parent,
      })
    ).toEqual(known([raw("title")]))
  })

  test("an append merges its parent's lineage, rows included", () => {
    const parent = version({
      producer: pipeline,
      lineage: { rows: [raw("amount")], columns: { id: [raw("id")], title: [raw("title")] } },
    })
    expect(
      lineageAtCommit({
        mode: "append",
        schema,
        producer: pipeline,
        written: known([raw("id")]),
        parent,
      })
    ).toEqual({
      rows: [raw("amount")],
      columns: { id: [raw("id")], title: [raw("id"), raw("title")] },
    })
  })

  test("a schema change keeps its parent's lineage; a column it adds holds nothing yet", () => {
    // Reproduce: give a schema version the lineage of its own columns; it loses `amount`.
    const widened = { columns: [...schema.columns, { name: "note", type: "string" as const }] }
    const parent = version({ producer: pipeline, lineage: known([raw("amount")]) })

    expect(lineageAtCommit({ mode: "schema", schema: widened, parent })).toEqual({
      rows: [],
      columns: { id: [raw("id")], note: [], title: [raw("amount")] },
    })
    expect(lineageAtCommit({ mode: "schema", schema: widened })).toEqual({
      rows: [],
      columns: { id: [], note: [], title: [] },
    })
  })

  test("a column the written lineage or the parent does not list stays unlisted", () => {
    const parent = version({
      producer: pipeline,
      lineage: { rows: [], columns: { id: [raw("id")] } },
    })
    expect(
      lineageAtCommit({
        mode: "append",
        schema,
        producer: pipeline,
        written: known([raw("title")]),
        parent,
      })
    ).toEqual({ rows: [], columns: { id: [raw("id")] } })
  })

  test("a pipeline write without lineage records none; any other write its own columns", () => {
    expect(lineageAtCommit({ mode: "snapshot", schema, producer: pipeline })).toBeUndefined()
    expect(
      lineageAtCommit({ mode: "append", schema, producer: pipeline, parent: version({}) })
    ).toBeUndefined()
    expect(
      lineageAtCommit({ mode: "merge", schema, producer: { kind: "sync", id: "erp" } })
    ).toEqual({ rows: [], columns: { id: [], title: [] } })
  })

  test("keeping rows of a parent without known lineage records an unknown history", () => {
    // Reproduce: read a pipeline parent without lineage like a sync one; the merge records
    // only its own columns and the rows it keeps lose their markings.
    const legacy = version({ producer: pipeline })
    const unknown = { unknown: "version 'parent' of 'normalized' recorded no column lineage" }
    const sync = { kind: "sync", id: "erp" } as const

    expect(lineageAtCommit({ mode: "merge", schema, producer: sync, parent: legacy })).toEqual(
      unknown
    )

    // It propagates as is, naming where the lineage was lost.
    const inherited = version({ producer: sync, lineage: unknown, versionId: "child" })
    expect(
      lineageAtCommit({
        mode: "append",
        schema,
        producer: pipeline,
        written: known([raw("title")]),
        parent: inherited,
      })
    ).toEqual(unknown)
    expect(lineageAtCommit({ mode: "schema", schema, parent: inherited })).toEqual(unknown)

    // A sync parent recorded before Sixb recorded lineage holds its own columns only.
    expect(
      lineageAtCommit({
        mode: "merge",
        schema,
        producer: sync,
        parent: version({ producer: sync }),
      })
    ).toEqual({ rows: [], columns: { id: [], title: [] } })
  })

  test("a stored lineage Sixb cannot read is unknown, and a malformed written one is refused", () => {
    // Reproduce: read a malformed stored lineage as absent; the merge keeps own columns only.
    const corrupt = version({
      producer: { kind: "sync", id: "erp" },
      lineage: { rows: "everything" } as unknown as DatasetColumnLineage,
    })
    expect(lineageAtCommit({ mode: "merge", schema, parent: corrupt })).toEqual({
      unknown: "version 'parent' of 'normalized' records a column lineage Sixb cannot read",
    })
    expect(() =>
      lineageAtCommit({
        mode: "snapshot",
        schema,
        written: { rows: [], columns: { id: [{ datasetId: "x" }] } } as never,
      })
    ).toThrow("[SixbLake] The column lineage passed to the write is malformed.")
  })
})

describe("resolving a step's lineage through its inputs", () => {
  const input = (fields: Partial<DatasetVersion>): DatasetVersion => ({
    datasetId: rawInvoices.id,
    versionId: "raw-1",
    mode: "snapshot",
    createdAt: new Date(0),
    schema: rawInvoices.schema,
    ...fields,
  })
  const copiesTitle = selects("raw_invoices", "title")

  test("each ref stands for itself and what its input records for it", () => {
    const computed = input({
      producer: pipeline,
      lineage: {
        rows: [ref("upstream", "tenant")],
        columns: { id: [ref("upstream", "id")], title: [ref("upstream", "amount")], amount: [] },
      },
    })
    expect(
      resolveStepLineage({ rows: [raw("amount")], columns: copiesTitle.columns }, [computed])
    ).toEqual({
      // Every column depends on the input's rows, so no column lists them again.
      rows: [raw("amount"), ref("upstream", "tenant")],
      columns: {
        id: [raw("id"), ref("upstream", "id")],
        title: [raw("title"), ref("upstream", "amount")],
      },
    })
  })

  test("a sync input recorded before Sixb recorded lineage stands for the ref alone", () => {
    expect(
      resolveStepLineage(copiesTitle, [input({ producer: { kind: "sync", id: "erp" } })])
    ).toEqual(copiesTitle)
  })

  test("an input whose lineage is unknown makes the output's unknown", () => {
    // Reproduce: resolve a legacy pipeline input like a sync one; its output classifies from
    // the refs alone.
    expect(resolveStepLineage(copiesTitle, [input({ producer: pipeline })])).toEqual({
      unknown: "version 'raw-1' of 'raw_invoices' recorded no column lineage",
    })
    const inherited = { unknown: "version 'v0' of 'upstream' recorded no column lineage" }
    expect(
      resolveStepLineage(copiesTitle, [input({ producer: pipeline, lineage: inherited })])
    ).toEqual(inherited)
    expect(
      resolveStepLineage(copiesTitle, [
        input({ producer: pipeline, lineage: { rows: [], columns: { id: [] } } }),
      ])
    ).toEqual({
      unknown: "version 'raw-1' of 'raw_invoices' recorded no lineage for column 'title'",
    })
    expect(resolveStepLineage(copiesTitle, [])).toEqual({
      unknown: "a pipeline step read 'raw_invoices' without recording which version",
    })
    expect(() => resolveStepLineage({ rows: [] } as never, [])).toThrow(
      "[SixbLake] A pipeline step's column lineage is malformed."
    )
  })

  describe("every output column depends on the rows of every input read", () => {
    // `rich` holds the invoices whose amount exceeds 100: its rows depend on the amount.
    const rich = input({
      datasetId: "rich",
      producer: pipeline,
      lineage: { rows: [raw("amount")], columns: { id: [raw("id")], title: [raw("title")] } },
    })
    const count = { rows: [], columns: { n: [] } }

    // Reproduce: drop the loop over `inputs` in resolveStepLineage; the count and the constants
    // record no dependency at all, and read unmarked.
    test("SELECT count(*) FROM rich", () => {
      const lineage = resolveStepLineage(count, [rich])
      expect(lineage).toEqual({ rows: [raw("amount")], columns: { n: [] } })

      const counted = { ...asVersion({ rows: [], columns: {} }), lineage }
      const counts = defineDataset("counts", { schema: [col("n", "int64")] })
      const markings = createDatasetVersionMarkings({
        datasets: { list: () => [...datasets, counts] },
        lakeStorage: { recordsLineage: true },
      })

      expect(
        markings.classify({ ...counted, datasetId: counts.id, schema: counts.schema }).columns
      ).toEqual(new Map([["n", new Set(["financial"])]]))
    })

    test("a constant selected from rich, alone or in a union", () => {
      expect(resolveStepLineage({ rows: [], columns: { flag: [] } }, [rich])).toEqual({
        rows: [raw("amount")],
        columns: { flag: [] },
      })

      // SELECT 'x' AS flag FROM rich UNION ALL SELECT title FROM raw_invoices
      const synced = input({ producer: { kind: "sync", id: "erp" } })
      expect(
        resolveStepLineage({ rows: [], columns: { flag: [raw("title")] } }, [rich, synced])
      ).toEqual({ rows: [raw("amount")], columns: { flag: [raw("title")] } })
    })

    test("an input whose lineage is unknown makes it unknown, named or not", () => {
      const legacy = input({ datasetId: "legacy", versionId: "l1", producer: pipeline })
      expect(resolveStepLineage(count, [legacy])).toEqual({
        unknown: "version 'l1' of 'legacy' recorded no column lineage",
      })
    })
  })
})

describe("canonical lineage", () => {
  // Reproduce: drop `exclude` from canonicalRefs; each row ref is listed again in every column.
  test("a column lists only what it depends on beyond the rows", () => {
    expect(
      lineageAtCommit({
        mode: "snapshot",
        schema: history.schema,
        producer: pipeline,
        written: { rows: [raw("amount")], columns: { id: [raw("amount"), raw("id")], title: [] } },
      })
    ).toEqual({ rows: [raw("amount")], columns: { id: [raw("id")], title: [] } })
  })

  // Reproduce: drop `exclude` from canonicalRefs. Classification is unchanged, but a lineage
  // listing its row refs in its columns no longer compares equal to the stored one.
  test("classifies, merges, resolves and compares as the lineage it was made from", () => {
    // A deterministic generator: the same lineages on every run.
    let seed = 7
    const next = (bound: number) => {
      seed = (seed * 48271) % 2147483647
      return seed % bound
    }

    const pool = [raw("id"), raw("title"), raw("amount"), norm("id"), norm("title"), ref("x", "y")]
    const refsOf = (max: number) =>
      Array.from({ length: next(max + 1) }, () => pool[next(pool.length)]!)
    const random = (): DatasetColumnLineage => ({
      rows: refsOf(3),
      columns: { id: refsOf(4), title: refsOf(4) },
    })

    const stored = (written: DatasetColumnLineage, parent?: DatasetColumnLineage) =>
      lineageAtCommit({
        mode: parent ? "append" : "snapshot",
        schema: history.schema,
        producer: pipeline,
        written,
        ...(parent && { parent: asVersion(parent) }),
      }) as DatasetColumnLineage

    /** Rows folded into every column, without dropping repeats: what the lineage means. */
    const flat = (...lineages: DatasetColumnLineage[]) => {
      const rows = lineages.flatMap((lineage) => lineage.rows)
      const column = (name: string) =>
        lineages.flatMap((lineage) => [...rows, ...(lineage.columns[name] ?? [])])

      return { rows, columns: { id: column("id"), title: column("title") } }
    }

    const step = {
      rows: [ref(history.id, "title")],
      columns: { id: [ref(history.id, "id")], title: [] },
    }

    for (let i = 0; i < 300; i += 1) {
      const written = random()
      const parent = random()
      const canonical = stored(written)

      expect(classify(asVersion(canonical))).toEqual(classify(asVersion(flat(written))))
      expect(hasDatasetProvenanceChanges(asVersion(canonical), asVersion(flat(written)))).toBe(
        false
      )

      const appended = stored(written, parent)
      expect(appended).toEqual(stored(written, stored(parent)))
      expect(classify(asVersion(appended))).toEqual(classify(asVersion(flat(written, parent))))

      expect(
        classify(
          asVersion(resolveStepLineage(step, [asVersion(canonical)]) as DatasetColumnLineage)
        )
      ).toEqual(
        classify(
          asVersion(resolveStepLineage(step, [asVersion(flat(written))]) as DatasetColumnLineage)
        )
      )
    }
  })
})

function asVersion(lineage: DatasetColumnLineage): DatasetVersion {
  return {
    datasetId: history.id,
    versionId: "v",
    mode: "snapshot",
    createdAt: new Date(0),
    schema: history.schema,
    producer: pipeline,
    lineage,
  }
}

describe("provenance changes", () => {
  const latest = (fields: Partial<DatasetVersion>): DatasetVersion => ({
    datasetId: normalized.id,
    versionId: "latest",
    mode: "snapshot",
    createdAt: new Date(0),
    schema: normalized.schema,
    ...fields,
  })
  const next = (fields: Partial<DatasetVersion>) => ({
    datasetId: normalized.id,
    schema: normalized.schema,
    ...fields,
  })
  const lineage = { rows: [], columns: { id: [raw("id")], title: [raw("title"), raw("id")] } }

  test("compares the lineage a commit would store, whatever its order and repetition", () => {
    const reordered = {
      rows: [],
      columns: { title: [raw("id"), raw("title"), raw("id")], id: [raw("id")] },
    }
    expect(
      hasDatasetProvenanceChanges(
        latest({ producer: pipeline, lineage }),
        next({ producer: pipeline, lineage: reordered })
      )
    ).toBe(false)
    expect(
      hasDatasetProvenanceChanges(
        latest({ producer: pipeline, lineage }),
        next({ producer: pipeline, lineage: { ...lineage, rows: [raw("amount")] } })
      )
    ).toBe(true)
  })

  test("an unknown lineage differs from a known one, and not from another unknown one", () => {
    // Reproduce: compare unknown lineages by their reason; a rerun over the same unknown history
    // writes a new version each time.
    const unknown = { unknown: "version 'v0' of 'normalized' recorded no column lineage" }

    expect(
      hasDatasetProvenanceChanges(
        latest({ producer: pipeline, lineage }),
        next({ producer: pipeline, lineage: unknown })
      )
    ).toBe(true)
    expect(
      hasDatasetProvenanceChanges(latest({ producer: pipeline }), next({ producer: pipeline }))
    ).toBe(false)
    expect(
      hasDatasetProvenanceChanges(
        latest({ producer: pipeline }),
        next({ producer: pipeline, lineage: { unknown: "elsewhere" } })
      )
    ).toBe(false)
    expect(
      hasDatasetProvenanceChanges(
        latest({ producer: pipeline }),
        next({ producer: pipeline, lineage })
      )
    ).toBe(true)
  })

  test("a sync version recorded before Sixb recorded lineage is reused for the same rows", () => {
    const sync = { kind: "sync", id: "erp" } as const
    expect(
      hasDatasetProvenanceChanges(
        latest({ producer: sync }),
        next({ producer: sync, lineage: { rows: [], columns: { id: [], title: [] } } })
      )
    ).toBe(false)
  })
})
