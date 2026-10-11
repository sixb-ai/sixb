import { describe, expect, test } from "bun:test"
import {
  col,
  type DatasetDefinition,
  type DatasetRow,
  defineDataset,
  defineMarking,
  defineObjectType,
  defineProjection,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import { ProjectionRunDispatcher } from "@sixb/core/internal/projections"
import type {
  BeginDatasetWriteInput,
  DatasetColumnLineage,
  DatasetVersion,
} from "@sixb/core/lake-storage"
import type { ProjectionRunRecord } from "@sixb/core/storage"
import { ProjectionWorker } from "../src"

const financial = defineMarking("financial")

const rawInvoices = defineDataset("raw_invoices", {
  schema: [
    col("id", "string"),
    col("title", "string"),
    col("amount", "decimal", { markings: [financial] }),
  ],
})
const unmarkedRawInvoices = defineDataset("raw_invoices", {
  schema: [col("id", "string"), col("title", "string"), col("amount", "decimal")],
})
const invoices = defineDataset("invoices", {
  schema: [col("id", "string"), col("title", "string"), col("amount", "decimal")],
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string"),
    prop("amount", "decimal", { markings: [financial] }),
  ],
})
const invoiceProjection = defineProjection("invoices", Invoice)
  .fromDataset(invoices)
  .properties({ id: "id", title: "title", amount: "amount" })

/** The pipeline versions below are committed as a pipeline worker would commit them. */
function createHost(raw: DatasetDefinition = rawInvoices) {
  return new SixbHost({
    id: "projection-version-markings",
    ontology: [Invoice],
    markings: [financial],
    datasets: [raw, invoices],
    projections: [invoiceProjection],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
}

type Host = ReturnType<typeof createHost>

const RAW_INVOICE = { id: "inv-1", title: "July maintenance", amount: "120" }

/** What a pipeline version of `invoices` holds, and the lineage it records if any. */
interface PipelineOutput {
  readonly rows: readonly DatasetRow[]
  readonly lineage?: DatasetColumnLineage
}

const exactCopy: PipelineOutput = {
  rows: [RAW_INVOICE],
  lineage: copies({ id: "id", title: "title", amount: "amount" }),
}
const amountInTitle: PipelineOutput = {
  rows: [{ ...RAW_INVOICE, title: RAW_INVOICE.amount }],
  lineage: copies({ id: "id", title: "amount", amount: "amount" }),
}
const withoutLineage: PipelineOutput = { rows: [RAW_INVOICE] }

/** `{ title: "amount" }`: each output column copies one column of `raw_invoices`. */
function copies(columns: Readonly<Record<string, string>>): DatasetColumnLineage {
  return {
    rows: [],
    columns: Object.fromEntries(
      Object.entries(columns).map(([output, input]) => [
        output,
        [{ datasetId: "raw_invoices", column: input }],
      ])
    ),
  }
}

/** Commits a `raw_invoices` version, then the `invoices` version the pipeline computed from it. */
async function commitPipelineVersion(sixb: Host, output: PipelineOutput): Promise<DatasetVersion> {
  const raw = await commitVersion(sixb, rawInvoices, [RAW_INVOICE], {
    producer: { kind: "sync", id: "invoices-sync" },
  })
  return commitVersion(sixb, invoices, output.rows, {
    inputs: [{ datasetId: raw.datasetId, versionId: raw.versionId }],
    producer: { kind: "pipeline", id: "invoices", stepId: "normalize-invoices" },
    // `raw_invoices` holds what it declares, so this lineage is resolved already.
    ...(output.lineage ? { lineage: output.lineage } : {}),
  })
}

async function commitVersion(
  sixb: Host,
  dataset: DatasetDefinition,
  rows: readonly DatasetRow[],
  write: Pick<BeginDatasetWriteInput, "producer" | "inputs" | "lineage">
): Promise<DatasetVersion> {
  await sixb.lakeStorage.createDataset(dataset)
  const writer = await sixb.lakeStorage.beginWrite({ dataset, mode: "snapshot", ...write })
  await writer.writeRows(rows)
  const { outcome: _outcome, ...version } = await writer.commit({ commitMessage: dataset.id })
  return version
}

/** Projects the version with a running worker, counting how the queue job ended. */
async function project(sixb: Host, version: DatasetVersion) {
  const { runId } = await new ProjectionRunDispatcher(sixb).dispatch({
    projectionId: invoiceProjection.id,
    datasetVersion: {
      datasetId: version.datasetId,
      versionId: version.versionId,
      createdAt: version.createdAt.toISOString(),
    },
  })
  const queue = { failed: 0, retried: 0 }
  const projections = sixb.queues.projections
  const fail = projections.fail.bind(projections)
  const retry = projections.retry.bind(projections)
  projections.fail = async (input) => {
    queue.failed += 1
    return fail(input)
  }
  projections.retry = async (input) => {
    queue.retried += 1
    return retry(input)
  }

  const worker = new ProjectionWorker(sixb)
  await worker.start()
  try {
    return { run: await waitForSettledRun(sixb, runId), queue }
  } finally {
    await worker.stop()
    projections.fail = fail
    projections.retry = retry
  }
}

async function waitForSettledRun(sixb: Host, runId: string): Promise<ProjectionRunRecord> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 2_000) {
    const run = await sixb.storage.projectionRuns?.getById({ projectId: sixb.id, id: runId })
    if (run?.status === "succeeded" || run?.status === "failed") return run
    await Bun.sleep(20)
  }
  throw new Error(`Projection run '${runId}' did not settle.`)
}

function readInvoice(sixb: Host) {
  return sixb.storage.objects.getByPrimaryId({
    projectId: sixb.id,
    objectTypeId: Invoice.id,
    primaryId: RAW_INVOICE.id,
  })
}

// Reproduce: remove `validatePinnedMarkings` from `validateProjectionJob`; every refusal below
// projects instead.
describe("projecting a pipeline version", () => {
  test("refuses for good a version that copies a marked column into an unmarked property", async () => {
    const sixb = createHost()
    const version = await commitPipelineVersion(sixb, amountInTitle)

    const { run, queue } = await project(sixb, version)

    expect(run).toMatchObject({
      status: "failed",
      error: {
        code: "projection.execution_failed",
        retryable: false,
        message: `Projection execution failed. [Sixb] Projection 'invoices' cannot read version '${version.versionId}' of dataset 'invoices': property 'Invoice.title' is projected from column 'invoices.title', which carries [financial] in this version. Add markings: [financial] to the property. If the code that writes 'invoices' no longer derives these markings, rerun its pipeline.`,
      },
    })
    expect(queue).toEqual({ failed: 1, retried: 0 })
    expect(await readInvoice(sixb)).toBeNull()
  })

  test("projects a version whose marked values stay in marked properties", async () => {
    const sixb = createHost()

    const { run } = await project(sixb, await commitPipelineVersion(sixb, exactCopy))

    expect(run.status).toBe("succeeded")
    expect(await readInvoice(sixb)).toMatchObject({ properties: RAW_INVOICE })
  })

  test("checks the version an incremental run moves to", async () => {
    const sixb = createHost()
    await project(sixb, await commitPipelineVersion(sixb, exactCopy))
    const leaking = await commitPipelineVersion(sixb, amountInTitle)

    const { run } = await project(sixb, leaking)

    expect(run.status).toBe("failed")
    expect(run.error?.message).toContain(`cannot read version '${leaking.versionId}'`)
    expect(await readInvoice(sixb)).toMatchObject({ properties: RAW_INVOICE })
  })

  test("refuses a version without lineage over marked inputs, whose id carries them too", async () => {
    const sixb = createHost()

    const { run } = await project(sixb, await commitPipelineVersion(sixb, withoutLineage))

    expect(run.status).toBe("failed")
    expect(run.error?.message).toContain(
      "column 'invoices.id' becomes the id of 'Invoice' and cannot carry markings, but carries [financial] in this version."
    )
  })

  test("projects a version without lineage over unmarked inputs", async () => {
    const sixb = createHost(unmarkedRawInvoices)

    const { run } = await project(sixb, await commitPipelineVersion(sixb, withoutLineage))

    expect(run.status).toBe("succeeded")
  })
})
