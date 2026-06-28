import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

interface AgentSkillReference {
  readonly path: string
  readonly content: string
}

interface AgentSkill {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly references?: readonly AgentSkillReference[]
}

const SIXB_AGENT_SKILLS: readonly AgentSkill[] = [
  {
    name: "sixb-query",
    description:
      "Use when discovering ontology, reading Sixb objects, filtering, sorting, paging, counting, faceting, traversing links, or expanding object query results.",
    content: `---
name: sixb-query
description: Use when discovering ontology, reading Sixb objects, filtering, sorting, paging, counting, faceting, traversing links, or expanding object query results.
compatibility: Requires the sandbox bash tool and SIXB_API_BASE_URL.
---

# Sixb Query

Use this skill before reading object data or answering questions about current ontology objects.

## Workflow

1. Discover the live ontology with \`curl -sS "$SIXB_API_BASE_URL/api/object-types"\`.
2. Use exact object type, property, link, and telemetry ids from the ontology response.
3. Prefer the smallest query that answers the question.
4. Start with a low limit when exploring, then widen only when needed.
5. Use count, exists, and facets endpoints for aggregate questions instead of listing everything.
6. Inspect API error messages and query plan issues before retrying.

## References

- Read [query API](references/query-api.md) for endpoints and payload envelopes.
- Read [query shapes](references/query-shapes.md) when composing graph/query nodes.
- Read [predicates](references/predicates.md) when building filters.
- Read [examples](references/examples.md) for copyable curl patterns.
`,
    references: [
      {
        path: "query-api.md",
        content: `# Query API

All requests go through \`$SIXB_API_BASE_URL\`. Do not add Authorization or Cookie headers.

## Discover Ontology

\`\`\`bash
curl -sS "$SIXB_API_BASE_URL/api/object-types"
\`\`\`

Use the returned ids exactly. Object type definitions describe properties, telemetry properties,
links, and applicable actions that are visible to the agent.

## List Objects

\`\`\`bash
curl -sS "$SIXB_API_BASE_URL/api/objects?objectTypeId=customer&limit=20"
\`\`\`

Common query params: \`objectTypeId\`, \`limit\`, \`cursor\`, \`includeSubtypes\`.

## Get One Object

\`\`\`bash
curl -sS "$SIXB_API_BASE_URL/api/objects/customer/cust-001"
\`\`\`

## Object Query

POST query bodies only accept \`query\` and optional \`includeTotal\` at the top level. Result
bounds go inside the nested query shape: use a \`limit\` node for a fixed cap, or a \`page\`
node with \`pageSize\` and optional \`pageToken\` for pagination. Do not send top-level
\`limit\`, \`cursor\`, \`pageSize\`, or \`pageToken\` fields to this endpoint.

\`\`\`bash
curl -sS \\
  -H "Content-Type: application/json" \\
  -X POST "$SIXB_API_BASE_URL/api/objects/query" \\
  --data '{"query":{"kind":"limit","input":{"kind":"start","objectTypeId":"customer"},"limit":20},"includeTotal":true}'
\`\`\`

## Count, Exists, Facets

\`\`\`bash
curl -sS -H "Content-Type: application/json" \\
  -X POST "$SIXB_API_BASE_URL/api/objects/query/count" \\
  --data '{"query":{"kind":"start","objectTypeId":"customer"}}'

curl -sS -H "Content-Type: application/json" \\
  -X POST "$SIXB_API_BASE_URL/api/objects/query/exists" \\
  --data '{"query":{"kind":"start","objectTypeId":"customer"}}'

curl -sS -H "Content-Type: application/json" \\
  -X POST "$SIXB_API_BASE_URL/api/objects/query/facets" \\
  --data '{"query":{"kind":"start","objectTypeId":"customer"},"facets":[{"propertyId":"status"}]}'
\`\`\`
`,
      },
      {
        path: "query-shapes.md",
        content: `# Query Shapes

Query payloads use a nested \`query\` object. Start with an object set, then compose transforms.

## Start

\`\`\`json
{ "kind": "start", "objectTypeId": "customer", "includeSubtypes": true }
\`\`\`

## Filter

\`\`\`json
{
  "kind": "filter",
  "input": { "kind": "start", "objectTypeId": "customer" },
  "predicate": { "kind": "eq", "propertyId": "status", "value": "active" }
}
\`\`\`

## Sort And Limit

\`\`\`json
{
  "kind": "limit",
  "input": {
    "kind": "sort",
    "input": { "kind": "start", "objectTypeId": "customer" },
    "by": [{ "propertyId": "createdAt", "direction": "desc" }]
  },
  "limit": 20
}
\`\`\`

## Page

Use \`page\` instead of a top-level cursor when continuing through query results.

\`\`\`json
{
  "kind": "page",
  "input": { "kind": "start", "objectTypeId": "customer" },
  "pageSize": 20,
  "pageToken": "next-page-token-from-previous-response"
}
\`\`\`

## Traverse Links

Use link ids from the ontology.

\`\`\`json
{
  "kind": "traverse",
  "input": { "kind": "start", "objectTypeId": "customer" },
  "linkId": "customerOrders",
  "direction": "out"
}
\`\`\`

## Expand

Use expand when the answer needs related objects alongside the root objects.

\`\`\`json
{
  "kind": "expand",
  "input": { "kind": "start", "objectTypeId": "customer" },
  "links": [{ "linkId": "customerOrders", "direction": "out", "limit": 5 }]
}
\`\`\`
`,
      },
      {
        path: "predicates.md",
        content: `# Predicates

Use property ids from \`/api/object-types\`. Match value shapes to the property type.

\`\`\`json
{ "kind": "eq", "propertyId": "status", "value": "active" }
{ "kind": "neq", "propertyId": "status", "value": "archived" }
{ "kind": "lt", "propertyId": "score", "value": 50 }
{ "kind": "lte", "propertyId": "score", "value": 50 }
{ "kind": "gt", "propertyId": "score", "value": 50 }
{ "kind": "gte", "propertyId": "score", "value": 50 }
{ "kind": "in", "propertyId": "status", "values": ["active", "trial"] }
{ "kind": "exists", "propertyId": "ownerId" }
{ "kind": "contains", "propertyId": "name", "value": "acme" }
\`\`\`

Compose predicates with boolean operators:

\`\`\`json
{
  "kind": "and",
  "predicates": [
    { "kind": "eq", "propertyId": "status", "value": "active" },
    { "kind": "gte", "propertyId": "score", "value": 80 }
  ]
}
\`\`\`

\`\`\`json
{
  "kind": "or",
  "predicates": [
    { "kind": "eq", "propertyId": "tier", "value": "enterprise" },
    { "kind": "eq", "propertyId": "tier", "value": "strategic" }
  ]
}
\`\`\`

\`\`\`json
{
  "kind": "not",
  "predicate": { "kind": "eq", "propertyId": "status", "value": "archived" }
}
\`\`\`
`,
      },
      {
        path: "examples.md",
        content: `# Examples

For \`POST /api/objects/query\`, keep pagination and limits inside the \`query\` shape.
Top-level request fields are limited to \`query\` and optional \`includeTotal\`.

## Active Customers

\`\`\`bash
curl -sS -H "Content-Type: application/json" \\
  -X POST "$SIXB_API_BASE_URL/api/objects/query" \\
  --data '{
    "query": {
      "kind": "limit",
      "input": {
        "kind": "filter",
        "input": { "kind": "start", "objectTypeId": "customer" },
        "predicate": { "kind": "eq", "propertyId": "status", "value": "active" }
      },
      "limit": 20
    },
    "includeTotal": true
  }'
\`\`\`

## Count Open Work Orders

\`\`\`bash
curl -sS -H "Content-Type: application/json" \\
  -X POST "$SIXB_API_BASE_URL/api/objects/query/count" \\
  --data '{
    "query": {
      "kind": "filter",
      "input": { "kind": "start", "objectTypeId": "workOrder" },
      "predicate": { "kind": "eq", "propertyId": "status", "value": "open" }
    }
  }'
\`\`\`

## Facet By Status

\`\`\`bash
curl -sS -H "Content-Type: application/json" \\
  -X POST "$SIXB_API_BASE_URL/api/objects/query/facets" \\
  --data '{
    "query": { "kind": "start", "objectTypeId": "workOrder" },
    "facets": [{ "propertyId": "status" }]
  }'
\`\`\`
`,
      },
    ],
  },
  {
    name: "sixb-telemetry",
    description:
      "Use when reading Sixb telemetry latest values or history for ontology telemetry properties.",
    content: `---
name: sixb-telemetry
description: Use when reading Sixb telemetry latest values or history for ontology telemetry properties.
compatibility: Requires the sandbox bash tool and SIXB_API_BASE_URL.
---

# Sixb Telemetry

Use this skill when a question asks about measurements, signals, readings, time series, latest
values, or historical telemetry for an object.

## Workflow

1. Discover the object type with \`curl -sS "$SIXB_API_BASE_URL/api/object-types"\`.
2. Confirm the object type has the telemetry property id you need.
3. Use latest for current state and history for trends or time windows.
4. Use bulk history when comparing multiple object/property series.
5. Treat telemetry through the agent proxy as read-only.

## References

- Read [telemetry API](references/telemetry-api.md) for endpoints and request shapes.
`,
    references: [
      {
        path: "telemetry-api.md",
        content: `# Telemetry API

All requests go through \`$SIXB_API_BASE_URL\`. Do not add Authorization or Cookie headers.

## Latest Point

\`\`\`bash
curl -sS "$SIXB_API_BASE_URL/api/objects/device/fan-1/telemetry/rpm/latest"
\`\`\`

## Single-Series History

\`\`\`bash
curl -sS "$SIXB_API_BASE_URL/api/objects/device/fan-1/telemetry/rpm/history?limit=100&order=desc"
\`\`\`

Useful query params include \`from\`, \`to\`, \`limit\`, and \`order\`.

## Bulk History

\`\`\`bash
curl -sS \\
  -H "Content-Type: application/json" \\
  -X POST "$SIXB_API_BASE_URL/api/telemetry/history" \\
  --data '{
    "series": [
      { "objectTypeId": "device", "objectId": "fan-1", "propertyId": "rpm" },
      { "objectTypeId": "device", "objectId": "fan-2", "propertyId": "rpm" }
    ],
    "limitPerSeries": 100,
    "order": "desc"
  }'
\`\`\`
`,
      },
    ],
  },
  {
    name: "sixb-actions",
    description:
      "Use when requesting declared Sixb ontology actions as the preferred mutation path.",
    content: `---
name: sixb-actions
description: Use when requesting declared Sixb ontology actions as the preferred mutation path.
compatibility: Requires the sandbox bash tool and SIXB_API_BASE_URL.
---

# Sixb Actions

Use this skill when the user asks you to make a domain change and an ontology action exists for it.
Actions are the preferred mutation path.

## Workflow

1. Discover available actions with \`curl -sS "$SIXB_API_BASE_URL/api/actions"\`.
2. Match the requested operation to an action id and inspect required params.
3. Use ontology object ids from live data for action subjects.
4. Before calling the action request route, show the user a concise preview of the action id, subject, params, and expected effect, then ask for approval.
5. Only call the action request route after the user approves. Send the smallest valid params object. Do not invent fields.
6. Use the returned run id to inspect action run detail when the user needs status, errors, or commit effects.
7. Report the action request result back to the user.

## References

- Read [actions API](references/actions-api.md) for endpoints and payload shapes.
`,
    references: [
      {
        path: "actions-api.md",
        content: `# Actions API

All requests go through \`$SIXB_API_BASE_URL\`. Do not add Authorization or Cookie headers.

## List Actions

\`\`\`bash
curl -sS "$SIXB_API_BASE_URL/api/actions"
\`\`\`

## Request An Action

Before calling this route, show the user a concise preview of what will happen and ask for approval.
Do not request the action until the user approves.

\`\`\`bash
curl -sS \\
  -H "Content-Type: application/json" \\
  -X POST "$SIXB_API_BASE_URL/api/actions/actionId" \\
  --data '{
    "subject": {
      "kind": "object",
      "objectTypeId": "customer",
      "primaryId": "cust-001"
    },
    "params": {}
  }'
\`\`\`

Use the subject and params shape required by the action definition. If no matching action exists,
explain that the requested change is not available through the ontology action surface.

For params whose schema is \`{ "type": "objectRef", "objectTypeId": "customer" }\`, pass the
value as \`{ "objectTypeId": "customer", "primaryId": "cust-001" }\` without a \`kind\`
field. This differs from the action \`subject\` shape, which uses \`kind\` to identify the
subject type.

## Get Action Run Detail

\`\`\`bash
curl -sS "$SIXB_API_BASE_URL/api/action-runs/action_run_id"
\`\`\`

Use the run id returned by an action request. The detail response includes status, phase, params,
writeback, commit diff, effects, and error details when available.
`,
      },
    ],
  },
]

export async function writeAgentSkills(skillsDir: string): Promise<void> {
  await Promise.all(
    SIXB_AGENT_SKILLS.map(async (skill) => {
      const skillDir = join(skillsDir, skill.name)
      const referencesDir = join(skillDir, "references")
      await mkdir(referencesDir, { recursive: true })
      await writeFile(join(skillDir, "SKILL.md"), skill.content, "utf-8")
      await Promise.all(
        (skill.references ?? []).map((reference) =>
          writeFile(join(referencesDir, reference.path), reference.content, "utf-8")
        )
      )
    })
  )
}

export function renderAgentSkillCatalog(): string {
  return [
    "Sixb API access is available from the sandboxed bash tool through a per-run proxy.",
    "Agent Skills are installed under $SIXB_SKILLS_DIR.",
    "Use $SIXB_SKILLS_DIR to reference skill file paths; do not hardcode sandbox directory paths.",
    "Before using a matching Sixb ontology API surface, read that skill's SKILL.md with bash/cat.",
    "Use live ontology and object APIs rather than guessing schema or relying on stale context.",
    "Do not add Authorization or Cookie headers. The proxy authenticates allowed requests.",
    "Operate through the ontology layer: object types, object reads/queries, telemetry reads, and declared actions.",
    "",
    "Available Agent Skills:",
    ...SIXB_AGENT_SKILLS.map(
      (skill) => `- ${skill.name}: ${skill.description} Path: $SIXB_SKILLS_DIR/${skill.name}`
    ),
  ].join("\n")
}
