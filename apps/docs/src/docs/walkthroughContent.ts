// Short teaching excerpts for the landing page. The complete example is linked on GitHub.
export interface WalkthroughSource {
  id: string
  label: string
  title: string
  description: string
  href: string
  linkLabel: string
  files: { label: string; path: string; language: string; code: string }[]
}

export const walkthroughSources: WalkthroughSource[] = [
  {
    id: "connect",
    label: "Connect",
    title: "Start with your data.",
    description:
      "Give your project access to the systems you already use. Choose a connector from the library, or bring your own client.",
    href: "/connectors",
    linkLabel: "Explore connectors",
    files: [
      {
        label: "Connector",
        path: "connectors/pipedrive.ts",
        language: "ts",
        code: `import { defineConnector } from "@sixb/core"
import { pipedrive } from "@sixb/connector-pipedrive"

export const crm = defineConnector(
  "pipedrive",
  pipedrive({
    apiToken: () => process.env.PIPEDRIVE_API_TOKEN!,
  })
)`,
      },
    ],
  },
  {
    id: "collect",
    label: "Collect",
    title: "Give every row a home.",
    description:
      "Describe the data you want to keep. A sync reads your connector and brings those records into a typed dataset.",
    href: "/datasets",
    linkLabel: "Explore datasets and syncs",
    files: [
      {
        label: "Dataset",
        path: "datasets/customers.ts",
        language: "ts",
        code: `import { col, defineDataset } from "@sixb/core"

export const rawCustomers = defineDataset(
  "pipedrive.customers",
  {
    schema: [
      col("id", "string"),
      col("name", "string"),
    ],
    primaryKey: "id",
  }
)`,
      },
      {
        label: "Sync",
        path: "syncs/customers.ts",
        language: "ts",
        code: `export const syncCustomers = defineSync("customers")
  .from(crm)
  .read(async function* (client) {
    for await (const org of client.organizations.listAll()) {
      if (!org.name?.trim()) continue
      yield {
        id: String(org.id),
        name: org.name,
      }
    }
  })
  .intoDataset(rawCustomers)`,
      },
    ],
  },
  {
    id: "prepare",
    label: "Prepare",
    title: "Make the pieces fit.",
    description:
      "Clean names, join sources, and shape records with SQL or TypeScript. Pipelines turn your raw datasets into data you can build on.",
    href: "/pipelines",
    linkLabel: "Explore pipelines",
    files: [
      {
        label: "Pipeline",
        path: "pipelines/customers.ts",
        language: "ts",
        code: `const cleanNames = definePipelineStep("clean-names")
  .inputs({ customers: rawCustomers })
  .output(cleanCustomers)
  .sql(({ customers }) => \`
    select id, trim(name) as name
    from \${customers}
  \`)

export const prepareCustomers =
  definePipeline("prepare-customers")
    .then(cleanNames)`,
      },
    ],
  },
  {
    id: "model",
    label: "Model",
    title: "Give your data meaning.",
    description:
      "Define the things your software works with and how they relate. Map dataset rows into that shared model, ready for your apps and AI.",
    href: "/ontology",
    linkLabel: "Explore the ontology",
    files: [
      {
        label: "Model",
        path: "ontology/customer.ts",
        language: "ts",
        code: `export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", {
      required: true,
      primary: true,
    }),
    prop("name", "string", { required: true }),
  ],
})`,
      },
      {
        label: "Projection",
        path: "projections/customers.ts",
        language: "ts",
        code: `import { defineProjection } from "@sixb/core"
import { cleanCustomers } from "../datasets/customers"
import { Customer } from "../ontology/customer"

export const projectCustomers =
  defineProjection("customers", Customer)
    .fromDataset(cleanCustomers)
    .properties({
      id: "id",
      name: "name",
    })`,
      },
    ],
  },
  {
    id: "analyze",
    label: "Analyze",
    title: "Ask better questions.",
    description:
      "Query your model with typed filters. Bring the results into an AI prompt to summarize, explain, or help decide what to do next.",
    href: "/objects/querying",
    linkLabel: "Explore queries",
    files: [
      {
        label: "Query",
        path: "Find quotes ready for review",
        language: "ts",
        code: `const { objects: quotes } = await sixb
  .objects(Quote)
  .query()
  .where((quote) => quote.p.status.eq("ready"))
  .limit(20)
  .list()

for (const quote of quotes) {
  console.log(quote.properties.title)
}`,
      },
      {
        label: "AI",
        path: "Summarize with a configured model",
        language: "ts",
        code: `// Inside an action or workflow step.
const { output } = await sixb.models.language.generate({
  prompt: [
    "Summarize these quotes for the review team.",
    "Highlight anything that needs attention.",
    JSON.stringify(quotes.map((q) => q.properties)),
  ].join("\\n"),
})`,
      },
    ],
  },
  {
    id: "automate",
    label: "Automate",
    title: "Turn decisions into action.",
    description:
      "Connect steps into a repeatable process. Pause for a person's approval, then run an action that writes back to your external system.",
    href: "/workflows",
    linkLabel: "Explore workflows",
    files: [
      {
        label: "Workflow",
        path: "workflows/quote-review.ts",
        language: "ts",
        code: `export const quoteReview = defineWorkflow("quote-review")
  .input({
    quote: ref(Quote),
    templateId: "string",
    recipientEmail: "string",
  })
  .then(reviewQuote, ({ input }) => ({ quote: input.quote }))
  .then(createQuoteDocument, ({ input, steps }) => ({
    subject: input.quote,
    params: {
      approved: steps.reviewQuote.approved,
      templateId: input.templateId,
      recipientEmail: input.recipientEmail,
    },
  }))`,
      },
    ],
  },
  {
    id: "operate",
    label: "Operate",
    title: "Put it in people's hands.",
    description:
      "Build a React interface on the same model. Your screens, agents, and automation work with the same data and logic.",
    href: "/apps",
    linkLabel: "Explore building apps",
    files: [
      {
        label: "React",
        path: "app/quotes/page.tsx",
        language: "tsx",
        code: `import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Quote } from "../../ontology/quote"

export default function Quotes() {
  const query = objects(Quote).query()
    .where((q) => q.p.status.eq("ready"))
  const { data } = useObjectsQuery(query)

  return data?.objects.map((quote) => (
    <article key={quote.primaryId}>
      <h2>{quote.properties.title}</h2>
      <p>{quote.properties.scope}</p>
    </article>
  ))
}`,
      },
    ],
  },
  {
    id: "secure",
    label: "Secure",
    title: "Make access intentional.",
    description:
      "Organize people into groups. Give each group a role with explicit grants for the data they can see and the operations they can perform.",
    href: "/auth/authorization",
    linkLabel: "Explore permissions",
    files: [
      {
        label: "Role",
        path: "security/roles/quote-reviewers.ts",
        language: "ts",
        code: `import { reviewers } from "../groups/reviewers"

export const quoteReviewer = defineRole("quote-reviewer", {
  grantedTo: [reviewers],
  grants: [
    can.access(applications.app),
    can.view([Customer, Quote]),
    can.apply(createQuoteDocument),
  ],
})`,
      },
      {
        label: "Group",
        path: "security/groups/reviewers.ts",
        language: "ts",
        code: `import { defineGroup } from "@sixb/core"

export const reviewers = defineGroup("reviewers", {
  label: "Quote reviewers",
})`,
      },
    ],
  },
  {
    id: "extend",
    label: "Extend",
    title: "Use it wherever you build.",
    description:
      "Run your project from the CLI. Access its data over HTTP, or subscribe to changes over WebSockets. The same framework, beyond the browser.",
    href: "/server",
    linkLabel: "Explore the HTTP API",
    files: [
      {
        label: "CLI",
        path: "Terminal",
        language: "bash",
        code: `# Start your local project
bun sixb dev

# Build for deployment
bun sixb build

# Start the production API
bun sixb api`,
      },
      {
        label: "HTTP",
        path: "Read a quote",
        language: "bash",
        code: `curl "$SIXB_API_URL/api/objects/Quote/Q-1042" \\
  -H "Authorization: Bearer $SIXB_TOKEN"`,
      },
      {
        label: "WebSocket",
        path: "Listen for quote updates",
        language: "ts",
        code: `// In an authenticated browser session.
const socket = new WebSocket(
  "wss://your-sixb-api.example/ws/events"
)

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({
    type: "subscribe",
    topic: "objects",
    types: ["object.updated"],
    objectTypeId: "Quote",
  }))
})`,
      },
    ],
  },
]
