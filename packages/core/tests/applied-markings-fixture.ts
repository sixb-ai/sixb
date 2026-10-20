import {
  type AuthorizationContext,
  can,
  col,
  type DatasetDefinition,
  type DatasetRow,
  defineAction,
  defineDataset,
  defineGroup,
  defineMarking,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineProjection,
  defineRole,
  link,
  type ProjectionDefinition,
  project,
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
import { getProjectionRegistry } from "../src/projections/internal"
import type { ActiveOntologySource } from "../src/storage/ontology"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A finance project whose invoice titles were once computed from amounts. Each test applies a
// dataset version to the `invoices` projection and reads the objects it wrote.

export const projectId = "applied-markings"

export const financial = defineMarking("financial")
export const pii = defineMarking("pii")

export const rawInvoices = defineDataset("raw_invoices", {
  schema: [
    col("id", "string"),
    col("customer_id", "string"),
    col("title", "string"),
    col("amount", "decimal", { markings: [financial] }),
    col("updated_at", "timestamp"),
  ],
})

export const invoicesNormalized = defineDataset("invoices_normalized", {
  schema: [
    col("id", "string"),
    col("customer_id", "string"),
    col("title", "string"),
    col("amount", "decimal"),
    col("updated_at", "timestamp"),
  ],
})

// Names the pipeline that writes `invoices_normalized`. Tests commit its versions directly, with
// the lineage they give them, as the step would have computed them.
const normalize = definePipelineStep("normalize-invoices")
  .inputs({ invoices: rawInvoices.pick("id", "customer_id", "title", "updated_at") })
  .output(invoicesNormalized)
  .sql(({ invoices }) => `SELECT id, customer_id, title, 0 AS amount, updated_at FROM ${invoices}`)

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

export const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("customerId", "string"),
    prop("title", "string", {
      query: { searchable: true, filterable: true, sortable: true, facet: true, text: true },
    }),
    prop("summary", "string", { query: { searchable: true, text: true } }),
    prop("amount", "decimal", { markings: [financial] }),
  ],
  links: [link("customer", Customer, { cardinality: "one" })],
  search: { title: "title", defaultText: ["title", "summary"] },
})

const invoiceProperties = {
  id: "id",
  customerId: "customer_id",
  title: "title",
  amount: "amount",
} as const

/** How the `invoices` projection keys its objects and links. */
export type InvoiceProjection = "plain" | "linkField" | "linkProperty" | "mostRecent"

function invoicesProjection(variant: InvoiceProjection): ProjectionDefinition {
  const base = defineProjection("invoices", Invoice)
    .fromDataset(invoicesNormalized)
    .properties(invoiceProperties)

  switch (variant) {
    case "plain":
      return base
    case "linkField":
      return base.withLinks({
        customer: { link: Invoice.l.customer, sourceField: "customer_id", target: Customer },
      })
    case "linkProperty":
      return base.withLinks({
        customer: {
          link: Invoice.l.customer,
          sourceProperty: Invoice.p.customerId,
          target: Customer,
        },
      })
    case "mostRecent":
      return base.resolveConflicts({ strategy: "mostRecent", sourceTimestamp: "updated_at" })
  }
}

export const archiveInvoice = defineAction("archive-invoice")
  .on(Invoice)
  .params({})
  .writeback(async () => {})

/** A global action: its runs name no subject. */
export const remindCustomers = defineAction("remind-customers")
  .params({})
  .writeback(async () => {})

export const sales = defineGroup("sales")
export const finance = defineGroup("finance")

const roles = [
  defineRole("invoice-reader", {
    grantedTo: [sales, finance],
    grants: [
      can.view([Invoice, Customer]),
      can.edit(Invoice),
      can.apply([archiveInvoice, remindCustomers]),
    ],
  }),
  defineRole("finance-clearance", { grantedTo: [finance], clearances: [financial] }),
]

export interface AppliedProject {
  readonly host: SixbHost
  readonly lake: InMemoryLakeStorage
  /** The sources the host reads as active. Replace its content to apply another version. */
  readonly active: ActiveOntologySource[]
  readonly calls: { listActive: number }
  revisionOf(projectionId: string): string
  apply(version: DatasetVersion, projectionRevision?: string): void
  contextFor(groupIds: readonly string[]): AuthorizationContext
  /** A raw version and a normalized version computed from it with this lineage. */
  normalized(lineage?: Partial<Record<string, readonly string[]>> | null): Promise<DatasetVersion>
}

/**
 * Lineage of a normalized version: each output column reads the raw columns listed, by default
 * the column of the same name. `null` records no lineage, like a version written before Sixb
 * recorded it.
 */
export async function createAppliedProject(
  options: {
    readonly variant?: InvoiceProjection
    readonly marked?: boolean
    /** Records activity, which both groups may observe. */
    readonly activity?: boolean
  } = {}
): Promise<AppliedProject> {
  const lake = new InMemoryLakeStorage()
  const datasets =
    options.marked === false
      ? [
          defineDataset("raw_invoices", {
            schema: [
              col("id", "string"),
              col("customer_id", "string"),
              col("title", "string"),
              col("amount", "decimal"),
              col("updated_at", "timestamp"),
            ],
          }),
          invoicesNormalized,
        ]
      : [rawInvoices, invoicesNormalized]

  const host = new SixbHost({
    id: projectId,
    ontology: [Customer, Invoice],
    markings: [financial, pii],
    groups: [sales, finance],
    roles: options.activity
      ? [
          ...roles,
          defineRole("activity-observer", {
            grantedTo: [sales, finance],
            grants: [can.observe(project.activity)],
          }),
        ]
      : roles,
    ...(options.activity ? { activity: { enabled: true } } : {}),
    datasets,
    pipelines: [definePipeline("finance").then(normalize)],
    projections: [invoicesProjection(options.variant ?? "plain")],
    actions: [archiveInvoice, remindCustomers],
    ...createTestRuntimeDeps(),
    lakeStorage: lake,
  })

  const active: ActiveOntologySource[] = []
  const calls = { listActive: 0 }
  let written = 0

  // The host reads the active sources through this method on every refresh.
  host.storage.ontology.sources.listActive = async () => {
    calls.listActive += 1
    return [...active]
  }

  const registry = getProjectionRegistry(host)
  const revisionOf = (projectionId: string) =>
    registry.resolveDispatch(projectionId).projectionRevision

  const raw = await commit(lake, datasets[0]!, [
    { id: "inv-1", customer_id: "c1", title: "Boiler", amount: "120", updated_at: at },
  ])

  return {
    host,
    lake,
    active,
    calls,
    revisionOf,
    apply(version, projectionRevision = revisionOf("invoices")) {
      active.splice(0, active.length, {
        source: { projectionId: "invoices" },
        datasetVersion: {
          datasetId: version.datasetId,
          versionId: version.versionId,
          createdAt: version.createdAt.toISOString(),
        },
        projectionRevision,
      })
    },
    contextFor: (groupIds) =>
      resolveAuthorizationContext({
        principal: { type: "user", id: `user-${groupIds.join("-")}` },
        groupIds,
        roles: host.definitions.security.listResolvedRoles(),
      }),
    normalized: (lineage = {}) => {
      written += 1

      const columns = ["id", "customer_id", "title", "amount", "updated_at"]
      const recorded: DatasetColumnLineage | undefined =
        lineage === null
          ? undefined
          : {
              rows: [],
              columns: Object.fromEntries(
                columns.map((column) => [
                  column,
                  (lineage[column] ?? [column]).map((input) => ({
                    datasetId: "raw_invoices",
                    column: input,
                  })),
                ])
              ),
            }

      return commit(
        lake,
        invoicesNormalized,
        // Each version differs, so the lake commits a new one.
        [
          {
            id: "inv-1",
            customer_id: "c1",
            title: `${written}`,
            amount: "120",
            updated_at: at,
          },
        ],
        { inputs: [raw], ...(recorded ? { lineage: recorded } : {}) }
      )
    },
  }
}

const at = "2026-10-01T10:00:00.000Z"

async function commit(
  lake: InMemoryLakeStorage,
  dataset: DatasetDefinition,
  rows: readonly DatasetRow[],
  pipeline?: { readonly inputs: readonly DatasetVersion[]; readonly lineage?: DatasetColumnLineage }
): Promise<DatasetVersion> {
  const definition = lakeDatasetDefinition(dataset)
  await lake.createDataset(definition)

  const session = await lake.beginWrite({
    dataset: definition,
    mode: "snapshot",
    producer: pipeline
      ? { kind: "pipeline", id: "finance", stepId: "normalize-invoices" }
      : { kind: "sync", id: "erp" },
    ...(pipeline
      ? {
          inputs: pipeline.inputs.map(({ datasetId, versionId }) => ({ datasetId, versionId })),
          // The raw versions hold what they declare, so this lineage is resolved already.
          ...(pipeline.lineage ? { lineage: pipeline.lineage } : {}),
        }
      : {}),
  })

  await session.writeRows(rows)
  const { outcome: _outcome, ...version } = await session.commit()
  return version
}
