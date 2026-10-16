import { join } from "node:path"
import {
  can,
  col,
  defineDataset,
  defineGroup,
  defineMarking,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineProjection,
  defineRole,
  every,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryQueues,
  type InMemoryStorage,
  type LakeStorage,
  link,
  type PipelineDefinition,
  prop,
  SixbHost,
  type SixbHostOptions,
} from "@sixb/core"
import { DuckLakeStorage } from "@sixb/ducklake"

/**
 * A field service company's operations project: finance, HR and building controls data, refined by
 * SQL and TypeScript pipeline steps and projected into the ontology.
 *
 * Each option is an edit a developer could make between two deployments.
 */
export interface PipelineMarkingsProjectOptions {
  /** The lake directory and the object storage outlive a deployment. */
  readonly lakeDir: string
  readonly storage: InMemoryStorage
  readonly onError?: SixbHostOptions["onError"]
  /** Declares `pii` on `Customer.displayName`, which the customer 360 derives from a name. */
  readonly customerNamePii?: boolean
  /** `amount`: an invoice title depends on the amount, without changing any row today. */
  readonly invoiceTitle?: "title" | "amount"
  /** Declares `financial` on `Invoice.title`, which a title computed from the amount carries. */
  readonly invoiceTitleFinancial?: boolean
  /** `amount`: the audit note quotes the amount. */
  readonly auditNote?: "title" | "amount"
  /** Adds a nullable column to `invoices_normalized`. */
  readonly invoiceDueDate?: boolean
  /** Adds a step that pivots payments, which the lake cannot analyze. */
  readonly paymentPivot?: boolean
  /** Hides the lake's SQL analysis, like a provider that has none. */
  readonly withoutSqlAnalysis?: boolean
}

// ── Markings, groups, roles ─────────────────────────────────

export const financial = defineMarking("financial", { label: "Financial" })
export const pii = defineMarking("pii", { label: "Personal data" })
export const hr = defineMarking("hr", { label: "HR" })

export const staff = defineGroup("staff")
export const finance = defineGroup("finance")
export const peopleOps = defineGroup("people-ops")

const roles = [
  defineRole("viewer", {
    grantedTo: [staff, finance, peopleOps],
    grants: [can.view(every.object()), can.view(every.dataset())],
  }),
  defineRole("finance-clearance", { grantedTo: [finance, peopleOps], clearances: [financial] }),
  defineRole("people-clearance", { grantedTo: [peopleOps], clearances: [hr, pii] }),
]

// ── Sources: where markings are declared ────────────────────

export const rawCustomers = defineDataset("raw_customers", {
  schema: [
    col("customer_id", "string"),
    col("name", "string", { markings: [pii] }),
    col("country", "string"),
    col("tax_id", "string", { markings: [pii] }),
  ],
  primaryKey: "customer_id",
})

export const rawInvoices = defineDataset("raw_invoices", {
  schema: [
    col("invoice_id", "string"),
    col("customer_id", "string"),
    col("title", "string"),
    col("amount", "decimal", { markings: [financial] }),
    col("amount_unit", "string"),
    col("currency", "string"),
    col("issued_at", "timestamp"),
    col("payload", "json"),
  ],
  primaryKey: "invoice_id",
})

export const rawPayments = defineDataset("raw_payments", {
  schema: [
    col("payment_id", "string"),
    col("invoice_id", "string"),
    col("paid_amount", "decimal", { markings: [financial] }),
    col("paid_at", "timestamp"),
  ],
  primaryKey: "payment_id",
})

export const rawFxRates = defineDataset("raw_fx_rates", {
  schema: [
    col("rate_id", "string"),
    col("currency", "string"),
    col("rate_to_eur", "decimal"),
    col("valid_from", "timestamp"),
  ],
  primaryKey: "rate_id",
})

export const rawEmployees = defineDataset("raw_employees", {
  schema: [
    col("employee_id", "string"),
    col("name", "string", { markings: [pii] }),
    col("team", "string"),
    col("manager_id", "string", { nullable: true }),
    col("salary", "decimal", { markings: [hr] }),
  ],
  primaryKey: "employee_id",
})

export const rawEquipment = defineDataset("raw_equipment", {
  schema: [col("equipment_id", "string"), col("facility_id", "string")],
  primaryKey: "equipment_id",
})

export const rawReadings = defineDataset("raw_readings", {
  schema: [
    col("reading_id", "string"),
    col("equipment_id", "string"),
    col("metric", "string"),
    col("value", "float64"),
    col("unit", "string"),
    col("observed_at", "timestamp"),
  ],
  primaryKey: "reading_id",
})

export const rawAlarms = defineDataset("raw_alarms", {
  schema: [col("alarm_id", "string"), col("equipment_id", "string"), col("severity", "string")],
  primaryKey: "alarm_id",
})

export const rawContracts = defineDataset("raw_contracts", {
  schema: [
    col("contract_id", "string"),
    col("facility_id", "string"),
    col("tier", "string"),
    col("monthly_fee", "decimal", { markings: [financial] }),
    col("starts_at", "timestamp"),
  ],
  primaryKey: "contract_id",
})

// ── Pipeline outputs: no markings of their own ─────────────

function invoicesNormalizedDataset(dueDate: boolean) {
  return defineDataset("invoices_normalized", {
    schema: [
      col("invoice_id", "string"),
      col("customer_id", "string"),
      col("title", "string"),
      col("amount", "decimal"),
      col("currency", "string"),
      col("issued_at", "timestamp"),
      col("channel", "string", { nullable: true }),
      ...(dueDate ? [col("due_at", "timestamp", { nullable: true })] : []),
    ],
  })
}

export const invoiceReconciliation = defineDataset("invoice_reconciliation", {
  schema: [
    col("invoice_id", "string"),
    col("customer_id", "string"),
    col("amount_eur", "decimal"),
    col("paid_eur", "decimal"),
    col("status", "string"),
  ],
})

export const largeInvoices = defineDataset("large_invoices", {
  schema: [col("invoice_id", "string"), col("customer_id", "string")],
})

export const customerRevenue = defineDataset("customer_revenue", {
  schema: [col("customer_id", "string"), col("invoices", "int64")],
})

export const invoiceTitles = defineDataset("invoice_titles", {
  schema: [col("invoice_id", "string"), col("title_upper", "string")],
})

export const invoiceAudit = defineDataset("invoice_audit", {
  schema: [col("invoice_id", "string"), col("note", "string")],
})

export const customer360 = defineDataset("customer_360", {
  schema: [
    col("customer_id", "string"),
    col("display_name", "string"),
    col("country", "string"),
    col("invoice_count", "int64"),
  ],
})

export const orgChart = defineDataset("org_chart", {
  schema: [
    col("employee_id", "string"),
    col("name", "string"),
    col("team", "string"),
    col("depth", "int64"),
  ],
})

export const teamPayroll = defineDataset("team_payroll", {
  schema: [col("team", "string"), col("headcount", "int64"), col("total_salary", "decimal")],
})

export const employeeDirectory = defineDataset("employee_directory", {
  schema: [col("employee_id", "string"), col("team", "string")],
})

export const equipmentStatus = defineDataset("equipment_status", {
  schema: [
    col("equipment_id", "string"),
    col("supply_temp_c", "float64", { nullable: true }),
    col("current_ma", "float64", { nullable: true }),
  ],
})

export const alarmContext = defineDataset("alarm_context", {
  schema: [
    col("alarm_id", "string"),
    col("equipment_id", "string"),
    col("severity", "string"),
    col("contract_tier", "string", { nullable: true }),
    col("monthly_fee", "decimal", { nullable: true }),
  ],
})

const paymentPivot = defineDataset("payment_pivot", {
  schema: [col("invoice_id", "string"), col("total", "decimal", { nullable: true })],
})

// ── Ontology ────────────────────────────────────────────────

function defineOntology(options: PipelineMarkingsProjectOptions) {
  const Customer = defineObjectType({
    id: "Customer",
    name: "Customer",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("displayName", "string", options.customerNamePii === false ? {} : { markings: [pii] }),
      prop("country", "string"),
      prop("invoiceCount", "integer"),
    ],
  })

  const Invoice = defineObjectType({
    id: "Invoice",
    name: "Invoice",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("customerId", "string"),
      prop("title", "string", {
        query: { searchable: true, filterable: true },
        ...(options.invoiceTitleFinancial ? { markings: [financial] } : {}),
      }),
      prop("amount", "decimal", { markings: [financial] }),
      prop("currency", "string"),
    ],
    links: [link("customer", Customer, { cardinality: "one" })],
  })

  const Receivable = defineObjectType({
    id: "Receivable",
    name: "Receivable",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("amountEur", "decimal", { markings: [financial] }),
      prop("paidEur", "decimal", { markings: [financial] }),
      prop("status", "string", {
        markings: [financial],
        query: { searchable: true, filterable: true, exact: true },
      }),
    ],
  })

  const Team = defineObjectType({
    id: "Team",
    name: "Team",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("headcount", "integer"),
      prop("totalSalary", "decimal", { markings: [hr] }),
    ],
  })

  const Employee = defineObjectType({
    id: "Employee",
    name: "Employee",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("name", "string", { markings: [pii] }),
      prop("team", "string"),
      prop("depth", "integer"),
    ],
  })

  const Equipment = defineObjectType({
    id: "Equipment",
    name: "Equipment",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("supplyTempC", "double"),
      prop("currentMa", "double"),
    ],
  })

  const Alarm = defineObjectType({
    id: "Alarm",
    name: "Alarm",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("severity", "string"),
      prop("contractTier", "string"),
      prop("monthlyFee", "decimal", { markings: [financial] }),
    ],
    links: [link("equipment", Equipment, { cardinality: "one" })],
  })

  return { Customer, Invoice, Receivable, Team, Employee, Equipment, Alarm }
}

// ── Pipelines ───────────────────────────────────────────────

function definePipelines(
  options: PipelineMarkingsProjectOptions,
  invoicesNormalized: ReturnType<typeof invoicesNormalizedDataset>
) {
  // No amount reaches a billion today, so both titles hold the same rows; only their lineage
  // differs.
  const title =
    options.invoiceTitle === "amount"
      ? "CASE WHEN amount_eur > 1000000000 THEN 'Major works' ELSE trim(title) END"
      : "trim(title)"

  const normalizeInvoices = definePipelineStep("normalize-invoices")
    .inputs({ invoices: rawInvoices })
    .output(invoicesNormalized)
    .sql(
      ({ invoices }) => `
        WITH converted AS (
          SELECT
            *,
            CASE WHEN amount_unit = 'cents' THEN amount / 100 ELSE amount END AS amount_eur
          FROM ${invoices}
        ),
        enriched AS (
          SELECT *, json_extract_string(payload, '$.channel') AS channel FROM converted
        )
        SELECT
          invoice_id,
          customer_id,
          ${title} AS title,
          CAST(amount_eur AS DECIMAL(38, 9)) AS amount,
          upper(currency) AS currency,
          issued_at,
          channel${options.invoiceDueDate ? ",\n          CAST(NULL AS TIMESTAMPTZ) AS due_at" : ""}
        FROM enriched
      `
    )

  const reconcilePayments = definePipelineStep("reconcile-payments")
    .inputs({ invoices: invoicesNormalized, payments: rawPayments, rates: rawFxRates })
    .output(invoiceReconciliation)
    .sql(
      ({ invoices, payments, rates }) => `
        WITH paid AS (
          SELECT invoice_id, sum(paid_amount) AS paid_amount FROM ${payments} GROUP BY invoice_id
        ),
        converted AS (
          SELECT
            i.invoice_id,
            i.customer_id,
            i.amount * r.rate_to_eur AS amount_eur,
            coalesce(p.paid_amount, 0) * r.rate_to_eur AS paid_eur
          FROM ${invoices} i
          ASOF JOIN ${rates} r ON i.currency = r.currency AND i.issued_at >= r.valid_from
          LEFT JOIN paid p ON p.invoice_id = i.invoice_id
        )
        SELECT
          invoice_id,
          customer_id,
          CAST(amount_eur AS DECIMAL(38, 9)) AS amount_eur,
          CAST(paid_eur AS DECIMAL(38, 9)) AS paid_eur,
          CASE WHEN paid_eur >= amount_eur THEN 'paid' WHEN paid_eur > 0 THEN 'partial' ELSE 'open' END
            AS status
        FROM converted
      `
    )

  // Which invoices exceed 1000 reveals their amount: every output column carries `financial`.
  const selectLargeInvoices = definePipelineStep("large-invoices")
    .inputs({ reconciliation: invoiceReconciliation })
    .output(largeInvoices)
    .sql(
      ({ reconciliation }) =>
        `SELECT invoice_id, customer_id FROM ${reconciliation} WHERE amount_eur > 1000`
    )

  // A TypeScript step reads every column of its input, so its output carries all of them.
  const countCustomerInvoices = definePipelineStep("customer-revenue")
    .inputs({ reconciliation: invoiceReconciliation })
    .output(customerRevenue)
    .run(async ({ inputs, output }) => {
      const counts = new Map<string, number>()

      for await (const row of inputs.reconciliation.readRows()) {
        const customerId = String(row.customer_id)
        counts.set(customerId, (counts.get(customerId) ?? 0) + 1)
      }

      await output.writeRows(
        [...counts].sort().map(([customer_id, invoices]) => ({ customer_id, invoices }))
      )
    })

  // A picked TypeScript step never reads `amount`.
  const upperCaseTitles = definePipelineStep("invoice-titles")
    .inputs({ invoices: invoicesNormalized.pick("invoice_id", "title") })
    .output(invoiceTitles)
    .run(async ({ inputs, output }) => {
      const rows: { invoice_id: string; title_upper: string }[] = []

      for await (const row of inputs.invoices.readRows()) {
        rows.push({
          invoice_id: String(row.invoice_id),
          title_upper: String(row.title).toUpperCase(),
        })
      }

      await output.writeRows(rows.sort((a, b) => a.invoice_id.localeCompare(b.invoice_id)))
    })

  // Appends the invoices it has not seen yet, reading its own output to know which.
  const note =
    options.auditNote === "amount"
      ? "'Seen ' || i.title || ' for ' || CAST(i.amount AS VARCHAR)"
      : "'Seen ' || i.title"
  const auditInvoices = definePipelineStep("audit-invoices")
    .inputs({ invoices: rawInvoices, audit: invoiceAudit })
    .output(invoiceAudit, { mode: "append" })
    .sql(
      ({ invoices, audit }) => `
        SELECT i.invoice_id, ${note} AS note
        FROM ${invoices} i
        WHERE i.invoice_id NOT IN (SELECT invoice_id FROM ${audit})
      `
    )

  const buildCustomer360 = definePipelineStep("customer-360")
    .inputs({ customers: rawCustomers, invoices: invoicesNormalized })
    .output(customer360)
    .sql(
      ({ customers, invoices }) => `
        WITH stats AS (
          SELECT customer_id, count(*) AS invoice_count FROM ${invoices} GROUP BY customer_id
        )
        SELECT
          c.customer_id,
          COALESCE(nullif(trim(c.name), ''), 'Unknown customer') AS display_name,
          upper(c.country) AS country,
          COALESCE(s.invoice_count, 0) AS invoice_count
        FROM ${customers} c
        LEFT JOIN stats s ON s.customer_id = c.customer_id
      `
    )

  const buildOrgChart = definePipelineStep("org-chart")
    .inputs({ employees: rawEmployees })
    .output(orgChart)
    .sql(
      ({ employees }) => `
        WITH RECURSIVE tree AS (
          SELECT employee_id, name, team, 0 AS depth FROM ${employees} WHERE manager_id IS NULL
          UNION ALL
          SELECT e.employee_id, e.name, e.team, t.depth + 1
          FROM ${employees} e
          JOIN tree t ON e.manager_id = t.employee_id
        )
        SELECT employee_id, name, team, CAST(depth AS BIGINT) AS depth FROM tree
      `
    )

  // The salaries are summed away, but the total still derives from them.
  const sumTeamPayroll = definePipelineStep("team-payroll")
    .inputs({ employees: rawEmployees })
    .output(teamPayroll)
    .sql(
      ({ employees }) => `
        SELECT team, count(*) AS headcount, CAST(sum(salary) AS DECIMAL(38, 9)) AS total_salary
        FROM ${employees}
        GROUP BY team
      `
    )

  // Reads a dataset with marked columns, but none of them.
  const listEmployees = definePipelineStep("employee-directory")
    .inputs({ employees: rawEmployees })
    .output(employeeDirectory)
    .sql(({ employees }) => `SELECT employee_id, team FROM ${employees}`)

  const latestReadings = definePipelineStep("equipment-status")
    .inputs({ readings: rawReadings, equipment: rawEquipment })
    .output(equipmentStatus)
    .sql(
      ({ readings, equipment }) => `
        WITH normalized AS (
          SELECT
            equipment_id,
            metric,
            CASE
              WHEN metric = 'supply_temp' AND unit = 'F' THEN (value - 32) * 5.0 / 9.0
              WHEN metric = 'current' AND unit = 'A' THEN value * 1000.0
              ELSE value
            END AS value,
            row_number() OVER (PARTITION BY equipment_id, metric ORDER BY observed_at DESC) AS rank
          FROM ${readings}
        )
        SELECT
          e.equipment_id,
          CAST(max(CASE WHEN n.metric = 'supply_temp' THEN n.value END) AS DOUBLE) AS supply_temp_c,
          CAST(max(CASE WHEN n.metric = 'current' THEN n.value END) AS DOUBLE) AS current_ma
        FROM ${equipment} e
        JOIN normalized n ON n.equipment_id = e.equipment_id AND n.rank = 1
        GROUP BY e.equipment_id
      `
    )

  // The current contract is picked by start date, so only its fee carries `financial`.
  const enrichAlarms = definePipelineStep("alarm-context")
    .inputs({ alarms: rawAlarms, equipment: rawEquipment, contracts: rawContracts })
    .output(alarmContext)
    .sql(
      ({ alarms, equipment, contracts }) => `
        WITH current_contracts AS (
          SELECT
            facility_id,
            tier,
            monthly_fee,
            row_number() OVER (PARTITION BY facility_id ORDER BY starts_at DESC) AS rank
          FROM ${contracts}
        )
        SELECT a.alarm_id, a.equipment_id, a.severity, c.tier AS contract_tier, c.monthly_fee
        FROM ${alarms} a
        JOIN ${equipment} e ON e.equipment_id = a.equipment_id
        LEFT JOIN current_contracts c ON c.facility_id = e.facility_id AND c.rank = 1
      `
    )

  const pipelines: PipelineDefinition[] = [
    definePipeline("finance")
      .then(normalizeInvoices)
      .then(reconcilePayments)
      .then(selectLargeInvoices)
      .then(countCustomerInvoices)
      .then(upperCaseTitles),
    definePipeline("audit").then(auditInvoices),
    definePipeline("customers").then(buildCustomer360),
    definePipeline("hr").then(buildOrgChart).then(sumTeamPayroll).then(listEmployees),
    definePipeline("field-service").then(latestReadings).then(enrichAlarms),
  ]

  if (options.paymentPivot) {
    const pivotPayments = definePipelineStep("payment-pivot")
      .inputs({ payments: rawPayments })
      .output(paymentPivot)
      .sql(
        ({ payments }) => `
          SELECT invoice_id, "2026" AS total FROM (
            PIVOT (SELECT invoice_id, strftime(paid_at, '%Y') AS year, paid_amount FROM ${payments})
            ON year IN ('2026') USING sum(paid_amount)
          )
        `
      )
    pipelines.push(definePipeline("payment-pivots").then(pivotPayments))
  }

  return pipelines
}

// ── Projections ─────────────────────────────────────────────

function defineProjections(
  ontology: ReturnType<typeof defineOntology>,
  invoicesNormalized: ReturnType<typeof invoicesNormalizedDataset>
) {
  const { Customer, Invoice, Receivable, Team, Employee, Equipment, Alarm } = ontology
  return [
    defineProjection("customers", Customer).fromDataset(customer360).properties({
      id: "customer_id",
      displayName: "display_name",
      country: "country",
      invoiceCount: "invoice_count",
    }),
    defineProjection("invoices", Invoice)
      .fromDataset(invoicesNormalized)
      .properties({
        id: "invoice_id",
        customerId: "customer_id",
        title: "title",
        amount: "amount",
        currency: "currency",
      })
      .withLinks({
        customer: { link: Invoice.l.customer, sourceField: "customer_id", target: Customer },
      }),
    defineProjection("receivables", Receivable).fromDataset(invoiceReconciliation).properties({
      id: "invoice_id",
      amountEur: "amount_eur",
      paidEur: "paid_eur",
      status: "status",
    }),
    defineProjection("teams", Team)
      .fromDataset(teamPayroll)
      .properties({ id: "team", headcount: "headcount", totalSalary: "total_salary" }),
    defineProjection("employees", Employee)
      .fromDataset(orgChart)
      .properties({ id: "employee_id", name: "name", team: "team", depth: "depth" }),
    defineProjection("equipment", Equipment).fromDataset(equipmentStatus).properties({
      id: "equipment_id",
      supplyTempC: "supply_temp_c",
      currentMa: "current_ma",
    }),
    defineProjection("alarms", Alarm).fromDataset(alarmContext).properties({
      id: "alarm_id",
      severity: "severity",
      contractTier: "contract_tier",
      monthlyFee: "monthly_fee",
    }),
    defineProjection("alarm-equipment", Alarm.l.equipment)
      .fromDataset(alarmContext)
      .sourceField("alarm_id")
      .targetField("equipment_id"),
  ]
}

/** The same lake, seen through a provider that cannot analyze SQL. */
function withoutSqlAnalysis(lake: DuckLakeStorage): LakeStorage {
  const { sql } = lake
  return Object.create(lake, {
    sql: {
      value: {
        dialect: sql.dialect,
        capabilities: sql.capabilities,
        preview: sql.preview.bind(sql),
        execute: sql.execute.bind(sql),
      },
    },
  })
}

/** One deployment of the project: today's code over the lake and storage earlier ones wrote. */
export function createPipelineMarkingsProject(options: PipelineMarkingsProjectOptions) {
  const lake = new DuckLakeStorage({
    catalog: { type: "duckdb", path: join(options.lakeDir, "catalog.ducklake") },
    dataPath: join(options.lakeDir, "data"),
  })

  const invoicesNormalized = invoicesNormalizedDataset(options.invoiceDueDate === true)
  const ontology = defineOntology(options)
  const pipelines = definePipelines(options, invoicesNormalized)

  return new SixbHost({
    id: "field-ops",
    ontology: Object.values(ontology),
    markings: [financial, pii, hr],
    groups: [staff, finance, peopleOps],
    roles,
    datasets: [
      rawCustomers,
      rawInvoices,
      rawPayments,
      rawFxRates,
      rawEmployees,
      rawEquipment,
      rawReadings,
      rawAlarms,
      rawContracts,
      invoicesNormalized,
      invoiceReconciliation,
      largeInvoices,
      customerRevenue,
      invoiceTitles,
      invoiceAudit,
      customer360,
      orgChart,
      teamPayroll,
      employeeDirectory,
      equipmentStatus,
      alarmContext,
      ...(options.paymentPivot ? [paymentPivot] : []),
    ],
    pipelines,
    projections: defineProjections(ontology, invoicesNormalized),
    broker: new InMemoryBroker(),
    storage: options.storage,
    lakeStorage: options.withoutSqlAnalysis ? withoutSqlAnalysis(lake) : lake,
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    auth: { id: "dev", kind: "dev" },
    ...(options.onError ? { onError: options.onError } : {}),
  })
}
