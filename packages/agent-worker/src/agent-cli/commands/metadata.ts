import {
  CLI_LIMITS,
  DEFAULT_LIST_ORDER,
  DEFAULT_OBJECT_ORDER_BY,
  DEFAULT_TELEMETRY_ORDER,
} from "../policies"

export const MAIN_HELP = `Sixb agent CLI

Usage:
  sixb <command> [options]

The CLI uses the run-scoped SIXB_API_BASE_URL. Do not configure authentication or another origin.
API commands emit JSON. Help, version, and examples emit text. Downloads write to --output and
emit a JSON receipt.

Discovery:
  sixb doctor                         Check the sandbox and API gateway
  sixb context                        Print the current run context
  sixb project show                   Show project metadata
  sixb ontology list                  Compact visible type and relationship catalog
  sixb ontology get <type>            Inspect one object type, properties, links, and actions

Objects:
  sixb objects inspect <type> <id>    Inspect an object and its related graph in one command
  sixb objects list [options]         Browse materialized objects
  sixb objects get <type> <id>...     Exact lookup through opaque object references
  sixb objects search <text>          Search visible objects
  sixb objects query --file <file|->  Execute query IR from JSON
  sixb objects count --file <file|->  Count a query without returning rows
  sixb objects exists --file <file|-> Test whether a query has a match
  sixb objects facets --file <file|-> Run a {query, facets} request
  sixb objects links <type> <id>      Read exact persisted links

Telemetry:
  sixb telemetry latest <type> <id> <property>
  sixb telemetry history <type> <id> <property> [options]
  sixb telemetry query --file <file|->

Actions and workflows:
  sixb actions list|get|request ...
  sixb action-runs list|get ...
  sixb workflows list|get|start ...
  sixb workflow-runs list|get ...

Files:
  sixb files upload|download ...

Run \`sixb <group> --help\` or \`sixb <group> <command> --help\` for exact arguments.
For query IR, run \`sixb objects query --help\` and \`sixb objects query --example list\`.`

export const OBJECTS_HELP = `Usage:
  sixb objects inspect <object-type> <primary-id> [options]
  sixb objects list [options]
  sixb objects get <object-type> <primary-id>...
  sixb objects search <text> [--limit <1-${CLI_LIMITS.search.maximum}>]
  sixb objects query --file <path|-> [--include-total|--no-total]
  sixb objects query --example <name>
  sixb objects count --file <path|->
  sixb objects exists --file <path|->
  sixb objects facets --file <path|->
  sixb objects facets --example
  sixb objects links <object-type> <primary-id> [options]

List options:
  --type <id>                         Exact ontology object type id
  --limit <1-${CLI_LIMITS.list.maximum}>                    Defaults to ${CLI_LIMITS.list.default}
  --offset <n>                        Non-negative; defaults to 0
  --order-by createdAt|updatedAt|primaryId  Defaults to ${DEFAULT_OBJECT_ORDER_BY}
  --order asc|desc                    Defaults to ${DEFAULT_LIST_ORDER}
  --id-prefix <value>                 Primary-id prefix
  --id-suffix <value>                 Primary-id suffix
  --created-after|--created-before <RFC3339>
  --updated-after|--updated-before <RFC3339>

Links options:
  --link <link-id>
  --direction outgoing|incoming|both  Defaults to both
  --page-size <1-${CLI_LIMITS.linkPage.maximum}>                Defaults to ${CLI_LIMITS.linkPage.default}
  --page-token <token>                Continue an edge page
  --include-objects                   Include selected and current-page endpoint objects

Inspect options:
  --depth <0-${CLI_LIMITS.inspect.depth.maximum}>                       Defaults to ${CLI_LIMITS.inspect.depth.default}; use 0 for only the object
  --max-objects <1-${CLI_LIMITS.inspect.objects.maximum}>               Defaults to ${CLI_LIMITS.inspect.objects.default}
  --max-links <1-${CLI_LIMITS.inspect.links.maximum}>                 Defaults to ${CLI_LIMITS.inspect.links.default}
  --full                              Include timestamps and encountered type definitions

Use \`objects get\` first when context provides an exact object reference. Use \`objects inspect\`
only when related objects are needed; it follows both relationship directions to depth 2 by
default and returns a bounded graph.
Inspect omits materialization timestamps and ontology definitions by default. Use \`--full\` when
storage timestamps, declared links, or available actions are needed.

Search returns at most ${CLI_LIMITS.search.maximum} matches and defaults to ${CLI_LIMITS.search.default}.

\`objects get\` uses a refs query without identity URL paths. Opaque ids containing :, /, #, ?, or
% are safe. Identifiers are case-sensitive.`

export const QUERY_HELP = `Usage:
  sixb objects query --file <path|-> [--include-total|--no-total]
  sixb objects query --example <exact|filter|incoming|expand|sort|page>
  sixb objects query --example list

Input is a query node. A full {"query": ...} request is also accepted.

Query nodes compose through input:
  start     {"kind":"start","objectTypeId":"Type","includeSubtypes":false}
  refs      {"kind":"refs","refs":[{"objectTypeId":"Type","primaryId":"opaque:id"}]}
  filter    {"kind":"filter","input":<query>,"predicate":<predicate>}
  text      {"kind":"text","input":<query>,"query":"words","fields":["name"]}
  traverse  {"kind":"traverse","input":<query>,"linkId":"link","direction":"outgoing"}
  vector, set, sort, limit, page, project, and expand are also supported.

Predicates use op, not kind:
  and/or, not, {"op":"eq","propertyId":"status","value":"open"}, neq, lt, lte, gt, gte,
  in, exists, and contains.

Traversal and expansion directions are outgoing or incoming. For incoming relationships, the link
is declared on the child/source type; add sourceObjectTypeId when needed to disambiguate it.

Run \`sixb ontology get <type>\` first; never guess property or link ids. Use refs for exact
identities. Put limits and pages inside the query tree.`

export const GROUP_HELP = {
  doctor: "Usage: sixb doctor",
  context: "Usage: sixb context",
  project: "Usage: sixb project show",
  ontology: `Usage:
  sixb ontology list [--full]
  sixb ontology get <object-type>`,
  telemetry: `Usage:
  sixb telemetry latest <object-type> <primary-id> <property-id>
  sixb telemetry history <object-type> <primary-id> <property-id> [options]
  sixb telemetry query --file <path|->

History options:
  --from <RFC3339>
  --to <RFC3339>
  --limit <1-${CLI_LIMITS.telemetryHistory.maximum}>                  Defaults to ${CLI_LIMITS.telemetryHistory.default}
  --order <asc|desc>                  Timestamp order; defaults to ${DEFAULT_TELEMETRY_ORDER}`,
  actions: `Usage:
  sixb actions list [--type <object-type>]
  sixb actions get <action-id>
  sixb actions request <action-id> [--subject-type <type> --subject-id <id>] [--file <path|->] [--run-id <id>] [--wait]

\`actions get\` includes inputSchema, the exact JSON shape accepted by the Action. The JSON file
contains that parameter object; use - to read standard input. --wait returns the terminal Action
run and waits at most 25 seconds.`,
  "action-runs": `Usage:
  sixb action-runs list [options]
  sixb action-runs get <run-id>

List options:
  --action <action-id>
  --type <object-type>
  --id <primary-id>
  --status queued|running|succeeded|failed|cancelled
  --started-after|--started-before <RFC3339>
  --limit <1-${CLI_LIMITS.list.maximum}>              Defaults to ${CLI_LIMITS.list.default}
  --offset <n>                  Non-negative; defaults to 0
  --order <asc|desc>            Started-time order; defaults to ${DEFAULT_LIST_ORDER}`,
  files: `Usage:
  sixb files upload <local-path> [--logical-path <path>]
  sixb files download object <type> <id> --path <json-pointer> --output <local-path>
  sixb files download action-run|workflow-run <run-id> --path <json-pointer> --output <local-path>`,
  workflows: `Usage:
  sixb workflows list
  sixb workflows get <workflow-id>
  sixb workflows start <workflow-id> [--file <path|->]

The JSON file contains the workflow input object. Use - to read standard input.`,
  "workflow-runs": `Usage:
  sixb workflow-runs list [options]
  sixb workflow-runs get <run-id>

List options:
  --workflow <workflow-id>
  --status queued|running|waiting|succeeded|failed|cancelled
  --started-after|--started-before <RFC3339>
  --limit <1-${CLI_LIMITS.list.maximum}>              Defaults to ${CLI_LIMITS.list.default}
  --offset <n>                  Non-negative; defaults to 0
  --order <asc|desc>            Started-time order; defaults to ${DEFAULT_LIST_ORDER}`,
} as const

export const QUERY_EXAMPLES: Readonly<Record<string, string>> = {
  exact:
    '{"kind":"refs","refs":[{"objectTypeId":"RepositoryIssue","primaryId":"github:issue:owner/repo#297"}]}',
  filter: `{"kind":"limit","input":{"kind":"filter","input":{"kind":"start","objectTypeId":"Customer"},"predicate":{"op":"eq","propertyId":"status","value":"active"}},"limit":${CLI_LIMITS.list.default}}`,
  incoming:
    '{"kind":"traverse","input":{"kind":"refs","refs":[{"objectTypeId":"RepositoryIssue","primaryId":"github:issue:owner/repo#297"}]},"linkId":"issue","direction":"incoming","sourceObjectTypeId":"RepositoryComment"}',
  expand: `{"kind":"expand","input":{"kind":"refs","refs":[{"objectTypeId":"RepositoryIssue","primaryId":"github:issue:owner/repo#297"}]},"expansions":[{"linkId":"issue","direction":"incoming","sourceObjectTypeId":"RepositoryComment","limit":${CLI_LIMITS.list.default}}]}`,
  sort: `{"kind":"limit","input":{"kind":"sort","input":{"kind":"start","objectTypeId":"Customer"},"fields":[{"kind":"property","propertyId":"name","direction":"asc"}]},"limit":${CLI_LIMITS.list.default}}`,
  page: `{"kind":"page","input":{"kind":"start","objectTypeId":"Customer"},"pageSize":${CLI_LIMITS.list.default}}`,
}

export const FACETS_EXAMPLE =
  '{"query":{"kind":"start","objectTypeId":"WorkOrder"},"facets":[{"propertyId":"status","limit":10}]}'
