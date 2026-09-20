import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { DocConfig } from "./config"
import { renderHighlightedMarkdown } from "./renderMarkdown"

// Hand-authored snippets for the landing hero. They tell the end-to-end story
// with one Customer type: model it, query it, render it.
const sources: ReadonlyArray<{
  readonly label: string
  readonly filename: string
  readonly lang: string
  readonly code: string
}> = [
  {
    label: "Model",
    filename: "ontology/customer.ts",
    lang: "ts",
    code: `import { defineObjectType, prop } from "@sixb/core/ontology"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("tier", "string", { query: { searchable: true, filterable: true } }),
    prop("mrr", "double", { mode: "telemetry" }),
  ],
})`,
  },
  {
    label: "Query",
    filename: "reports/top-customers.ts",
    lang: "ts",
    code: `// Typed against your ontology.
const top = await sixb
  .objects(Customer)
  .query()
  .where((c) => c.p.tier.eq("team"))
  .limit(10)
  .list()`,
  },
  {
    label: "App",
    filename: "app/customers.tsx",
    lang: "tsx",
    code: `import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Customer } from "../ontology/customer"

export default function Customers() {
  const query = objects(Customer).query()
  const { data } = useObjectsQuery(query)

  return data?.objects.map((c) => (
    <div key={c.primaryId}>
      {c.properties.name}
    </div>
  ))
}`,
  },
]

const stubDoc = { markdownPath: "/" } as unknown as DocConfig

const snippets = await Promise.all(
  sources.map(async (source) => {
    const markdown = `File: \`${source.filename}\`\n\n\`\`\`${source.lang}\n${source.code}\n\`\`\`\n`
    const { html } = await renderHighlightedMarkdown(markdown, { doc: stubDoc, docs: [] })
    return { label: source.label, html }
  })
)

const outputPath = join(import.meta.dir, "..", "generated", "snippets.ts")
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(
  outputPath,
  `export interface HeroSnippet {\n  readonly label: string\n  readonly html: string\n}\n\nexport const heroSnippets: readonly HeroSnippet[] = ${JSON.stringify(snippets, null, 2)}\n`,
  "utf-8"
)

// The starter keeps the scaffold's behavior, with its HTTP client in a separate file for reading.
const starterFiles = [
  ["sixb.config.ts", "Choose storage and messaging providers."],
  ["connectors/celestrak.ts", "Declare the connector; the HTTP client lives in lib/."],
  ["datasets/satellite-orbit.ts", "Describe the imported rows."],
  ["syncs/satellite-orbit.ts", "Read the connector into a dataset."],
  ["ontology/satellite.ts", "Define the object your app works with."],
  ["projections/satellite.ts", "Map dataset rows to objects."],
  ["app/page.tsx", "Query the objects from a React page."],
  ["lib/celestrak.ts", "HTTP requests, caching, validation, and TLE parsing."],
] as const

const marketingFiles = [
  ["connectors/google-ads.ts", "Configure access to Google Ads."],
  ["datasets/campaigns.ts", "Declare the raw, active, and clean tables."],
  ["syncs/campaigns.ts", "Import campaigns from one advertiser account."],
  ["pipelines/campaigns.ts", "Run the two transform steps in order."],
  ["pipelines/steps/select-active.ts", "Step 1: keep enabled campaigns."],
  ["pipelines/steps/clean-names.ts", "Step 2: trim campaign names."],
  ["ontology/campaign.ts", "Define the Campaign object and its search fields."],
  ["projections/campaigns.ts", "Map clean rows to Campaign objects."],
  ["schedules/campaigns.ts", "Import hourly; transform when raw data changes."],
  ["app/page.tsx", "Read campaign objects in your React app."],
  ["actions/mark-reviewed.ts", "Mark an object as reviewed."],
  ["projections/campaign-history.ts", "Map timestamped measurements into object history."],
  ["workflows/monthly-report.ts", "Analyze supplied performance, then wait for human review."],
  [
    "workflows/steps/analyze-performance.ts",
    "An agent step summarizes the supplied measurements; configure a language model to run it.",
  ],
  ["workflows/steps/review-report.ts", "A reviewer edits and submits the final report."],
  ["agent/conversation.ts", "Start a conversation using the configured browser client."],
] as const

async function renderFiles(files: ReadonlyArray<readonly [string, string]>, starter: boolean) {
  return Promise.all(
    files.map(async ([path, description]) => {
      const local = !starter || path === "connectors/celestrak.ts" || path === "lib/celestrak.ts"
      const base = local
        ? join(import.meta.dir, "../examples", starter ? "starter" : "marketing")
        : join(import.meta.dir, "../../../../packages/create-sixb/template")
      const code = await Bun.file(join(base, path)).text()
      const lang = path.endsWith(".tsx") ? "tsx" : "ts"
      const formatter = Bun.spawn(
        [
          "bun",
          "x",
          "--no-install",
          "biome",
          "format",
          "--stdin-file-path",
          path,
          "--line-width=64",
        ],
        { stdin: new Blob([code]), stdout: "pipe", stderr: "pipe" }
      )
      const [displayCode, error, exitCode] = await Promise.all([
        new Response(formatter.stdout).text(),
        new Response(formatter.stderr).text(),
        formatter.exited,
      ])
      if (exitCode !== 0) throw new Error(`[SixbDocs] Cannot format ${path}: ${error}`)
      const { html } = await renderHighlightedMarkdown(`\`\`\`${lang}\n${displayCode}\n\`\`\``, {
        doc: stubDoc,
        docs: [],
      })
      return { path, description, html, code }
    })
  )
}

const [starter, marketing] = await Promise.all([
  renderFiles(starterFiles, true),
  renderFiles(marketingFiles, false),
])
const collections = {
  starter: { title: "my-sixb-app", initialFile: "ontology/satellite.ts", files: starter },
  data: { title: "marketing-platform", initialFile: "connectors/google-ads.ts", files: marketing },
  pipeline: {
    title: "campaign pipeline",
    initialFile: "pipelines/campaigns.ts",
    files: marketing.filter((file) => /^(pipelines|datasets|schedules)\//.test(file.path)),
  },
}
await writeFile(
  join(import.meta.dir, "../generated/projectFiles.ts"),
  `export const projects = ${JSON.stringify(collections, null, 2)} as const\n`
)

// Small excerpts for the animated overview, highlighted once at build time.
const flowFiles = [
  "connectors/google-ads.ts",
  "syncs/campaigns.ts",
  "datasets/campaigns.ts",
  "pipelines/campaigns.ts",
  "projections/campaigns.ts",
  "ontology/campaign.ts",
  "app/page.tsx",
]
const flowSources = flowFiles.map((path) => {
  const file = marketing.find((entry) => entry.path === path)!
  const code = file.code.replace(/^import .*\n/gm, "").trim()
  return { path, code: path.startsWith("datasets/") ? code.split("\n\n")[0]! : code }
})
flowSources.push(
  ...["agent/conversation.ts", "workflows/monthly-report.ts"].map((path) => {
    const file = marketing.find((entry) => entry.path === path)!
    return {
      path,
      code: path.startsWith("agent/")
        ? file.code
        : file.code.slice(file.code.indexOf("export const")),
    }
  })
)
const flowSnippets = await Promise.all(
  flowSources.map(async ({ path, code }) => {
    const formatter = Bun.spawn(
      ["bun", "x", "--no-install", "biome", "format", "--stdin-file-path", path, "--line-width=44"],
      { stdin: new Blob([code]), stdout: "pipe", stderr: "pipe" }
    )
    const [formatted, error, exitCode] = await Promise.all([
      new Response(formatter.stdout).text(),
      new Response(formatter.stderr).text(),
      formatter.exited,
    ])
    if (exitCode !== 0) throw new Error(`[SixbDocs] Cannot format ${path}: ${error}`)
    const { html } = await renderHighlightedMarkdown(
      `\`\`\`${path.endsWith("tsx") ? "tsx" : "ts"}\n${formatted}\n\`\`\``,
      { doc: stubDoc, docs: [] }
    )
    return { path, html: html.replace(/<button\b[\s\S]*?<\/button>/g, "") }
  })
)
await writeFile(
  join(import.meta.dir, "../generated/flowSnippets.ts"),
  `export const flowSnippets = ${JSON.stringify(flowSnippets, null, 2)} as const\n`
)

const homeSources = [
  {
    path: "projections/campaign-history.ts",
    source: "projections/campaign-history.ts",
    start: "export const campaignHistory",
  },
  { path: "ontology/campaign.ts", source: "ontology/campaign.ts", start: "export const Campaign" },
  {
    path: "actions/mark-reviewed.ts",
    source: "actions/mark-reviewed.ts",
    start: "export const markReviewed",
  },
]
const homeSnippets = await Promise.all(
  homeSources.map(async ({ path, source, start }) => {
    const file = await Bun.file(join(import.meta.dir, "../examples/marketing", source)).text()
    const code = file.slice(file.indexOf(start))
    const { html } = await renderHighlightedMarkdown(`\`\`\`ts\n${code}\n\`\`\``, {
      doc: stubDoc,
      docs: [],
    })
    return { path, html: html.replace(/<button\b[\s\S]*?<\/button>/g, "") }
  })
)
await writeFile(
  join(import.meta.dir, "../generated/homeSnippets.ts"),
  `export const homeSnippets = ${JSON.stringify(homeSnippets, null, 2)} as const\n`
)
