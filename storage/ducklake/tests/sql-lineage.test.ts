// Column lineage reads DuckDB's serialized logical plan, which is not a stable DuckDB API. That is
// why @duckdb/node-api is pinned to an exact version: before upgrading it, run this file. The
// corpus below asserts exact lineage, and the drift cases prove that a format change rejects the
// transform instead of dropping a dependency.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api"
import { col, type DatasetColumnDefinition, defineDataset } from "@sixb/core"
import type {
  AnalyzeSqlTransformSource,
  SqlTransformBody,
  SqlTransformLineage,
} from "@sixb/core/lake-storage"
import {
  analyzeSqlTransformLineage,
  type SqlLineageAnalysis,
} from "../src/internal/sql-lineage/analysis"
import { isJsonObject } from "../src/internal/sql-lineage/plan-json"
import { type PlanSourceTables, planLineage } from "../src/internal/sql-lineage/plan-walker"
import { SqlLineageRejected } from "../src/internal/sql-lineage/rejection"
import { createDuckLakeSqlTransformTemplate } from "../src/internal/sql-transform-relations"

/** Lineage written as `source.column` strings, the way the cases below read best. */
interface ExpectedLineage {
  readonly rows: readonly string[]
  readonly columns: Readonly<Record<string, readonly string[]>>
}

interface LineageCase extends ExpectedLineage {
  readonly name: string
  readonly sql: SqlTransformBody<"duckdb">
}

interface RejectionCase {
  readonly name: string
  readonly sql: SqlTransformBody<"duckdb">
  readonly reason: string
}

function dataset(id: string, ...columns: DatasetColumnDefinition[]): AnalyzeSqlTransformSource {
  return { dataset: defineDataset(id, { schema: columns }) }
}

const sources = {
  inv: dataset(
    "billing.invoices_raw",
    col("id", "string"),
    col("customer_id", "string"),
    col("title", "string"),
    col("amount", "decimal"),
    col("currency", "string"),
    col("issued_at", "timestamp"),
    col("tags", "json"),
    col("attachment", "fileRef"),
    col("payload", "json")
  ),
  cust: dataset(
    "crm.customers_raw",
    col("id", "string"),
    col("name", "string"),
    col("country", "string"),
    col("segment", "string"),
    col("parent_id", "string"),
    col("updated_at", "timestamp")
  ),
  lines: dataset(
    "billing.invoice_lines",
    col("invoice_id", "string"),
    col("sku", "string"),
    col("qty", "int64"),
    col("price", "float64")
  ),
  fx: dataset(
    "finance.fx_rates",
    col("currency", "string"),
    col("day", "date"),
    col("rate", "float64")
  ),
  events: dataset(
    "web.events",
    col("user_id", "string"),
    col("ts", "timestamp"),
    col("kind", "string"),
    col("page", "string")
  ),
  inv2: dataset(
    "billing.invoices_archive",
    col("id", "string"),
    col("customer_id", "string"),
    col("amount", "decimal")
  ),
  readings: dataset(
    "telemetry.readings",
    col("equipment_id", "string"),
    col("metric", "string"),
    col("value", "float64"),
    col("unit", "string"),
    col("read_at", "timestamp")
  ),
  equipment: dataset(
    "assets.equipment",
    col("id", "string"),
    col("facility_id", "string"),
    col("kind", "string"),
    col("serial", "string")
  ),
  facilities: dataset(
    "assets.facilities",
    col("id", "string"),
    col("name", "string"),
    col("region", "string"),
    col("customer_id", "string")
  ),
  contracts: dataset(
    "sales.contracts",
    col("id", "string"),
    col("facility_id", "string"),
    col("tier", "string"),
    col("starts_on", "date"),
    col("ends_on", "date"),
    col("monthly_fee", "decimal")
  ),
  alarms: dataset(
    "telemetry.alarms",
    col("id", "string"),
    col("equipment_id", "string"),
    col("severity", "string"),
    col("raised_at", "timestamp"),
    col("payload", "json")
  ),
  invoices: dataset(
    "billing.invoices",
    col("id", "string"),
    col("customer_id", "string"),
    col("amount", "decimal"),
    col("currency", "string"),
    col("issued_at", "timestamp")
  ),
  payments: dataset(
    "billing.payments",
    col("id", "string"),
    col("invoice_id", "string"),
    col("amount", "decimal"),
    col("paid_at", "timestamp")
  ),
  crm: dataset(
    "crm.accounts",
    col("id", "string"),
    col("name", "string"),
    col("email", "string"),
    col("country", "string"),
    col("updated_at", "timestamp")
  ),
  billing: dataset(
    "billing.accounts",
    col("customer_id", "string"),
    col("legal_name", "string"),
    col("vat_number", "string"),
    col("country", "string")
  ),
  tickets: dataset(
    "support.tickets",
    col("id", "string"),
    col("customer_id", "string"),
    col("status", "string")
  ),
  employees: dataset(
    "hr.employees",
    col("id", "string"),
    col("manager_id", "string"),
    col("name", "string")
  ),
  orders: dataset(
    "sales.orders",
    col("id", "string"),
    col("customer_id", "string"),
    col("ordered_at", "timestamp")
  ),
  orderLines: dataset(
    "sales.order_lines",
    col("order_id", "string"),
    col("product_id", "string"),
    col("quantity", "int64"),
    col("unit_price", "decimal")
  ),
  products: dataset(
    "catalog.products",
    col("id", "string"),
    col("category", "string"),
    col("name", "string")
  ),
  calendar: dataset(
    "reference.calendar",
    col("day", "date"),
    col("year", "int64"),
    col("quarter", "int64")
  ),
  webOrders: dataset(
    "web.orders",
    col("id", "string"),
    col("customer_id", "string"),
    col("amount", "decimal")
  ),
  storeOrders: dataset(
    "retail.receipts",
    col("receipt_id", "string"),
    col("customer_id", "string"),
    col("total", "decimal")
  ),
  partnerOrders: dataset(
    "partners.orders",
    col("reference", "string"),
    col("account_id", "string"),
    col("amount_due", "decimal"),
    col("status", "string")
  ),
  samples: dataset(
    "telemetry.sample_batches",
    col("id", "string"),
    col("payload", "json"),
    col("scale", "float64"),
    col("excluded_tag", "string")
  ),
} satisfies Record<string, AnalyzeSqlTransformSource>

function analyze(
  sql: SqlTransformBody<"duckdb">,
  analyzedSources: Readonly<Record<string, AnalyzeSqlTransformSource>> = sources
): Promise<SqlLineageAnalysis> {
  return analyzeSqlTransformLineage({
    sources: analyzedSources,
    template: createDuckLakeSqlTransformTemplate(Object.keys(analyzedSources), sql),
  })
}

async function supportedAnalysis(
  sql: SqlTransformBody<"duckdb">,
  analyzedSources: Readonly<Record<string, AnalyzeSqlTransformSource>> = sources
): Promise<Extract<SqlLineageAnalysis, { supported: true }>> {
  const analysis = await analyze(sql, analyzedSources)
  if (!analysis.supported) {
    throw new Error(`Expected a supported analysis, got: ${analysis.reason}`)
  }

  return analysis
}

function compact(lineage: SqlTransformLineage): ExpectedLineage {
  const refs = (columnRefs: readonly { source: string; column: string }[]) =>
    columnRefs.map(({ source, column }) => `${source}.${column}`).sort()

  return {
    rows: refs(lineage.rows),
    columns: Object.fromEntries(
      Object.entries(lineage.columns).map(([name, columnRefs]) => [name, refs(columnRefs)])
    ),
  }
}

function sorted(expected: ExpectedLineage): ExpectedLineage {
  return {
    rows: [...expected.rows].sort(),
    columns: Object.fromEntries(
      Object.entries(expected.columns).map(([name, refs]) => [name, [...refs].sort()])
    ),
  }
}

function expectLineageCases(cases: readonly LineageCase[]): void {
  for (const { name, sql, ...expected } of cases) {
    test(name, async () => {
      const analysis = await supportedAnalysis(sql)
      expect(compact(analysis.lineage)).toEqual(sorted(expected))
      expect(analysis.outputColumns).toEqual(Object.keys(expected.columns))
    })
  }
}

describe("SQL lineage: hand-checked constructs", () => {
  expectLineageCases([
    {
      name: "filter and projection",
      sql: ({ inv }) => `SELECT id, upper(title) t FROM ${inv} i WHERE amount > 100`,
      rows: ["inv.amount"],
      columns: { id: ["inv.id"], t: ["inv.title"] },
    },
    {
      name: "count(*) with a filter",
      sql: ({ inv }) => `SELECT count(*) n FROM ${inv} i WHERE currency = 'EUR'`,
      rows: ["inv.currency"],
      columns: { n: [] },
    },
    {
      name: "GROUP BY and HAVING",
      sql: ({ inv }) =>
        `SELECT customer_id, sum(amount) total FROM ${inv} i GROUP BY customer_id HAVING count(*) > 1`,
      rows: ["inv.customer_id"],
      columns: { customer_id: ["inv.customer_id"], total: ["inv.amount"] },
    },
    {
      name: "dedup with row_number",
      sql: ({ inv }) => `
        SELECT id, title
        FROM (SELECT *, row_number() OVER (PARTITION BY id ORDER BY issued_at DESC) rn FROM ${inv} i)
        WHERE rn = 1`,
      rows: ["inv.id", "inv.issued_at"],
      columns: { id: ["inv.id"], title: ["inv.title"] },
    },
    {
      name: "latest row per key with QUALIFY",
      sql: ({ cust }) => `
        SELECT id, name FROM ${cust} c
        QUALIFY row_number() OVER (PARTITION BY id ORDER BY updated_at DESC) = 1`,
      rows: ["cust.id", "cust.updated_at"],
      columns: { id: ["cust.id"], name: ["cust.name"] },
    },
    {
      name: "star join and aggregate",
      sql: ({ inv, cust, lines }) => `
        SELECT c.country, sum(l.qty * l.price) rev
        FROM ${lines} l
        JOIN ${inv} i ON l.invoice_id = i.id
        JOIN ${cust} c ON i.customer_id = c.id
        GROUP BY c.country`,
      rows: ["cust.country", "cust.id", "inv.customer_id", "inv.id", "lines.invoice_id"],
      columns: { country: ["cust.country"], rev: ["lines.price", "lines.qty"] },
    },
    {
      name: "multi-CTE pipeline",
      sql: ({ inv, cust }) => `
        WITH a AS (SELECT id, customer_id, amount FROM ${inv} i WHERE amount > 0),
             b AS (SELECT customer_id, sum(amount) s FROM a GROUP BY 1)
        SELECT cust.name, b.s FROM b JOIN ${cust} cust ON cust.id = b.customer_id`,
      rows: ["cust.id", "inv.amount", "inv.customer_id"],
      columns: { name: ["cust.name"], s: ["inv.amount"] },
    },
    {
      name: "an unused CTE adds nothing",
      sql: ({ inv, cust }) => `
        WITH unused AS (SELECT * FROM ${cust} c WHERE segment = 'x')
        SELECT id FROM ${inv} i`,
      rows: [],
      columns: { id: ["inv.id"] },
    },
    {
      name: "FX conversion through a LEFT JOIN",
      sql: ({ inv, fx }) => `
        SELECT i.id, i.amount * f.rate amount_eur
        FROM ${inv} i
        LEFT JOIN ${fx} f ON f.currency = i.currency AND f.day = CAST(i.issued_at AS DATE)`,
      rows: ["fx.currency", "fx.day", "inv.currency", "inv.issued_at"],
      columns: { id: ["inv.id"], amount_eur: ["fx.rate", "inv.amount"] },
    },
    {
      name: "FX conversion through an ASOF JOIN",
      sql: ({ inv, fx }) => `
        SELECT i.id, f.rate
        FROM ${inv} i
        ASOF JOIN ${fx} f ON i.currency = f.currency AND CAST(i.issued_at AS DATE) >= f.day`,
      rows: ["fx.currency", "fx.day", "inv.currency", "inv.issued_at"],
      columns: { id: ["inv.id"], rate: ["fx.rate"] },
    },
    {
      name: "sessions with LAG",
      sql: ({ events }) => `
        WITH e AS (
          SELECT user_id, ts,
            CASE WHEN ts - lag(ts) OVER (PARTITION BY user_id ORDER BY ts) > INTERVAL 30 MINUTE
              THEN 1 ELSE 0 END new_s
          FROM ${events} ev
        )
        SELECT user_id, ts, sum(new_s) OVER (PARTITION BY user_id ORDER BY ts) sid FROM e`,
      rows: ["events.ts", "events.user_id"],
      columns: {
        user_id: ["events.user_id"],
        ts: ["events.ts"],
        sid: ["events.ts", "events.user_id"],
      },
    },
    {
      name: "JSON extraction",
      sql: ({ inv }) => `SELECT id, payload->>'$.status' status FROM ${inv} i`,
      rows: [],
      columns: { id: ["inv.id"], status: ["inv.payload"] },
    },
    {
      name: "COALESCE across sources",
      sql: ({ inv, cust }) => `
        SELECT coalesce(c.name, i.title) lbl
        FROM ${inv} i LEFT JOIN ${cust} c ON c.id = i.customer_id`,
      rows: ["cust.id", "inv.customer_id"],
      columns: { lbl: ["cust.name", "inv.title"] },
    },
    {
      name: "string_agg with ORDER BY",
      sql: ({ inv }) =>
        `SELECT customer_id, string_agg(title, ',' ORDER BY issued_at) ts FROM ${inv} i GROUP BY 1`,
      rows: ["inv.customer_id"],
      columns: { customer_id: ["inv.customer_id"], ts: ["inv.issued_at", "inv.title"] },
    },
    {
      name: "lambda capturing a column",
      sql: ({ inv }) =>
        `SELECT list_filter(tags::VARCHAR[], x -> length(x) > amount) f FROM ${inv} i`,
      rows: [],
      columns: { f: ["inv.amount", "inv.tags"] },
    },
    {
      name: "UNNEST in the select list",
      sql: ({ inv }) => `SELECT id, unnest(tags::VARCHAR[]) tag FROM ${inv} i`,
      rows: ["inv.tags"],
      columns: { id: ["inv.id"], tag: ["inv.tags"] },
    },
    {
      name: "lateral unnest, resolved through column bindings",
      sql: ({ inv }) => `SELECT i.id, t.tag FROM ${inv} i, unnest(i.tags::VARCHAR[]) t(tag)`,
      rows: ["inv.tags"],
      columns: { id: ["inv.id"], tag: ["inv.tags"] },
    },
    {
      name: "recursive hierarchy",
      sql: ({ cust }) => `
        WITH RECURSIVE h(id, parent_id, depth) AS (
          SELECT id, parent_id, 0 FROM ${cust} c WHERE parent_id IS NULL
          UNION ALL
          SELECT c.id, c.parent_id, h.depth + 1 FROM ${cust} c JOIN h ON c.parent_id = h.id
        )
        SELECT id, depth FROM h`,
      rows: ["cust.id", "cust.parent_id"],
      columns: { id: ["cust.id"], depth: [] },
    },
    {
      name: "recursive value propagation",
      sql: ({ cust }) => `
        WITH RECURSIVE t(n, s) AS (
          SELECT 1, name FROM ${cust} c
          UNION ALL
          SELECT n + 1, s || country FROM t, ${cust} c2 WHERE n < 3
        )
        SELECT s FROM t`,
      rows: [],
      columns: { s: ["cust.country", "cust.name"] },
    },
    {
      name: "UNION ALL of three inputs",
      sql: ({ inv, inv2, lines }) => `
        SELECT id, amount FROM ${inv} a
        UNION ALL SELECT id, amount FROM ${inv2} b
        UNION ALL SELECT invoice_id, price FROM ${lines} l`,
      rows: [],
      columns: {
        id: ["inv.id", "inv2.id", "lines.invoice_id"],
        amount: ["inv.amount", "inv2.amount", "lines.price"],
      },
    },
    {
      name: "EXCEPT",
      sql: ({ inv, inv2 }) => `SELECT id FROM ${inv} a EXCEPT SELECT id FROM ${inv2} b`,
      rows: ["inv.id", "inv2.id"],
      columns: { id: ["inv.id"] },
    },
    {
      name: "correlated scalar subquery",
      sql: ({ inv, lines }) => `
        SELECT id, (SELECT sum(qty * price) FROM ${lines} l WHERE l.invoice_id = i.id) total
        FROM ${inv} i`,
      rows: ["inv.id", "lines.invoice_id"],
      columns: { id: ["inv.id"], total: ["lines.price", "lines.qty"] },
    },
    {
      name: "uncorrelated scalar subquery",
      sql: ({ inv, fx }) => `SELECT id, (SELECT max(rate) FROM ${fx} f) maxrate FROM ${inv} i`,
      rows: [],
      columns: { id: ["inv.id"], maxrate: ["fx.rate"] },
    },
    {
      name: "EXISTS",
      sql: ({ inv, lines }) => `
        SELECT id FROM ${inv} i
        WHERE EXISTS (SELECT 1 FROM ${lines} l WHERE l.invoice_id = i.id AND l.qty > 2)`,
      rows: ["inv.id", "lines.invoice_id", "lines.qty"],
      columns: { id: ["inv.id"] },
    },
    {
      name: "NOT IN",
      sql: ({ inv, cust }) => `
        SELECT id FROM ${inv} i
        WHERE customer_id NOT IN (SELECT id FROM ${cust} c WHERE segment = 'x')`,
      rows: ["cust.id", "cust.segment", "inv.customer_id"],
      columns: { id: ["inv.id"] },
    },
    {
      name: "IN used as a value (MARK join)",
      sql: ({ inv, cust }) =>
        `SELECT id, customer_id IN (SELECT id FROM ${cust} c) known FROM ${inv} i`,
      rows: ["cust.id", "inv.customer_id"],
      columns: { id: ["inv.id"], known: ["cust.id", "inv.customer_id"] },
    },
    {
      name: "ANTI JOIN",
      sql: ({ inv, cust }) => `SELECT id FROM ${inv} i ANTI JOIN ${cust} c ON i.customer_id = c.id`,
      rows: ["cust.id", "inv.customer_id"],
      columns: { id: ["inv.id"] },
    },
    {
      name: "FULL JOIN with USING",
      sql: ({ inv, inv2 }) => `
        SELECT customer_id, i.amount, j.amount a2
        FROM ${inv} i FULL JOIN ${inv2} j USING (customer_id)`,
      rows: ["inv.customer_id", "inv2.customer_id"],
      columns: {
        customer_id: ["inv.customer_id", "inv2.customer_id"],
        amount: ["inv.amount"],
        a2: ["inv2.amount"],
      },
    },
    {
      name: "LATERAL correlated aggregate",
      sql: ({ inv, cust }) => `
        SELECT c.id, t.latest
        FROM ${cust} c,
        LATERAL (SELECT max(issued_at) latest FROM ${inv} i WHERE i.customer_id = c.id) t`,
      rows: ["cust.id", "inv.customer_id"],
      columns: { id: ["cust.id"], latest: ["inv.issued_at"] },
    },
    {
      name: "* EXCLUDE and REPLACE",
      sql: ({ inv }) => `
        SELECT * EXCLUDE (tags, attachment, payload) REPLACE (upper(title) AS title)
        FROM ${inv} i`,
      rows: [],
      columns: {
        id: ["inv.id"],
        customer_id: ["inv.customer_id"],
        title: ["inv.title"],
        amount: ["inv.amount"],
        currency: ["inv.currency"],
        issued_at: ["inv.issued_at"],
      },
    },
    {
      name: "COLUMNS with a regular expression",
      sql: ({ inv }) => `SELECT max(COLUMNS('^(amount|issued_at)$')) FROM ${inv} i`,
      rows: [],
      columns: { amount: ["inv.amount"], issued_at: ["inv.issued_at"] },
    },
    {
      name: "GROUPING SETS and grouping()",
      sql: ({ inv }) => `
        SELECT customer_id, currency, sum(amount) s, grouping(customer_id) g
        FROM ${inv} i
        GROUP BY GROUPING SETS ((customer_id), (currency))`,
      rows: ["inv.currency", "inv.customer_id"],
      columns: {
        customer_id: ["inv.customer_id"],
        currency: ["inv.currency"],
        s: ["inv.amount"],
        g: ["inv.customer_id"],
      },
    },
    {
      name: "DISTINCT ON",
      sql: ({ inv }) => `
        SELECT DISTINCT ON (customer_id) customer_id, amount
        FROM ${inv} i ORDER BY customer_id, issued_at DESC`,
      rows: ["inv.customer_id", "inv.issued_at"],
      columns: { customer_id: ["inv.customer_id"], amount: ["inv.amount"] },
    },
    {
      name: "ORDER BY with LIMIT and OFFSET",
      sql: ({ inv }) => `SELECT id FROM ${inv} i ORDER BY amount DESC LIMIT 10 OFFSET 5`,
      rows: ["inv.amount"],
      columns: { id: ["inv.id"] },
    },
    {
      name: "ORDER BY without LIMIT still orders the materialized rows",
      sql: ({ inv }) => `SELECT id FROM ${inv} i ORDER BY issued_at`,
      rows: ["inv.issued_at"],
      columns: { id: ["inv.id"] },
    },
    {
      name: "SAMPLE",
      sql: ({ inv }) => `SELECT id FROM ${inv} i USING SAMPLE 10%`,
      rows: [],
      columns: { id: ["inv.id"] },
    },
    {
      name: "no FROM clause",
      sql: () => "SELECT 1 AS one, now() t",
      rows: [],
      columns: { one: [], t: [] },
    },
    {
      name: "joined VALUES list",
      sql: ({ inv }) => `
        SELECT i.id, v.label
        FROM ${inv} i JOIN (VALUES ('EUR', 'euro')) v(cur, label) ON i.currency = v.cur`,
      rows: ["inv.currency"],
      columns: { id: ["inv.id"], label: [] },
    },
    {
      name: "CASE, casts and struct fields",
      sql: ({ inv }) => `
        SELECT
          CASE WHEN amount > 0 THEN attachment.fileName ELSE try_cast(title AS VARCHAR) END k,
          issued_at::DATE d
        FROM ${inv} i`,
      rows: [],
      columns: { k: ["inv.amount", "inv.attachment", "inv.title"], d: ["inv.issued_at"] },
    },
    {
      name: "lateral column alias",
      sql: ({ inv }) => `SELECT amount * 2 AS dbl, dbl + 1 AS dbl1 FROM ${inv} i`,
      rows: [],
      columns: { dbl: ["inv.amount"], dbl1: ["inv.amount"] },
    },
    {
      name: "table function with a subquery argument",
      sql: ({ lines }) => `SELECT * FROM range((SELECT max(qty) FROM ${lines} l))`,
      rows: ["lines.qty"],
      columns: { range: ["lines.qty"] },
    },
    {
      name: "UNION deduplicates on every column",
      sql: ({ inv, inv2 }) => `SELECT id FROM ${inv} a UNION SELECT customer_id FROM ${inv2} b`,
      rows: ["inv.id", "inv2.customer_id"],
      columns: { id: ["inv.id", "inv2.customer_id"] },
    },
    {
      name: "duplicate output names as the executor materializes them",
      sql: ({ inv }) => `SELECT id, customer_id AS id FROM ${inv} i`,
      rows: [],
      columns: { id: ["inv.id"], id_1: ["inv.customer_id"] },
    },
  ])
})

describe("SQL lineage: data platform pipelines", () => {
  expectLineageCases([
    {
      name: "multi-CTE normalization with unit conversions",
      sql: ({ readings }) => `
        WITH normalized AS (
          SELECT equipment_id, metric, read_at,
            CASE unit
              WHEN 'kW' THEN value * 1000
              WHEN 'MW' THEN value * 1000000
              ELSE value
            END AS value_w
          FROM ${readings}
          WHERE metric IN ('power', 'load')
        ),
        hourly AS (
          SELECT equipment_id, metric, date_trunc('hour', read_at) AS hour,
            avg(value_w) AS avg_w, max(value_w) AS peak_w
          FROM normalized
          GROUP BY ALL
        )
        SELECT equipment_id, metric, hour,
          round(avg_w / 1000, 3) AS avg_kw, round(peak_w / 1000, 3) AS peak_kw
        FROM hourly`,
      rows: ["readings.equipment_id", "readings.metric", "readings.read_at"],
      columns: {
        equipment_id: ["readings.equipment_id"],
        metric: ["readings.metric"],
        hour: ["readings.read_at"],
        avg_kw: ["readings.unit", "readings.value"],
        peak_kw: ["readings.unit", "readings.value"],
      },
    },
    {
      name: "latest reading per equipment joined on rank 1",
      sql: ({ readings, equipment }) => `
        WITH ranked AS (
          SELECT equipment_id, value, unit, read_at,
            row_number() OVER (PARTITION BY equipment_id ORDER BY read_at DESC) AS rank
          FROM ${readings}
          WHERE metric = 'temperature'
        )
        SELECT e.id AS equipment_id, e.kind, r.value AS last_value, r.unit,
          r.read_at AS last_read_at
        FROM ${equipment} e
        JOIN ranked r ON r.equipment_id = e.id AND r.rank = 1`,
      rows: ["equipment.id", "readings.equipment_id", "readings.metric", "readings.read_at"],
      columns: {
        equipment_id: ["equipment.id"],
        kind: ["equipment.kind"],
        last_value: ["readings.value"],
        unit: ["readings.unit"],
        last_read_at: ["readings.read_at"],
      },
    },
    {
      name: "alarm enrichment with ranked contract selection",
      sql: ({ alarms, equipment, facilities, contracts }) => `
        WITH active_contracts AS (
          SELECT facility_id, tier, monthly_fee,
            row_number() OVER (PARTITION BY facility_id ORDER BY starts_on DESC) AS pick
          FROM ${contracts}
          WHERE ends_on IS NULL OR ends_on >= current_date
        )
        SELECT a.id AS alarm_id, a.severity, a.raised_at, e.serial,
          f.name AS facility, f.region, c.tier,
          CASE
            WHEN c.tier = 'premium' AND a.severity = 'critical' THEN 'P1'
            WHEN a.severity = 'critical' THEN 'P2'
            ELSE 'P3'
          END AS priority
        FROM ${alarms} a
        JOIN ${equipment} e ON e.id = a.equipment_id
        JOIN ${facilities} f ON f.id = e.facility_id
        LEFT JOIN active_contracts c ON c.facility_id = f.id AND c.pick = 1`,
      rows: [
        "alarms.equipment_id",
        "contracts.ends_on",
        "contracts.facility_id",
        "contracts.starts_on",
        "equipment.facility_id",
        "equipment.id",
        "facilities.id",
      ],
      columns: {
        alarm_id: ["alarms.id"],
        severity: ["alarms.severity"],
        raised_at: ["alarms.raised_at"],
        serial: ["equipment.serial"],
        facility: ["facilities.name"],
        region: ["facilities.region"],
        tier: ["contracts.tier"],
        priority: ["alarms.severity", "contracts.tier"],
      },
    },
    {
      name: "invoice and payment reconciliation with an FX ASOF join",
      sql: ({ invoices, payments, fx }) => `
        WITH paid AS (
          SELECT invoice_id, sum(amount) AS paid_amount, max(paid_at) AS last_paid_at
          FROM ${payments}
          GROUP BY invoice_id
        ),
        converted AS (
          SELECT i.id, i.customer_id, i.amount * fx.rate AS amount_eur, i.issued_at
          FROM ${invoices} i
          ASOF LEFT JOIN ${fx} fx
            ON fx.currency = i.currency AND CAST(i.issued_at AS DATE) >= fx.day
        )
        SELECT c.id AS invoice_id, c.customer_id, c.amount_eur,
          coalesce(p.paid_amount, 0) AS paid_amount,
          CASE
            WHEN coalesce(p.paid_amount, 0) >= c.amount_eur THEN 'paid'
            WHEN p.last_paid_at IS NULL AND c.issued_at < now() - INTERVAL 30 DAY THEN 'overdue'
            ELSE 'open'
          END AS status
        FROM converted c
        LEFT JOIN paid p ON p.invoice_id = c.id`,
      rows: [
        "fx.currency",
        "fx.day",
        "invoices.currency",
        "invoices.id",
        "invoices.issued_at",
        "payments.invoice_id",
      ],
      columns: {
        invoice_id: ["invoices.id"],
        customer_id: ["invoices.customer_id"],
        amount_eur: ["fx.rate", "invoices.amount"],
        paid_amount: ["payments.amount"],
        status: [
          "fx.rate",
          "invoices.amount",
          "invoices.issued_at",
          "payments.amount",
          "payments.paid_at",
        ],
      },
    },
    {
      name: "customer 360 with COALESCE across sources",
      sql: ({ crm, billing, tickets }) => `
        SELECT
          coalesce(crm.id, b.customer_id) AS customer_id,
          coalesce(b.legal_name, crm.name) AS name,
          coalesce(crm.country, b.country) AS country,
          crm.email,
          t.open_tickets
        FROM ${crm} crm
        FULL OUTER JOIN ${billing} b ON b.customer_id = crm.id
        LEFT JOIN (
          SELECT customer_id, count(*) FILTER (WHERE status <> 'closed') AS open_tickets
          FROM ${tickets}
          GROUP BY customer_id
        ) t ON t.customer_id = coalesce(crm.id, b.customer_id)`,
      rows: ["billing.customer_id", "crm.id", "tickets.customer_id"],
      columns: {
        customer_id: ["billing.customer_id", "crm.id"],
        name: ["billing.legal_name", "crm.name"],
        country: ["billing.country", "crm.country"],
        email: ["crm.email"],
        open_tickets: ["tickets.status"],
      },
    },
    {
      name: "sessionization with LAG",
      sql: ({ events }) => `
        WITH flagged AS (
          SELECT user_id, ts, page,
            CASE
              WHEN lag(ts) OVER (PARTITION BY user_id ORDER BY ts) IS NULL
                OR ts - lag(ts) OVER (PARTITION BY user_id ORDER BY ts) > INTERVAL 30 MINUTE
              THEN 1 ELSE 0
            END AS is_new_session
          FROM ${events}
          WHERE kind = 'page_view'
        ),
        numbered AS (
          SELECT *,
            sum(is_new_session) OVER (
              PARTITION BY user_id ORDER BY ts ROWS UNBOUNDED PRECEDING
            ) AS session_number
          FROM flagged
        )
        SELECT user_id, session_number, min(ts) AS started_at, max(ts) AS ended_at,
          count(*) AS page_views, list(page ORDER BY ts) AS pages
        FROM numbered
        GROUP BY user_id, session_number`,
      rows: ["events.kind", "events.ts", "events.user_id"],
      columns: {
        user_id: ["events.user_id"],
        session_number: ["events.ts", "events.user_id"],
        started_at: ["events.ts"],
        ended_at: ["events.ts"],
        page_views: [],
        pages: ["events.page", "events.ts"],
      },
    },
    {
      name: "SCD latest row per key with QUALIFY",
      sql: ({ crm }) => `
        SELECT id, name, email, country, updated_at AS valid_from
        FROM ${crm}
        QUALIFY row_number() OVER (PARTITION BY id ORDER BY updated_at DESC) = 1`,
      rows: ["crm.id", "crm.updated_at"],
      columns: {
        id: ["crm.id"],
        name: ["crm.name"],
        email: ["crm.email"],
        country: ["crm.country"],
        valid_from: ["crm.updated_at"],
      },
    },
    {
      name: "SCD validity ranges with LEAD",
      sql: ({ crm }) => `
        SELECT id, country, updated_at AS valid_from,
          lead(updated_at) OVER (PARTITION BY id ORDER BY updated_at) AS valid_to
        FROM ${crm}`,
      rows: ["crm.id", "crm.updated_at"],
      columns: {
        id: ["crm.id"],
        country: ["crm.country"],
        valid_from: ["crm.updated_at"],
        valid_to: ["crm.id", "crm.updated_at"],
      },
    },
    {
      name: "star schema aggregation with ROLLUP",
      sql: ({ orderLines, orders, products, calendar }) => `
        SELECT p.category, d.year, d.quarter,
          sum(l.quantity * l.unit_price) AS revenue,
          count(DISTINCT o.customer_id) AS customers,
          grouping(p.category, d.year, d.quarter) AS level
        FROM ${orderLines} l
        JOIN ${orders} o ON o.id = l.order_id
        JOIN ${products} p ON p.id = l.product_id
        JOIN ${calendar} d ON d.day = CAST(o.ordered_at AS DATE)
        GROUP BY ROLLUP (p.category, d.year, d.quarter)`,
      rows: [
        "calendar.day",
        "calendar.quarter",
        "calendar.year",
        "orderLines.order_id",
        "orderLines.product_id",
        "orders.id",
        "orders.ordered_at",
        "products.category",
        "products.id",
      ],
      columns: {
        category: ["products.category"],
        year: ["calendar.year"],
        quarter: ["calendar.quarter"],
        revenue: ["orderLines.quantity", "orderLines.unit_price"],
        customers: ["orders.customer_id"],
        level: ["calendar.quarter", "calendar.year", "products.category"],
      },
    },
    {
      name: "dedup with DISTINCT ON",
      sql: ({ readings }) => `
        SELECT DISTINCT ON (equipment_id, metric) equipment_id, metric, value, read_at
        FROM ${readings}
        ORDER BY equipment_id, metric, read_at DESC`,
      rows: ["readings.equipment_id", "readings.metric", "readings.read_at"],
      columns: {
        equipment_id: ["readings.equipment_id"],
        metric: ["readings.metric"],
        value: ["readings.value"],
        read_at: ["readings.read_at"],
      },
    },
    {
      name: "UNION ALL of three order sources",
      sql: ({ webOrders, storeOrders, partnerOrders }) => `
        SELECT 'web' AS channel, id AS order_ref, customer_id, amount FROM ${webOrders}
        UNION ALL
        SELECT 'store', receipt_id, customer_id, total FROM ${storeOrders}
        UNION ALL
        SELECT 'partner', reference, account_id, amount_due
        FROM ${partnerOrders}
        WHERE status = 'confirmed'`,
      rows: ["partnerOrders.status"],
      columns: {
        channel: [],
        order_ref: ["partnerOrders.reference", "storeOrders.receipt_id", "webOrders.id"],
        customer_id: [
          "partnerOrders.account_id",
          "storeOrders.customer_id",
          "webOrders.customer_id",
        ],
        amount: ["partnerOrders.amount_due", "storeOrders.total", "webOrders.amount"],
      },
    },
    {
      name: "recursive org hierarchy",
      sql: ({ employees }) => `
        WITH RECURSIVE chain AS (
          SELECT id, manager_id, name, 0 AS depth, name AS path
          FROM ${employees}
          WHERE manager_id IS NULL
          UNION ALL
          SELECT e.id, e.manager_id, e.name, c.depth + 1, c.path || ' > ' || e.name
          FROM ${employees} e
          JOIN chain c ON e.manager_id = c.id
        )
        SELECT id, name, depth, path FROM chain`,
      rows: ["employees.id", "employees.manager_id"],
      columns: {
        id: ["employees.id"],
        name: ["employees.name"],
        depth: [],
        path: ["employees.name"],
      },
    },
    {
      name: "recursive reachability deduplicated with UNION",
      sql: ({ employees }) => `
        WITH RECURSIVE reports(id, name) AS (
          SELECT id, name FROM ${employees} WHERE manager_id IS NULL
          UNION
          SELECT e.id, e.name FROM ${employees} e JOIN reports r ON e.manager_id = r.id
        )
        SELECT name FROM reports`,
      rows: ["employees.id", "employees.manager_id", "employees.name"],
      columns: { name: ["employees.name"] },
    },
    {
      name: "JSON extraction from a payload column",
      sql: ({ alarms }) => `
        SELECT id AS alarm_id,
          payload ->> '$.code' AS code,
          CAST(payload -> '$.threshold' AS DOUBLE) AS threshold,
          json_extract_string(payload, '$.source.sensor') AS sensor
        FROM ${alarms}
        WHERE json_extract_string(payload, '$.state') = 'open'`,
      rows: ["alarms.payload"],
      columns: {
        alarm_id: ["alarms.id"],
        code: ["alarms.payload"],
        threshold: ["alarms.payload"],
        sensor: ["alarms.payload"],
      },
    },
    {
      name: "list lambdas over a JSON payload",
      sql: ({ samples }) => `
        SELECT id,
          list_transform(CAST(payload -> '$.values' AS DOUBLE[]), x -> x * scale) AS scaled,
          list_filter(CAST(payload -> '$.tags' AS VARCHAR[]), lambda t: t <> excluded_tag) AS tags,
          list_reduce(CAST(payload -> '$.values' AS DOUBLE[]), (a, b) -> greatest(a, b)) AS peak
        FROM ${samples}`,
      rows: [],
      columns: {
        id: ["samples.id"],
        scaled: ["samples.payload", "samples.scale"],
        tags: ["samples.excluded_tag", "samples.payload"],
        peak: ["samples.payload"],
      },
    },
  ])
})

describe("SQL lineage: rejections", () => {
  const cases: readonly RejectionCase[] = [
    {
      name: "PIVOT",
      sql: ({ inv }) => `
        SELECT * FROM (
          PIVOT ${inv} ON currency IN ('EUR') USING sum(amount) GROUP BY customer_id
        )`,
      reason: "PIVOT is not supported",
    },
    {
      name: "UNPIVOT",
      sql: ({ inv }) => `
        SELECT * FROM (
          UNPIVOT (SELECT id, title, currency FROM ${inv}) ON title, currency INTO NAME k VALUE v
        )`,
      reason: "UNPIVOT is not supported",
    },
    {
      name: "read_csv",
      sql: () => "SELECT * FROM read_csv('/etc/hosts')",
      reason: "table function 'read_csv' is not supported",
    },
    {
      name: "read_parquet",
      sql: () => "SELECT * FROM read_parquet('data.parquet')",
      reason: "table function 'read_parquet' is not supported",
    },
    {
      name: "glob",
      sql: () => "SELECT * FROM glob('*')",
      reason: "table function 'glob' is not supported",
    },
    {
      name: "the query() table macro",
      sql: () => "SELECT * FROM query('SELECT 1')",
      reason: "table function 'query' is not supported",
    },
    {
      name: "the query_table() table macro",
      sql: () => "SELECT * FROM query_table('anything')",
      reason: "table function 'query_table' is not supported",
    },
    {
      name: "catalog table functions",
      sql: () => "SELECT * FROM duckdb_tables()",
      reason: "table function 'duckdb_tables' is not supported",
    },
    {
      name: "catalog views over table functions",
      sql: () => "SELECT * FROM information_schema.columns",
      reason: "table function 'duckdb_columns' is not supported",
    },
    {
      name: "DESCRIBE in FROM",
      sql: ({ inv }) => `SELECT * FROM (DESCRIBE ${inv})`,
      reason: "DESCRIBE, SHOW and SUMMARIZE are not supported",
    },
    {
      name: "query parameters",
      sql: ({ inv }) => `SELECT id FROM ${inv} WHERE amount > $1`,
      reason: "query parameters are not supported",
    },
    {
      name: "several statements",
      sql: ({ inv }) => `SELECT id FROM ${inv}; SELECT 2`,
      reason: "the transform must be exactly one SELECT statement",
    },
    {
      name: "an empty transform",
      sql: () => "",
      reason: "the transform must be exactly one SELECT statement",
    },
  ]

  for (const { name, sql, reason } of cases) {
    test(name, async () => {
      expect(await analyze(sql)).toEqual({ supported: false, reason })
    })
  }

  test("statements other than SELECT", async () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "SET threads = 1",
      "PIVOT t ON a USING sum(b)",
      "ATTACH 'other.db'",
    ]) {
      expect(await analyze(() => sql)).toEqual({
        supported: false,
        reason: expect.stringMatching(/^DuckDB could not parse the transform: /),
      })
    }
  })

  test("SQL that does not bind against the sources", async () => {
    expect(await analyze(({ inv }) => `SELECT rowid FROM ${inv}`)).toEqual({
      supported: false,
      reason: expect.stringMatching(
        /^DuckDB could not bind the transform: Referenced column "rowid" not found/
      ),
    })
    expect(await analyze(() => "SELECT * FROM '/etc/hosts'")).toEqual({
      supported: false,
      reason: expect.stringMatching(/^DuckDB could not bind the transform: /),
    })
  })
})

describe("SQL lineage: sources", () => {
  const orders = dataset(
    "sales.orders",
    col("id", "string"),
    col("customer_id", "string"),
    col("amount", "decimal")
  )

  test("binds a pick as the only columns of the source, in pick order", async () => {
    const picked = { orders: { ...orders, columns: ["amount", "id"] } }

    expect(await analyze(({ orders }) => `SELECT * FROM ${orders}`, picked)).toEqual({
      supported: true,
      lineage: {
        rows: [],
        columns: {
          amount: [{ source: "orders", column: "amount" }],
          id: [{ source: "orders", column: "id" }],
        },
      },
      outputColumns: ["amount", "id"],
    })
    expect(
      await analyze(({ orders }) => `SELECT customer_id FROM ${orders}`, picked)
    ).toMatchObject({
      supported: false,
      reason: expect.stringContaining('Referenced column "customer_id" not found'),
    })
  })

  test("throws for invalid picks instead of reporting an unsupported transform", async () => {
    await expect(
      analyze(({ orders }) => `SELECT * FROM ${orders}`, {
        orders: { ...orders, columns: ["total"] },
      })
    ).rejects.toThrow("picks column 'total', which dataset 'sales.orders' does not have")
  })

  // Regression proof: read the result's column order from the lineage record's keys. Names that
  // look like integers enumerate first, so the order no longer matches the result.
  test("keeps the result's column order when names look like integers", async () => {
    const analysis = await supportedAnalysis(
      ({ inv }) => `SELECT currency AS code, amount AS "2024", id AS "10" FROM ${inv}`
    )

    expect(analysis.outputColumns).toEqual(["code", "2024", "10"])
    expect(Object.keys(analysis.lineage.columns)).toEqual(["10", "2024", "code"])
  })

  test("names refs by source, whatever the source is called", async () => {
    const named = { ["__proto__"]: orders, "orders.v2": orders }

    expect(
      await analyze(
        (relations) => `
          SELECT a.id, b.amount
          FROM ${relations.__proto__} a JOIN ${relations["orders.v2"]} b USING (id)`,
        named
      )
    ).toEqual({
      supported: true,
      lineage: {
        rows: [
          { source: "__proto__", column: "id" },
          { source: "orders.v2", column: "id" },
        ],
        columns: {
          id: [{ source: "__proto__", column: "id" }],
          amount: [{ source: "orders.v2", column: "amount" }],
        },
      },
      outputColumns: ["id", "amount"],
    })
  })
})

describe("SQL lineage: perturbation", () => {
  // A result column must not change when a source column outside its value and row dependencies
  // changes. Each case runs on small random tables, then again after redrawing one such column.
  // Regression proof: drop the filter's row dependencies, and the first case fails.
  const perturbed = {
    s: dataset(
      "perturbation.s",
      col("id", "int64"),
      col("a", "int64"),
      col("m", "int64"),
      col("g", "string")
    ),
    t: dataset("perturbation.t", col("id", "int64"), col("b", "int64"), col("n", "int64")),
  }
  const tableNames = { s: "perturbation_s", t: "perturbation_t" }
  const rowCount = 6
  const trials = 4

  const cases: readonly {
    readonly name: string
    readonly sql: SqlTransformBody<"duckdb">
    readonly ordered?: boolean
  }[] = [
    { name: "filter", sql: ({ s }) => `SELECT id, a + 1 AS next FROM ${s} WHERE m > 1` },
    {
      name: "inner join",
      sql: ({ s, t }) => `SELECT s.id, t.b FROM ${s} s JOIN ${t} t ON s.id = t.id WHERE t.n <> 0`,
    },
    {
      name: "left join",
      sql: ({ s, t }) =>
        `SELECT s.id, coalesce(t.b, s.a) AS v FROM ${s} s LEFT JOIN ${t} t ON t.id = s.id`,
    },
    {
      name: "aggregate",
      sql: ({ s }) => `SELECT g, sum(a) AS total FROM ${s} GROUP BY g HAVING count(*) > 1`,
    },
    {
      name: "EXISTS",
      sql: ({ s, t }) =>
        `SELECT id, a FROM ${s} s WHERE EXISTS (SELECT 1 FROM ${t} t WHERE t.id = s.id AND t.b > 1)`,
    },
    {
      name: "correlated scalar subquery",
      sql: ({ s, t }) =>
        `SELECT id, (SELECT max(b) FROM ${t} t WHERE t.id = s.id) AS top_b FROM ${s} s`,
    },
    {
      name: "window",
      sql: ({ s }) => `SELECT id, sum(a) OVER (PARTITION BY g ORDER BY id, m) AS running FROM ${s}`,
    },
    {
      name: "ordered LIMIT",
      sql: ({ s }) =>
        `SELECT id, CASE WHEN m > 1 THEN a ELSE 0 END AS c FROM ${s} ORDER BY m, id, a LIMIT 3`,
      ordered: true,
    },
  ]

  let instance: DuckDBInstance
  let connection: DuckDBConnection

  beforeAll(async () => {
    instance = await DuckDBInstance.create(":memory:", { threads: "1" })
    connection = await instance.connect()
  })

  afterAll(() => {
    connection.closeSync()
    instance.closeSync()
  })

  type Tables = Record<keyof typeof perturbed, string[][]>

  /** mulberry32: unsigned 32-bit integers from a fixed seed. */
  function seededRandom(seed: number): () => number {
    let state = seed
    return () => {
      state = (state + 0x6d2b79f5) | 0
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
      return (mixed ^ (mixed >>> 14)) >>> 0
    }
  }

  function randomTables(random: () => number): Tables {
    const tables = {} as Tables
    for (const source of ["s", "t"] as const) {
      const columns = perturbed[source].dataset.schema.columns
      tables[source] = Array.from({ length: rowCount }, () =>
        columns.map((column) => randomValue(random, column.type))
      )
    }

    return tables
  }

  function randomValue(random: () => number, type: string): string {
    if (random() % 8 === 0) {
      return "NULL"
    }

    return type === "string" ? `'g${random() % 3}'` : String(random() % 4)
  }

  async function load(prefix: string, tables: Tables): Promise<void> {
    const statements = (["s", "t"] as const).map((source) => {
      const columns = perturbed[source].dataset.schema.columns.map(
        (column) => `"${column.name}" ${column.type === "string" ? "VARCHAR" : "BIGINT"}`
      )
      const rows = tables[source].map((row) => `(${row.join(", ")})`).join(", ")
      const name = `${prefix}_${tableNames[source]}`

      return `CREATE OR REPLACE TABLE ${name} (${columns.join(", ")}); INSERT INTO ${name} VALUES ${rows};`
    })
    await connection.run(statements.join("\n"))
  }

  async function columnValues(sql: string, index: number, ordered: boolean): Promise<string> {
    try {
      const values = (await connection.runAndReadAll(sql))
        .getRows()
        .map((row) => String(row[index]))
      return JSON.stringify(ordered ? values : values.sort())
    } catch (error) {
      return `error: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  cases.forEach((perturbationCase, caseIndex) => {
    test(perturbationCase.name, async () => {
      const random = seededRandom(1_000 + caseIndex)
      const analysis = await supportedAnalysis(perturbationCase.sql, perturbed)

      const template = createDuckLakeSqlTransformTemplate(["s", "t"], perturbationCase.sql)
      const render = (prefix: string) =>
        template.render(
          new Map(
            (["s", "t"] as const).map((source) => [
              source,
              `(SELECT * FROM ${prefix}_${tableNames[source]})`,
            ])
          )
        )

      for (const [index, output] of analysis.outputColumns.entries()) {
        const dependencies = new Set(
          [...analysis.lineage.rows, ...analysis.lineage.columns[output]].map(
            (ref) => `${ref.source}.${ref.column}`
          )
        )

        for (const source of ["s", "t"] as const) {
          const columns = perturbed[source].dataset.schema.columns
          for (const [columnIndex, column] of columns.entries()) {
            if (dependencies.has(`${source}.${column.name}`)) {
              continue
            }

            for (let trial = 0; trial < trials; trial += 1) {
              const before = randomTables(random)
              const after = structuredClone(before)

              for (const row of after[source]) {
                if (random() % 2 === 0) {
                  row[columnIndex] = randomValue(random, column.type)
                }
              }

              await load("before", before)
              await load("after", after)

              const ordered = perturbationCase.ordered ?? false
              expect({
                output,
                perturbed: `${source}.${column.name}`,
                values: await columnValues(render("after"), index, ordered),
              }).toEqual({
                output,
                perturbed: `${source}.${column.name}`,
                values: await columnValues(render("before"), index, ordered),
              })
            }
          }
        }
      }
    })
  })
})

describe("SQL lineage: DuckDB plan format drift", () => {
  let instance: DuckDBInstance
  let connection: DuckDBConnection
  const tables: PlanSourceTables = new Map([
    [
      "inv",
      new Map([
        ["id", 0],
        ["customer_id", 1],
        ["amount", 2],
      ]),
    ],
    [
      "cust",
      new Map([
        ["id", 3],
        ["name", 4],
      ]),
    ],
  ])

  beforeAll(async () => {
    instance = await DuckDBInstance.create(":memory:")
    connection = await instance.connect()

    await connection.run("CREATE TABLE inv (id VARCHAR, customer_id VARCHAR, amount DOUBLE)")
    await connection.run("CREATE TABLE cust (id VARCHAR, name VARCHAR)")
  })

  afterAll(() => {
    connection.closeSync()
    instance.closeSync()
  })

  async function planOf(sql: string): Promise<Record<string, unknown>> {
    const reader = await connection.runAndReadAll(
      `SELECT json_serialize_plan('${sql.replaceAll("'", "''")}', skip_null := false, skip_empty := false, optimize := false)`
    )
    const output: unknown = JSON.parse(String(reader.getRows()[0]?.[0]))
    if (!isJsonObject(output) || !Array.isArray(output.plans)) {
      throw new Error("Expected a serialized plan.")
    }

    return output.plans[0]
  }

  /** The first object in the plan matching `predicate`, depth first. */
  function find(value: unknown, predicate: (node: Record<string, unknown>) => boolean) {
    const stack: unknown[] = [value]
    while (stack.length > 0) {
      const next = stack.pop()
      if (Array.isArray(next)) {
        stack.push(...[...next].reverse())
      } else if (typeof next === "object" && next !== null) {
        const node = next as Record<string, unknown>
        if (predicate(node)) {
          return node
        }

        stack.push(...Object.values(node).reverse())
      }
    }

    throw new Error("No matching plan node.")
  }

  function expectRejected(plan: unknown, reason: string): void {
    expect(() => planLineage(plan, tables)).toThrow(new SqlLineageRejected(reason))
  }

  const joinSql = "SELECT i.id, c.name FROM inv i JOIN cust c ON i.customer_id = c.id"

  test("reads the unmodified plan", async () => {
    expect(planLineage(await planOf(joinSql), tables)).toEqual({
      rows: [1, 3],
      columns: [[0], [4]],
    })
  })

  test("rejects a renamed field", async () => {
    const plan = await planOf(joinSql)
    const join = find(plan, (node) => node.type === "LOGICAL_COMPARISON_JOIN")
    join.join_conditions = join.conditions
    delete join.conditions

    expectRejected(plan, "unexpected DuckDB plan format: missing field 'conditions'")
  })

  test("rejects a retyped field", async () => {
    const plan = await planOf(joinSql)
    find(plan, (node) => node.type === "LOGICAL_GET").table_index = "0"

    expectRejected(plan, "unexpected DuckDB plan format: field 'table_index' is not an index")
  })

  test("rejects an unknown join type", async () => {
    const plan = await planOf(joinSql)
    find(plan, (node) => node.type === "LOGICAL_COMPARISON_JOIN").join_type = "LEFT_LATERAL"

    expectRejected(plan, "join type 'LEFT_LATERAL' is not supported")
  })

  test("rejects an unknown plan node", async () => {
    const plan = await planOf(joinSql)
    find(plan, (node) => node.type === "LOGICAL_COMPARISON_JOIN").type = "LOGICAL_HASH_JOIN"

    expectRejected(plan, "plan node 'LOGICAL_HASH_JOIN' is not supported")
  })

  test("rejects an unknown expression", async () => {
    const plan = await planOf(joinSql)
    find(plan, (node) => node.expression_class === "BOUND_REF").expression_class = "BOUND_SLOT"

    expectRejected(plan, "expression 'BOUND_SLOT' is not supported")
  })

  test("rejects an out-of-range column reference", async () => {
    const plan = await planOf(joinSql)
    find(plan, (node) => node.expression_class === "BOUND_REF").index = 9

    expectRejected(plan, "unexpected DuckDB plan format: column 9 is out of range")
  })

  test("rejects expressions hidden in function bind data", async () => {
    const plan = await planOf("SELECT upper(c.name) FROM cust c")
    const call = find(plan, (node) => node.expression_class === "BOUND_FUNCTION")
    call.has_serialize = true
    call.function_data = { pattern: find(plan, (node) => node.expression_class === "BOUND_REF") }

    expectRejected(
      plan,
      "function 'upper' keeps expressions in its bind data, which is not supported"
    )
  })

  test("rejects expressions hidden in window aggregate bind data", async () => {
    const plan = await planOf(
      "SELECT quantile_cont(amount, 0.5) OVER (PARTITION BY customer_id) FROM inv"
    )
    expect(planLineage(plan, tables)).toEqual({ rows: [1], columns: [[1, 2]] })

    const window = find(plan, (node) => node.expression_class === "BOUND_WINDOW")
    window.function_data = {
      quantiles: [find(plan, (node) => node.expression_class === "BOUND_REF")],
    }

    expectRejected(
      plan,
      "function 'quantile_cont' keeps expressions in its bind data, which is not supported"
    )
  })

  test("rejects reads of virtual columns", async () => {
    expectRejected(
      await planOf("SELECT rowid FROM inv"),
      "reading virtual columns such as rowid is not supported"
    )
    expect(planLineage(await planOf("SELECT count(*) FROM inv"), tables)).toEqual({
      rows: [],
      columns: [[]],
    })
  })

  test("keeps UNION deduplication without a DISTINCT above it", async () => {
    // Today DuckDB plans UNION as DISTINCT over UNION ALL. Should the deduplication move into the
    // set operation, setop_all still makes every column a row dependency.
    const plan = await planOf("SELECT id FROM inv UNION SELECT name FROM cust")
    expect(plan.type).toBe("LOGICAL_DISTINCT")

    const union = find(plan, (node) => node.type === "LOGICAL_UNION")

    expect(planLineage(union, tables)).toEqual({ rows: [0, 4], columns: [[0, 4]] })
  })
})
