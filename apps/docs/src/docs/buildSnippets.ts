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
    prop("id", "string", { primary: true }),
    prop("name", "string", { required: true }),
    prop("tier", "string"),
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
