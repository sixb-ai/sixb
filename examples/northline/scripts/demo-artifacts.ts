import { resolve } from "node:path"
import { apiBaseUrl, apiRequest, isRecord } from "./api"

// Publishes artifacts that exercise the viewer: documents with every element the document page
// shapes, a second version, artifact themes, sheets with charts and a long one to scroll, and one
// file artifact per way a file can show.
// Run it while Northline is up; each run publishes a new set.

const appUrl = (process.env.SIXB_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "")

type FileRef = Record<string, unknown>
type Kind = "document" | "sheet" | "file"

async function upload(name: string, body: BlobPart, mediaType: string): Promise<FileRef> {
  const form = new FormData()
  form.append("file", new File([body], name, { type: mediaType }))
  const fileRef = await apiRequest("/files", { method: "POST", body: form })
  if (!isRecord(fileRef) || typeof fileRef.blobId !== "string") {
    throw new Error(`[Northline] Uploading ${name} returned an unexpected response.`)
  }
  return fileRef
}

async function publish(
  input: { readonly kind: Kind; readonly title: string; readonly files: Record<string, FileRef> },
  artifactId?: string
): Promise<{ readonly id: string; readonly version: number }> {
  const published = await apiRequest(
    artifactId ? `/artifacts/${encodeURIComponent(artifactId)}/versions` : "/artifacts",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: input.kind,
        title: input.title,
        files: Object.entries(input.files).map(([path, file]) => ({ path, file })),
      }),
    }
  )
  if (
    !isRecord(published) ||
    !isRecord(published.artifact) ||
    typeof published.artifact.id !== "string" ||
    !isRecord(published.version) ||
    typeof published.version.version !== "number"
  ) {
    throw new Error(`[Northline] Publishing "${input.title}" returned an unexpected response.`)
  }
  if (Array.isArray(published.warnings) && published.warnings.length > 0) {
    console.warn(`[Northline] "${input.title}" published with warnings:`, published.warnings)
  }
  return { id: published.artifact.id, version: published.version.version }
}

async function publishFile(title: string, path: string, body: BlobPart, mediaType: string) {
  const file = await upload(path, body, mediaType)
  return publish({ kind: "file", title, files: { [path]: file } })
}

// --- Content ---------------------------------------------------------------------------------

/** A grouped bar chart in fixed colors that read on light and dark pages alike. */
function barChart(input: {
  readonly series: readonly [string, string]
  readonly rows: readonly (readonly [string, number, number])[]
  readonly min: number
  readonly max: number
  readonly ticks: readonly number[]
  readonly format: (value: number) => string
}): string {
  const [width, height, left, right, top, bottom] = [720, 340, 64, 24, 56, 44]
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const y = (value: number) =>
    top + plotHeight * (1 - (value - input.min) / (input.max - input.min))
  const slot = plotWidth / input.rows.length
  const bar = Math.min(44, slot / 3)
  const colors = ["#94a3b8", "#0d9488"] as const

  const grid = input.ticks.map(
    (tick) =>
      `<line x1="${left}" x2="${width - right}" y1="${y(tick)}" y2="${y(tick)}" stroke="#94a3b8" stroke-opacity="0.35"/>` +
      `<text x="${left - 10}" y="${y(tick) + 4}" text-anchor="end">${input.format(tick)}</text>`
  )
  const bars = input.rows.map(([label, before, after], index) => {
    const center = left + slot * (index + 0.5)
    const rect = (x: number, value: number, color: string) =>
      `<rect x="${x}" y="${y(value)}" width="${bar}" height="${top + plotHeight - y(value)}" rx="3" fill="${color}"/>`
    return (
      rect(center - bar - 3, before, colors[0]) +
      rect(center + 3, after, colors[1]) +
      `<text x="${center + 3 + bar / 2}" y="${y(after) - 7}" text-anchor="middle" font-weight="600" fill="${colors[1]}">${input.format(after)}</text>` +
      `<text x="${center}" y="${height - bottom + 24}" text-anchor="middle">${label}</text>`
    )
  })
  const legend = input.series.map(
    (name, index) =>
      `<rect x="${left + index * 120}" y="18" width="12" height="12" rx="2" fill="${colors[index]}"/>` +
      `<text x="${left + index * 120 + 18}" y="28">${name}</text>`
  )
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui, sans-serif" font-size="13" fill="#64748b">${grid.join("")}${bars.join("")}${legend.join("")}</svg>`
}

const restorations = (rows: readonly (readonly [string, number, number])[]) =>
  barChart({
    series: ["Q2", "Q3"],
    rows,
    min: 80,
    max: 100,
    ticks: [80, 85, 90, 95, 100],
    format: (value) => `${value % 1 === 0 ? value : value.toFixed(1)}%`,
  })

const reviewDraft = `# Q3 operations review

Draft: figures through September 15. Priority restorations within the service window are tracking
near 91%.

## Service performance

![Restorations within SLA](figures/restorations.svg "Figure 1. Priority restorations within SLA by region, Q2 and Q3 to date")

| Region | Visits | Within SLA |
| --- | --- | --- |
| North | 1,102 | 94.0% |
| Central | 811 | 89.9% |
| South | 948 | 90.6% |
| Coastal | 377 | 93.2% |

> [!NOTE]
> This draft is replaced by version 2 once the quarter closes.
`

const reviewFinal = `# Q3 operations review

Northline restored 94% of priority equipment within its service window this quarter, up from 88%,
while parts costs held flat against a 12% rise in call volume.

## Highlights

- Priority restorations within SLA rose to **94%**.
- First-visit fix rate reached 81%[^fix].
- Two technicians completed building-controls certification.

> [!NOTE]
> Figures cover July 1 to September 30 and exclude warranty-only visits.

## Service performance

![Restorations within SLA](figures/restorations.svg "Figure 1. Priority restorations within SLA by region, Q2 and Q3")

| Region | Visits | Within SLA | Change | Parts cost |
| --- | --- | --- | --- | --- |
| North | 1,284 | 96.1% | +4.2% | $182,400 |
| Central | 962 | 93.4% | +6.8% | $141,950 |
| South | 1,107 | 91.8% | (1.3%) | $166,020 |
| Coastal | 448 | 95.0% | +2.1% | $58,310 |
| **Total** | **3,801** | **94.0%** | **+3.9%** | **$548,680** |

### Response times

Median time to arrival fell to 3.4 hours. The slowest fifth of calls still waits more than eight
hours, almost all of them after hours in the South region.

> [!TIP]
> Link straight to this section with \`?part=response-times\`, or copy its address from the link
> icon beside the heading.

### Notes

South is the only region that slipped. Two senior technicians were on leave in August, and the
region absorbed the Harbor Point failures.

## Revenue & cost

Service revenue grew 9.6% to $2.14M. Parts cost per visit fell from $151 to $144 as more repairs
used depot stock instead of rush orders.

## Risks

> [!WARNING]
> Compressor lead times have stretched to nine weeks. Three open cases are waiting on parts.

> [!CAUTION]
> Both rooftop units at Harbor Point failed twice this quarter. A third failure in winter would
> close the building.

> [!IMPORTANT]
> Approve the Harbor Point replacement quote by October 31 to hold this year's price.

| Site | Issue | Owner | Due |
| --- | --- | --- | --- |
| Harbor Point | Rooftop units RTU-1 and RTU-2 | Dana Ortiz | Oct 31 |
| Central depot | Compressor stock | Sam Patel | Nov 15 |

### Notes

A plain quote stays a quote:

> Keep the units running, and tell the customer before they ask.
> — Field operations handbook

## Next quarter

- [x] Roll out the dispatch board to every region
- [ ] Stock compressors at the Central depot
- [ ] Certify four more technicians on building controls

How the review counts a restoration as within SLA:

\`\`\`ts
const withinSla =
  restored.filter((visit) => visit.restoredAt <= visit.dueAt).length / restored.length
\`\`\`

## Appendix: méthode de calcul

![Northline](images/northline.png)

Visits come from the field-service platform and costs from the business system, both through
Northline's syncs. See [the field-service platform](https://example.com) for raw visit records, or
go back to [Service performance](#service-performance).

[^fix]: Cases closed on the first visit, excluding planned maintenance.
`

const brief = `# Harbor Point: replace both rooftop units

Both units have failed twice this quarter. Replacing them now costs less over three years than
repairing them as they fail, and it holds this year's price.

> [!IMPORTANT]
> Approval is needed by October 31 to hold the quoted price.

## The decision

| Option | Upfront | 3-year cost | Downtime risk |
| --- | --- | --- | --- |
| Replace both units | $84,200 | $91,600 | Low |
| Repair as they fail | $12,800 | $118,400 | High |

## Why now

![Emergency repair spend](figures/repairs.svg "Figure 1. Emergency repair spend at Harbor Point by quarter, in thousands")

Emergency spend has risen every quarter since the units passed fifteen years in service. Parts for
this model are now special-order, which is what turned the last failure into a four-day outage.

> [!NOTE]
> This brief carries its own theme: it stays dark, in its own colors, whatever theme the app uses.
`

const brightBrief = `# Morning checklist

This page pins light mode, so it stays light when the app is dark.

## Before the first visit

- [ ] Check the dispatch board for overnight alarms
- [ ] Load parts for the first two visits
- [x] Confirm the van's refrigerant scale is calibrated

> [!TIP]
> Switch the app to dark mode: this page stays light, and the Q3 review follows the app.
`

function pdf(lines: readonly string[]): string {
  const pdfString = (line: string) => line.replace(/[\\()]/g, "\\$&")
  const content = lines
    .map((line, index) => {
      const size = index === 0 ? 20 : 12
      return `BT /F1 ${size} Tf 72 ${720 - index * 26} Td (${pdfString(line)}) Tj ET`
    })
    .join("\n")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  // ASCII only, so string offsets are byte offsets.
  let body = "%PDF-1.4\n"
  const offsets = objects.map((object, index) => {
    const offset = body.length
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return body
}

const sites = ["north/ahu-3", "central/rtu-7", "south/chiller-1", "coastal/rtu-2"] as const

function sensorCsv(rows: number): string {
  const lines = ["reading_at,site,unit,supply_temp_f,return_temp_f,delta_f,status"]
  for (let index = 0; index < rows; index += 1) {
    const at = new Date(Date.UTC(2026, 8, 1) + index * 15 * 60_000).toISOString()
    const [site, unit] = (sites[index % sites.length] as string).split("/")
    const supply = 54 + ((index * 7) % 30) / 10
    const returned = supply + 14 + ((index * 3) % 40) / 10
    const status = returned - supply > 17.5 ? "check" : "ok"
    lines.push(
      `${at},${site},${unit},${supply.toFixed(1)},${returned.toFixed(1)},${(returned - supply).toFixed(1)},${status}`
    )
  }
  return `${lines.join("\n")}\n`
}

function telemetryLog(minBytes: number): string {
  const lines: string[] = []
  let bytes = 0
  for (let index = 0; bytes < minBytes; index += 1) {
    const at = new Date(Date.UTC(2026, 9, 1) + index * 1_000).toISOString()
    const line = `${at} ${sites[index % sites.length]} supply=${(54 + (index % 30) / 10).toFixed(1)}F status=ok`
    lines.push(line)
    bytes += line.length + 1
  }
  return `${lines.join("\n")}\n`
}

const partsTsv = [
  ["part", "description", "on_hand", "reorder_at", "unit_cost"],
  ["CMP-4410", "Scroll compressor, 5 ton", "0", "2", "$1,840.00"],
  ["FAN-220", "Condenser fan motor", "6", "4", "$212.50"],
  ["CAP-45-5", "Dual run capacitor 45/5 uF", "38", "20", "$18.75"],
  ["FLT-2025", "Pleated filter 20x25x2, MERV 13", "140", "60", "$9.10"],
  ["BLT-A48", "V-belt A48", "22", "10", "$14.30"],
  ["TXV-R410", "Thermal expansion valve, R-410A", "3", "4", "$165.00"],
]
  .map((row) => row.join("\t"))
  .join("\n")

const technicianNotes = `# Technician notes: RTU-2, Harbor Point

Visit on **October 3** for a high-pressure lockout.

## Findings

1. Condenser coil about 40% blocked with debris.
2. Fan motor drawing 6.8 A against a 5.9 A rating.
3. Compressor contactor pitted.

## Work done

| Task | Minutes |
| --- | --- |
| Coil cleaning | 45 |
| Contactor replacement | 30 |

> Recommend replacing the unit; see the Harbor Point brief.
`

const telemetryJson = JSON.stringify(
  {
    unit: "RTU-2",
    site: "Harbor Point",
    readAt: "2026-10-03T14:05:00.000Z",
    supplyTempF: 57.4,
    returnTempF: 76.9,
    compressor: { state: "locked_out", fault: "high_pressure", starts24h: 41 },
    alarms: [{ code: "HP-01", raisedAt: "2026-10-03T13:51:12.000Z" }],
  },
  null,
  2
)

const floorPlanHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Harbor Point floor plan</title></head>
  <body><h1>Harbor Point, roof level</h1><p>RTU-1 serves the east wing; RTU-2 the west.</p></body>
</html>
`

// The smallest valid zip: an end-of-central-directory record with no entries.
const emptyZip = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)])

// --- Publish ---------------------------------------------------------------------------------

try {
  await apiRequest("/project")
} catch {
  throw new Error(
    `[Northline] Could not reach the API at ${apiBaseUrl()}. Start Northline first: bun --filter @sixb/example-northline dev`
  )
}

const logo = await Bun.file(resolve(import.meta.dir, "../app/public/icon-512.png")).arrayBuffer()

const reviewV1 = await publish({
  kind: "document",
  title: "Q3 operations review",
  files: {
    "document.md": await upload("document.md", reviewDraft, "text/markdown"),
    "figures/restorations.svg": await upload(
      "restorations.svg",
      restorations([
        ["North", 91.9, 94.0],
        ["Central", 86.6, 89.9],
        ["South", 93.1, 90.6],
        ["Coastal", 92.9, 93.2],
      ]),
      "image/svg+xml"
    ),
  },
})
const review = await publish(
  {
    kind: "document",
    title: "Q3 operations review",
    files: {
      "document.md": await upload("document.md", reviewFinal, "text/markdown"),
      "figures/restorations.svg": await upload(
        "restorations.svg",
        restorations([
          ["North", 91.9, 96.1],
          ["Central", 86.6, 93.4],
          ["South", 93.1, 91.8],
          ["Coastal", 92.9, 95.0],
        ]),
        "image/svg+xml"
      ),
      "images/northline.png": await upload("northline.png", logo, "image/png"),
    },
  },
  reviewV1.id
)

const themed = await publish({
  kind: "document",
  title: "Harbor Point: replace both rooftop units",
  files: {
    "document.md": await upload("document.md", brief, "text/markdown"),
    "figures/repairs.svg": await upload(
      "repairs.svg",
      barChart({
        series: ["Parts", "Labor"],
        rows: [
          ["Q4 2025", 3.1, 2.4],
          ["Q1 2026", 4.8, 3.6],
          ["Q2 2026", 7.9, 5.2],
          ["Q3 2026", 12.6, 8.8],
        ],
        min: 0,
        max: 14,
        ticks: [0, 2, 4, 6, 8, 10, 12, 14],
        format: (value) => `$${value}k`,
      }),
      "image/svg+xml"
    ),
    "theme.json": await upload(
      "theme.json",
      JSON.stringify({
        mode: "dark",
        tokens: {
          "--background": "#10151c",
          "--foreground": "#e8edf3",
          "--muted": "#1b232e",
          "--muted-foreground": "#93a1b3",
          "--border": "#2a3441",
          "--primary": "#f2b84b",
          "--font-serif": "Georgia, serif",
          "--radius": "4px",
        },
      }),
      "application/json"
    ),
  },
})

const bright = await publish({
  kind: "document",
  title: "Morning checklist",
  files: {
    "document.md": await upload("document.md", brightBrief, "text/markdown"),
    "theme.json": await upload("theme.json", JSON.stringify({ mode: "light" }), "application/json"),
  },
})

// The Agent's example workbooks, as its skill ships them.
const sheetExamples = resolve(
  import.meta.dir,
  "../../../packages/agent-worker/src/skills/sixb-artifacts/examples/sheet"
)
async function exampleSheetFiles(name: string): Promise<Record<string, FileRef>> {
  const directory = resolve(sheetExamples, name)
  const files: Record<string, FileRef> = {}
  for (const path of new Bun.Glob("**/*").scanSync(directory)) {
    const mediaType = path.endsWith(".json") ? "application/json" : "text/csv"
    const name = path.split("/").at(-1) ?? path
    files[path] = await upload(name, await Bun.file(resolve(directory, path)).text(), mediaType)
  }
  return files
}

/** A visit log long enough to scroll: dates, hours, costs, an SLA flag, and a link per case. */
function visitLogCsv(rows: number): string {
  const regions = ["North", "Central", "South", "Coastal"]
  const issues = ["Compressor", "Fan motor", "Thermostat", "Refrigerant leak", "Control board"]
  const lines = ["Visit,Date,Region,Site,Issue,Hours,Parts cost,Within SLA,Case"]
  for (let index = 0; index < rows; index += 1) {
    const date = new Date(Date.UTC(2026, 6, 1) + Math.floor(index / 55) * 86_400_000)
    lines.push(
      [
        `V-${24_001 + index}`,
        date.toISOString().slice(0, 10),
        regions[index % regions.length],
        `"Site ${(index * 37) % 211}, Bay ${(index % 6) + 1}"`,
        issues[(index * 7) % issues.length],
        (((index * 17) % 70) / 10 + 0.5).toFixed(1),
        (((index * 7919) % 120_000) / 100).toFixed(2),
        index % 9 === 0 ? 0 : 1,
        `https://ops.northline.example/cases/${41_000 + index}`,
      ].join(",")
    )
  }
  return `${lines.join("\n")}\n`
}

const metrics = await publish({
  kind: "sheet",
  title: "Q3 service metrics",
  files: await exampleSheetFiles("service-metrics"),
})

const inventory = await publish({
  kind: "sheet",
  title: "Parts inventory",
  files: {
    ...(await exampleSheetFiles("parts-inventory")),
    // Its own chart colors, from its theme.
    "theme.json": await upload(
      "theme.json",
      JSON.stringify({
        tokens: {
          "--chart-1": "#0d9488",
          "--chart-2": "#2563eb",
          "--chart-3": "#f59e0b",
          "--chart-4": "#e11d48",
          "--chart-5": "#7c3aed",
        },
      }),
      "application/json"
    ),
  },
})

const visits = await publish({
  kind: "sheet",
  title: "Q3 visit log",
  files: {
    "workbook.json": await upload(
      "workbook.json",
      JSON.stringify({
        sheets: [
          {
            name: "Visits",
            frozenColumns: 1,
            columns: {
              Date: "date",
              Hours: { type: "number", decimals: 1 },
              "Parts cost": "currency",
              "Within SLA": { type: "percent", decimals: 0 },
              Case: "link",
            },
          },
        ],
      }),
      "application/json"
    ),
    "sheets/Visits.csv": await upload("Visits.csv", visitLogCsv(5_000), "text/csv"),
  },
})

const files = [
  [
    "Sensor readings (CSV, 1,200 rows)",
    await publishFile("Sensor readings", "sensor-readings.csv", sensorCsv(1_200), "text/csv"),
  ],
  [
    "Parts inventory (TSV)",
    await publishFile(
      "Parts inventory",
      "parts-inventory.tsv",
      partsTsv,
      "text/tab-separated-values"
    ),
  ],
  [
    "Technician notes (Markdown)",
    await publishFile("Technician notes", "technician-notes.md", technicianNotes, "text/markdown"),
  ],
  [
    "Unit telemetry (JSON as text)",
    await publishFile("Unit telemetry", "rtu-2.json", telemetryJson, "application/json"),
  ],
  ["Northline mark (PNG)", await publishFile("Northline mark", "northline.png", logo, "image/png")],
  [
    "Service report (PDF)",
    await publishFile(
      "Service report",
      "service-report.pdf",
      pdf([
        "Northline Mechanical: service report",
        "Site: Harbor Point. Unit: RTU-2.",
        "Cleaned the condenser coil and replaced the compressor contactor.",
        "Recommendation: replace the unit before winter.",
      ]),
      "application/pdf"
    ),
  ],
  [
    "Floor plan (HTML, downloads)",
    await publishFile("Floor plan", "floor-plan.html", floorPlanHtml, "text/html"),
  ],
  [
    "Site photos (ZIP, downloads)",
    await publishFile("Site photos", "site-photos.zip", emptyZip, "application/zip"),
  ],
  [
    "Fleet telemetry (6 MB log, too large to preview)",
    await publishFile(
      "Fleet telemetry",
      "fleet-telemetry.log",
      telemetryLog(6 * 1024 * 1024),
      "text/plain"
    ),
  ],
] as const

// --- Report ----------------------------------------------------------------------------------

const page = (id: string, query = "") => `${appUrl}/artifacts/${id}${query}`
const threads = await apiRequest("/agent-threads").catch(() => null)
const threadId =
  isRecord(threads) &&
  Array.isArray(threads.threads) &&
  isRecord(threads.threads[0]) &&
  typeof threads.threads[0].id === "string"
    ? threads.threads[0].id
    : null

const rows: (readonly [string, string])[] = [
  ["Q3 operations review (2 versions)", page(review.id)],
  ["  at a section", page(review.id, "?part=response-times")],
  ["  version 1", page(review.id, "?v=1")],
  ["Harbor Point brief (own dark theme)", page(themed.id)],
  ["Morning checklist (pinned light)", page(bright.id)],
  ["Q3 service metrics (sheet, 2 charts)", page(metrics.id)],
  ["  at a chart", page(metrics.id, "?part=chart=revenue")],
  ["Parts inventory (sheet, own chart colors)", page(inventory.id, "?part=Spend")],
  ["Q3 visit log (sheet, 5,000 rows)", page(visits.id)],
  ...files.map(([label, artifact]) => [label, page(artifact.id)] as const),
  [
    "Beside a conversation",
    threadId
      ? `${appUrl}/agents/${encodeURIComponent(threadId)}?artifact=${review.id}`
      : `${appUrl}/agents/<thread id>?artifact=${review.id}  (start a conversation first)`,
  ],
]
const width = Math.max(...rows.map(([label]) => label.length))
console.log(`[Northline] Published ${6 + files.length} artifacts:\n`)
for (const [label, url] of rows) console.log(`  ${label.padEnd(width)}  ${url}`)
