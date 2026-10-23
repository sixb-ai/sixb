import {
  CLI_LIMITS,
  DEFAULT_LIST_ORDER,
  DEFAULT_OBJECT_ORDER_BY,
  DEFAULT_TELEMETRY_ORDER,
} from "../policies"

const SANDBOX_MAIN_HELP = `Sixb agent CLI

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

When you do not know a type's properties or links, read its file under $SIXB_ONTOLOGY_DIR. Use
\`sixb ontology get\` for a type that has no file there.

Objects:
  sixb objects inspect <type> <id>    Inspect an object and its related graph in one command
  sixb objects list [options]         Browse materialized objects
  sixb objects get <type> <id>...     Exact lookup through opaque object references
  sixb objects get-by <type> <property> <value>
                                      The object holding a value of a unique property
  sixb objects search <text>          Search visible objects by id prefix and full text
  sixb objects search <text> --type <type>
                                      Semantic search through the type's vector profile
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

Members:
  sixb users search <text>            Find members by name or email
  sixb users list|get ...

A user parameter or property is {"type":"user","id":"<user-id>"}. Find the id with
\`sixb users search <name>\`.

Run \`sixb <group> --help\` or \`sixb <group> <command> --help\` for exact arguments.
For query IR, run \`sixb objects query --help\` and \`sixb objects query --example list\`.`

const LOCAL_MAIN_HELP = SANDBOX_MAIN_HELP.replace("Sixb agent CLI", "Sixb instance CLI")
  .replace(
    "The CLI uses the run-scoped SIXB_API_BASE_URL. Do not configure authentication or another origin.",
    "The CLI uses the selected local profile and its API credentials."
  )
  .replace(
    "  sixb doctor                         Check the sandbox and API gateway\n  sixb context                        Print the current run context\n",
    ""
  )
  .replace(
    "\nWhen you do not know a type's properties or links, read its file under $SIXB_ONTOLOGY_DIR. Use\n`sixb ontology get` for a type that has no file there.\n",
    ""
  )

  // The agent reaches models through its run's gateway once the model routes allow it.
  .replace(
    "Files:\n  sixb files upload|download ...\n",
    "Files:\n  sixb files upload|download ...\n\nModels:\n  sixb models list [--kind <kind>]    Configured models of every kind, with prices\n  sixb models get <model>             One model's options and rate card\n  sixb models text|image|speech|transcribe ...   Call a model; see sixb models --help\n"
  )

export function renderInstanceHelp(mode: "local" | "sandbox"): string {
  return mode === "sandbox" ? SANDBOX_MAIN_HELP : LOCAL_MAIN_HELP
}

const SEARCH_DETAILS = `Without --type, search matches primary-id prefixes and full-text fields across visible types.
With --type, the server embeds the text with the profile's model and ranks results by score,
a cosine similarity where higher is closer. \`sixb ontology list\` shows each type's
vectorProfiles. To combine semantic search with filters, run
\`sixb objects query --example vector\`.`

export const SEARCH_HELP = `Usage:
  sixb objects search <text> [--limit <1-${CLI_LIMITS.search.maximum}>]
  sixb objects search <text> --type <object-type> [--vector-profile <name>] [--limit <1-${CLI_LIMITS.search.maximum}>]

--limit defaults to ${CLI_LIMITS.search.default}. --vector-profile is required when the type declares several
profiles.

${SEARCH_DETAILS}`

export const GET_BY_HELP = `Usage:
  sixb objects get-by <object-type> <property> <value> [--json]

Prints the object of exactly <object-type> holding <value> for a property marked unique in its
ontology doc, or null when no visible object holds it. Values match exactly, case included.
The value is a string; with --json it is parsed as JSON, for an integer (42) or a user
reference ({"type":"user","id":"usr_1"}).`

export const OBJECTS_HELP = `Usage:
  sixb objects inspect <object-type> <primary-id> [options]
  sixb objects list [options]
  sixb objects get <object-type> <primary-id>...
  sixb objects get-by <object-type> <property> <value> [--json]
  sixb objects search <text> [--type <object-type> [--vector-profile <name>]] [--limit <n>]
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

Search options:
  --limit <1-${CLI_LIMITS.search.maximum}>                      Defaults to ${CLI_LIMITS.search.default}
  --type <id>                         Semantic search through this type's vector profile
  --vector-profile <name>             Required when the type declares several profiles

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

${SEARCH_DETAILS}

\`objects get\` uses a refs query without identity URL paths. Opaque ids containing :, /, #, ?, or
% are safe. Identifiers are case-sensitive.`

export const QUERY_HELP = `Usage:
  sixb objects query --file <path|-> [--include-total|--no-total]
  sixb objects query --example <name>
  sixb objects query --example list

Input is a query node. A full {"query": ...} request is also accepted.

Query nodes compose through input:
  start     {"kind":"start","objectTypeId":"Type","includeSubtypes":false}
  refs      {"kind":"refs","refs":[{"objectTypeId":"Type","primaryId":"opaque:id"}]}
  filter    {"kind":"filter","input":<query>,"predicate":<predicate>}
  text      {"kind":"text","input":<query>,"query":"words","fields":["name"]}
  traverse  {"kind":"traverse","input":<query>,"linkId":"link","direction":"outgoing"}
  set       {"kind":"set","op":"union","inputs":[<query>,<query>]}  op: union, intersect, subtract
  sort      {"kind":"sort","input":<query>,"fields":[{"kind":"property","propertyId":"name","direction":"asc"}]}
  limit     {"kind":"limit","input":<query>,"limit":${CLI_LIMITS.list.default}}
  page      {"kind":"page","input":<query>,"pageSize":${CLI_LIMITS.list.default},"pageToken":"from nextPageToken"}
  project   {"kind":"project","input":<query>,"properties":["name","status"]}
  expand    {"kind":"expand","input":<query>,"expansions":[{"linkId":"link","direction":"outgoing","limit":5}],"users":["assignee"]}
  vector    {"kind":"vector","input":<start|filter>,"vector":"text","profile":"name","k":10}
  rerank    {"kind":"rerank","input":<vector>,"model":{"provider":"provider","modelId":"model"}}

Predicates use op, not kind:
  {"op":"and","items":[<predicate>,<predicate>]}  or: same shape
  {"op":"not","item":<predicate>}
  {"op":"eq","propertyId":"status","value":"open"}  neq, lt, lte, gt, gte: same shape
  {"op":"in","propertyId":"status","values":["open","blocked"]}
  {"op":"exists","propertyId":"dueDate","value":true}
  {"op":"contains","propertyId":"tags","value":"urgent"}
  {"op":"eq","propertyId":"assignee","value":{"type":"currentUser"}}  the caller, on a user reference: neq, in, contains too

Every field shown is required except includeSubtypes, fields, pageToken, properties, a sort
direction, an expansion's limit, and users. Sort by relevance after text or vector with
{"kind":"relevance"}. Wrap the outermost node in project to return only the properties you need.

An expand's users, or an expansion's, lists user-reference properties: each row then carries the
members' profiles under users (id, email, displayName, avatarUrl, status). Without access to the
member directory, users is empty.

Traversal and expansion directions are outgoing or incoming. For incoming relationships, the link
is declared on the child/source type; add sourceObjectTypeId when needed to disambiguate it.

Never guess property or link ids: run \`sixb ontology get <type>\` (in the agent sandbox, read
the type's file under $SIXB_ONTOLOGY_DIR). Use refs for exact
identities. Put limits and pages inside the query tree.

Vector profile names are the keys of the type's search.vectors. Vector input is a start node,
optionally under filters; k bounds the ranked matches and results carry a score.`

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
  sixb actions request <action-id> [--subject-type <type> --subject-id <id>] [--file <path|->] [--run-id <id>]

\`actions get\` includes inputSchema, the exact JSON shape accepted by the Action. The JSON file
contains that parameter object; use - to read standard input. \`actions request\` runs the Action
and prints its finished run, with its status and any error. It waits at most 25 seconds: a run that
takes longer keeps running, and the error names the run to read with \`action-runs get\`.`,
  "action-runs": `Usage:
  sixb action-runs list [options]
  sixb action-runs get <run-id>

List options:
  --action <action-id>
  --type <object-type>
  --id <primary-id>
  --status succeeded|failed
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
  users: `Usage:
  sixb users list [options]
  sixb users search <text> [options]
  sixb users get <user-id>

Options:
  --status active|suspended|all       Defaults to active
  --limit <1-${CLI_LIMITS.users.maximum}>                     Defaults to ${CLI_LIMITS.users.default}
  --offset <n>                        Non-negative; defaults to 0

\`users search\` matches part of a display name or email, ignoring case. Each member is
{"id","email","displayName","avatarUrl","status"}; a user parameter takes
{"type":"user","id":"<id>"}. Reading members requires can.view(project.users).`,
  models: `Usage:
  sixb models list [--kind language|image|speech|transcription]
  sixb models get <model> [--kind <kind>]
  sixb models text "<prompt>" [--model <model>] [--instructions <text>]
                   [--max-output-tokens <n>] [--reasoning <level>]
  sixb models image "<prompt>" --output <path> [--model <model>] [--n <n>]
                    [--size <size>] [--aspect-ratio <ratio>] [--quality <q>] [--style <s>]
                    [--seed <n>] [--image <file>]...
  sixb models speech "<text>" --output <path> [--model <model>] [--voice <voice>]
                     [--format mp3|wav|ogg|aac|flac] [--instructions <text>]
                     [--speed <n>] [--language <code>]
  sixb models transcribe <file> [--model <model>]
  sixb models calls files <call-id> [--output <path>]

<model> is a model id, or provider:model-id when two providers share one; without --model, the
kind's default answers. \`list\` shows each model's kind, default, description and price; \`get\`
adds the sizes, voices and other options a request can use. Prices are in USD.

--output is a file, numbered when a call returns several, or a directory ending in /. The
extension follows the file's type, and the result lists the paths written. --image uploads a
reference image; repeat it for several. \`calls files\` lists a past call's files, or downloads
them again.`,
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
  and: `{"kind":"limit","input":{"kind":"filter","input":{"kind":"start","objectTypeId":"Customer"},"predicate":{"op":"and","items":[{"op":"eq","propertyId":"status","value":"active"},{"op":"gte","propertyId":"createdAt","value":"2026-01-01T00:00:00Z"}]}},"limit":${CLI_LIMITS.list.default}}`,
  not: `{"kind":"limit","input":{"kind":"filter","input":{"kind":"start","objectTypeId":"Customer"},"predicate":{"op":"not","item":{"op":"eq","propertyId":"status","value":"churned"}}},"limit":${CLI_LIMITS.list.default}}`,
  in: `{"kind":"limit","input":{"kind":"filter","input":{"kind":"start","objectTypeId":"Customer"},"predicate":{"op":"in","propertyId":"status","values":["active","trial"]}},"limit":${CLI_LIMITS.list.default}}`,
  exists: `{"kind":"limit","input":{"kind":"filter","input":{"kind":"start","objectTypeId":"Customer"},"predicate":{"op":"exists","propertyId":"accountManager","value":false}},"limit":${CLI_LIMITS.list.default}}`,
  mine: `{"kind":"limit","input":{"kind":"filter","input":{"kind":"start","objectTypeId":"Task"},"predicate":{"op":"eq","propertyId":"assignee","value":{"type":"currentUser"}}},"limit":${CLI_LIMITS.list.default}}`,
  project: `{"kind":"project","input":{"kind":"limit","input":{"kind":"start","objectTypeId":"Customer"},"limit":${CLI_LIMITS.list.default}},"properties":["name","status"]}`,
  incoming:
    '{"kind":"traverse","input":{"kind":"refs","refs":[{"objectTypeId":"RepositoryIssue","primaryId":"github:issue:owner/repo#297"}]},"linkId":"issue","direction":"incoming","sourceObjectTypeId":"RepositoryComment"}',
  expand: `{"kind":"expand","input":{"kind":"refs","refs":[{"objectTypeId":"RepositoryIssue","primaryId":"github:issue:owner/repo#297"}]},"expansions":[{"linkId":"issue","direction":"incoming","sourceObjectTypeId":"RepositoryComment","limit":${CLI_LIMITS.list.default}}]}`,
  users: `{"kind":"expand","input":{"kind":"limit","input":{"kind":"start","objectTypeId":"Task"},"limit":${CLI_LIMITS.list.default}},"expansions":[],"users":["assignee"]}`,
  sort: `{"kind":"limit","input":{"kind":"sort","input":{"kind":"start","objectTypeId":"Customer"},"fields":[{"kind":"property","propertyId":"name","direction":"asc"}]},"limit":${CLI_LIMITS.list.default}}`,
  page: `{"kind":"page","input":{"kind":"start","objectTypeId":"Customer"},"pageSize":${CLI_LIMITS.list.default}}`,
  vector: `{"kind":"vector","input":{"kind":"filter","input":{"kind":"start","objectTypeId":"Product"},"predicate":{"op":"eq","propertyId":"status","value":"active"}},"vector":"waterproof trail shoes","profile":"content","k":${CLI_LIMITS.search.default}}`,
}

export const FACETS_EXAMPLE =
  '{"query":{"kind":"start","objectTypeId":"WorkOrder"},"facets":[{"propertyId":"status","limit":10}]}'
