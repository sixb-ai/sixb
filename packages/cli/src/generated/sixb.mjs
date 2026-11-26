#!/usr/bin/env node

// src/output.ts
var INSTANCE_CLI_VERSION = "1";
var EXIT_USAGE = 2;
var EXIT_API = 3;
var EXIT_AWAITING_APPROVAL = 4;

class CliError extends Error {
  body;
  exitCode;
  constructor(body, exitCode = EXIT_USAGE) {
    super(body.message);
    this.name = "CliError";
    this.body = body;
    this.exitCode = exitCode;
  }
}
function fail(message, code = "invalid_arguments", hint) {
  throw new CliError({ code, message, ...hint ? { hint } : {} });
}
function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}
`);
}

class CliExit extends Error {
  exitCode;
  constructor(exitCode) {
    super(`The Sixb CLI exited with code ${exitCode}.`);
    this.exitCode = exitCode;
    this.name = "CliExit";
  }
}
function writeRequestResult(value) {
  writeJson(value);
  const status = typeof value === "object" && value !== null ? Reflect.get(value, "status") : null;
  if (status === "awaiting_approval")
    throw new CliExit(EXIT_AWAITING_APPROVAL);
}
function writeText(value) {
  process.stdout.write(value.endsWith(`
`) ? value : `${value}
`);
}
function reportError(error, options = {}) {
  if (error instanceof CliExit)
    return error.exitCode;
  const cliError = error instanceof CliError ? error : new CliError({
    code: "internal_error",
    message: error instanceof Error ? error.message : "The Sixb CLI failed unexpectedly."
  }, EXIT_API);
  const asJson = options.json === true || process.env.SIXB_OUTPUT === "json" || process.stderr.isTTY !== true;
  if (asJson) {
    process.stderr.write(`${JSON.stringify({ error: cliError.body })}
`);
  } else {
    const color = !process.env.NO_COLOR;
    const prefix = color ? "\x1B[31merror:\x1B[0m" : "error:";
    process.stderr.write(`${prefix} ${cliError.body.message}
`);
    if (cliError.body.hint) {
      const hintPrefix = color ? "\x1B[2mhint:\x1B[0m" : "hint:";
      process.stderr.write(`${hintPrefix} ${cliError.body.hint}
`);
    }
  }
  return cliError.exitCode;
}

// src/arguments.ts
function parseCommandArgs(args, kinds, command, positionalCount = 0) {
  const positionals = [];
  const options = {};
  let positionalOnly = false;
  for (let index = 0;index < args.length; index++) {
    const argument = args[index] ?? "";
    if (!positionalOnly && argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !argument.startsWith("-") || argument === "-") {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    if (!Object.hasOwn(kinds, flag))
      fail(`Unknown ${command} option '${flag}'.`);
    if (Object.hasOwn(options, flag) && kinds[flag] !== "strings") {
      fail(`${flag} may only be provided once.`);
    }
    if (kinds[flag] === "boolean") {
      if (equals >= 0)
        fail(`${flag} does not accept a value.`);
      options[flag] = true;
    } else {
      const value = equals < 0 ? args[++index] : argument.slice(equals + 1);
      if (!value || equals < 0 && value.startsWith("--")) {
        fail(`${flag} requires a value.`);
      }
      const previous = options[flag];
      options[flag] = kinds[flag] === "strings" ? [...Array.isArray(previous) ? previous : [], value] : value;
    }
  }
  const [minimum, maximum] = typeof positionalCount === "number" ? [positionalCount, positionalCount] : positionalCount;
  if (positionals.length < minimum || positionals.length > maximum) {
    fail(`Invalid arguments for '${command}'.`);
  }
  return {
    positionals,
    options
  };
}
function requestsHelp(args) {
  const separator = args.indexOf("--");
  const beforeSeparator = separator < 0 ? args : args.slice(0, separator);
  return isHelp(args[0]) || beforeSeparator.includes("--help") || beforeSeparator.includes("-h");
}
var RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function isHelp(value) {
  return value === "-h" || value === "--help" || value === "help";
}
function requireExact(args, count, message) {
  if (args.length !== count)
    fail(message);
}
function integerInRange(flag, value, minimum, maximum) {
  if (!/^[0-9]+$/.test(value)) {
    fail(`${flag} must be an integer from ${minimum} through ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${flag} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}
function nonNegativeInteger(flag, value) {
  if (!/^[0-9]+$/.test(value)) {
    fail(`${flag} must be a non-negative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fail(`${flag} must be a non-negative safe integer.`);
  }
  return parsed;
}
function rfc3339Value(flag, value) {
  if (!RFC3339_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${flag} must be an RFC 3339 timestamp.`);
  }
  return value;
}
function requireOrderedRange(afterFlag, after, beforeFlag, before) {
  if (after && before && Date.parse(after) > Date.parse(before)) {
    fail(`${afterFlag} must be before or equal to ${beforeFlag}.`);
  }
}
function enumValue(flag, value, allowed) {
  if (!allowed.includes(value))
    fail(`${flag} must be ${formatAlternatives(allowed)}.`);
  return value;
}
function formatAlternatives(values) {
  if (values.length < 2)
    return values[0] ?? "a supported value";
  if (values.length === 2)
    return `${values[0]} or ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
}

// src/commands/actions.ts
import { randomUUID } from "node:crypto";

// src/policies.ts
var CLI_LIMITS = {
  list: { default: 20, maximum: 1000 },
  search: { default: 20, maximum: 50 },
  vectorSearchText: { maximum: 8000 },
  telemetryHistory: { default: 100, maximum: 1000 },
  linkPage: { default: 100, maximum: 1000 },
  users: { default: 20, maximum: 200 },
  history: { default: 20, maximum: 100 },
  datasetVersions: { default: 20, maximum: 100 },
  datasetRows: { default: 100, maximum: 1000 },
  inspect: {
    depth: { default: 2, maximum: 3 },
    objects: { default: 20, maximum: 100 },
    links: { default: 50, maximum: 500 },
    maximumPages: 10
  }
};
var DEFAULT_LIST_ORDER = "desc";
var DEFAULT_OBJECT_ORDER_BY = "updatedAt";
var DEFAULT_TELEMETRY_ORDER = "desc";

// src/commands/metadata.ts
var SANDBOX_MAIN_HELP = `Sixb CLI

Usage:
  sixb <command> [options]

API commands emit JSON. Help, version, and examples emit text. Downloads write to --output and
emit a JSON receipt.

Discovery:
  sixb status                         Check API connection, project, and runtime
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

Data:
  sixb datasets list|get|versions|rows ...
  sixb syncs list|get ...             Syncs you may run, each with its latest run
  sixb sync-runs list ...
  sixb pipelines list|get ...         Pipelines you may run, each with its latest run
  sixb pipeline-runs list|get ...

Files:
  sixb files upload|download ...

Members and access:
  sixb users search <text>            Find members by name or email
  sixb users list|get ...
  sixb tokens list|create|revoke ...
  sixb service-accounts list|create|disable|tokens ...
  sixb shares list|create|revoke ...

Threads and memory:
  sixb threads list|get|messages|runs|approvals ...
  sixb memory get|pull|save ...

Artifacts:
  sixb artifacts list|get|version|freeze|delete ...
  sixb artifacts comments list <artifact-id>
                                      Open comments, as threads with where each is
  sixb artifacts comments resolve|reply ...
  sixb artifacts media <artifact-id> --path <file-path> ...
                                      A video's or sound's proxy, poster, cuts, transcript
  sixb artifacts export <artifact-id> --output <path.mp4>
                                      A video's MP4, rendered, then downloaded

Observability and raw API:
  sixb logs list ...
  sixb activity summary|visits|users ...
  sixb connectors accounts <connector-id>
  sixb api <METHOD> <path> ...        Direct request to any relative /api/ route

A user parameter or property is {"type":"user","id":"<user-id>"}. Find the id with
\`sixb users search <name>\`.

In a Sixb project checked out here, other commands (\`sixb dev\`, \`sixb env pull\`, \`sixb check\`,
\`sixb typegen\`) run the project's own sixb, at the version it pins.

Run \`sixb <group> --help\` or \`sixb <group> <command> --help\` for exact arguments.
For query IR, run \`sixb objects query --help\` and \`sixb objects query --example list\`.`;
function renderInstanceHelp() {
  return SANDBOX_MAIN_HELP;
}
var SEARCH_DETAILS = `Without --type, search matches primary-id prefixes and full-text fields across visible types.
With --type, the server embeds the text with the profile's model and ranks results by score,
a cosine similarity where higher is closer. \`sixb ontology list\` shows each type's
vectorProfiles. To combine semantic search with filters, run
\`sixb objects query --example vector\`.`;
var SEARCH_HELP = `Usage:
  sixb objects search <text> [--limit <1-${CLI_LIMITS.search.maximum}>]
  sixb objects search <text> --type <object-type> [--vector-profile <name>] [--limit <1-${CLI_LIMITS.search.maximum}>]

--limit defaults to ${CLI_LIMITS.search.default}. --vector-profile is required when the type declares several
profiles.

${SEARCH_DETAILS}`;
var GET_BY_HELP = `Usage:
  sixb objects get-by <object-type> <property> <value> [--json]

Prints the object of exactly <object-type> holding <value> for a property marked unique in its
ontology doc, or null when no visible object holds it. Values match exactly, case included.
The value is a string; with --json it is parsed as JSON, for an integer (42) or a user
reference ({"type":"user","id":"usr_1"}).`;
var OBJECTS_HELP = `Usage:
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
% are safe. Identifiers are case-sensitive.`;
var QUERY_HELP = `Usage:
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
optionally under filters; k bounds the ranked matches and results carry a score.`;
var GROUP_HELP = {
  status: "Usage: sixb status [--json]",
  threads: `Usage:
  sixb threads list [--limit <1-${CLI_LIMITS.list.maximum}>] [--offset <n>]
  sixb threads get [thread-id]
  sixb threads messages [thread-id] [--offset <n>] [--limit <1-${CLI_LIMITS.history.maximum}>] [--seq <n>] [--json]
  sixb threads runs [thread-id]
  sixb threads approvals [thread-id]

When [thread-id] is omitted, SIXB_THREAD_ID is used.

\`threads messages\` prints the conversation as text, oldest first, including turns summarized
when it was compacted: what was said, files sent, and each tool call with its result. A page
holds ${CLI_LIMITS.history.default} messages by default and cuts long text; pass \`--seq <n>\` to print one message
whole, or \`--json\` for raw JSON.`,
  memory: `Usage:
  sixb memory get <repo>
  sixb memory pull [repo] [--dir <path>]
  sixb memory save <repo> -m <message> [--dir <path>]

<repo> is user or project. --dir defaults to $SIXB_MEMORY_DIR.

A save is rejected for files another conversation changed since they were loaded. Their
current contents are written next to yours as <file>.theirs: merge each into its file, delete
it, then save again. Changes others made to other files are brought in by save and pull.`,
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
takes longer keeps running, and the error names the run to read with \`action-runs get\`. A request
that waits for the user's approval prints \`"status": "awaiting_approval"\` and exits with code 4.`,
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
  sixb files upload <local-path> [--logical-path <path>] [--media-type <type>]
  sixb files download object <type> <id> --path <json-pointer> --output <local-path>
  sixb files download action-run|workflow-run <run-id> --path <json-pointer> --output <local-path>
  sixb files download artifact <artifact-id> <version> --path <file-path> --output <local-path>
  sixb files download url <content-url> --output <local-path>

\`upload\` prints the file's reference as JSON. A file past 25 MB, up to 2 GB, is sent in stages
from disk and checked against its SHA-256; on a terminal, stderr shows how far it is.`,
  workflows: `Usage:
  sixb workflows list
  sixb workflows get <workflow-id>
  sixb workflows start <workflow-id> [--file <path|->] [--run-id <id>]

The JSON file contains the workflow input object. Use - to read standard input. A start that waits
for the user's approval prints \`"status": "awaiting_approval"\` and exits with code 4.`,
  users: `Usage:
  sixb users list [options]
  sixb users search <text> [options]
  sixb users get <user-id|email>

Options:
  --status active|suspended|all       Defaults to active
  --limit <1-${CLI_LIMITS.users.maximum}>                     Defaults to ${CLI_LIMITS.users.default}
  --offset <n>                        Non-negative; defaults to 0

\`users search\` matches part of a display name or email, ignoring case; \`users get\` takes an
exact email, ignoring case, and finds suspended members too. Each member is
{"id","email","displayName","avatarUrl","status"}; a user parameter takes
{"type":"user","id":"<id>"}. Reading members requires can.view(project.users).`,
  artifacts: `Usage:
  sixb artifacts list [--limit <n>] [--offset <n>]
  sixb artifacts get <artifact-id>
  sixb artifacts version <artifact-id> <version>
  sixb artifacts freeze <artifact-id>
  sixb artifacts delete <artifact-id>
  sixb artifacts comments list <artifact-id> [--status open|resolved|all]
  sixb artifacts comments resolve <artifact-id> <comment-id> [--reopen]
  sixb artifacts comments reply <artifact-id> <comment-id> <text>|--file <path|->
  sixb artifacts export <artifact-id> [--version <n|latest>] [--retry] [--output <path.mp4>]
  sixb artifacts media <artifact-id> --path <file-path> [--version <n|latest>] [--retry]
  sixb artifacts media <artifact-id> --path <file-path> --part <part> --output <local-path>

\`list\` prints {"threads"}, open ones by default: each comment with its anchor (board, element
address and label on a canvas; at, in milliseconds, and scene on a video; revision), its body,
authorName and its replies. A message quoting comments
names each one's id as \`comment <id>\`. Resolve a comment once the change it asks for is made;
reply to one to say why it is not. Reading takes access to the artifact; resolving, the right to
change it or being the comment's author.

\`export\` asks for a video's MP4 and prints {"status"}: ready, rendering with {"progress"} (its
segments ready of all of them), or failed with its reason; --retry renders what failed anew.
With --output it waits while the video renders, then downloads the MP4 there. Each scene renders
once and is kept, so a version that changes one scene renders only that one again.

\`media\` prints what is derived of a video or a sound in the version: {"parts"}, each ready,
pending, unavailable or failed with its reason: probe, proxy, poster, filmstrip, waveform, cuts
and transcript. --retry derives each failed part anew. --part proxy|poster|filmstrip|waveform|
transcript downloads that part's file once it is ready: a proxy is a 720p H.264 copy to look at
footage with, never to publish in the original's place.`,
  models: `Usage:
  sixb models list [--kind language|image|video|speech|transcription]
  sixb models get <model> [--kind <kind>]
  sixb models text "<prompt>"|--file <path|-> [--model <tier|model>] [--instructions <text>]
                   [--max-output-tokens <n>] [--reasoning <level>]
  sixb models image "<prompt>" --output <path> [--model <model>] [--n <n>]
                    [--size <size>] [--aspect-ratio <ratio>] [--quality <q>] [--style <s>]
                    [--seed <n>] [--image <file>]...
  sixb models video "<prompt>" --output <path> [--model <model>] [--duration <seconds>]
                    [--resolution <WxH>] [--aspect-ratio <ratio>] [--audio|--no-audio]
                    [--first-frame <file>] [--last-frame <file>] [--reference <file>]...
                    [--n <n>] [--seed <n>] [--no-wait]
  sixb models video --call <call-id> --output <path> [--no-wait]
  sixb models speech "<text>" --output <path> [--model <model>] [--voice <voice>]
                     [--format mp3|wav|ogg|aac|flac] [--instructions <text>]
                     [--speed <n>] [--language <code>]
  sixb models transcribe <file> [--model <model>]
  sixb models calls files <call-id> [--output <path>]

<model> is a model id, or provider:model-id when two providers share one; without --model, the
kind's default answers. \`list\` shows each model's kind, default, description and price; \`get\`
adds the sizes, voices and other options a request can use. Prices are in USD.

\`text\` also takes a tier (light, standard or heavy) for --model, and reads a long prompt from
--file: a path, or - for standard input. \`transcribe\` prints the text, and its words and segments,
each timed in milliseconds, when the model times them.

--output is a file, numbered when a call returns several, or a directory ending in /. The
extension follows the file's type, and the result lists the paths written. --image uploads a
reference image; repeat it for several. \`calls files\` lists a past call's files, or downloads
them again.

\`video\` takes minutes: it starts the video, waits for it and downloads it. The video keeps
generating if the command stops; \`--call <call-id>\` picks it up again, and \`--no-wait\` prints
where it stands and returns. --first-frame and --last-frame are the images the clip starts from
and ends on; --reference shows a character, object or style, and repeats.`,
  "workflow-runs": `Usage:
  sixb workflow-runs list [options]
  sixb workflow-runs get <run-id>
  sixb workflow-runs cancel <run-id>

List options:
  --workflow <workflow-id>
  --status queued|running|waiting|succeeded|failed|cancelled
  --started-after|--started-before <RFC3339>
  --limit <1-${CLI_LIMITS.list.maximum}>              Defaults to ${CLI_LIMITS.list.default}
  --offset <n>                  Non-negative; defaults to 0
  --order <asc|desc>            Started-time order; defaults to ${DEFAULT_LIST_ORDER}`,
  datasets: `Usage:
  sixb datasets list
  sixb datasets get <dataset-id>
  sixb datasets versions <dataset-id> [--limit <1-${CLI_LIMITS.datasetVersions.maximum}>]
  sixb datasets rows <dataset-id> [options]

Rows options:
  --version <version-id>        Defaults to the latest version
  --columns <a,b,...>           Defaults to every column
  --limit <1-${CLI_LIMITS.datasetRows.maximum}>              Defaults to ${CLI_LIMITS.datasetRows.default}
  --offset <n>                  Non-negative; defaults to 0

\`list\` and \`get\` show a dataset's schema, its latest version, and the syncs and pipelines you
may run that read or write it. \`versions\` lists the newest first. \`rows\` leaves out the
columns your clearances do not cover and names them under redactions.`,
  syncs: `Usage:
  sixb syncs list
  sixb syncs get <sync-id>
  sixb syncs run <sync-id> [--file <path|->]

Lists, inspects, or triggers syncs you may run. \`sixb sync-runs list\` shows the history.`,
  "sync-runs": `Usage:
  sixb sync-runs list [options]

List options:
  --sync <sync-id>
  --dataset <dataset-id>
  --status queued|running|succeeded|failed|cancelled
  --started-after|--started-before <RFC3339>
  --limit <1-${CLI_LIMITS.list.maximum}>              Defaults to ${CLI_LIMITS.list.default}
  --offset <n>                  Non-negative; defaults to 0
  --order <asc|desc>            Started-time order; defaults to ${DEFAULT_LIST_ORDER}`,
  pipelines: `Usage:
  sixb pipelines list
  sixb pipelines get <pipeline-id>
  sixb pipelines run <pipeline-id>

Lists, inspects, or triggers pipelines you may run. \`sixb pipeline-runs\` shows the history and
each run's steps.`,
  "pipeline-runs": `Usage:
  sixb pipeline-runs list [options]
  sixb pipeline-runs get <run-id>

List options:
  --pipeline <pipeline-id>
  --status queued|running|succeeded|failed|cancelled
  --started-after|--started-before <RFC3339>
  --limit <1-${CLI_LIMITS.list.maximum}>              Defaults to ${CLI_LIMITS.list.default}
  --offset <n>                  Non-negative; defaults to 0
  --order <asc|desc>            Started-time order; defaults to ${DEFAULT_LIST_ORDER}

\`get\` includes the run's steps.`,
  tokens: `Usage:
  sixb tokens list [--json]
  sixb tokens create <name> [--expires-in <duration>|--expires-at <iso>] [--group <id>]... [--json]
  sixb tokens revoke <token-id> [--json]

Manage personal access tokens. Creating a token requires a signed-in session (\`sixb login\`).`,
  "service-accounts": `Usage:
  sixb service-accounts list [--json]
  sixb service-accounts create <name> [--id <id>] [--description <text>] [--group <id>]... [--json]
  sixb service-accounts disable <service-account-id> [--json]
  sixb service-accounts tokens list <service-account-id> [--json]
  sixb service-accounts tokens create <service-account-id> <name> [--expires-in <duration>|--expires-at <iso>] [--group <id>]... [--json]
  sixb service-accounts tokens revoke <service-account-id> <token-id> [--json]

Manage service accounts and their access tokens.`,
  shares: `Usage:
  sixb shares list [--definition <id>] [--primary-id <id>] [--json]
  sixb shares create --file <path|-> [--json]
  sixb shares revoke <grant-id> [--json]

List, create, and revoke shared-access grants.`,
  logs: `Usage:
  sixb logs list [--limit <n>] [--level <level>] [--service <name>] [--search <text>] [--from <RFC3339>] [--to <RFC3339>]`,
  activity: `Usage:
  sixb activity summary [--from <RFC3339>] [--to <RFC3339>]
  sixb activity visits [--from <RFC3339>] [--to <RFC3339>] [--limit <n>]
  sixb activity users [--from <RFC3339>] [--to <RFC3339>] [--limit <n>]`,
  connectors: `Usage:
  sixb connectors accounts <connector-id>`,
  api: `Usage:
  sixb api <METHOD> <path> [--file <path|->|--input <json>] [--query <key=value>]... [--json]

Send a request directly to any relative /api/... route using the active connection, auth, and
grant boundary. METHOD is GET, POST, PUT, PATCH, DELETE, or HEAD.`
};
var QUERY_EXAMPLES = {
  exact: '{"kind":"refs","refs":[{"objectTypeId":"RepositoryIssue","primaryId":"github:issue:owner/repo#297"}]}',
  filter: `{"kind":"limit","input":{"kind":"filter","input":{"kind":"start","objectTypeId":"Customer"},"predicate":{"op":"eq","propertyId":"status","value":"active"}},"limit":${CLI_LIMITS.list.default}}`,
  and: `{"kind":"limit","input":{"kind":"filter","input":{"kind":"start","objectTypeId":"Customer"},"predicate":{"op":"and","items":[{"op":"eq","propertyId":"status","value":"active"},{"op":"gte","propertyId":"createdAt","value":"2026-01-01T00:00:00Z"}]}},"limit":${CLI_LIMITS.list.default}}`,
  not: `{"kind":"limit","input":{"kind":"filter","input":{"kind":"start","objectTypeId":"Customer"},"predicate":{"op":"not","item":{"op":"eq","propertyId":"status","value":"churned"}}},"limit":${CLI_LIMITS.list.default}}`,
  in: `{"kind":"limit","input":{"kind":"filter","input":{"kind":"start","objectTypeId":"Customer"},"predicate":{"op":"in","propertyId":"status","values":["active","trial"]}},"limit":${CLI_LIMITS.list.default}}`,
  exists: `{"kind":"limit","input":{"kind":"filter","input":{"kind":"start","objectTypeId":"Customer"},"predicate":{"op":"exists","propertyId":"accountManager","value":false}},"limit":${CLI_LIMITS.list.default}}`,
  mine: `{"kind":"limit","input":{"kind":"filter","input":{"kind":"start","objectTypeId":"Task"},"predicate":{"op":"eq","propertyId":"assignee","value":{"type":"currentUser"}}},"limit":${CLI_LIMITS.list.default}}`,
  project: `{"kind":"project","input":{"kind":"limit","input":{"kind":"start","objectTypeId":"Customer"},"limit":${CLI_LIMITS.list.default}},"properties":["name","status"]}`,
  incoming: '{"kind":"traverse","input":{"kind":"refs","refs":[{"objectTypeId":"RepositoryIssue","primaryId":"github:issue:owner/repo#297"}]},"linkId":"issue","direction":"incoming","sourceObjectTypeId":"RepositoryComment"}',
  expand: `{"kind":"expand","input":{"kind":"refs","refs":[{"objectTypeId":"RepositoryIssue","primaryId":"github:issue:owner/repo#297"}]},"expansions":[{"linkId":"issue","direction":"incoming","sourceObjectTypeId":"RepositoryComment","limit":${CLI_LIMITS.list.default}}]}`,
  users: `{"kind":"expand","input":{"kind":"limit","input":{"kind":"start","objectTypeId":"Task"},"limit":${CLI_LIMITS.list.default}},"expansions":[],"users":["assignee"]}`,
  sort: `{"kind":"limit","input":{"kind":"sort","input":{"kind":"start","objectTypeId":"Customer"},"fields":[{"kind":"property","propertyId":"name","direction":"asc"}]},"limit":${CLI_LIMITS.list.default}}`,
  page: `{"kind":"page","input":{"kind":"start","objectTypeId":"Customer"},"pageSize":${CLI_LIMITS.list.default}}`,
  vector: `{"kind":"vector","input":{"kind":"filter","input":{"kind":"start","objectTypeId":"Product"},"predicate":{"op":"eq","propertyId":"status","value":"active"}},"vector":"waterproof trail shoes","profile":"content","k":${CLI_LIMITS.search.default}}`
};
var FACETS_EXAMPLE = '{"query":{"kind":"start","objectTypeId":"WorkOrder"},"facets":[{"propertyId":"status","limit":10}]}';

// src/commands/shared.ts
import { readFile } from "node:fs/promises";
function idSegment(value) {
  if (!value || value === "." || value === "..")
    fail(`'${value ?? ""}' is not an id.`);
  return encodeURIComponent(value);
}
function parseQueryOptions(args, names, command) {
  const kinds = Object.fromEntries(Object.keys(names).map((flag) => [flag, "string"]));
  const { options } = parseCommandArgs(args, kinds, command);
  const query = {};
  for (const [flag, value] of Object.entries(options)) {
    const name = names[flag];
    if (name)
      query[name] = value;
  }
  return query;
}
function normalizeWindowOptions(options, policy) {
  const normalized = {
    ...options,
    limit: String(integerInRange("--limit", options.limit ?? String(policy.defaultLimit), 1, policy.maximumLimit)),
    order: enumValue("--order", options.order ?? policy.defaultOrder, ["asc", "desc"])
  };
  if (policy.offset && options.offset !== undefined) {
    normalized.offset = String(nonNegativeInteger("--offset", options.offset));
  }
  return normalized;
}
function singleFileOption(args, command) {
  const { options } = parseCommandArgs(args, { "--file": "string" }, command);
  if (!options["--file"])
    fail(`${command} requires --file <path|->.`);
  return options["--file"];
}
async function readJson(source) {
  const text = await readText(source, "JSON file");
  try {
    return JSON.parse(text);
  } catch {
    fail(source === "-" ? "Standard input is not valid JSON." : `JSON file '${source}' is not valid JSON.`, "invalid_json");
  }
}
async function readText(source, noun) {
  try {
    return source === "-" ? await readStdin() : await readFile(source, "utf8");
  } catch (error) {
    if (isFileError(error, "ENOENT"))
      fail(`${noun} '${source}' does not exist.`);
    throw error;
  }
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function asRecords(value) {
  return Array.isArray(value) ? value.map(asRecord) : [];
}
function vectorProfileNames(objectType) {
  return Object.keys(asRecord(asRecord(objectType.search).vectors));
}
function isFileError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// src/commands/actions.ts
var ACTION_REQUEST_WAIT_MS = 25000;
async function actions(api, args, requestWaitMs = ACTION_REQUEST_WAIT_MS) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.actions);
  if (sub === "get") {
    const { positionals } = parseCommandArgs(rest, {}, "actions get", 1);
    return writeJson(await api.get(`/api/actions/${idSegment(positionals[0])}`));
  }
  if (sub === "list") {
    const options = parseQueryOptions(rest, { "--type": "objectTypeId" }, "actions list");
    const response = await api.get("/api/actions");
    if (!options.objectTypeId)
      return writeJson(response);
    if (!Array.isArray(response))
      fail("The actions API returned an invalid response.");
    return writeJson(response.filter((value) => asRecord(value).objectTypeId === options.objectTypeId));
  }
  if (sub === "request") {
    const { positionals, options } = parseCommandArgs(rest, {
      "--subject-type": "string",
      "--subject-id": "string",
      "--file": "string",
      "--run-id": "string"
    }, "actions request", 1);
    const actionId = positionals[0] ?? "";
    const subjectType = options["--subject-type"];
    const subjectId = options["--subject-id"];
    const paramsSource = options["--file"];
    const runId = options["--run-id"];
    if (Boolean(subjectType) !== Boolean(subjectId)) {
      fail("--subject-type and --subject-id must be provided together.");
    }
    const params = paramsSource ? await readJson(paramsSource) : {};
    if (Array.isArray(params) || typeof params !== "object" || params === null) {
      fail("Action params must be a JSON object.");
    }
    const requestedRunId = runId ?? `act_${randomUUID()}`;
    const waiting = AbortSignal.timeout(requestWaitMs);
    try {
      return writeRequestResult(await api.post(`/api/actions/${idSegment(actionId)}`, {
        params,
        ...subjectType && subjectId ? { subject: { kind: "object", objectTypeId: subjectType, primaryId: subjectId } } : {},
        runId: requestedRunId
      }, { signal: waiting }));
    } catch (error) {
      if (!waiting.aborted)
        throw error;
      throw new CliError({
        code: "action_wait_timeout",
        message: `Action run '${requestedRunId}' did not finish within ${requestWaitMs / 1000} ` + "seconds. It was not cancelled.",
        hint: `Read it with 'sixb action-runs get ${requestedRunId}': its record exists once it ` + `has ended. A repeated request must pass '--run-id ${requestedRunId}', or the ` + "Action runs twice."
      }, EXIT_API);
    }
  }
  fail(`Unknown actions command '${sub}'.`);
}

// src/commands/api.ts
var METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
async function apiCommand(client, args) {
  if (args.length === 0 || isHelp(args[0]) || requestsHelp(args)) {
    return writeText(GROUP_HELP.api);
  }
  const { positionals, options } = parseCommandArgs(args, {
    "--file": "string",
    "--input": "string",
    "--query": "strings",
    "--json": "boolean"
  }, "api", 2);
  const rawMethod = (positionals[0] ?? "").toUpperCase();
  if (!METHODS.has(rawMethod)) {
    fail(`Unsupported HTTP method '${positionals[0] ?? ""}'. Use GET, POST, PUT, PATCH, DELETE, or HEAD.`);
  }
  const path = positionals[1] ?? "";
  if (options["--file"] && options["--input"]) {
    fail("--file and --input cannot be used together.");
  }
  let body;
  if (options["--file"]) {
    body = await readJson(options["--file"]);
  } else if (options["--input"] !== undefined) {
    try {
      body = JSON.parse(options["--input"]);
    } catch {
      fail("--input must be valid JSON.", "invalid_json");
    }
  }
  if (body !== undefined && (rawMethod === "GET" || rawMethod === "HEAD")) {
    fail(`${rawMethod} requests cannot include a body.`);
  }
  const query = parseQueryPairs(options["--query"]);
  const result = await client.request(rawMethod, path, {
    ...query ? { query } : {},
    ...body === undefined ? {} : { body }
  });
  if (rawMethod === "POST" || rawMethod === "PUT" || rawMethod === "PATCH") {
    return writeRequestResult(result);
  }
  writeJson(result);
}
function parseQueryPairs(entries) {
  if (!entries || entries.length === 0)
    return;
  const query = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      fail(`Invalid --query '${entry}'. Use key=value.`);
    }
    query[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return query;
}

// src/commands/artifacts.ts
var STATUSES = ["open", "resolved", "all"];
var MAX_BODY_LENGTH = 4000;
async function artifacts(api, args) {
  const [group, sub, ...rest] = args;
  if (!group || isHelp(group))
    return writeText(GROUP_HELP.artifacts);
  if (group === "list") {
    if (requestsHelp(args.slice(1)))
      return writeText(GROUP_HELP.artifacts);
    const { options } = parseCommandArgs(args.slice(1), { "--limit": "string", "--offset": "string" }, "artifacts list");
    return writeJson(await api.get("/api/artifacts", {
      ...options["--limit"] ? { limit: options["--limit"] } : {},
      ...options["--offset"] ? { offset: options["--offset"] } : {}
    }));
  }
  if (group === "get") {
    if (requestsHelp(args.slice(1)))
      return writeText(GROUP_HELP.artifacts);
    const { positionals } = parseCommandArgs(args.slice(1), {}, "artifacts get", 1);
    return writeJson(await api.get(`/api/artifacts/${idSegment(positionals[0]?.trim())}`));
  }
  if (group === "version") {
    if (requestsHelp(args.slice(1)))
      return writeText(GROUP_HELP.artifacts);
    const { positionals } = parseCommandArgs(args.slice(1), {}, "artifacts version", 2);
    const [artifactId, version] = positionals;
    return writeJson(await api.get(`/api/artifacts/${idSegment(artifactId?.trim())}/versions/${idSegment(version?.trim())}`));
  }
  if (group === "freeze") {
    if (requestsHelp(args.slice(1)))
      return writeText(GROUP_HELP.artifacts);
    const { positionals } = parseCommandArgs(args.slice(1), {}, "artifacts freeze", 1);
    return writeJson(await api.post(`/api/artifacts/${idSegment(positionals[0]?.trim())}/freeze`, {}));
  }
  if (group === "delete") {
    if (requestsHelp(args.slice(1)))
      return writeText(GROUP_HELP.artifacts);
    const { positionals } = parseCommandArgs(args.slice(1), {}, "artifacts delete", 1);
    return writeJson(await api.delete(`/api/artifacts/${idSegment(positionals[0]?.trim())}`));
  }
  if (group === "export")
    return exportVideo(api, args.slice(1));
  if (group === "media")
    return media(api, args.slice(1));
  if (group !== "comments")
    fail(`Unknown artifacts command '${group}'.`);
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.artifacts);
  if (sub === "list") {
    const { positionals, options } = parseCommandArgs(rest, { "--status": "string" }, "artifacts comments list", 1);
    const artifact = idSegment(positionals[0]?.trim());
    const status = enumValue("--status", options["--status"] ?? "open", STATUSES);
    const page = await api.get(`/api/artifacts/${artifact}/comments`);
    return writeJson({ threads: threadsOf(commentsOf(page), status) });
  }
  if (sub === "resolve") {
    const { positionals, options } = parseCommandArgs(rest, { "--reopen": "boolean" }, "artifacts comments resolve", 2);
    const [artifact, comment] = positionals.map((value) => idSegment(value.trim()));
    return writeJson(await api.post(`/api/artifacts/${artifact}/comments/${comment}/resolve`, {
      resolved: options["--reopen"] !== true
    }));
  }
  if (sub === "reply") {
    const { positionals, options } = parseCommandArgs(rest, { "--file": "string" }, "artifacts comments reply", [2, 3]);
    const [artifactId, commentId, words] = positionals;
    const body = (options["--file"] ? await readText(options["--file"], "reply") : words ?? "").trim();
    if (!body)
      fail("artifacts comments reply requires the reply's words, or --file <path|->.");
    if (body.length > MAX_BODY_LENGTH) {
      fail(`A reply holds at most ${MAX_BODY_LENGTH} characters.`);
    }
    return writeJson(await api.post(`/api/artifacts/${idSegment(artifactId?.trim())}/comments`, {
      body,
      parentId: commentId?.trim()
    }));
  }
  fail(`Unknown artifacts comments command '${sub}'.`);
}
var EXPORT_POLL_MS = 3000;
var EXPORT_WAIT_MS = 60 * 60000;
async function exportVideo(api, args) {
  if (requestsHelp(args))
    return writeText(GROUP_HELP.artifacts);
  const { positionals, options } = parseCommandArgs(args, { "--version": "string", "--retry": "boolean", "--output": "string" }, "artifacts export", 1);
  const version = options["--version"]?.trim() || "latest";
  if (!/^(latest|[1-9]\d*)$/.test(version)) {
    fail('artifacts export --version is a version number, or "latest".');
  }
  const path = `/api/artifacts/${idSegment(positionals[0]?.trim())}/versions/${version}/video`;
  const ask = async (retry) => await api.post(`${path}${retry ? "?retry=true" : ""}`, {});
  let asked = await ask(options["--retry"] === true);
  const output = options["--output"];
  if (!output)
    return writeJson(asked);
  const progress = process.stderr.isTTY ? exportProgress() : undefined;
  const deadline = Date.now() + EXPORT_WAIT_MS;
  try {
    while (asked.status === "rendering") {
      progress?.show(asked);
      if (Date.now() > deadline) {
        fail("The video is still rendering. Run the command again to keep waiting.", "timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_MS));
      asked = await ask(false);
    }
  } finally {
    progress?.clear();
  }
  if (asked.status === "failed") {
    fail(`The video could not be rendered: ${asked.reason ?? "no reason given"}`, "video_failed", "Run the command again with --retry to render what failed anew.");
  }
  await api.download(path, output);
  return writeJson({ ...asked, downloaded: true, output });
}
function exportProgress() {
  let shown = "";
  return {
    show({ progress }) {
      const line = progress?.assembling ? "Joining the scenes…" : `Rendering… ${progress?.ready ?? 0} of ${progress?.total ?? 0} segments`;
      if (line === shown)
        return;
      shown = line;
      process.stderr.write(`\r\x1B[2K${line}`);
    },
    clear() {
      if (shown)
        process.stderr.write("\r\x1B[2K");
    }
  };
}
var MEDIA_FILES = ["proxy", "poster", "filmstrip", "waveform", "transcript"];
async function media(api, args) {
  if (requestsHelp(args))
    return writeText(GROUP_HELP.artifacts);
  const { positionals, options } = parseCommandArgs(args, {
    "--path": "string",
    "--version": "string",
    "--part": "string",
    "--output": "string",
    "--retry": "boolean"
  }, "artifacts media", 1);
  const path = options["--path"]?.trim();
  if (!path)
    fail("artifacts media requires --path <file-path>, the video or sound in the version.");
  const version = options["--version"]?.trim() || "latest";
  if (!/^(latest|[1-9]\d*)$/.test(version)) {
    fail('artifacts media --version is a version number, or "latest".');
  }
  const part = options["--part"] && enumValue("--part", options["--part"], MEDIA_FILES);
  const output = options["--output"];
  if (part && !output)
    fail("artifacts media --part requires --output <local-path>.");
  const route = `/api/artifacts/${idSegment(positionals[0]?.trim())}/versions/${version}/media`;
  const derived = await api.get(route, {
    path,
    ...options["--retry"] === true ? { retry: "true" } : {}
  });
  if (!part || !output)
    return writeJson(derived);
  const wanted = derived.parts?.[part];
  if (wanted?.status === "pending") {
    fail(`The ${part} of ${path} is still being made.`, "media_pending", "Ask again in a few seconds.");
  }
  if (wanted?.status !== "ready" || !wanted.url) {
    fail(`${path} has no ${part}: ${wanted?.reason ?? "it was not derived"}`, "media_unavailable", wanted?.status === "failed" ? "Run the command again with --retry to derive it anew." : undefined);
  }
  const url = new URL(wanted.url, "http://sixb.invalid");
  await api.download(url.pathname, output, Object.fromEntries(url.searchParams));
  return writeJson({ downloaded: true, part, output });
}
function commentsOf(page) {
  const comments = typeof page === "object" && page !== null && "comments" in page ? page.comments : [];
  return Array.isArray(comments) ? comments.filter((comment) => typeof comment === "object" && comment !== null && typeof comment.id === "string") : [];
}
function threadsOf(comments, status) {
  return comments.filter((comment) => !comment.parentId).filter((comment) => status === "all" || status === "resolved" === Boolean(comment.resolvedAt)).map((comment) => ({
    ...comment,
    replies: comments.filter((reply) => reply.parentId === comment.id)
  }));
}

// src/commands/data.ts
async function datasets(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.datasets);
  if (sub === "list") {
    parseCommandArgs(rest, {}, "datasets list");
    return writeJson(await api.get("/api/datasets"));
  }
  if (sub === "get") {
    const { positionals } = parseCommandArgs(rest, {}, "datasets get", 1);
    return writeJson(await api.get(`/api/datasets/${idSegment(positionals[0])}`));
  }
  if (sub === "versions") {
    const { positionals, options } = parseCommandArgs(rest, { "--limit": "string" }, "datasets versions", 1);
    const { default: fallback, maximum } = CLI_LIMITS.datasetVersions;
    const limit = integerInRange("--limit", options["--limit"] ?? String(fallback), 1, maximum);
    return writeJson(await api.get(`/api/datasets/${idSegment(positionals[0])}/versions`, { limit: String(limit) }));
  }
  if (sub === "rows") {
    const { positionals, options } = parseCommandArgs(rest, { "--version": "string", "--columns": "string", "--limit": "string", "--offset": "string" }, "datasets rows", 1);
    const { default: fallback, maximum } = CLI_LIMITS.datasetRows;
    const query = {
      limit: String(integerInRange("--limit", options["--limit"] ?? String(fallback), 1, maximum)),
      ...options["--version"] === undefined ? {} : { versionId: options["--version"] },
      ...options["--columns"] === undefined ? {} : { columns: columnList(options["--columns"]) },
      ...options["--offset"] === undefined ? {} : { offset: String(nonNegativeInteger("--offset", options["--offset"])) }
    };
    return writeJson(await api.get(`/api/datasets/${idSegment(positionals[0])}/rows`, query));
  }
  fail(`Unknown datasets command '${sub}'.`);
}
async function runnables(api, group, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP[group]);
  if (sub === "list") {
    parseCommandArgs(rest, {}, `${group} list`);
    return writeJson(await api.get(`/api/${group}`));
  }
  if (sub === "get") {
    const { positionals } = parseCommandArgs(rest, {}, `${group} get`, 1);
    return writeJson(await api.get(`/api/${group}/${idSegment(positionals[0])}`));
  }
  if (sub === "run") {
    const { positionals, options } = parseCommandArgs(rest, group === "syncs" ? { "--file": "string" } : {}, `${group} run`, 1);
    const file = typeof options["--file"] === "string" ? options["--file"] : undefined;
    const body = group === "syncs" && file ? await readJson(file) : {};
    return writeJson(await api.post(`/api/${group}/${idSegment(positionals[0])}/runs`, body));
  }
  fail(`Unknown ${group} command '${sub}'.`);
}
function columnList(value) {
  const columns = value.split(",").map((column) => column.trim());
  if (columns.some((column) => !column))
    fail("--columns takes column names separated by commas.");
  return columns.join(",");
}

// src/commands/files.ts
import { basename as basename2 } from "node:path";

// src/upload.ts
import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
var SIMPLE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
var READ_CHUNK_BYTES = 1024 * 1024;
async function uploadFile(api, source, options = {}) {
  const sizeBytes = await regularFileSize(source);
  if (sizeBytes <= SIMPLE_UPLOAD_MAX_BYTES) {
    const fileRef = await api.upload("/api/files", source, options.logicalPath, options.mediaType);
    options.onProgress?.({ stage: "upload", loadedBytes: sizeBytes, totalBytes: sizeBytes });
    return fileRef;
  }
  const progress = (stage, loadedBytes) => options.onProgress?.({ stage, loadedBytes, totalBytes: sizeBytes });
  const digest = await fileDigest(source, (hashedBytes) => progress("hash", hashedBytes));
  const forceServer = options.strategy === "server" || process.env.SIXB_UPLOAD_STRATEGY === "server";
  const upload = stagedUpload(await api.post("/api/files/uploads", {
    fileName: basename(source),
    ...options.mediaType ? { mediaType: options.mediaType } : {},
    sizeBytes,
    digest,
    ...options.logicalPath ? { logicalPath: options.logicalPath } : {},
    ...forceServer ? { strategy: "server" } : {}
  }));
  try {
    progress("upload", 0);
    const parts = await sendContent(api, upload, source, sizeBytes, (sentBytes) => progress("upload", sentBytes));
    return await api.post(`/api/files/uploads/${encodeURIComponent(upload.uploadId)}/complete`, {
      digest,
      sizeBytes,
      ...parts ? { parts } : {}
    });
  } catch (error) {
    await api.post(`/api/files/uploads/${encodeURIComponent(upload.uploadId)}/abort`, {}).catch(() => {});
    throw error;
  }
}
async function sendContent(api, upload, source, sizeBytes, onSent) {
  if (upload.strategy === "server") {
    await api.put(upload.url, fileStream(source, { onBytes: onSent }), sizeBytes);
    return;
  }
  const file = await openAsBlob(source);
  if (upload.strategy === "direct-put") {
    await signedPut(upload.url, upload.headers, file);
    onSent(sizeBytes);
    return;
  }
  const parts = [];
  for (let offset = 0, partNumber = 1;offset < sizeBytes; partNumber += 1) {
    const end = Math.min(sizeBytes, offset + upload.partSizeBytes);
    const signed = signedPart(await api.post(`/api/files/uploads/${encodeURIComponent(upload.uploadId)}/parts/${partNumber}`, {}));
    const etag = await signedPut(signed.url, signed.headers, file.slice(offset, end));
    if (upload.partReceipt === "etag" && !etag) {
      throw uploadFailed(`Part ${partNumber} of the upload returned no ETag.`);
    }
    parts.push(upload.partReceipt === "etag" && etag ? { partNumber, etag } : { partNumber });
    onSent(end);
    offset = end;
  }
  return parts;
}
async function signedPut(url, headers, body) {
  let response;
  try {
    response = await fetch(url, { method: "PUT", headers, body });
  } catch {
    throw uploadFailed("Blob storage could not be reached to upload the file.");
  }
  if (!response.ok) {
    throw uploadFailed(`Blob storage refused the upload with HTTP ${response.status}.`);
  }
  return response.headers.get("etag");
}
async function regularFileSize(source) {
  const info = await stat(source).catch(() => null);
  if (!info)
    fail(`Upload file '${source}' does not exist.`);
  if (!info.isFile())
    fail(`Upload file '${source}' is not a regular file.`);
  return info.size;
}
async function fileDigest(source, onBytes) {
  const hash = createHash("sha256");
  let hashedBytes = 0;
  for await (const chunk of createReadStream(source, { highWaterMark: READ_CHUNK_BYTES })) {
    hash.update(chunk);
    hashedBytes += chunk.byteLength;
    onBytes(hashedBytes);
  }
  return `sha256:${hash.digest("hex")}`;
}
function fileStream(source, options) {
  const stream = Readable.toWeb(createReadStream(source, { highWaterMark: READ_CHUNK_BYTES }));
  let readBytes = 0;
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      readBytes += chunk.byteLength;
      options.onBytes(readBytes);
      controller.enqueue(chunk);
    }
  }));
}
function stagedUpload(value) {
  const upload = value;
  const uploadId = upload?.uploadId;
  if (typeof uploadId !== "string")
    throw invalidResponse();
  if (upload?.strategy === "server" && typeof upload.url === "string") {
    return { strategy: "server", uploadId, url: upload.url };
  }
  if (upload?.strategy === "direct-put" && typeof upload.url === "string") {
    return {
      strategy: "direct-put",
      uploadId,
      url: upload.url,
      headers: stringRecord(upload.headers)
    };
  }
  if (upload?.strategy === "multipart" && typeof upload.partSizeBytes === "number" && upload.partSizeBytes > 0) {
    return {
      strategy: "multipart",
      uploadId,
      partSizeBytes: upload.partSizeBytes,
      partReceipt: upload.partReceipt === "none" ? "none" : "etag"
    };
  }
  throw invalidResponse();
}
function signedPart(value) {
  const part = value;
  if (typeof part?.url !== "string")
    throw invalidResponse();
  return { url: part.url, headers: stringRecord(part.headers) };
}
function stringRecord(value) {
  if (typeof value !== "object" || value === null)
    return {};
  return Object.fromEntries(Object.entries(value).filter((entry) => typeof entry[1] === "string"));
}
function invalidResponse() {
  return new CliError({
    code: "invalid_api_response",
    message: "The Sixb API described the upload in a way the CLI does not know."
  }, EXIT_API);
}
function uploadFailed(message) {
  return new CliError({ code: "upload_failed", message }, EXIT_API);
}

// src/commands/files.ts
async function files(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.files);
  if (sub === "upload") {
    const { positionals, options } = parseCommandArgs(rest, { "--logical-path": "string", "--media-type": "string" }, "files upload", 1);
    const source = positionals[0] ?? "";
    const logicalPath = options["--logical-path"];
    const mediaType = options["--media-type"];
    const progress = process.stderr.isTTY ? progressLine(basename2(source)) : undefined;
    try {
      const fileRef = await uploadFile(api, source, {
        ...logicalPath ? { logicalPath } : {},
        ...mediaType ? { mediaType } : {},
        ...progress ? { onProgress: progress.show } : {}
      });
      progress?.clear();
      return writeJson(fileRef);
    } catch (error) {
      progress?.clear();
      throw error;
    }
  }
  if (sub === "download") {
    const { positionals, options } = parseCommandArgs(rest, { "--path": "string", "--output": "string" }, "files download", [2, 3]);
    const context = positionals[0];
    const output = options["--output"];
    if (context === "url") {
      requireExact(positionals, 2, "files download url requires exactly one content URL.");
      const url = parseContentUrl(positionals[1] ?? "");
      if (!output)
        fail("files download requires --output <local-path>.");
      await api.download(url.pathname, output, Object.fromEntries(url.searchParams));
      return writeJson({ downloaded: true, output });
    }
    let route;
    if (context === "object") {
      requireExact(positionals, 3, "files download object requires object type and primary id.");
      const type = positionals[1] ?? "";
      const id = positionals[2] ?? "";
      route = `/api/objects/${idSegment(type)}/${idSegment(id)}/files/content`;
    } else if (context === "artifact") {
      requireExact(positionals, 3, "files download artifact requires an artifact id and a version.");
      const id = positionals[1] ?? "";
      const version = positionals[2] ?? "";
      if (!/^[1-9]\d*$/.test(version))
        fail(`'${version}' is not a version number.`);
      route = `/api/artifacts/${idSegment(id)}/versions/${version}/content`;
    } else if (context === "action-run" || context === "workflow-run") {
      requireExact(positionals, 2, `files download ${context} requires exactly one run id.`);
      const id = positionals[1] ?? "";
      route = `/api/${context}s/${idSegment(id)}/files/content`;
    } else
      fail(`Unknown file download context '${context}'.`);
    const path = options["--path"];
    if (!path) {
      fail(`files download requires --path <${context === "artifact" ? "file-path" : "json-pointer"}>.`);
    }
    if (!output)
      fail("files download requires --output <local-path>.");
    await api.download(route, output, { path });
    return writeJson({ downloaded: true, output });
  }
  fail(`Unknown files command '${sub}'.`);
}
function progressLine(name) {
  let shown = "";
  return {
    show({ stage, loadedBytes, totalBytes }) {
      const percent = Math.floor(loadedBytes / Math.max(1, totalBytes) * 100);
      const line = stage === "hash" ? `Checking ${name}… ${percent}%` : `Uploading ${name}… ${percent}% of ${megabytes(totalBytes)}`;
      if (line === shown)
        return;
      shown = line;
      process.stderr.write(`\r\x1B[2K${line}`);
    },
    clear() {
      if (shown)
        process.stderr.write("\r\x1B[2K");
    }
  };
}
function megabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function parseContentUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`'${value}' is not a URL.`);
  }
  if (!url.pathname.startsWith("/api/") || !url.pathname.endsWith("/files/content")) {
    fail(`'${value}' is not a Sixb file content URL.`);
  }
  return url;
}

// src/commands/memory.ts
import { lstat, mkdir, readdir, readFile as readFile2, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// src/memory.ts
import { createHash as createHash2 } from "node:crypto";
var AGENT_MEMORY_MANIFEST = "context/memory.json";
var AGENT_MEMORY_ENTRY = "MEMORY.md";
var AGENT_MEMORY_STARTER = `# Memory

`;
function agentMemoryFileHash(contents) {
  return createHash2("sha256").update(contents).digest("hex");
}

// src/commands/memory.ts
var THEIRS = ".theirs";
var LOCAL_MANIFEST_NAME = ".sixb-memory.json";
var CONFLICT_HINT = "Merge each .theirs file into its file, delete it, then save again.";
async function memory(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.memory);
  if (sub === "get")
    return get(api, rest);
  if (sub === "save")
    return save(api, rest);
  if (sub === "pull")
    return pull(api, rest);
  fail(`Unknown memory command '${sub}'. Run 'sixb memory --help'.`);
}
async function get(api, args) {
  const { positionals } = parseCommandArgs(args, {}, "memory get", 1);
  const repo = parseRepo(positionals[0] ?? "");
  const remote = await fetchRepo(api, repo);
  writeJson({
    repo,
    revision: remote.revision,
    files: [...remote.files.entries()].map(([path, contents]) => ({ path, contents }))
  });
}
async function save(api, args) {
  const { repo, message, dir } = parseSaveArgs(args);
  const local = localMemory(dir);
  const manifest = await local.readManifest();
  const loaded = manifest.repos[repo];
  if (!loaded)
    fail(`Memory repo '${repo}' is not installed.`, "invalid_arguments", `Run 'sixb memory pull ${repo}'.`);
  const files = await local.readRepo(repo);
  const unresolved = [...files.keys()].filter((path) => path.endsWith(THEIRS));
  if (unresolved.length > 0) {
    fail(`Resolve ${unresolved.join(", ")} first.`, "unresolved_conflicts", CONFLICT_HINT);
  }
  const changes = [...new Set([...files.keys(), ...Object.keys(loaded.files)])].sort().flatMap((path) => {
    const contents = files.get(path);
    const changed = (contents === undefined ? undefined : agentMemoryFileHash(contents)) !== loaded.files[path];
    return changed ? [{ path, contents: contents ?? null }] : [];
  });
  if (changes.length === 0) {
    return writeJson({
      repo,
      saved: false,
      changed: [],
      hint: "No file changed since it was loaded."
    });
  }
  let saved;
  try {
    saved = asRecord(await api.post(`/api/agent-memory/${repo}/revisions`, {
      baseRevision: loaded.revision,
      message,
      changes
    }));
  } catch (error) {
    if (!(error instanceof CliError) || error.body.status !== 409)
      throw error;
    const { revision, conflicts } = await update(local, repo, manifest, await fetchRepo(api, repo));
    process.exitCode = 1;
    return writeJson({ repo, saved: false, revision, conflicts, hint: CONFLICT_HINT });
  }
  const savedFiles = { ...loaded.files };
  for (const change of changes) {
    if (change.contents === null)
      delete savedFiles[change.path];
    else
      savedFiles[change.path] = agentMemoryFileHash(change.contents);
  }
  const after = {
    repos: { ...manifest.repos, [repo]: { ...loaded, files: savedFiles } }
  };
  const { revision, conflicts } = await update(local, repo, after, await fetchRepo(api, repo));
  const warnings = Array.isArray(saved.warnings) ? saved.warnings : [];
  writeJson({
    repo,
    saved: true,
    revision,
    changed: changes.map((change) => change.path),
    ...warnings.length > 0 ? { warnings } : {},
    ...conflicts.length > 0 ? { conflicts, hint: CONFLICT_HINT } : {}
  });
}
async function pull(api, args) {
  const { positionals, options } = parseCommandArgs(args, { "--dir": "string" }, "memory pull", [0, 1]);
  const local = localMemory(options["--dir"]);
  const manifest = await local.readManifest();
  const repos = positionals[0] === undefined ? installedRepos(manifest) : [parseRepo(positionals[0])];
  if (repos.length === 0) {
    fail("No memory repo is installed.", "invalid_arguments", "Run 'sixb memory pull user'.");
  }
  let current = manifest;
  for (const repo of repos) {
    const result = await update(local, repo, current, await fetchRepo(api, repo));
    current = result.manifest;
    writeJson({
      repo,
      revision: result.revision,
      updated: result.updated,
      conflicts: result.conflicts,
      ...result.conflicts.length > 0 ? { hint: CONFLICT_HINT } : {}
    });
  }
}
async function update(local, repo, manifest, remote) {
  const base = manifest.repos[repo]?.files ?? {};
  const files = await local.readRepo(repo);
  const updated = [];
  const conflicts = [];
  for (const path of [
    ...new Set([...files.keys(), ...remote.files.keys(), ...Object.keys(base)])
  ].sort()) {
    if (path.endsWith(THEIRS))
      continue;
    const mine = files.get(path);
    const theirs = remote.files.get(path);
    const mineHash = mine === undefined ? undefined : agentMemoryFileHash(mine);
    const theirsHash = theirs === undefined ? undefined : agentMemoryFileHash(theirs);
    if (theirsHash === base[path] || theirsHash === mineHash)
      continue;
    if (mineHash === base[path]) {
      await local.write(repo, path, theirs);
      updated.push(path);
    } else if (theirs === undefined) {
      conflicts.push({ path, theirs: null });
    } else {
      await local.write(repo, `${path}${THEIRS}`, theirs);
      conflicts.push({ path, theirs: `${path}${THEIRS}` });
    }
  }
  if (!remote.files.has(AGENT_MEMORY_ENTRY) && !(await local.readRepo(repo)).has(AGENT_MEMORY_ENTRY)) {
    await local.write(repo, AGENT_MEMORY_ENTRY, AGENT_MEMORY_STARTER);
  }
  const next = {
    repos: {
      ...manifest.repos,
      [repo]: {
        revision: remote.revision,
        files: Object.fromEntries([...remote.files].map(([path, contents]) => [path, agentMemoryFileHash(contents)]))
      }
    }
  };
  await local.writeManifest(next);
  return { manifest: next, revision: remote.revision, updated, conflicts };
}
async function fetchRepo(api, repo) {
  const body = asRecord(await api.get(`/api/agent-memory/${repo}`));
  const files = Array.isArray(body.files) ? body.files.map(asRecord) : null;
  if (typeof body.revision !== "number" || !files?.every((file) => typeof file.path === "string" && typeof file.contents === "string")) {
    throw new CliError({ code: "invalid_api_response", message: "The Sixb API returned an invalid memory repo." }, EXIT_API);
  }
  return {
    revision: body.revision,
    files: new Map(files.map((file) => [String(file.path), String(file.contents)]))
  };
}
function localMemory(explicitDir) {
  const root = explicitDir || process.env.SIXB_MEMORY_DIR;
  const contextDir = explicitDir ? undefined : process.env.SIXB_CONTEXT_DIR;
  if (!root) {
    fail("Specify --dir <path> or set SIXB_MEMORY_DIR.", "invalid_arguments", "Run 'sixb memory get user' to read memory without a local directory.");
  }
  const manifestPath = contextDir ? join(contextDir, ...AGENT_MEMORY_MANIFEST.split("/")) : join(root, LOCAL_MANIFEST_NAME);
  const fileOf = (repo, path) => join(root, repo, ...path.split("/"));
  return {
    async readManifest() {
      let text;
      try {
        text = await readFile2(manifestPath, "utf8");
      } catch (error) {
        if (isFileError(error, "ENOENT"))
          return { repos: {} };
        throw error;
      }
      try {
        return parseManifest(JSON.parse(text));
      } catch {
        fail(`Memory manifest '${manifestPath}' is not valid.`, "invalid_json");
      }
    },
    async writeManifest(manifest) {
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}
`);
    },
    async readRepo(repo) {
      const files = new Map;
      const walk = async (directory, prefix) => {
        let entries;
        try {
          entries = await readdir(directory);
        } catch (error) {
          if (isFileError(error, "ENOENT"))
            return;
          throw error;
        }
        for (const name of entries) {
          const path = prefix ? `${prefix}/${name}` : name;
          const stats = await lstat(join(directory, name));
          if (stats.isDirectory())
            await walk(join(directory, name), path);
          else if (stats.isFile())
            files.set(path, await readFile2(join(directory, name), "utf8"));
          else
            fail(`Memory file '${repo}/${path}' is not a regular file.`);
        }
      };
      await walk(join(root, repo), "");
      return files;
    },
    async write(repo, path, contents) {
      const file = fileOf(repo, path);
      if (contents === undefined) {
        await rm(file, { force: true });
        return;
      }
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
  };
}
function parseSaveArgs(args) {
  const positionals = [];
  let message;
  let dir;
  for (let index = 0;index < args.length; index++) {
    const argument = args[index] ?? "";
    if (argument === "-m" || argument === "--message") {
      if (message !== undefined)
        fail(`${argument} may only be provided once.`);
      message = args[++index];
      if (!message)
        fail(`${argument} requires a value.`);
    } else if (argument === "--dir") {
      if (dir !== undefined)
        fail("--dir may only be provided once.");
      dir = args[++index];
      if (!dir)
        fail("--dir requires a value.");
    } else if (argument.startsWith("--dir=")) {
      if (dir !== undefined)
        fail("--dir may only be provided once.");
      dir = argument.slice("--dir=".length);
      if (!dir)
        fail("--dir requires a value.");
    } else if (argument.startsWith("-")) {
      fail(`Unknown memory save option '${argument}'.`);
    } else {
      positionals.push(argument);
    }
  }
  if (positionals.length !== 1)
    fail("Invalid arguments for 'memory save'.");
  if (message === undefined || message.trim().length === 0) {
    fail("memory save requires -m <what you learned>.");
  }
  return { repo: parseRepo(positionals[0] ?? ""), message, ...dir ? { dir } : {} };
}
function parseRepo(value) {
  if (value === "user" || value === "project")
    return value;
  fail(`Unknown memory repo '${value}'. Use 'user' or 'project'.`);
}
function installedRepos(manifest) {
  return ["user", "project"].filter((repo) => manifest.repos[repo] !== undefined);
}
function parseManifest(value) {
  const repos = asRecord(asRecord(value).repos);
  const parsed = {};
  for (const repo of ["user", "project"]) {
    if (repos[repo] === undefined)
      continue;
    const entry = asRecord(repos[repo]);
    const files = asRecord(entry.files);
    if (typeof entry.revision !== "number" || !Object.values(files).every((digest) => typeof digest === "string")) {
      throw new Error("invalid memory manifest");
    }
    parsed[repo] = {
      revision: entry.revision,
      files
    };
  }
  return { repos: parsed };
}

// src/commands/models.ts
import { access, mkdir as mkdir2, stat as stat2 } from "node:fs/promises";
import { dirname as dirname2, extname, join as join2, parse } from "node:path";
var MODEL_KINDS = ["language", "image", "video", "speech", "transcription"];
async function models(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.models);
  if (sub === "list") {
    const { options } = parseCommandArgs(rest, { "--kind": "string" }, "models list", 0);
    const kind = options["--kind"] === undefined ? undefined : modelKind(options["--kind"]);
    const entries = catalogEntries(await api.get("/api/models"));
    return writeJson(entries.filter((entry) => kind === undefined || entry.kind === kind).map(({ kind, entry }) => ({
      kind,
      model: entry.modelId,
      provider: entry.provider,
      ...entry.tier ? { tier: entry.tier } : {},
      ...entry.isDefault ? { default: true } : {},
      ...entry.description ? { description: entry.description } : {},
      price: describePrice(entry.rateCard)
    })));
  }
  if (sub === "get") {
    const { positionals, options } = parseCommandArgs(rest, { "--kind": "string" }, "models get", 1);
    const kind = options["--kind"] === undefined ? undefined : modelKind(options["--kind"]);
    const entries = catalogEntries(await api.get("/api/models"));
    const { kind: found, entry } = findModel(entries, positionals[0] ?? "", kind);
    const { provider, modelId, isDefault, rateCard, ...details } = entry;
    return writeJson({
      kind: found,
      model: modelId,
      provider,
      default: isDefault,
      ...details,
      price: describePrice(rateCard),
      ...rateCard ? { rateCard } : {}
    });
  }
  if (sub === "text")
    return generateText(api, rest);
  if (sub === "image")
    return generateImages(api, rest);
  if (sub === "video")
    return generateVideos(api, rest);
  if (sub === "speech")
    return generateSpeech(api, rest);
  if (sub === "transcribe")
    return transcribe(api, rest);
  if (sub === "calls")
    return calls(api, rest);
  fail(`Unknown models command '${sub}'.`);
}
var VIDEO_POLL_MS = 5000;
var VIDEO_PROGRESS_MS = 60000;
var SPEECH_FORMATS = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac"
};
var SPEECH_FORMAT_NAMES = Object.keys(SPEECH_FORMATS);
var MEDIA_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".opus": "audio/opus",
  ".m4a": "audio/mp4",
  ".webm": "audio/webm",
  ".mp4": "video/mp4"
};
var EXTENSIONS = Object.fromEntries(Object.entries(MEDIA_TYPES).filter(([extension]) => extension !== ".jpeg").map(([extension, mediaType]) => [mediaType, extension]));
async function generateText(api, args) {
  const { positionals, options } = parseCommandArgs(args, {
    "--model": "string",
    "--instructions": "string",
    "--max-output-tokens": "string",
    "--reasoning": "string",
    "--file": "string"
  }, "models text", [0, 1]);
  const prompt = await readPrompt(positionals[0], options["--file"]);
  const maxOutputTokens = options["--max-output-tokens"];
  const result = await api.post("/api/models/language/generations", {
    ...await languageModelRef(api, options["--model"]),
    prompt,
    ...options["--instructions"] === undefined ? {} : { instructions: options["--instructions"] },
    ...maxOutputTokens === undefined ? {} : { maxOutputTokens: integerInRange("--max-output-tokens", maxOutputTokens, 1, 1e6) },
    ...options["--reasoning"] === undefined ? {} : { reasoning: options["--reasoning"] }
  });
  writeJson({
    callId: result.callId,
    model: result.model.modelId,
    text: result.text,
    finishReason: result.finishReason,
    cost: describeCost(result.cost)
  });
}
async function generateImages(api, args) {
  const { positionals, options } = parseCommandArgs(args, {
    "--output": "string",
    "--model": "string",
    "--n": "string",
    "--size": "string",
    "--aspect-ratio": "string",
    "--quality": "string",
    "--style": "string",
    "--seed": "string",
    "--image": "strings"
  }, "models image", 1);
  const output = requireOutput(options["--output"], "models image");
  const seed = options["--seed"];
  if (seed !== undefined && !/^-?[0-9]+$/.test(seed))
    fail("--seed must be an integer.");
  const model = await modelRef(api, options["--model"], "image");
  const images = [];
  for (const path of options["--image"] ?? [])
    images.push(await uploadInput(api, path, "image"));
  const result = await api.post("/api/models/image/generations", {
    ...model,
    prompt: positionals[0],
    ...options["--n"] === undefined ? {} : { n: integerInRange("--n", options["--n"], 1, 100) },
    ...optional("size", options["--size"]),
    ...optional("aspectRatio", options["--aspect-ratio"]),
    ...optional("quality", options["--quality"]),
    ...optional("style", options["--style"]),
    ...seed === undefined ? {} : { seed: Number(seed) },
    ...images.length > 0 ? { images } : {}
  });
  writeJson(await savedResult(api, result, output));
}
async function generateVideos(api, args) {
  const { positionals, options } = parseCommandArgs(args, {
    "--output": "string",
    "--call": "string",
    "--no-wait": "boolean",
    "--model": "string",
    "--n": "string",
    "--duration": "string",
    "--resolution": "string",
    "--aspect-ratio": "string",
    "--audio": "boolean",
    "--no-audio": "boolean",
    "--seed": "string",
    "--first-frame": "string",
    "--last-frame": "string",
    "--reference": "strings"
  }, "models video", [0, 1]);
  const wait = options["--no-wait"] !== true;
  const output = wait ? requireOutput(options["--output"], "models video") : options["--output"];
  const callId = options["--call"];
  if (callId === undefined === (positionals[0] === undefined)) {
    fail('models video takes a "<prompt>" to start a video, or --call <call-id> to follow one.');
  }
  let generation;
  if (callId !== undefined) {
    generation = await videoGeneration(api, callId);
  } else {
    const seed = options["--seed"];
    if (seed !== undefined && !/^-?[0-9]+$/.test(seed))
      fail("--seed must be an integer.");
    if (options["--audio"] && options["--no-audio"])
      fail("Use --audio or --no-audio, not both.");
    const resolution = options["--resolution"];
    if (resolution !== undefined && !/^[1-9][0-9]*x[1-9][0-9]*$/.test(resolution)) {
      fail("--resolution must be a frame size, such as 1280x720.");
    }
    const model = await modelRef(api, options["--model"], "video");
    const firstFrame = options["--first-frame"];
    const lastFrame = options["--last-frame"];
    const references = [];
    for (const path of options["--reference"] ?? []) {
      references.push(await uploadInput(api, path, "image"));
    }
    generation = await api.post("/api/models/video/generations", {
      ...model,
      prompt: positionals[0],
      ...options["--n"] === undefined ? {} : { n: integerInRange("--n", options["--n"], 1, 8) },
      ...options["--duration"] === undefined ? {} : { duration: integerInRange("--duration", options["--duration"], 1, 600) },
      ...optional("resolution", resolution),
      ...optional("aspectRatio", options["--aspect-ratio"]),
      ...options["--audio"] ? { audio: true } : {},
      ...options["--no-audio"] ? { audio: false } : {},
      ...seed === undefined ? {} : { seed: Number(seed) },
      ...firstFrame === undefined ? {} : { firstFrame: await uploadInput(api, firstFrame, "image") },
      ...lastFrame === undefined ? {} : { lastFrame: await uploadInput(api, lastFrame, "image") },
      ...references.length > 0 ? { referenceImages: references } : {}
    });
  }
  if (wait)
    generation = await waitForVideo(api, generation);
  if (generation.status === "failed") {
    const reason = generation.error ?? "the provider gave no reason";
    throw new CliError({
      code: "generation_failed",
      message: `Video generation ${generation.callId} failed: ${reason}`
    }, EXIT_API);
  }
  if (generation.status === "pending" || output === undefined) {
    return writeJson({
      callId: generation.callId,
      model: generation.model.modelId,
      status: generation.status,
      ...generation.status === "pending" ? {} : { files: generation.files },
      ...generation.warnings?.length ? { warnings: generation.warnings } : {},
      ...generation.status === "pending" ? {} : { cost: describeCost(generation.cost) }
    });
  }
  writeJson(await savedResult(api, generation, output));
}
async function videoGeneration(api, callId) {
  return await api.get(`/api/models/video/generations/${idSegment(callId)}`);
}
async function waitForVideo(api, started) {
  const startedAt = Date.now();
  let said = startedAt;
  let generation = started;
  if (generation.status === "pending") {
    process.stderr.write(`Generating video ${generation.callId}. If this command stops, follow it with: sixb models video --call ${generation.callId} --output <path>
`);
  }
  while (generation.status === "pending") {
    await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_MS));
    generation = await videoGeneration(api, generation.callId);
    if (generation.status === "pending" && Date.now() - said >= VIDEO_PROGRESS_MS) {
      said = Date.now();
      const minutes = Math.round((said - startedAt) / VIDEO_PROGRESS_MS);
      process.stderr.write(`Still generating ${generation.callId}, ${minutes} min so far.
`);
    }
  }
  return generation;
}
async function generateSpeech(api, args) {
  const { positionals, options } = parseCommandArgs(args, {
    "--output": "string",
    "--model": "string",
    "--voice": "string",
    "--format": "string",
    "--instructions": "string",
    "--speed": "string",
    "--language": "string"
  }, "models speech", 1);
  const output = requireOutput(options["--output"], "models speech");
  const format = options["--format"];
  const speed = options["--speed"];
  if (speed !== undefined && !(Number(speed) > 0))
    fail("--speed must be a positive number.");
  const result = await api.post("/api/models/audio/speech", {
    ...await modelRef(api, options["--model"], "speech"),
    text: positionals[0],
    ...optional("voice", options["--voice"]),
    ...format === undefined ? {} : { mediaType: SPEECH_FORMATS[enumValue("--format", format, SPEECH_FORMAT_NAMES)] },
    ...optional("instructions", options["--instructions"]),
    ...speed === undefined ? {} : { speed: Number(speed) },
    ...optional("language", options["--language"])
  });
  writeJson(await savedResult(api, result, output));
}
async function transcribe(api, args) {
  const { positionals, options } = parseCommandArgs(args, { "--model": "string" }, "models transcribe", 1);
  const model = await modelRef(api, options["--model"], "transcription");
  const audio = await uploadInput(api, positionals[0] ?? "", "audio");
  const result = await api.post("/api/models/audio/transcriptions", {
    ...model,
    audio
  });
  const { words, segments, language } = result;
  writeJson({
    callId: result.callId,
    model: result.model.modelId,
    text: result.text,
    ...language === undefined ? {} : { language },
    ...words === undefined ? {} : { words },
    ...segments === undefined ? {} : { segments },
    cost: describeCost(result.cost)
  });
}
async function calls(api, args) {
  const [sub, ...rest] = args;
  if (sub !== "files")
    fail(`Unknown models calls command '${sub ?? ""}'. Use 'models calls files'.`);
  const { positionals, options } = parseCommandArgs(rest, { "--output": "string" }, "models calls files", 1);
  const callId = positionals[0] ?? "";
  const call = await api.get(`/api/ai/model-calls/${idSegment(callId)}/files`);
  const output = options["--output"];
  if (output === undefined)
    return writeJson(call);
  writeJson({ callId: call.callId, files: await saveFiles(api, call.callId, call.files, output) });
}
async function modelRef(api, reference, kind) {
  if (reference === undefined)
    return {};
  const { entry } = findModel(catalogEntries(await api.get("/api/models")), reference, kind);
  return { model: { provider: entry.provider, modelId: entry.modelId } };
}
var LANGUAGE_TIERS = ["light", "standard", "heavy"];
async function languageModelRef(api, reference) {
  const tier = LANGUAGE_TIERS.find((candidate) => candidate === reference);
  if (tier !== undefined)
    return { model: tier };
  return modelRef(api, reference, "language");
}
async function readPrompt(argument, source) {
  if (argument !== undefined && source !== undefined) {
    fail("models text takes its prompt as an argument or from --file, not both.");
  }
  const prompt = source === undefined ? argument : await readText(source, "Prompt file");
  if (prompt === undefined) {
    fail('models text requires a prompt: "<prompt>", or --file <path|-> to read it.');
  }
  if (!prompt.trim())
    fail("The prompt is empty.");
  return prompt;
}
function requireOutput(output, command) {
  if (!output)
    fail(`${command} requires --output <path>: a file, or a directory ending in /.`);
  return output;
}
function optional(field, value) {
  return value === undefined ? {} : { [field]: value };
}
async function uploadInput(api, path, kind) {
  try {
    await access(path);
  } catch {
    fail(`Input file '${path}' does not exist.`);
  }
  const mediaType = MEDIA_TYPES[extname(path).toLowerCase()];
  if (!mediaType?.startsWith(`${kind}/`)) {
    const accepted = Object.entries(MEDIA_TYPES).filter(([, type]) => type.startsWith(`${kind}/`)).map(([extension]) => extension);
    fail(`'${path}' is not an ${kind} file. Use ${accepted.join(", ")}.`);
  }
  return api.upload("/api/files", path, undefined, mediaType);
}
async function savedResult(api, result, output) {
  return {
    callId: result.callId,
    model: result.model.modelId,
    files: await saveFiles(api, result.callId, result.files ?? [], output),
    ...result.warnings?.length ? { warnings: result.warnings } : {},
    cost: describeCost(result.cost)
  };
}
async function saveFiles(api, callId, files, output) {
  const directory = output.endsWith("/") || (await stat2(output).catch(() => null))?.isDirectory();
  const paths = files.map((file, index) => {
    const number = files.length > 1 ? `-${index + 1}` : "";
    const extension = (file.mediaType && EXTENSIONS[file.mediaType]) ?? "";
    if (directory)
      return join2(output, `${callId}${number}${extension || ".bin"}`);
    const { dir, name, ext } = parse(output);
    return join2(dir, `${name}${number}${extension || ext}`);
  });
  for (const [index, path] of paths.entries()) {
    await mkdir2(dirname2(path), { recursive: true });
    await api.download(`/api/ai/model-calls/${idSegment(callId)}/files/content`, path, {
      path: `/files/${index}`
    });
  }
  return paths;
}
function describeCost(cost) {
  if (!cost.money)
    return "unknown";
  const nanos = BigInt(cost.money.amountNanos);
  const whole = nanos / 1000000000n;
  const fraction = (nanos % 1000000000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `$${whole}${fraction ? `.${fraction}` : ""}`;
}
function modelKind(value) {
  const kind = MODEL_KINDS.find((candidate) => candidate === value);
  if (!kind)
    fail(`Unknown model kind '${value}'. Use one of: ${MODEL_KINDS.join(", ")}.`);
  return kind;
}
function catalogEntries(catalog) {
  return [
    ...catalog.language.map((entry) => ({ kind: "language", entry })),
    ...catalog.image.map((entry) => ({ kind: "image", entry })),
    ...(catalog.video ?? []).map((entry) => ({ kind: "video", entry })),
    ...catalog.audio.speech.map((entry) => ({ kind: "speech", entry })),
    ...catalog.audio.transcription.map((entry) => ({ kind: "transcription", entry }))
  ];
}
function findModel(entries, reference, kind) {
  const ofKind = entries.filter((candidate) => kind === undefined || candidate.kind === kind);
  let matches = ofKind.filter((candidate) => candidate.entry.modelId === reference);
  const separator = reference.indexOf(":");
  if (matches.length === 0 && separator > 0) {
    const provider = reference.slice(0, separator);
    const modelId = reference.slice(separator + 1);
    matches = ofKind.filter((candidate) => candidate.entry.provider === provider && candidate.entry.modelId === modelId);
  }
  const [match] = matches;
  if (!match) {
    fail(`No ${kind === undefined ? "" : `${kind} `}model '${reference}' is configured. Run 'sixb models list'.`);
  }
  if (matches.length > 1) {
    const kinds = new Set(matches.map((candidate) => candidate.kind));
    fail(kinds.size > 1 ? `'${reference}' is configured as ${[...kinds].join(" and ")}. Add --kind <kind>.` : `'${reference}' is configured by ${matches.map((candidate) => candidate.entry.provider).join(" and ")}. Use provider:${reference}.`);
  }
  return match;
}
function describePrice(card) {
  if (!card)
    return "price unknown";
  const parts = [
    variantPrice(card.images, "per image", "at"),
    variantPrice(card.characters, "per 1M characters", "for"),
    variantPrice(card.audioInputSeconds, "per second of audio", "for"),
    variantPrice(card.videoOutputSeconds, "per second of video", "at"),
    card.input !== undefined && card.output !== undefined ? `${dollars(tokenPrice(card.input))} input · ${dollars(tokenPrice(card.output))} output per 1M tokens` : undefined,
    card.audioOutput === undefined ? undefined : `${dollars(tokenPrice(card.audioOutput))} per 1M audio tokens`
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? "price unknown" : parts.join(" · ");
}
function variantPrice(price, unit, joiner) {
  if (price === undefined)
    return;
  if (typeof price === "string")
    return `${dollars(price)} ${unit}`;
  const only = price.default;
  if (only !== undefined && price.variants.every((variant) => variant.price === only)) {
    return `${dollars(only)} ${unit}`;
  }
  const variants = price.variants.map(({ price: amount, ...dimensions }) => {
    const label = Object.values(dimensions).join(" ");
    return `${dollars(amount)} ${joiner} ${label}`;
  });
  const otherwise = price.default === undefined ? [] : [`otherwise ${dollars(price.default)}`];
  return `${unit}: ${[...variants, ...otherwise].join(", ")}`;
}
function tokenPrice(price) {
  return typeof price === "string" ? price : price.default;
}
function dollars(amount) {
  return `$${amount}`;
}

// src/graph.ts
async function inspectGraph(api, objectTypeId, primaryId, options) {
  if (options.depth === 0)
    return inspectRoot(api, objectTypeId, primaryId, options);
  let refs = [{ objectTypeId, primaryId, distance: 0 }];
  let frontier = refs;
  const objects = new Map;
  const links = new Map;
  let objectsTruncated = false;
  let linksTruncated = false;
  let pagesTruncated = false;
  let pagesRead = 0;
  let linksExamined = 0;
  for (let level = 0;level < options.depth && frontier.length > 0; level += 1) {
    const levelObjects = new Map;
    const levelLinks = new Map;
    const seenPageTokens = new Set;
    let pageToken;
    let continuePaging = true;
    while (continuePaging) {
      const remainingLinks = options.maxLinks - linksExamined;
      if (remainingLinks <= 0) {
        linksTruncated = true;
        break;
      }
      if (pagesRead >= CLI_LIMITS.inspect.maximumPages) {
        pagesTruncated = true;
        break;
      }
      const response = asLinksResponse(await api.post("/api/objects/query/links", {
        query: {
          kind: "refs",
          refs: frontier.map(({ objectTypeId: type, primaryId: id }) => ({
            objectTypeId: type,
            primaryId: id
          }))
        },
        direction: "both",
        includeObjects: true,
        pageSize: Math.min(CLI_LIMITS.linkPage.default, remainingLinks),
        ...pageToken ? { pageToken } : {}
      }));
      pagesRead += 1;
      const pageLinks = response.links.slice(0, remainingLinks);
      linksExamined += pageLinks.length;
      linksTruncated ||= response.links.length > pageLinks.length;
      const relevantObjects = new Set(frontier.map(refKey));
      for (const link of pageLinks) {
        relevantObjects.add(refKey(link.source));
        relevantObjects.add(refKey(link.target));
      }
      for (const object of response.objects) {
        if (relevantObjects.has(refKey(object)))
          levelObjects.set(refKey(object), object);
      }
      for (const link of pageLinks) {
        const physical = {
          sourceTypeId: link.source.objectTypeId,
          sourceId: link.source.primaryId,
          linkId: link.linkId,
          targetTypeId: link.target.objectTypeId,
          targetId: link.target.primaryId,
          ...Object.hasOwn(link, "properties") ? { properties: link.properties } : {}
        };
        levelLinks.set(linkKey(physical), physical);
      }
      if (!response.hasMore) {
        continuePaging = false;
        continue;
      }
      if (linksExamined >= options.maxLinks) {
        linksTruncated = true;
        break;
      }
      if (pagesRead >= CLI_LIMITS.inspect.maximumPages) {
        pagesTruncated = true;
        break;
      }
      if (!response.nextPageToken) {
        invalidApiResponse("The object-links API reported another page without a nextPageToken.");
      }
      if (seenPageTokens.has(response.nextPageToken)) {
        invalidApiResponse("The object-links API repeated a nextPageToken while inspecting the graph.");
      }
      seenPageTokens.add(response.nextPageToken);
      pageToken = response.nextPageToken;
    }
    for (const [key, object] of levelObjects)
      objects.set(key, object);
    for (const [key, link] of levelLinks)
      links.set(key, link);
    const frontierKeys = new Set(frontier.map(refKey));
    const candidates = [];
    for (const link of levelLinks.values()) {
      const source = { objectTypeId: link.sourceTypeId, primaryId: link.sourceId };
      const target = { objectTypeId: link.targetTypeId, primaryId: link.targetId };
      if (frontierKeys.has(refKey(source)))
        candidates.push({ ...target, distance: level + 1 });
      else if (frontierKeys.has(refKey(target)))
        candidates.push({ ...source, distance: level + 1 });
    }
    const seen = new Set(refs.map(refKey));
    const all = dedupeRefs([...refs, ...candidates]);
    objectsTruncated ||= all.length > options.maxObjects;
    refs = all.slice(0, options.maxObjects);
    frontier = linksTruncated || pagesTruncated ? [] : refs.filter((ref) => !seen.has(refKey(ref)));
  }
  const kept = new Set(refs.map(refKey));
  const filteredLinks = [...links.values()].filter((link) => kept.has(refKey({ objectTypeId: link.sourceTypeId, primaryId: link.sourceId })) && kept.has(refKey({ objectTypeId: link.targetTypeId, primaryId: link.targetId }))).sort(compareLinks).map((link) => link.properties == null ? {
    sourceTypeId: link.sourceTypeId,
    sourceId: link.sourceId,
    linkId: link.linkId,
    targetTypeId: link.targetTypeId,
    targetId: link.targetId
  } : link);
  const root = objects.get(refKey({ objectTypeId, primaryId }));
  if (!root)
    objectNotFound(objectTypeId, primaryId);
  const relatedObjects = refs.filter((ref) => ref.distance > 0).flatMap((ref) => {
    const object = objects.get(refKey(ref));
    return object ? [{ ...object, distance: ref.distance }] : [];
  });
  const objectTypes = options.full ? await Promise.all([...new Set(refs.map((ref) => ref.objectTypeId))].sort((left, right) => left.localeCompare(right)).map((typeId) => api.get(`/api/object-types/${encodeURIComponent(typeId)}`))) : undefined;
  return {
    object: options.full ? root : compactObject(root),
    relatedObjects: options.full ? relatedObjects : relatedObjects.map(compactObject),
    links: filteredLinks,
    graph: {
      depth: options.depth,
      maxObjects: options.maxObjects,
      maxLinks: options.maxLinks,
      maxPages: CLI_LIMITS.inspect.maximumPages,
      objectCount: 1 + relatedObjects.length,
      linkCount: filteredLinks.length,
      pagesRead,
      linksExamined,
      truncated: objectsTruncated || linksTruncated || pagesTruncated,
      truncation: {
        objects: objectsTruncated,
        links: linksTruncated,
        pages: pagesTruncated
      }
    },
    ...objectTypes ? { objectTypes } : {}
  };
}
async function inspectRoot(api, objectTypeId, primaryId, options) {
  const response = await api.post("/api/objects/query", {
    query: { kind: "refs", refs: [{ objectTypeId, primaryId }] },
    includeTotal: false
  });
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    invalidApiResponse("The object query API returned an invalid response.");
  }
  const rows = response.objects;
  if (!Array.isArray(rows))
    invalidApiResponse("The object query API returned an invalid response.");
  const root = rows.find((value) => isMaterializedObject(value) && value.objectTypeId === objectTypeId && value.primaryId === primaryId);
  if (!root)
    objectNotFound(objectTypeId, primaryId);
  const objectTypes = options.full ? [await api.get(`/api/object-types/${encodeURIComponent(objectTypeId)}`)] : undefined;
  return {
    object: options.full ? root : compactObject(root),
    relatedObjects: [],
    links: [],
    graph: {
      depth: 0,
      maxObjects: options.maxObjects,
      maxLinks: options.maxLinks,
      maxPages: CLI_LIMITS.inspect.maximumPages,
      objectCount: 1,
      linkCount: 0,
      pagesRead: 0,
      linksExamined: 0,
      truncated: false,
      truncation: { objects: false, links: false, pages: false }
    },
    ...objectTypes ? { objectTypes } : {}
  };
}
function asLinksResponse(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalidLinksResponse();
  const record = value;
  if (!Array.isArray(record.objects) || !Array.isArray(record.links))
    invalidLinksResponse();
  if (typeof record.hasMore !== "boolean")
    invalidLinksResponse();
  if (record.nextPageToken !== undefined && typeof record.nextPageToken !== "string") {
    invalidLinksResponse();
  }
  if (!record.objects.every(isMaterializedObject) || !record.links.every(isPhysicalLinkResponse)) {
    invalidLinksResponse();
  }
  return record;
}
function invalidLinksResponse() {
  invalidApiResponse("The object-links API returned an invalid response.");
}
function invalidApiResponse(message) {
  throw new CliError({ code: "invalid_api_response", message }, EXIT_API);
}
function objectNotFound(objectTypeId, primaryId) {
  throw new CliError({ code: "not_found", message: `Object '${objectTypeId}/${primaryId}' was not found.` }, EXIT_API);
}
function isMaterializedObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value;
  return typeof record.objectTypeId === "string" && typeof record.primaryId === "string";
}
function isPhysicalLinkResponse(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value;
  return typeof record.linkId === "string" && isObjectRef(record.source) && isObjectRef(record.target);
}
function isObjectRef(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value;
  return typeof record.objectTypeId === "string" && typeof record.primaryId === "string";
}
function compactObject(object) {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...compact } = object;
  return compact;
}
function dedupeRefs(values) {
  const unique = new Map;
  for (const value of values) {
    const key = refKey(value);
    const current = unique.get(key);
    if (!current || value.distance < current.distance)
      unique.set(key, value);
  }
  return [...unique.values()].sort((left, right) => left.distance - right.distance || left.objectTypeId.localeCompare(right.objectTypeId) || left.primaryId.localeCompare(right.primaryId));
}
function refKey(ref) {
  return JSON.stringify([ref.objectTypeId, ref.primaryId]);
}
function linkKey(link) {
  return JSON.stringify([
    link.sourceTypeId,
    link.sourceId,
    link.linkId,
    link.targetTypeId,
    link.targetId
  ]);
}
function compareLinks(left, right) {
  return linkKey(left).localeCompare(linkKey(right));
}

// src/commands/objects.ts
async function objects(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub))
    return writeText(OBJECTS_HELP);
  switch (sub) {
    case "inspect":
      return objectsInspect(api, rest);
    case "list":
      return objectsList(api, rest);
    case "get":
      return objectsGet(api, rest);
    case "get-by":
      return objectsGetBy(api, rest);
    case "search":
      return objectsSearch(api, rest);
    case "query":
      return objectsQuery(api, rest);
    case "count":
    case "exists":
      return objectsScalar(api, sub, rest);
    case "facets":
      return objectsFacets(api, rest);
    case "links":
      return objectsLinks(api, rest);
    default:
      fail(`Unknown objects command '${sub}'.`);
  }
}
async function objectsInspect(api, args) {
  if (requestsHelp(args))
    return writeText(OBJECTS_HELP);
  const { positionals, options } = parseCommandArgs(args, {
    "--full": "boolean",
    "--depth": "string",
    "--max-objects": "string",
    "--max-links": "string"
  }, "objects inspect", 2);
  const objectTypeId = positionals[0] ?? "";
  const primaryId = positionals[1] ?? "";
  const depth = integerInRange("--depth", options["--depth"] ?? String(CLI_LIMITS.inspect.depth.default), 0, CLI_LIMITS.inspect.depth.maximum);
  const maxObjects = integerInRange("--max-objects", options["--max-objects"] ?? String(CLI_LIMITS.inspect.objects.default), 1, CLI_LIMITS.inspect.objects.maximum);
  const maxLinks = integerInRange("--max-links", options["--max-links"] ?? String(CLI_LIMITS.inspect.links.default), 1, CLI_LIMITS.inspect.links.maximum);
  const full = options["--full"] ?? false;
  writeJson(await inspectGraph(api, objectTypeId, primaryId, {
    depth,
    maxObjects,
    maxLinks,
    full
  }));
}
async function objectsList(api, args) {
  if (requestsHelp(args))
    return writeText(OBJECTS_HELP);
  const optionNames = {
    "--type": "objectTypeId",
    "--limit": "limit",
    "--offset": "offset",
    "--order-by": "orderBy",
    "--order": "order",
    "--id-prefix": "idPrefix",
    "--id-suffix": "idSuffix",
    "--created-after": "createdAfter",
    "--created-before": "createdBefore",
    "--updated-after": "updatedAfter",
    "--updated-before": "updatedBefore"
  };
  const options = normalizeWindowOptions(parseQueryOptions(args, optionNames, "objects list"), {
    defaultLimit: CLI_LIMITS.list.default,
    maximumLimit: CLI_LIMITS.list.maximum,
    defaultOrder: DEFAULT_LIST_ORDER,
    offset: true
  });
  options.orderBy = enumValue("--order-by", options.orderBy ?? DEFAULT_OBJECT_ORDER_BY, [
    "createdAt",
    "updatedAt",
    "primaryId"
  ]);
  for (const [name, flag] of [
    ["createdAfter", "--created-after"],
    ["createdBefore", "--created-before"],
    ["updatedAfter", "--updated-after"],
    ["updatedBefore", "--updated-before"]
  ]) {
    if (options[name] !== undefined)
      options[name] = rfc3339Value(flag, options[name]);
  }
  requireOrderedRange("--created-after", options.createdAfter, "--created-before", options.createdBefore);
  requireOrderedRange("--updated-after", options.updatedAfter, "--updated-before", options.updatedBefore);
  writeJson(await api.get("/api/objects", options));
}
async function objectsGet(api, args) {
  if (requestsHelp(args))
    return writeText("Usage: sixb objects get <object-type> <primary-id>...");
  const { positionals } = parseCommandArgs(args, {}, "objects get", [2, Number.POSITIVE_INFINITY]);
  const objectTypeId = positionals[0] ?? "";
  writeJson(await api.post("/api/objects/query", {
    query: {
      kind: "refs",
      refs: positionals.slice(1).map((primaryId) => ({ objectTypeId, primaryId }))
    },
    includeTotal: false
  }));
}
async function objectsGetBy(api, args) {
  if (requestsHelp(args))
    return writeText(GET_BY_HELP);
  const { positionals, options } = parseCommandArgs(args, { "--json": "boolean" }, "objects get-by", 3);
  const [objectTypeId = "", propertyId = "", text = ""] = positionals;
  const value = options["--json"] ? parseJsonValue(text) : text;
  const path = `/api/objects/${encodeURIComponent(objectTypeId)}/by/${encodeURIComponent(propertyId)}`;
  try {
    writeJson(await api.post(path, { value }));
  } catch (error) {
    if (!isObjectNotFound(error))
      throw error;
    writeJson(null);
  }
}
function parseJsonValue(text) {
  try {
    return JSON.parse(text);
  } catch {
    fail(`--json needs the value as JSON, such as 42 or '{"type":"user","id":"usr_1"}'.`);
  }
}
function isObjectNotFound(error) {
  return error instanceof CliError && error.body.status === 404 && error.body.code === "object.not_found";
}
async function objectsSearch(api, args) {
  if (requestsHelp(args))
    return writeText(SEARCH_HELP);
  const { positionals, options } = parseCommandArgs(args, { "--limit": "string", "--type": "string", "--vector-profile": "string" }, "objects search", 1);
  const text = positionals[0] ?? "";
  const limit = integerInRange("--limit", options["--limit"] ?? String(CLI_LIMITS.search.default), 1, CLI_LIMITS.search.maximum);
  const objectTypeId = options["--type"];
  if (!objectTypeId) {
    if (options["--vector-profile"])
      fail("--vector-profile requires --type.");
    return writeJson(await api.get("/api/objects/search", { q: text, limit: String(limit) }));
  }
  if (!text.trim() || text.length > CLI_LIMITS.vectorSearchText.maximum) {
    fail(`Semantic search text must be nonempty and at most ${CLI_LIMITS.vectorSearchText.maximum} characters.`);
  }
  const objectType = asRecord(await api.get(`/api/object-types/${encodeURIComponent(objectTypeId)}`));
  const profile = selectVectorProfile(objectTypeId, objectType, options["--vector-profile"]);
  writeJson(await api.post("/api/objects/query", {
    query: {
      kind: "vector",
      input: { kind: "start", objectTypeId },
      vector: text,
      profile,
      k: limit
    },
    includeTotal: false
  }));
}
function selectVectorProfile(objectTypeId, objectType, requested) {
  const profiles = vectorProfileNames(objectType);
  if (profiles.length === 0) {
    fail(`${objectTypeId} has no vector search profile.`, "invalid_arguments", "Omit --type for identifier and full-text search.");
  }
  if (requested !== undefined) {
    if (!profiles.includes(requested)) {
      fail(`${objectTypeId} has no vector profile '${requested}'. Use ${profiles.join(", ")}.`);
    }
    return requested;
  }
  if (profiles.length > 1) {
    fail(`${objectTypeId} has vector profiles ${profiles.join(", ")}. Pass --vector-profile <name>.`);
  }
  return profiles[0] ?? "";
}
async function objectsQuery(api, args) {
  if (requestsHelp(args))
    return writeText(QUERY_HELP);
  const { options } = parseCommandArgs(args, {
    "--example": "string",
    "--file": "string",
    "--include-total": "boolean",
    "--no-total": "boolean"
  }, "objects query");
  if (options["--include-total"] && options["--no-total"])
    fail("--include-total and --no-total cannot be used together.");
  if (options["--example"]) {
    if (Object.keys(options).length !== 1)
      fail("--example cannot be combined with query options.");
    const name = options["--example"];
    if (name === "list")
      return writeText(Object.keys(QUERY_EXAMPLES).join(" "));
    const example = QUERY_EXAMPLES[name];
    if (!example)
      fail(`Unknown query example '${name}'. Run 'sixb objects query --example list'.`);
    return writeText(example);
  }
  const source = options["--file"];
  const includeTotal = options["--include-total"] ?? false;
  if (!source)
    fail("objects query requires --file <path|->.");
  const input = await readJson(source);
  const record = asRecord(input);
  const body = Object.hasOwn(record, "query") ? { ...record, ...Object.hasOwn(record, "includeTotal") ? {} : { includeTotal } } : { query: input, includeTotal };
  writeJson(await api.post("/api/objects/query", body));
}
async function objectsScalar(api, operation, args) {
  if (requestsHelp(args))
    return writeText(`Usage: sixb objects ${operation} --file <path|->`);
  const source = singleFileOption(args, `objects ${operation}`);
  const input = await readJson(source);
  const record = asRecord(input);
  writeJson(await api.post(`/api/objects/query/${operation}`, {
    query: Object.hasOwn(record, "query") ? record.query : input
  }));
}
async function objectsFacets(api, args) {
  if (requestsHelp(args)) {
    return writeText(`Usage: sixb objects facets --file <path|->
       sixb objects facets --example`);
  }
  const { options } = parseCommandArgs(args, { "--file": "string", "--example": "boolean" }, "objects facets");
  if (options["--example"]) {
    if (options["--file"])
      fail("--example cannot be combined with --file.");
    return writeText(FACETS_EXAMPLE);
  }
  if (!options["--file"])
    fail("objects facets requires --file <path|->.");
  const body = await readJson(options["--file"]);
  const record = asRecord(body);
  if (!Object.hasOwn(record, "query") || !Object.hasOwn(record, "facets")) {
    fail("objects facets input must contain query and facets.");
  }
  writeJson(await api.post("/api/objects/query/facets", body));
}
async function objectsLinks(api, args) {
  if (requestsHelp(args))
    return writeText(OBJECTS_HELP);
  const { positionals, options } = parseCommandArgs(args, {
    "--link": "string",
    "--direction": "string",
    "--page-size": "string",
    "--page-token": "string",
    "--include-objects": "boolean"
  }, "objects links", 2);
  const objectTypeId = positionals[0] ?? "";
  const primaryId = positionals[1] ?? "";
  const linkId = options["--link"];
  const direction = enumValue("--direction", options["--direction"] ?? "both", [
    "outgoing",
    "incoming",
    "both"
  ]);
  const pageSize = integerInRange("--page-size", options["--page-size"] ?? String(CLI_LIMITS.linkPage.default), 1, CLI_LIMITS.linkPage.maximum);
  const pageToken = options["--page-token"];
  const includeObjects = options["--include-objects"] ?? false;
  writeJson(await api.post("/api/objects/query/links", {
    query: { kind: "refs", refs: [{ objectTypeId, primaryId }] },
    direction,
    includeObjects,
    pageSize,
    ...linkId ? { linkId } : {},
    ...pageToken ? { pageToken } : {}
  }));
}

// src/commands/observability.ts
async function logs(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.logs);
  if (sub === "list") {
    const { options } = parseCommandArgs(rest, {
      "--limit": "string",
      "--level": "string",
      "--service": "string",
      "--search": "string",
      "--from": "string",
      "--to": "string"
    }, "logs list");
    const limit = options["--limit"] === undefined ? undefined : String(integerInRange("--limit", options["--limit"], 1, CLI_LIMITS.list.maximum));
    return writeJson(await api.get("/api/logs", {
      ...limit ? { limit } : {},
      ...options["--level"] ? { level: options["--level"] } : {},
      ...options["--service"] ? { service: options["--service"] } : {},
      ...options["--search"] ? { search: options["--search"] } : {},
      ...options["--from"] ? { from: rfc3339Value("--from", options["--from"]) } : {},
      ...options["--to"] ? { to: rfc3339Value("--to", options["--to"]) } : {}
    }));
  }
  fail(`Unknown logs command '${sub}'. Run 'sixb logs --help'.`);
}
async function activity(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.activity);
  if (sub === "summary" || sub === "visits" || sub === "users") {
    const { options } = parseCommandArgs(rest, { "--from": "string", "--to": "string", "--limit": "string" }, `activity ${sub}`);
    const limit = options["--limit"] === undefined ? undefined : String(integerInRange("--limit", options["--limit"], 1, CLI_LIMITS.list.maximum));
    return writeJson(await api.get(`/api/activity/${sub}`, {
      ...options["--from"] ? { from: rfc3339Value("--from", options["--from"]) } : {},
      ...options["--to"] ? { to: rfc3339Value("--to", options["--to"]) } : {},
      ...limit ? { limit } : {}
    }));
  }
  fail(`Unknown activity command '${sub}'. Run 'sixb activity --help'.`);
}
async function connectors(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.connectors);
  if (sub === "accounts") {
    const { positionals } = parseCommandArgs(rest, {}, "connectors accounts", 1);
    return writeJson(await api.get(`/api/connectors/${idSegment(positionals[0]?.trim())}/accounts`));
  }
  fail(`Unknown connectors command '${sub}'. Run 'sixb connectors --help'.`);
}

// src/commands/ontology.ts
async function ontology(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub))
    return writeText(GROUP_HELP.ontology);
  if (sub === "list") {
    if (requestsHelp(rest))
      return writeText("Usage: sixb ontology list [--full]");
    const { options } = parseCommandArgs(rest, { "--full": "boolean" }, "ontology list");
    const full = options["--full"] ?? false;
    const value = await api.get("/api/object-types");
    if (full)
      return writeJson(value);
    if (!Array.isArray(value))
      fail("The ontology API returned an invalid response.");
    return writeJson(value.map((entry) => {
      const type = asRecord(entry);
      const properties = asRecords(type.properties);
      const vectorProfiles = vectorProfileNames(type);
      return {
        id: type.id,
        name: type.name,
        description: type.description,
        primaryPropertyId: properties.find((property) => property.primary === true)?.id,
        ...vectorProfiles.length === 0 ? {} : { vectorProfiles },
        links: asRecords(type.links).map(({ id, name, description, targetObjectTypeId, cardinality }) => ({
          id,
          name,
          ...description === undefined ? {} : { description },
          targetObjectTypeId,
          cardinality
        })),
        actions: asRecords(type.actions).map(({ id, name, description }) => ({
          id,
          name,
          ...description === undefined ? {} : { description }
        }))
      };
    }));
  }
  if (sub === "get") {
    if (requestsHelp(rest))
      return writeText("Usage: sixb ontology get <object-type>");
    const { positionals } = parseCommandArgs(rest, {}, "ontology get", 1);
    return writeJson(await api.get(`/api/object-types/${idSegment(positionals[0])}`));
  }
  fail(`Unknown ontology command '${sub}'.`);
}

// src/commands/project.ts
async function project(api, args) {
  if (!args[0] || isHelp(args[0]) || args[0] === "show" && requestsHelp(args.slice(1))) {
    return writeText(GROUP_HELP.project);
  }
  if (args[0] !== "show")
    fail(`Unknown project command '${args[0]}'.`);
  parseCommandArgs(args.slice(1), {}, "project show");
  writeJson(await api.get("/api/project"));
}

// src/commands/runs.ts
var ACTION_RUN_STATUSES = ["succeeded", "failed"];
var WORKFLOW_RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled"
];
var DATA_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"];
var STATUSES2 = {
  action: ACTION_RUN_STATUSES,
  workflow: WORKFLOW_RUN_STATUSES,
  sync: DATA_RUN_STATUSES,
  pipeline: DATA_RUN_STATUSES
};
var FILTERS = {
  action: { "--action": "actionId", "--type": "objectTypeId", "--id": "primaryId" },
  workflow: { "--workflow": "workflowId" },
  sync: { "--sync": "syncId", "--dataset": "datasetId" },
  pipeline: { "--pipeline": "pipelineId" }
};
async function runs(api, kind, args) {
  const [sub, ...rest] = args;
  const group = `${kind}-runs`;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP[group]);
  if (sub === "cancel" && kind === "workflow") {
    const { positionals } = parseCommandArgs(rest, {}, "workflow-runs cancel", 1);
    return writeJson(await api.post(`/api/workflow-runs/${encodeURIComponent(positionals[0] ?? "")}/cancel`, {}));
  }
  if (sub === "get" && kind !== "sync") {
    const { positionals } = parseCommandArgs(rest, {}, `${group} get`, 1);
    return writeJson(await api.get(`/api/${group}/${encodeURIComponent(positionals[0] ?? "")}`));
  }
  if (sub === "list") {
    const common = {
      "--status": "status",
      "--started-after": "startedAfter",
      "--started-before": "startedBefore",
      "--limit": "limit",
      "--offset": "offset",
      "--order": "order"
    };
    const options = normalizeWindowOptions(parseQueryOptions(rest, { ...common, ...FILTERS[kind] }, `${group} list`), {
      defaultLimit: CLI_LIMITS.list.default,
      maximumLimit: CLI_LIMITS.list.maximum,
      defaultOrder: DEFAULT_LIST_ORDER,
      offset: true
    });
    if (options.status !== undefined) {
      options.status = enumValue("--status", options.status, STATUSES2[kind]);
    }
    for (const [name, flag] of [
      ["startedAfter", "--started-after"],
      ["startedBefore", "--started-before"]
    ]) {
      if (options[name] !== undefined)
        options[name] = rfc3339Value(flag, options[name]);
    }
    requireOrderedRange("--started-after", options.startedAfter, "--started-before", options.startedBefore);
    return writeJson(await api.get(`/api/${group}`, options));
  }
  fail(`Unknown ${group} command '${sub}'.`);
}

// src/format.ts
function wantsJson(explicitJson) {
  if (explicitJson === true)
    return true;
  if (process.env.SIXB_OUTPUT === "json")
    return true;
  return process.stdout.isTTY !== true;
}
function renderOutput(data, options) {
  if (wantsJson(options.json)) {
    writeJson(data);
    return;
  }
  writeText(options.renderText());
}
var useColor = () => process.stdout.isTTY === true && !process.env.NO_COLOR;
var style = {
  bold: (text) => useColor() ? `\x1B[1m${text}\x1B[0m` : text,
  dim: (text) => useColor() ? `\x1B[2m${text}\x1B[0m` : text,
  blue: (text) => useColor() ? `\x1B[34m${text}\x1B[0m` : text,
  green: (text) => useColor() ? `\x1B[32m${text}\x1B[0m` : text,
  red: (text) => useColor() ? `\x1B[31m${text}\x1B[0m` : text
};
function renderTable(options) {
  const lines = [];
  if (options.title || options.subtitle) {
    const heading = [
      options.title ? style.bold(options.title) : "",
      options.subtitle ? style.dim(options.subtitle) : ""
    ].filter(Boolean).join("  ");
    lines.push(heading);
  }
  if (options.rows.length === 0) {
    lines.push(style.dim(options.emptyMessage ?? "No results."));
    return lines.join(`
`);
  }
  const widths = options.headers.map((header, column) => Math.max(header.length, ...options.rows.map((row) => (row[column] ?? "").length)));
  const formatRow = (cells) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");
  lines.push(style.dim(formatRow(options.headers)));
  for (const row of options.rows) {
    lines.push(formatRow(options.headers.map((_, index) => row[index] ?? "")));
  }
  return lines.join(`
`);
}
function renderKeyValues(options) {
  const lines = [];
  if (options.title) {
    const painted = options.titleTone === "green" ? style.green(style.bold(options.title)) : options.titleTone === "red" ? style.red(style.bold(options.title)) : style.bold(options.title);
    lines.push(options.subtitle ? `${painted}  ${style.dim(options.subtitle)}` : painted);
  }
  const width = Math.max(0, ...options.items.map((item) => item.label.length));
  for (const item of options.items) {
    lines.push(`${style.dim(`${item.label.padEnd(width)}:`)} ${item.value}`);
  }
  if (options.note)
    lines.push("", options.note);
  return lines.join(`
`);
}
function formatShortDate(value) {
  if (typeof value !== "string" || !value)
    return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed))
    return value;
  return new Date(parsed).toISOString().slice(0, 10);
}
function formatGroups(value) {
  if (!Array.isArray(value) || value.length === 0)
    return "all";
  return value.map(String).join(", ");
}

// src/commands/tokens.ts
var DURATION_PATTERN = /^(\d+)([smhdwy])$/i;
var DURATION_MS = {
  s: 1000,
  m: 60000,
  h: 3600000,
  d: 86400000,
  w: 7 * 86400000,
  y: 365 * 86400000
};
async function tokens(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.tokens);
  if (sub === "list") {
    const { options } = parseCommandArgs(rest, { "--json": "boolean" }, "tokens list");
    const result = asRecord(await api.get("/api/auth/access-tokens"));
    const items = Array.isArray(result.accessTokens) ? result.accessTokens.map(asRecord) : [];
    return renderOutput(result, {
      json: options["--json"],
      renderText: () => renderTable({
        subtitle: `${items.length} visible`,
        headers: ["Name", "ID", "Status", "Groups", "Last used", "Expires"],
        rows: items.map((token) => [
          String(token.name ?? ""),
          String(token.id ?? ""),
          String(token.status ?? ""),
          formatGroups(token.groupIds),
          formatShortDate(token.lastUsedAt),
          formatShortDate(token.expiresAt)
        ]),
        emptyMessage: "No personal access tokens."
      })
    });
  }
  if (sub === "create") {
    const { positionals, options } = parseCommandArgs(rest, {
      "--name": "string",
      "--expires-at": "string",
      "--expires-in": "string",
      "--group": "strings",
      "--json": "boolean"
    }, "tokens create", [0, 1]);
    const name = options["--name"]?.trim() || positionals[0]?.trim();
    if (!name)
      fail("Usage: sixb tokens create <name> [--expires-in 90d] [--group <id>]");
    assertNotAccessToken(api);
    const expiresAt = resolveExpiration(options["--expires-at"], options["--expires-in"]);
    const groupIds = normalizeGroupIds(options["--group"]);
    const result = asRecord(await api.post("/api/auth/access-tokens", {
      name,
      ...expiresAt ? { expiresAt } : {},
      ...groupIds.length > 0 ? { groupIds } : {}
    }));
    const token = asRecord(result.accessToken);
    const secret = typeof result.tokenValue === "string" ? result.tokenValue : "";
    return renderOutput(result, {
      json: options["--json"],
      renderText: () => renderKeyValues({
        title: "Created personal access token",
        titleTone: "green",
        items: [
          { label: "Name", value: String(token.name ?? "") },
          { label: "ID", value: String(token.id ?? "") },
          { label: "Expires", value: formatShortDate(token.expiresAt) },
          { label: "Groups", value: formatGroups(token.groupIds) },
          { label: "Token", value: secret }
        ],
        note: "Copy this token now; it will not be shown again."
      })
    });
  }
  if (sub === "revoke") {
    const { positionals, options } = parseCommandArgs(rest, { "--id": "string", "--json": "boolean" }, "tokens revoke", [0, 1]);
    const tokenId = options["--id"]?.trim() || positionals[0]?.trim();
    if (!tokenId)
      fail("Usage: sixb tokens revoke <token-id>");
    const result = asRecord(await api.post(`/api/auth/access-tokens/${idSegment(tokenId)}/revoke`, {}));
    const token = asRecord(result.accessToken);
    return renderOutput(result, {
      json: options["--json"],
      renderText: () => renderKeyValues({
        title: "Revoked personal access token",
        items: [
          { label: "Name", value: String(token.name ?? "") },
          { label: "ID", value: String(token.id ?? "") },
          { label: "Status", value: String(token.status ?? "") }
        ]
      })
    });
  }
  fail(`Unknown tokens command '${sub}'. Run 'sixb tokens --help'.`);
}
function assertNotAccessToken(api) {
  const token = api.bearerToken;
  if (token && (token.startsWith("sixb_pat_") || token.startsWith("sixb_sat_"))) {
    throw new CliError({
      code: "session_required",
      message: `Creating a token requires signing in; an access token cannot create another token. Run \`sixb login ${api.baseUrl}\`, then create the token from that profile.`
    }, EXIT_USAGE);
  }
}
function resolveExpiration(expiresAt, expiresIn) {
  if (expiresAt && expiresIn) {
    fail("Use either --expires-at or --expires-in, not both.");
  }
  if (expiresAt) {
    const parsed = Date.parse(expiresAt);
    if (Number.isNaN(parsed))
      fail(`Invalid --expires-at timestamp '${expiresAt}'.`);
    return new Date(parsed).toISOString();
  }
  if (!expiresIn)
    return;
  const match = DURATION_PATTERN.exec(expiresIn.trim());
  if (!match)
    fail(`Invalid --expires-in duration '${expiresIn}'. Use values like 30d, 12h, or 1y.`);
  const amount = Number.parseInt(match[1] ?? "0", 10);
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = DURATION_MS[unit];
  if (!multiplier || amount <= 0)
    fail(`Invalid --expires-in duration '${expiresIn}'.`);
  return new Date(Date.now() + amount * multiplier).toISOString();
}
function normalizeGroupIds(values) {
  if (!values || values.length === 0)
    return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

// src/commands/service-accounts.ts
async function serviceAccounts(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP["service-accounts"]);
  if (sub === "list") {
    const { options } = parseCommandArgs(rest, { "--json": "boolean" }, "service-accounts list");
    const result = asRecord(await api.get("/api/auth/service-accounts"));
    const items = Array.isArray(result.serviceAccounts) ? result.serviceAccounts.map(asRecord) : [];
    return renderOutput(result, {
      json: options["--json"],
      renderText: () => renderTable({
        subtitle: `${items.length} visible`,
        headers: ["Name", "ID", "Status", "Groups", "Updated"],
        rows: items.map((sa) => [
          String(sa.name ?? ""),
          String(sa.id ?? ""),
          String(sa.status ?? ""),
          formatGroups(sa.groupIds),
          formatShortDate(sa.updatedAt)
        ]),
        emptyMessage: "No service accounts."
      })
    });
  }
  if (sub === "create") {
    const { positionals, options } = parseCommandArgs(rest, {
      "--id": "string",
      "--name": "string",
      "--description": "string",
      "--group": "strings",
      "--json": "boolean"
    }, "service-accounts create", [0, 1]);
    const name = options["--name"]?.trim() || positionals[0]?.trim();
    if (!name)
      fail("Usage: sixb service-accounts create <name> [--id <id>] [--group <id>]");
    const groupIds = normalizeGroupIds(options["--group"]);
    const result = asRecord(await api.post("/api/auth/service-accounts", {
      ...options["--id"]?.trim() ? { id: options["--id"].trim() } : {},
      name,
      ...options["--description"]?.trim() ? { description: options["--description"].trim() } : {},
      ...groupIds.length > 0 ? { groupIds } : {}
    }));
    const sa = asRecord(result.serviceAccount);
    return renderOutput(result, {
      json: options["--json"],
      renderText: () => renderKeyValues({
        title: "Created service account",
        titleTone: "green",
        items: [
          { label: "Name", value: String(sa.name ?? "") },
          { label: "ID", value: String(sa.id ?? "") },
          { label: "Status", value: String(sa.status ?? "") },
          { label: "Groups", value: formatGroups(sa.groupIds) }
        ]
      })
    });
  }
  if (sub === "disable") {
    const { positionals, options } = parseCommandArgs(rest, { "--id": "string", "--json": "boolean" }, "service-accounts disable", [0, 1]);
    const id = options["--id"]?.trim() || positionals[0]?.trim();
    if (!id)
      fail("Usage: sixb service-accounts disable <service-account-id>");
    const result = asRecord(await api.post(`/api/auth/service-accounts/${idSegment(id)}/disable`, {}));
    const sa = asRecord(result.serviceAccount);
    return renderOutput(result, {
      json: options["--json"],
      renderText: () => renderKeyValues({
        title: "Disabled service account",
        items: [
          { label: "Name", value: String(sa.name ?? "") },
          { label: "ID", value: String(sa.id ?? "") },
          { label: "Status", value: String(sa.status ?? "") }
        ]
      })
    });
  }
  if (sub === "tokens" || sub === "token") {
    return serviceAccountTokens(api, rest);
  }
  fail(`Unknown service-accounts command '${sub}'. Run 'sixb service-accounts --help'.`);
}
async function serviceAccountTokens(api, args) {
  const [action, ...rest] = args;
  if (!action || isHelp(action) || requestsHelp(rest)) {
    return writeText(GROUP_HELP["service-accounts"]);
  }
  if (action === "list") {
    const { positionals, options } = parseCommandArgs(rest, { "--json": "boolean" }, "service-accounts tokens list", 1);
    const saId = positionals[0]?.trim() ?? "";
    const result = asRecord(await api.get(`/api/auth/service-accounts/${idSegment(saId)}/access-tokens`));
    const items = Array.isArray(result.accessTokens) ? result.accessTokens.map(asRecord) : [];
    return renderOutput(result, {
      json: options["--json"],
      renderText: () => renderTable({
        subtitle: saId,
        headers: ["Name", "ID", "Status", "Groups", "Last used", "Expires"],
        rows: items.map((token) => [
          String(token.name ?? ""),
          String(token.id ?? ""),
          String(token.status ?? ""),
          formatGroups(token.groupIds),
          formatShortDate(token.lastUsedAt),
          formatShortDate(token.expiresAt)
        ]),
        emptyMessage: "No service-account tokens."
      })
    });
  }
  if (action === "create") {
    const { positionals, options } = parseCommandArgs(rest, {
      "--name": "string",
      "--expires-at": "string",
      "--expires-in": "string",
      "--group": "strings",
      "--json": "boolean"
    }, "service-accounts tokens create", [1, 2]);
    const saId = positionals[0]?.trim() ?? "";
    const name = options["--name"]?.trim() || positionals[1]?.trim();
    if (!name) {
      fail("Usage: sixb service-accounts tokens create <service-account-id> <name> [options]");
    }
    assertNotAccessToken(api);
    const expiresAt = resolveExpiration(options["--expires-at"], options["--expires-in"]);
    const groupIds = normalizeGroupIds(options["--group"]);
    const result = asRecord(await api.post(`/api/auth/service-accounts/${idSegment(saId)}/access-tokens`, {
      name,
      ...expiresAt ? { expiresAt } : {},
      ...groupIds.length > 0 ? { groupIds } : {}
    }));
    const token = asRecord(result.accessToken);
    const secret = typeof result.tokenValue === "string" ? result.tokenValue : "";
    return renderOutput(result, {
      json: options["--json"],
      renderText: () => renderKeyValues({
        title: "Created service-account token",
        titleTone: "green",
        subtitle: saId,
        items: [
          { label: "Name", value: String(token.name ?? "") },
          { label: "ID", value: String(token.id ?? "") },
          { label: "Expires", value: formatShortDate(token.expiresAt) },
          { label: "Groups", value: formatGroups(token.groupIds) },
          { label: "Token", value: secret }
        ],
        note: "Copy this token now; it will not be shown again."
      })
    });
  }
  if (action === "revoke") {
    const { positionals, options } = parseCommandArgs(rest, { "--id": "string", "--json": "boolean" }, "service-accounts tokens revoke", [1, 2]);
    const saId = positionals[0]?.trim() ?? "";
    const tokenId = options["--id"]?.trim() || positionals[1]?.trim();
    if (!tokenId) {
      fail("Usage: sixb service-accounts tokens revoke <service-account-id> <token-id>");
    }
    const result = asRecord(await api.post(`/api/auth/service-accounts/${idSegment(saId)}/access-tokens/${idSegment(tokenId)}/revoke`, {}));
    const token = asRecord(result.accessToken);
    return renderOutput(result, {
      json: options["--json"],
      renderText: () => renderKeyValues({
        title: "Revoked service-account token",
        subtitle: saId,
        items: [
          { label: "Name", value: String(token.name ?? "") },
          { label: "ID", value: String(token.id ?? "") },
          { label: "Status", value: String(token.status ?? "") }
        ]
      })
    });
  }
  fail(`Unknown service-accounts tokens command '${action}'. Run 'sixb service-accounts --help'.`);
}

// src/commands/shares.ts
async function shares(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.shares);
  if (sub === "list") {
    const { options } = parseCommandArgs(rest, { "--definition": "string", "--primary-id": "string", "--json": "boolean" }, "shares list");
    const result = asRecord(await api.get("/api/share-grants", {
      ...options["--definition"] ? { definitionId: options["--definition"] } : {},
      ...options["--primary-id"] ? { primaryId: options["--primary-id"] } : {}
    }));
    const grants = Array.isArray(result.grants) ? result.grants.map(asRecord) : [];
    return renderOutput(result, {
      json: options["--json"],
      renderText: () => renderTable({
        subtitle: `${grants.length} visible`,
        headers: ["ID", "Definition", "Destination", "Status", "Expires"],
        rows: grants.map((grant) => [
          String(grant.id ?? ""),
          String(grant.definitionId ?? ""),
          String(grant.destinationPath ?? ""),
          String(grant.status ?? ""),
          formatShortDate(grant.expiresAt)
        ]),
        emptyMessage: "No shared-access grants."
      })
    });
  }
  if (sub === "create") {
    const { options } = parseCommandArgs(rest, { "--file": "string", "--json": "boolean" }, "shares create");
    if (!options["--file"]) {
      fail("shares create requires --file <path|-> with the share grant payload.");
    }
    const payload = await readJson(options["--file"]);
    const result = asRecord(await api.post("/api/share-grants", payload));
    const grant = asRecord(result.grant);
    return renderOutput(result, {
      json: options["--json"],
      renderText: () => renderKeyValues({
        title: "Created shared-access grant",
        titleTone: "green",
        items: [
          { label: "ID", value: String(grant.id ?? "") },
          { label: "Definition", value: String(grant.definitionId ?? "") },
          { label: "Expires", value: formatShortDate(grant.expiresAt) },
          { label: "URL", value: String(result.url ?? "") }
        ]
      })
    });
  }
  if (sub === "revoke") {
    const { positionals, options } = parseCommandArgs(rest, { "--json": "boolean" }, "shares revoke", 1);
    const grantId = positionals[0]?.trim() ?? "";
    const result = asRecord(await api.delete(`/api/share-grants/${idSegment(grantId)}`));
    return renderOutput(result, {
      json: options["--json"],
      renderText: () => renderKeyValues({
        title: "Revoked shared-access grant",
        items: [{ label: "ID", value: grantId }]
      })
    });
  }
  fail(`Unknown shares command '${sub}'. Run 'sixb shares --help'.`);
}

// src/commands/status.ts
async function fetchStatus(api, context = {}) {
  const project = asRecord(await api.get("/api/project"));
  if (typeof project.id !== "string" || project.id.length === 0) {
    throw new CliError({ code: "invalid_api_response", message: "The Sixb API returned an invalid project." }, EXIT_API);
  }
  return {
    ok: true,
    connected: true,
    apiUrl: context.apiUrl ?? api.baseUrl,
    cli: { version: INSTANCE_CLI_VERSION },
    runtime: javascriptRuntime(),
    project: {
      id: project.id,
      ...typeof project.locale === "string" ? { locale: project.locale } : {},
      ...typeof project.timeZone === "string" ? { timeZone: project.timeZone } : {}
    },
    ...context.authenticated === undefined ? {} : { authenticated: context.authenticated },
    ...context.profile === undefined ? {} : { profile: context.profile },
    ...context.source === undefined ? {} : { source: context.source }
  };
}
async function status(api, args, context = {}) {
  if (isHelp(args[0]))
    return writeText(GROUP_HELP.status);
  if (args.some((arg) => arg !== "--json"))
    fail("status accepts no arguments but --json.");
  const report = await fetchStatus(api, context);
  renderOutput(report, {
    json: args.includes("--json"),
    renderText: () => renderKeyValues({
      title: "Connected",
      titleTone: "green",
      items: [
        ...report.profile ? [{ label: "Profile", value: report.profile }] : [],
        { label: "Project", value: report.project.id },
        { label: "API", value: report.apiUrl },
        ...report.authenticated === undefined ? [] : [
          {
            label: "Authentication",
            value: report.authenticated ? "token" : "not required"
          }
        ],
        { label: "Runtime", value: `${report.runtime.name} ${report.runtime.version}` }
      ]
    })
  });
}
function javascriptRuntime() {
  if (typeof globalThis.Bun === "object") {
    return { name: "bun", version: globalThis.Bun.version };
  }
  return { name: "node", version: process.versions.node };
}

// src/commands/telemetry.ts
async function telemetry(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.telemetry);
  if (sub === "latest") {
    const { positionals } = parseCommandArgs(rest, {}, "telemetry latest", 3);
    return writeJson(await api.get(telemetryPath(positionals, "latest")));
  }
  if (sub === "history") {
    const { positionals, options } = parseCommandArgs(rest, {
      "--from": "string",
      "--to": "string",
      "--limit": "string",
      "--order": "string"
    }, "telemetry history", 3);
    const query = normalizeWindowOptions({
      from: options["--from"],
      to: options["--to"],
      limit: options["--limit"],
      order: options["--order"]
    }, {
      defaultLimit: CLI_LIMITS.telemetryHistory.default,
      maximumLimit: CLI_LIMITS.telemetryHistory.maximum,
      defaultOrder: DEFAULT_TELEMETRY_ORDER
    });
    if (query.from !== undefined)
      query.from = rfc3339Value("--from", query.from);
    if (query.to !== undefined)
      query.to = rfc3339Value("--to", query.to);
    requireOrderedRange("--from", query.from, "--to", query.to);
    return writeJson(await api.get(telemetryPath(positionals, "history"), query));
  }
  if (sub === "query") {
    return writeJson(await api.post("/api/telemetry/history", normalizeTelemetryQueryInput(await readJson(singleFileOption(rest, "telemetry query")))));
  }
  fail(`Unknown telemetry command '${sub}'.`);
}
function telemetryPath(args, terminal) {
  return `/api/objects/${idSegment(args[0])}/${idSegment(args[1])}/telemetry/${idSegment(args[2])}/${terminal}`;
}
function normalizeTelemetryQueryInput(input) {
  if (Array.isArray(input) || typeof input !== "object" || input === null) {
    fail("Telemetry query input must be a JSON object.");
  }
  const body = { ...input };
  const rawLimit = body.limitPerSeries;
  if (rawLimit !== undefined && typeof rawLimit !== "number") {
    fail("limitPerSeries must be a number.");
  }
  body.limitPerSeries = integerInRange("limitPerSeries", String(rawLimit ?? CLI_LIMITS.telemetryHistory.default), 1, CLI_LIMITS.telemetryHistory.maximum);
  const rawOrder = body.order;
  if (rawOrder !== undefined && typeof rawOrder !== "string") {
    fail("order must be a string.");
  }
  body.order = enumValue("order", rawOrder ?? DEFAULT_TELEMETRY_ORDER, ["asc", "desc"]);
  for (const field of ["from", "to"]) {
    const value = body[field];
    if (value === undefined)
      continue;
    if (typeof value !== "string")
      fail(`${field} must be an RFC 3339 timestamp.`);
    body[field] = rfc3339Value(field, value);
  }
  requireOrderedRange("from", body.from, "to", body.to);
  return body;
}

// src/commands/threads.ts
var PAGE_TEXT_CHARS = 4000;
var PAGE_TOOL_CHARS = 1000;
async function threads(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.threads);
  if (sub === "list") {
    const { options } = parseCommandArgs(rest, { "--limit": "string", "--offset": "string" }, "threads list");
    const limit = integerInRange("--limit", options["--limit"] ?? String(CLI_LIMITS.list.default), 1, CLI_LIMITS.list.maximum);
    const offset = options["--offset"] === undefined ? undefined : nonNegativeInteger("--offset", options["--offset"]);
    return writeJson(await api.get("/api/agent-threads", {
      limit: String(limit),
      ...offset === undefined ? {} : { offset: String(offset) }
    }));
  }
  if (sub === "get") {
    const { positionals } = parseCommandArgs(rest, {}, "threads get", [0, 1]);
    const threadId = resolveThreadId(positionals[0]);
    return writeJson(await api.get(`/api/agent-threads/${idSegment(threadId)}`));
  }
  if (sub === "runs") {
    const { positionals } = parseCommandArgs(rest, {}, "threads runs", [0, 1]);
    const threadId = resolveThreadId(positionals[0]);
    return writeJson(await api.get(`/api/agent-threads/${idSegment(threadId)}/runs`));
  }
  if (sub === "approvals") {
    const { positionals } = parseCommandArgs(rest, {}, "threads approvals", [0, 1]);
    const threadId = resolveThreadId(positionals[0]);
    return writeJson(await api.get(`/api/agent-threads/${idSegment(threadId)}/approvals`));
  }
  if (sub === "messages") {
    return threadMessages(api, rest);
  }
  fail(`Unknown threads command '${sub}'. Run 'sixb threads --help'.`);
}
async function threadMessages(api, args) {
  const { positionals, options } = parseCommandArgs(args, { "--offset": "string", "--limit": "string", "--seq": "string", "--json": "boolean" }, "threads messages", [0, 1]);
  const threadId = resolveThreadId(positionals[0]);
  const explicitThread = positionals[0] !== undefined;
  const path = `/api/agent-threads/${idSegment(threadId)}/messages`;
  const asJson = options["--json"] === true;
  const seqRaw = options["--seq"];
  if (seqRaw !== undefined) {
    const wanted = integerInRange("--seq", seqRaw, 1, Number.MAX_SAFE_INTEGER);
    const page = messagePage(await api.get(path, { order: "asc", offset: String(wanted - 1), limit: "1" }));
    const message = page.messages[0];
    if (message?.seq !== wanted) {
      throw new CliError({ code: "not_found", message: `The conversation has no message #${wanted}.` }, EXIT_API);
    }
    if (asJson)
      return writeJson(message);
    return writeText(renderMessage(message, page, threadId, { whole: true }));
  }
  const offset = nonNegativeInteger("--offset", options["--offset"] ?? "0");
  const limit = integerInRange("--limit", options["--limit"] ?? String(CLI_LIMITS.history.default), 1, CLI_LIMITS.history.maximum);
  const page = messagePage(await api.get(path, { order: "asc", offset: String(offset), limit: String(limit) }));
  if (asJson)
    return writeJson(page);
  const cmdPrefix = explicitThread ? `sixb threads messages ${threadId}` : "sixb threads messages";
  const shown = page.messages.map((message) => renderMessage(message, page, threadId, { whole: false, cmdPrefix }));
  const end = offset + page.messages.length;
  const footer = page.messages.length === 0 ? `No messages from offset ${offset}: the conversation has ${page.total}.` : page.hasMore ? `Messages ${offset + 1}–${end} of ${page.total}. Next: ${cmdPrefix} --offset ${end}` : `Messages ${offset + 1}–${end} of ${page.total}: the end of the conversation.`;
  writeText([...shown, footer].join(`

`));
}
function resolveThreadId(explicit) {
  const threadId = explicit?.trim() || process.env.SIXB_THREAD_ID?.trim();
  if (!threadId) {
    fail("Specify a thread id, or set SIXB_THREAD_ID.");
  }
  return threadId;
}
function renderMessage(message, page, threadId, options) {
  const author = message.authorPrincipal ? page.authors.find((person) => person.id === message.authorPrincipal?.id)?.displayName : undefined;
  const heading = [`#${message.seq} ${message.role}`, author, message.createdAt].filter(Boolean).join(" · ");
  const bounds = {
    seq: message.seq,
    cmdPrefix: options.cmdPrefix ?? "sixb threads messages",
    textChars: options.whole ? Number.POSITIVE_INFINITY : PAGE_TEXT_CHARS,
    toolChars: options.whole ? Number.POSITIVE_INFINITY : PAGE_TOOL_CHARS
  };
  return [
    `── ${heading}`,
    ...message.parts.flatMap((part, index) => [
      ...renderPart(part, bounds),
      ...renderOutputFile(part, message, threadId, index)
    ])
  ].join(`
`);
}
function renderOutputFile(part, message, threadId, index) {
  const file = part.type === "tool-call" ? record(part.outputFile) : undefined;
  const fileRef = record(file?.fileRef);
  if (typeof file?.path !== "string" || typeof fileRef?.sizeBytes !== "number")
    return [];
  const contextDir = process.env.SIXB_CONTEXT_DIR;
  const path = contextDir ? `${contextDir.replace(/\/$/, "")}/${file.path}` : file.path;
  const apiBaseUrl = process.env.SIXB_API_URL || process.env.SIXB_API_BASE_URL;
  const download = apiBaseUrl && message.id ? `; else: sixb files download url ${apiBaseUrl.replace(/\/$/, "")}/api/agent-threads/${idSegment(threadId)}/messages/${idSegment(message.id)}/files/content?path=${encodeURIComponent(`/parts/${index}/outputFile/fileRef`)} --output <file>` : "";
  return [
    `  [whole output, ${fileRef.sizeBytes.toLocaleString("en-US")} bytes: ${path}, written back to the sandbox at each run while the conversation shows this call${download}]`
  ];
}
function renderPart(part, bounds) {
  const cut = (value, max) => value.length <= max ? value : `${value.slice(0, max)}… [${(value.length - max).toLocaleString("en-US")} more characters: ${bounds.cmdPrefix} --seq ${bounds.seq}]`;
  switch (part.type) {
    case "text":
      return typeof part.text === "string" && part.text.trim() ? [cut(part.text, bounds.textChars)] : [];
    case "file": {
      const file = record(part.fileRef);
      const name = file?.fileName ?? file?.logicalPath ?? file?.blobId;
      return [`[file ${String(name)}${file?.mediaType ? `, ${String(file.mediaType)}` : ""}]`];
    }
    case "tool-call": {
      const input = cut(JSON.stringify(part.input ?? {}), bounds.toolChars);
      const outcome = part.state === "output-error" ? `error: ${cut(String(part.errorText ?? ""), bounds.toolChars)}` : part.state === "output-available" ? cut(typeof part.output === "string" ? part.output : JSON.stringify(part.output), bounds.toolChars) : String(part.state ?? "");
      return [`[${String(part.toolName)}] ${input}`, `→ ${outcome}`];
    }
    case "continuation":
      return ["[asked to continue]"];
    case "approval-outcome":
      return [`[approval ${String(part.status)}]`];
    default:
      return [];
  }
}
function messagePage(value) {
  const page = record(value);
  if (!page || !Array.isArray(page.messages) || typeof page.total !== "number") {
    throw new CliError({ code: "invalid_api_response", message: "The Sixb API returned an invalid message page." }, EXIT_API);
  }
  return {
    messages: page.messages,
    authors: Array.isArray(page.authors) ? page.authors : [],
    hasMore: page.hasMore === true,
    total: page.total
  };
}
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

// src/commands/users.ts
var USER_STATUSES = ["active", "suspended", "all"];
var LIST_FLAGS = {
  "--status": "string",
  "--limit": "string",
  "--offset": "string"
};
async function users(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.users);
  if (sub === "get") {
    const { positionals } = parseCommandArgs(rest, {}, "users get", 1);
    const user = positionals[0]?.trim();
    if (!user)
      fail("users get requires a user id or email.");
    if (!user.includes("@")) {
      return writeJson(await api.get(`/api/users/${idSegment(user)}`));
    }
    const page = await api.get("/api/users", { email: user });
    const [member] = isRecord(page) && Array.isArray(page.users) ? page.users : [];
    if (member === undefined) {
      throw new CliError({ code: "not_found", message: `No member has the email '${user}'.` }, EXIT_API);
    }
    return writeJson(member);
  }
  if (sub === "list") {
    const { options } = parseCommandArgs(rest, LIST_FLAGS, "users list");
    return writeJson(await api.get("/api/users", listQuery(options)));
  }
  if (sub === "search") {
    const { positionals, options } = parseCommandArgs(rest, LIST_FLAGS, "users search", 1);
    const search = positionals[0]?.trim();
    if (!search)
      fail("users search requires the text to find in a name or email.");
    return writeJson(await api.get("/api/users", { ...listQuery(options), search }));
  }
  fail(`Unknown users command '${sub}'.`);
}
function listQuery(options) {
  const limit = integerInRange("--limit", options["--limit"] ?? String(CLI_LIMITS.users.default), 1, CLI_LIMITS.users.maximum);
  return {
    status: enumValue("--status", options["--status"] ?? "active", USER_STATUSES),
    limit: String(limit),
    ...options["--offset"] === undefined ? {} : { offset: String(nonNegativeInteger("--offset", options["--offset"])) }
  };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/commands/workflows.ts
import { randomUUID as randomUUID2 } from "node:crypto";
async function workflows(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.workflows);
  if (sub === "list") {
    parseCommandArgs(rest, {}, "workflows list");
    return writeJson(await api.get("/api/workflows"));
  }
  if (sub === "get") {
    const {
      positionals: [workflowId]
    } = parseCommandArgs(rest, {}, "workflows get", 1);
    return writeJson(await api.get(`/api/workflows/${idSegment(workflowId)}`));
  }
  if (sub === "start") {
    const {
      positionals: [workflowId],
      options
    } = parseCommandArgs(rest, { "--file": "string", "--run-id": "string" }, "workflows start", 1);
    const input = options["--file"] ? await readJson(options["--file"]) : {};
    if (Array.isArray(input) || typeof input !== "object" || input === null) {
      fail("Workflow input must be a JSON object.");
    }
    const runId = options["--run-id"] ?? `run_${randomUUID2()}`;
    return writeRequestResult(await api.post(`/api/workflows/${idSegment(workflowId)}/runs`, {
      input,
      runId
    }));
  }
  fail(`Unknown workflows command '${sub}'.`);
}

// src/commands/index.ts
var COMMAND_REGISTRY = [
  {
    name: "status",
    category: "Discovery",
    summary: "Check API connection, project, and runtime",
    run: status
  },
  { name: "project", category: "Discovery", summary: "Show project metadata", run: project },
  {
    name: "ontology",
    category: "Discovery",
    summary: "Inspect the visible ontology",
    run: ontology
  },
  {
    name: "objects",
    category: "Objects",
    summary: "Inspect, list, search, and query objects",
    run: objects
  },
  {
    name: "telemetry",
    category: "Telemetry",
    summary: "Read current and historical telemetry",
    run: telemetry
  },
  {
    name: "actions",
    category: "Actions and workflows",
    summary: "Discover and request actions",
    run: actions
  },
  {
    name: "action-runs",
    category: "Actions and workflows",
    summary: "Inspect action execution history",
    run: (api, args) => runs(api, "action", args)
  },
  {
    name: "workflows",
    category: "Actions and workflows",
    summary: "Discover and start workflows",
    run: workflows
  },
  {
    name: "workflow-runs",
    category: "Actions and workflows",
    summary: "Inspect and cancel workflow runs",
    run: (api, args) => runs(api, "workflow", args)
  },
  {
    name: "datasets",
    category: "Data",
    summary: "Read datasets, versions, and rows",
    run: datasets
  },
  {
    name: "syncs",
    category: "Data",
    summary: "List, inspect, and run syncs",
    run: (api, args) => runnables(api, "syncs", args)
  },
  {
    name: "sync-runs",
    category: "Data",
    summary: "Inspect sync run history",
    run: (api, args) => runs(api, "sync", args)
  },
  {
    name: "pipelines",
    category: "Data",
    summary: "List, inspect, and run pipelines",
    run: (api, args) => runnables(api, "pipelines", args)
  },
  {
    name: "pipeline-runs",
    category: "Data",
    summary: "Inspect pipeline runs and their steps",
    run: (api, args) => runs(api, "pipeline", args)
  },
  { name: "files", category: "Files", summary: "Upload and download files", run: files },
  {
    name: "users",
    category: "Members and access",
    summary: "List and search project members",
    run: users
  },
  {
    name: "tokens",
    category: "Members and access",
    summary: "Manage personal access tokens",
    run: tokens
  },
  {
    name: "service-accounts",
    category: "Members and access",
    summary: "Manage service accounts and their tokens",
    run: serviceAccounts
  },
  {
    name: "shares",
    category: "Members and access",
    summary: "List, create, and revoke shared-access grants",
    run: shares
  },
  {
    name: "threads",
    category: "Threads and memory",
    summary: "List threads, messages, runs, and approvals",
    run: threads
  },
  {
    name: "memory",
    category: "Threads and memory",
    summary: "Read, pull, and save memory repos",
    run: memory
  },
  {
    name: "artifacts",
    category: "Artifacts and models",
    summary: "Manage artifacts, comments, media, and video exports",
    run: artifacts
  },
  {
    name: "models",
    category: "Artifacts and models",
    summary: "List and call the project's AI models",
    run: models
  },
  { name: "logs", category: "Observability", summary: "Read project logs", run: logs },
  { name: "activity", category: "Observability", summary: "Read activity metrics", run: activity },
  {
    name: "connectors",
    category: "Observability",
    summary: "Inspect connector accounts",
    run: connectors
  },
  {
    name: "api",
    category: "Raw API",
    summary: "Send an authenticated request to any relative /api/ path",
    run: apiCommand
  }
];
var COMMAND_BY_NAME = new Map(COMMAND_REGISTRY.map((entry) => [entry.name, entry]));
function isInstanceCommand(command) {
  return COMMAND_BY_NAME.has(command);
}
async function dispatch(api, command, args) {
  const entry = COMMAND_BY_NAME.get(command);
  if (!entry)
    fail(`Unknown command '${command}'. Run 'sixb --help'.`);
  return entry.run(api, args);
}

// src/commands/auth.ts
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";

// src/profiles.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { chmod, mkdir as mkdir3, readFile as readFile3, rename, rm as rm2, writeFile as writeFile2 } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname as dirname3, isAbsolute, join as join3 } from "node:path";

// src/session.ts
class SixbSessionEndedError extends Error {
  name = "SixbSessionEndedError";
}
var REFRESH_MARGIN_MS = 60000;
var refreshing = new WeakMap;
function normalizeApiUrl(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("unix:")) {
    const socketPath = trimmed.slice("unix:".length);
    if (!socketPath) {
      throw new Error(`[SixbCLI] Invalid API URL '${value}'. Use a full http(s) URL or unix:<path>.`);
    }
    return trimmed;
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`[SixbCLI] Invalid API URL '${value}'. Use a full http(s) URL.`);
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`[SixbCLI] Invalid API URL '${value}'. Use a full http(s) URL.`);
  }
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return `${url.origin}${pathname}`;
}
async function startDeviceLogin(options) {
  const baseUrl = normalizeApiUrl(options.baseUrl);
  const response = await postJson(baseUrl, "/api/auth/device-authorizations", {
    clientName: options.clientName
  });
  if (!response.ok)
    throw await responseError(response, "start device login");
  const body = asRecord2(await response.json());
  const deviceCode = nonblank(body.deviceCode);
  const userCode = nonblank(body.userCode);
  const verificationUri = nonblank(body.verificationUri);
  const verificationUriComplete = nonblank(body.verificationUriComplete);
  const expiresAt = nonblank(body.expiresAt);
  const interval = body.interval;
  if (!deviceCode || !userCode || !verificationUri || !verificationUriComplete || !expiresAt || !Number.isFinite(Date.parse(expiresAt)) || typeof interval !== "number" || !Number.isFinite(interval)) {
    throw new Error("[SixbCLI] The Sixb API returned an invalid device login response.");
  }
  if (new URL(verificationUriComplete).origin !== new URL(baseUrl).origin) {
    throw new Error("[SixbCLI] The device login page is not on the Sixb API origin.");
  }
  const intervalMs = Math.max(1, Math.min(10, interval)) * 1000;
  return {
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresAt,
    async complete({ signal } = {}) {
      while (Date.now() < Date.parse(expiresAt)) {
        signal?.throwIfAborted();
        const poll = await postJson(baseUrl, "/api/auth/device-authorizations/token", { deviceCode }, signal);
        if (!poll.ok)
          throw await responseError(poll, "complete device login");
        const result = asRecord2(await poll.json());
        if (result.status === "approved")
          return parseSessionTokens(result);
        if (result.status === "denied")
          throw new Error("[SixbCLI] Device login was denied.");
        if (result.status === "expired")
          break;
        if (result.status !== "pending") {
          throw new Error("[SixbCLI] The Sixb API returned an unknown device login status.");
        }
        await sleep(intervalMs, signal);
      }
      throw new Error("[SixbCLI] Device login expired. Start it again.");
    }
  };
}
async function getSessionAccessToken(options) {
  const tokens = await options.store.load();
  if (!tokens)
    return null;
  const remainingMs = Date.parse(tokens.accessExpiresAt) - Date.now();
  if (remainingMs > REFRESH_MARGIN_MS)
    return tokens.accessToken;
  try {
    return (await renewSession(options, tokens)).accessToken;
  } catch (error) {
    if (!(error instanceof SixbSessionEndedError) && remainingMs > 0)
      return tokens.accessToken;
    throw error;
  }
}
async function signOutSession(options) {
  let accessToken = null;
  try {
    accessToken = await getSessionAccessToken(options);
  } catch (error) {
    if (error instanceof SixbSessionEndedError)
      return;
  }
  const baseUrl = normalizeApiUrl(options.baseUrl);
  if (accessToken) {
    await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` }
    }).catch(() => {});
  }
  await options.store.clear();
}
async function renewSession(options, current) {
  const active = refreshing.get(options.store);
  if (active)
    return active;
  const promise = (async () => {
    const baseUrl = normalizeApiUrl(options.baseUrl);
    const response = await postJson(baseUrl, "/api/auth/refresh", {
      refreshToken: current.refreshToken
    });
    if (response.status === 401) {
      await options.store.clear();
      throw new SixbSessionEndedError("[SixbCLI] The session has ended. Sign in again.");
    }
    if (!response.ok)
      throw await responseError(response, "refresh the session");
    const next = parseSessionTokens(asRecord2(await response.json()));
    await options.store.save(next);
    return next;
  })();
  refreshing.set(options.store, promise);
  try {
    return await promise;
  } finally {
    refreshing.delete(options.store);
  }
}
async function postJson(baseUrl, path, body, signal) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...signal ? { signal } : {}
  });
}
function parseSessionTokens(record) {
  const accessToken = nonblank(record.accessToken);
  const refreshToken = nonblank(record.refreshToken);
  const accessExpiresAt = nonblank(record.accessExpiresAt);
  if (!accessToken || !refreshToken || !accessExpiresAt || Number.isNaN(Date.parse(accessExpiresAt))) {
    throw new Error("[SixbCLI] The Sixb API returned invalid session tokens.");
  }
  return { accessToken, refreshToken, accessExpiresAt };
}
async function responseError(response, action) {
  const text = await response.text().catch(() => "");
  try {
    const parsed = asRecord2(JSON.parse(text));
    if (typeof parsed.error === "string" && parsed.error) {
      return new Error(`[SixbCLI] Failed to ${action}: ${parsed.error}`);
    }
  } catch {}
  return new Error(`[SixbCLI] Failed to ${action} (HTTP ${response.status}).`);
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function nonblank(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function asRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

// src/profiles.ts
var CONFIG_DIRECTORY_MODE = 448;
var CONFIG_FILE_MODE = 384;
var PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function resolveConfigPath(options = {}) {
  const env = options.env ?? process.env;
  const configuredRoot = nonblank2(env.XDG_CONFIG_HOME);
  if (configuredRoot && !isAbsolute(configuredRoot)) {
    throw new Error("[SixbCLI] XDG_CONFIG_HOME must be an absolute path.");
  }
  const root = configuredRoot ?? join3(options.homeDirectory ?? homedir(), ".config");
  return join3(root, "sixb", "config.json");
}
async function readConfig(options = {}) {
  const path = resolveConfigPath(options);
  let text;
  try {
    text = await readFile3(path, "utf8");
  } catch (error) {
    if (isFileError2(error, "ENOENT"))
      return emptyConfig();
    throw error;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`[SixbCLI] Profile config '${path}' is not valid JSON.`);
  }
  return parseConfig(value, path);
}
async function updateConfig(update, options = {}) {
  const path = resolveConfigPath(options);
  const directory = dirname3(path);
  const config = parseConfig(update(await readConfig(options)), path);
  const temporary = join3(directory, `.config-${process.pid}-${randomUUID3()}.tmp`);
  await mkdir3(directory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
  await chmod(directory, CONFIG_DIRECTORY_MODE);
  try {
    await writeFile2(temporary, `${JSON.stringify(config, null, 2)}
`, {
      encoding: "utf8",
      flag: "wx",
      mode: CONFIG_FILE_MODE
    });
    await rename(temporary, path);
    await chmod(path, CONFIG_FILE_MODE);
  } catch (error) {
    await rm2(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return config;
}
async function resolveProfile(input = {}) {
  const env = input.env ?? process.env;
  const runId = nonblank2(env.SIXB_RUN_ID);
  const withRunId = runId ? { runId } : {};
  const explicitToken = nonblank2(input.token);
  const explicitApiUrl = nonblank2(input.apiUrl);
  if (explicitApiUrl) {
    return {
      apiUrl: normalizeApiUrl(explicitApiUrl),
      ...explicitToken ? { token: explicitToken, tokenSource: "--token" } : {},
      ...withRunId,
      source: "api-url-flag"
    };
  }
  const explicitProfile = nonblank2(input.profile);
  if (explicitProfile) {
    const config = await readConfig(input);
    const stored = requireProfile(config, explicitProfile);
    return {
      ...await resolvedStoredProfile(stored, explicitProfile, "profile-flag", explicitToken, input),
      ...withRunId
    };
  }
  const environmentApiUrl = nonblank2(env.SIXB_API_URL) ?? nonblank2(env.SIXB_API_BASE_URL) ?? nonblank2(env.SIXB_API_PUBLIC_ORIGIN);
  if (environmentApiUrl) {
    const environmentToken = resolveEnvironmentToken(env);
    return {
      apiUrl: normalizeApiUrl(environmentApiUrl),
      ...explicitToken ? { token: explicitToken, tokenSource: "--token" } : environmentToken,
      ...withRunId,
      source: "environment"
    };
  }
  const config = await readConfig(input);
  const environmentProfile = nonblank2(env.SIXB_PROFILE);
  if (environmentProfile) {
    const stored = requireProfile(config, environmentProfile);
    return {
      ...await resolvedStoredProfile(stored, environmentProfile, "profile-environment", explicitToken, input),
      ...withRunId
    };
  }
  if (config.currentProfile) {
    const stored = requireProfile(config, config.currentProfile);
    return {
      ...await resolvedStoredProfile(stored, config.currentProfile, "current-profile", explicitToken, input),
      ...withRunId
    };
  }
  return {
    apiUrl: input.defaultApiUrl ?? "http://localhost:3001",
    ...explicitToken ? { token: explicitToken, tokenSource: "--token" } : {},
    ...withRunId,
    source: "default"
  };
}
function requireProfile(config, name) {
  assertProfileName(name);
  const profile = config.profiles[name];
  if (!profile)
    throw new Error(`[SixbCLI] Profile '${name}' does not exist.`);
  return profile;
}
function assertProfileName(name) {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error("[SixbCLI] Profile names must be 1-64 characters using letters, numbers, '.', '_', or '-'.");
  }
}

class ProfileUnansweredError extends Error {
  apiUrl;
  constructor(apiUrl, cause) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.apiUrl = apiUrl;
    this.name = "ProfileUnansweredError";
  }
}
async function resolvedStoredProfile(stored, profile, source, explicitToken, options) {
  const { session, ...rest } = stored;
  const base = { ...rest, profile, source };
  if (explicitToken)
    return { ...base, token: explicitToken, tokenSource: "--token" };
  if (session) {
    const token = await getSessionAccessToken({
      baseUrl: stored.apiUrl,
      store: profileSessionStore(profile, options)
    }).catch((error) => {
      if (!(error instanceof SixbSessionEndedError)) {
        throw new ProfileUnansweredError(stored.apiUrl, error);
      }
      return null;
    });
    if (!token) {
      throw new Error(`[SixbCLI] The sign-in for profile '${profile}' has ended. Run \`sixb login ${stored.apiUrl} --profile ${profile}\` again.`);
    }
    return { ...base, token, tokenSource: "session" };
  }
  return stored.token ? { ...base, tokenSource: "profile" } : base;
}
function profileSessionStore(profile, options = {}) {
  const update = (change) => updateConfig((config) => ({
    ...config,
    profiles: { ...config.profiles, [profile]: change(requireProfile(config, profile)) }
  }), options);
  return {
    load: async () => requireProfile(await readConfig(options), profile).session ?? null,
    save: async (session) => void await update((stored) => ({ ...stored, session })),
    clear: async () => void await update(({ session: _ended, ...stored }) => stored)
  };
}
function resolveEnvironmentToken(env) {
  const apiToken = nonblank2(env.SIXB_API_TOKEN);
  if (apiToken)
    return { token: apiToken, tokenSource: "SIXB_API_TOKEN" };
  const legacyToken = nonblank2(env.SIXB_TOKEN);
  return legacyToken ? { token: legacyToken, tokenSource: "SIXB_TOKEN" } : {};
}
function emptyConfig() {
  return { version: 1, profiles: {} };
}
function parseConfig(value, path) {
  const record = asRecord3(value);
  if (record.version !== 1 || !isRecord2(record.profiles)) {
    throw invalidConfig(path);
  }
  const profiles = {};
  for (const [name, rawProfile] of Object.entries(record.profiles)) {
    assertProfileName(name);
    const profile = asRecord3(rawProfile);
    const apiUrl = nonblankString(profile.apiUrl);
    const projectId = nonblankString(profile.projectId);
    const token = profile.token === undefined ? undefined : nonblankString(profile.token);
    const session = profile.session === undefined ? undefined : parseStoredSession(profile.session);
    if (!apiUrl || !projectId || profile.token !== undefined && !token || profile.session !== undefined && !session || token && session) {
      throw invalidConfig(path);
    }
    profiles[name] = {
      apiUrl: normalizeApiUrl(apiUrl),
      projectId,
      ...token ? { token } : {},
      ...session ? { session } : {}
    };
  }
  const currentProfile = record.currentProfile === undefined ? undefined : nonblankString(record.currentProfile);
  if (record.currentProfile !== undefined && !currentProfile || currentProfile && !profiles[currentProfile]) {
    throw invalidConfig(path);
  }
  return {
    version: 1,
    ...currentProfile ? { currentProfile } : {},
    profiles
  };
}
function parseStoredSession(value) {
  const record = asRecord3(value);
  const accessToken = nonblankString(record.accessToken);
  const refreshToken = nonblankString(record.refreshToken);
  const accessExpiresAt = nonblankString(record.accessExpiresAt);
  if (!accessToken || !refreshToken || !accessExpiresAt || Number.isNaN(Date.parse(accessExpiresAt))) {
    return;
  }
  return { accessToken, refreshToken, accessExpiresAt };
}
function invalidConfig(path) {
  return new Error(`[SixbCLI] Profile config '${path}' has an invalid shape.`);
}
function nonblank2(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
function nonblankString(value) {
  return typeof value === "string" ? nonblank2(value) : undefined;
}
function asRecord3(value) {
  return isRecord2(value) ? value : {};
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFileError2(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

// src/api-client.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile as readFile4, rename as rename2, rm as rm3 } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { basename as basename3, dirname as dirname4, join as join4 } from "node:path";
import { Readable as Readable2 } from "node:stream";
import { pipeline } from "node:stream/promises";
var UNIX_BASE_URL_PREFIX = "unix:";
var RUN_HEADER = "x-sixb-run";

class ApiClient {
  baseUrl;
  socketPath;
  authorization;
  runId;
  missingBaseUrlMessage;
  unavailableMessage;
  unavailableHint;
  constructor(options) {
    const baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.socketPath = baseUrl.startsWith(UNIX_BASE_URL_PREFIX) ? baseUrl.slice(UNIX_BASE_URL_PREFIX.length) : undefined;
    this.baseUrl = this.socketPath === undefined ? baseUrl : "http://localhost";
    this.authorization = options.authorization;
    this.runId = options.runId || undefined;
    this.missingBaseUrlMessage = options.missingBaseUrlMessage ?? "No Sixb API URL is configured. Run 'sixb login <api-url>' or set SIXB_API_URL.";
    this.unavailableMessage = options.unavailableMessage ?? "The Sixb API could not be reached.";
    this.unavailableHint = options.unavailableHint ?? "Run 'sixb status' to check the connection.";
  }
  get bearerToken() {
    return this.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  }
  async request(method, path, options = {}) {
    const url = this.url(path, options.query);
    if (method === "HEAD") {
      const response = await this.fetch(url, {
        method,
        ...options.signal ? { signal: options.signal } : {}
      });
      return { status: response.status, ok: response.ok };
    }
    const init = {
      method,
      ...options.signal ? { signal: options.signal } : {}
    };
    if (options.body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(options.body);
    }
    return this.json(url, init);
  }
  async get(path, query) {
    return this.request("GET", path, { query });
  }
  async delete(path, query) {
    return this.request("DELETE", path, { query });
  }
  async post(path, body, options = {}) {
    return this.request("POST", path, { body, signal: options.signal });
  }
  async patch(path, body, options = {}) {
    return this.request("PATCH", path, { body, signal: options.signal });
  }
  async put(path, body, sizeBytes) {
    return this.json(this.url(path), {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(sizeBytes)
      },
      body,
      duplex: "half"
    });
  }
  async upload(path, source, logicalPath, mediaType) {
    const form = new FormData;
    const bytes = new Uint8Array(await readFile4(source));
    form.append("file", new Blob([bytes], mediaType ? { type: mediaType } : undefined), basename3(source));
    if (logicalPath)
      form.append("logicalPath", logicalPath);
    return this.json(this.url(path), { method: "POST", body: form });
  }
  async download(path, output, query) {
    const response = await this.fetch(this.url(path, query), { method: "GET" });
    const temporary = join4(dirname4(output), `.${basename3(output)}.sixb-${randomUUID4()}.tmp`);
    try {
      const body = response.body ? Readable2.fromWeb(response.body) : Readable2.from([]);
      await pipeline(body, createWriteStream(temporary, { flags: "wx" }));
      await rename2(temporary, output);
    } catch (error) {
      await rm3(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  url(path, query) {
    if (!this.baseUrl)
      fail(this.missingBaseUrlMessage, "runtime_unavailable");
    validateApiPath(path);
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined)
        url.searchParams.set(key, value);
    }
    return url;
  }
  async json(url, init) {
    const response = await this.fetch(url, init);
    const text = await response.text();
    if (!text)
      return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new CliError({ code: "invalid_api_response", message: "The Sixb API returned invalid JSON." }, EXIT_API);
    }
  }
  async fetch(url, init) {
    let response;
    try {
      const headers = new Headers(init.headers);
      if (this.authorization)
        headers.set("authorization", this.authorization);
      if (this.runId)
        headers.set(RUN_HEADER, this.runId);
      response = await send(url, { ...init, headers }, this.socketPath);
    } catch (error) {
      if (init.signal?.aborted)
        throw error;
      throw new CliError({
        code: "api_unreachable",
        message: this.unavailableMessage,
        hint: this.unavailableHint
      }, EXIT_API);
    }
    if (response.ok)
      return response;
    const body = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    const record = asRecord4(parsed);
    const error = record.error;
    const nested = asRecord4(error);
    const code = stringField(record, "code") ?? stringField(nested, "code") ?? "http_error";
    const message = stringField(record, "message") ?? stringField(nested, "message") ?? (typeof error === "string" ? error : `The Sixb API request failed with HTTP ${response.status}.`);
    const hint = stringField(record, "hint") ?? stringField(nested, "hint");
    const issues = Array.isArray(record.issues) ? record.issues : Array.isArray(nested.issues) ? nested.issues : undefined;
    throw new CliError({
      code,
      status: response.status,
      message,
      ...hint ? { hint } : {},
      ...issues ? { issues } : {}
    }, EXIT_API);
  }
}
function validateApiPath(path) {
  const invalid = () => fail("API paths must be relative and start with /api/.");
  if (path.includes("\\") || path.includes("#"))
    invalid();
  const normalized = (() => {
    try {
      return new URL(path, "http://sixb.invalid");
    } catch {
      return invalid();
    }
  })();
  if (normalized.origin !== "http://sixb.invalid" || normalized.pathname !== "/api" && !normalized.pathname.startsWith("/api/")) {
    invalid();
  }
}
function asRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function stringField(record, key) {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
function send(url, init, socketPath) {
  if (socketPath === undefined)
    return fetch(url, init);
  if (typeof Bun !== "undefined")
    return fetch(url, { ...init, unix: socketPath });
  return sendOverNodeSocket(url, init, socketPath);
}
async function sendOverNodeSocket(url, init, socketPath) {
  const outgoing = new Request(url, init);
  const headers = Object.fromEntries(outgoing.headers);
  const streamed = init.body instanceof ReadableStream;
  const body = outgoing.body && !streamed ? Buffer.from(await outgoing.arrayBuffer()) : undefined;
  if (body)
    headers["content-length"] = String(body.byteLength);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath,
      method: outgoing.method,
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, host: "localhost" },
      ...init.signal ? { signal: init.signal } : {}
    }, (response) => {
      const responseHeaders = new Headers;
      for (const [name, value] of Object.entries(response.headers)) {
        for (const each of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
          responseHeaders.append(name, each);
        }
      }
      const status = response.statusCode ?? 502;
      const empty = status === 204 || status === 304 || outgoing.method === "HEAD";
      resolve(new Response(empty ? null : nodeBody(response), {
        status,
        statusText: response.statusMessage ?? "",
        headers: responseHeaders
      }));
    });
    request.on("error", reject);
    if (streamed && outgoing.body) {
      Readable2.fromWeb(outgoing.body).on("error", (error) => request.destroy(error)).pipe(request);
    } else
      request.end(body);
  });
}
function nodeBody(response) {
  return Readable2.toWeb(response);
}

// src/run.ts
async function runInstanceCli(input) {
  const [command, ...args] = input.args;
  await dispatch(createInstanceApiClient(input.connection), command ?? "", args);
}
function createInstanceApiClient(connection) {
  return new ApiClient({
    baseUrl: connection.baseUrl,
    ...connection.token ? { authorization: `Bearer ${connection.token}` } : {},
    ...connection.runId ? { runId: connection.runId } : {}
  });
}

// src/commands/auth.ts
var LOGIN_HELP = `Usage:
  sixb login <api-url> [--profile <name>] [--token-stdin] [--json]

Sign in to a Sixb instance and save it as a profile. Pass --token-stdin to store an access
token from standard input (for CI or scripts).`;
var LOGOUT_HELP = `Usage:
  sixb logout [--profile <name>] [--json]

Sign out of a saved profile and remove it from ~/.config/sixb/config.json.`;
var PROFILE_HELP = `Usage:
  sixb profile list [--json]
  sixb profile show [name] [--json]
  sixb profile use <name> [--json]

Manage saved Sixb API profiles.`;
async function login(args) {
  if (requestsHelp(args))
    return writeText(LOGIN_HELP);
  const { positionals, options } = parseCommandArgs(args, { "--profile": "string", "--token-stdin": "boolean", "--json": "boolean" }, "login", [0, 1]);
  let requested = positionals[0]?.trim() ?? "";
  if (!requested) {
    if (process.stdin.isTTY && process.stdout.isTTY && !options["--json"]) {
      requested = await promptForApiUrl();
    } else {
      fail("Usage: sixb login <api-url> [--profile <name>] [--token-stdin]");
    }
  }
  const apiUrl = normalizeApiUrl(requested);
  let token;
  let session;
  let projectId;
  try {
    projectId = await fetchProjectId(apiUrl);
  } catch (error) {
    if (!isAuthorizationError(error))
      throw error;
    if (options["--token-stdin"]) {
      token = await readTokenFromStdin();
    } else {
      session = await authorizeDevice(apiUrl);
    }
    projectId = await fetchProjectId(apiUrl, token ?? session?.accessToken);
  }
  const profile = options["--profile"]?.trim() || projectId;
  assertProfileName(profile);
  await updateConfig((config) => ({
    version: 1,
    currentProfile: profile,
    profiles: {
      ...config.profiles,
      [profile]: {
        apiUrl,
        projectId,
        ...token ? { token } : {},
        ...session ? { session } : {}
      }
    }
  }));
  const result = { profile, projectId, apiUrl, authenticated: Boolean(token ?? session) };
  renderOutput(result, {
    json: options["--json"],
    renderText: () => renderKeyValues({
      title: `Logged in with profile "${profile}"`,
      titleTone: "green",
      items: [
        { label: "Project", value: projectId },
        { label: "API", value: apiUrl },
        {
          label: "Authentication",
          value: session ? "signed in" : token ? "stored token" : "not required"
        }
      ]
    })
  });
}
async function logout(args) {
  if (requestsHelp(args))
    return writeText(LOGOUT_HELP);
  const { options } = parseCommandArgs(args, { "--profile": "string", "--json": "boolean" }, "logout");
  const config = await readConfig();
  const name = options["--profile"]?.trim() || config.currentProfile;
  if (!name)
    fail("No active profile to log out of.");
  const stored = requireProfile(config, name);
  if (stored.session) {
    await signOutSession({
      baseUrl: stored.apiUrl,
      store: profileSessionStore(name)
    }).catch(() => {});
  }
  const next = await updateConfig((current) => {
    const remaining = Object.fromEntries(Object.entries(current.profiles).filter(([entry]) => entry !== name));
    const remainingNames = Object.keys(remaining).sort();
    const currentProfile = current.currentProfile === name ? remainingNames[0] : current.currentProfile;
    return {
      version: 1,
      ...currentProfile ? { currentProfile } : {},
      profiles: remaining
    };
  });
  const result = {
    removed: name,
    ...next.currentProfile ? { currentProfile: next.currentProfile } : {}
  };
  renderOutput(result, {
    json: options["--json"],
    renderText: () => renderKeyValues({
      title: `Logged out of profile "${name}"`,
      items: next.currentProfile ? [{ label: "Current profile", value: next.currentProfile }] : [{ label: "Current profile", value: "none" }]
    })
  });
}
async function profile(args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(PROFILE_HELP);
  if (sub === "list") {
    const { options } = parseCommandArgs(rest, { "--json": "boolean" }, "profile list");
    const config = await readConfig();
    const entries = Object.entries(config.profiles).sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => ({
      name,
      current: name === config.currentProfile,
      projectId: entry.projectId,
      apiUrl: entry.apiUrl,
      authenticated: Boolean(entry.session ?? entry.token)
    }));
    return renderOutput({ currentProfile: config.currentProfile ?? null, profiles: entries }, {
      json: options["--json"],
      renderText: () => renderTable({
        subtitle: `${entries.length} saved`,
        headers: ["Profile", "Project", "API", "Auth"],
        rows: entries.map((entry) => [
          entry.current ? `${entry.name} *` : entry.name,
          entry.projectId,
          entry.apiUrl,
          entry.authenticated ? "signed in" : "none"
        ]),
        emptyMessage: "No saved profiles. Run `sixb login <api-url>`."
      })
    });
  }
  if (sub === "show") {
    const { positionals, options } = parseCommandArgs(rest, { "--json": "boolean" }, "profile show", [0, 1]);
    const config = await readConfig();
    const name = positionals[0]?.trim() || config.currentProfile;
    if (!name)
      fail("No active profile. Run `sixb login <api-url>`.");
    const entry = requireProfile(config, name);
    const result = {
      name,
      current: name === config.currentProfile,
      projectId: entry.projectId,
      apiUrl: entry.apiUrl,
      authenticated: Boolean(entry.session ?? entry.token)
    };
    return renderOutput(result, {
      json: options["--json"],
      renderText: () => renderKeyValues({
        title: result.current ? `${name} (current)` : name,
        items: [
          { label: "Project", value: result.projectId },
          { label: "API", value: result.apiUrl },
          { label: "Authentication", value: result.authenticated ? "configured" : "none" }
        ]
      })
    });
  }
  if (sub === "use") {
    const { positionals, options } = parseCommandArgs(rest, { "--json": "boolean" }, "profile use", 1);
    const name = positionals[0]?.trim() ?? "";
    const config = await readConfig();
    const entry = requireProfile(config, name);
    await updateConfig((current) => ({ ...current, currentProfile: name }));
    const result = { currentProfile: name, projectId: entry.projectId, apiUrl: entry.apiUrl };
    return renderOutput(result, {
      json: options["--json"],
      renderText: () => renderKeyValues({
        title: `Switched to profile "${name}"`,
        titleTone: "green",
        items: [
          { label: "Project", value: entry.projectId },
          { label: "API", value: entry.apiUrl }
        ]
      })
    });
  }
  fail(`Unknown profile command '${sub}'. Run 'sixb profile --help'.`);
}
async function promptForApiUrl() {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question("API URL (default http://localhost:3001): ")).trim();
    return answer || "http://localhost:3001";
  } finally {
    rl.close();
  }
}
async function authorizeDevice(apiUrl) {
  const device = await startDeviceLogin({
    baseUrl: apiUrl,
    clientName: `sixb CLI on ${hostname()}`
  });
  process.stderr.write(`
  ${style.blue("→")} Opening ${device.verificationUriComplete}
` + `    Confirm code: ${style.bold(device.userCode)}

`);
  if (process.env.SIXB_CLI_NO_BROWSER !== "1") {
    openBrowser(device.verificationUriComplete);
  }
  process.stderr.write(`Waiting for browser authorization...
`);
  return device.complete();
}
function openBrowser(url) {
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
async function fetchProjectId(apiUrl, token) {
  const api = createInstanceApiClient({
    baseUrl: apiUrl,
    ...token ? { token } : {}
  });
  const result = await api.get("/api/project");
  if (typeof result !== "object" || result === null || !("id" in result) || typeof result.id !== "string" || !result.id.trim()) {
    throw new Error("[SixbCLI] The Sixb API returned project metadata without a project id.");
  }
  return result.id.trim();
}
function isAuthorizationError(error) {
  return error instanceof CliError && (error.body.status === 401 || error.body.status === 403);
}
async function readTokenFromStdin() {
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk.toString();
    if (value.length > 16384) {
      fail("The token read from stdin is too large.");
    }
  }
  const token = value.trim();
  if (!token)
    fail("API token cannot be empty.");
  if (/\s/.test(token))
    fail("API token cannot contain whitespace.");
  return token;
}

// src/delegate.ts
import { spawn as spawn2 } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname as dirname5, join as join5, resolve } from "node:path";
var PROJECT_COMMANDS = new Set([
  "dev",
  "serve",
  "check",
  "typegen",
  "build",
  "run",
  "env",
  "deploy",
  "desktop",
  "db",
  "lake",
  "init",
  "agent",
  "connect"
]);
function findProjectCli(cwd = process.cwd(), env = process.env) {
  let dir = resolve(cwd);
  for (;; ) {
    const localBin = join5(dir, "node_modules", ".bin", "sixb-project");
    if (isExecutable(localBin)) {
      return { command: localBin, prefixArgs: [] };
    }
    const workspaceEntry = join5(dir, "packages", "project-cli", "src", "index.tsx");
    if (isReadable(workspaceEntry)) {
      return { command: "bun", prefixArgs: [workspaceEntry] };
    }
    const parent = dirname5(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  for (const entry of (env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!entry)
      continue;
    const candidate = join5(entry, "sixb-project");
    if (isExecutable(candidate)) {
      return { command: candidate, prefixArgs: [] };
    }
  }
  return null;
}
async function runProjectCli(target, args) {
  return new Promise((resolveExit, reject) => {
    const child = spawn2(target.command, [...target.prefixArgs, ...args], {
      stdio: "inherit"
    });
    const onSigint = () => child.kill("SIGINT");
    const onSigterm = () => child.kill("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    child.on("error", (error) => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      reject(error);
    });
    child.on("close", (code, signal) => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      if (signal)
        resolveExit(128);
      else
        resolveExit(code ?? 1);
    });
  });
}
function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function isReadable(path) {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// src/main.ts
var CONNECTION_FLAGS = new Set(["api-url", "profile", "token"]);
async function main(args) {
  const [command, ...rest] = args;
  if (!command) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const projectCli = findProjectCli();
      if (projectCli) {
        process.exitCode = await runProjectCli(projectCli, []);
        return;
      }
    }
    return writeText(renderInstanceHelp());
  }
  if (isHelp(command)) {
    if (rest.length > 0 && isInstanceCommand(rest[0] ?? "")) {
      await runInstanceCli({ args: [...rest, "--help"], connection: { baseUrl: "" } });
      return;
    }
    if (rest.length > 0 && PROJECT_COMMANDS.has(rest[0] ?? "")) {
      const projectCli = findProjectCli();
      if (projectCli) {
        process.exitCode = await runProjectCli(projectCli, ["help", ...rest]);
        return;
      }
    }
    return writeText(renderInstanceHelp());
  }
  if (command === "--version" || command === "-v" || command === "version") {
    return writeText(`sixb CLI ${INSTANCE_CLI_VERSION}`);
  }
  if (command === "login")
    return login(rest);
  if (command === "logout")
    return logout(rest);
  if (command === "profile")
    return profile(rest);
  if (isInstanceCommand(command)) {
    const { commandArgs, apiUrl, profile: profileName, token } = extractConnectionOptions(args);
    if (requestsHelp(commandArgs)) {
      await runInstanceCli({ args: commandArgs, connection: { baseUrl: "" } });
      return;
    }
    const resolved = await resolveProfile({
      ...apiUrl ? { apiUrl } : {},
      ...profileName ? { profile: profileName } : {},
      ...token ? { token } : {},
      defaultApiUrl: ""
    });
    const connection = {
      baseUrl: resolved.apiUrl,
      ...resolved.token ? { token: resolved.token } : {},
      ...resolved.runId ? { runId: resolved.runId } : {}
    };
    if (command === "status") {
      return status(createInstanceApiClient(connection), commandArgs.slice(1), {
        ...resolved.token ? { authenticated: true } : {},
        ...resolved.profile ? { profile: resolved.profile } : {},
        ...resolved.source === "default" ? {} : { source: resolved.source }
      });
    }
    await runInstanceCli({ args: commandArgs, connection });
    return;
  }
  const projectCli = findProjectCli();
  if (projectCli && PROJECT_COMMANDS.has(command)) {
    process.exitCode = await runProjectCli(projectCli, args);
    return;
  }
  if (PROJECT_COMMANDS.has(command)) {
    fail(`Command '${command}' requires @sixb/project-cli.`, "runtime_unavailable", "Run inside a Sixb project with @sixb/project-cli installed, or install it globally.");
  }
  fail(`Unknown command '${command}'. Run 'sixb --help'.`);
}
function extractConnectionOptions(args) {
  const commandArgs = [];
  const values = {};
  for (let index = 0;index < args.length; index++) {
    const argument = args[index];
    if (argument === "--") {
      commandArgs.push(...args.slice(index));
      break;
    }
    if (!argument?.startsWith("--")) {
      if (argument !== undefined)
        commandArgs.push(argument);
      continue;
    }
    const equalsIndex = argument.indexOf("=");
    const name = argument.slice(2, equalsIndex < 0 ? undefined : equalsIndex);
    if (!CONNECTION_FLAGS.has(name)) {
      commandArgs.push(argument);
      continue;
    }
    if (values[name] !== undefined) {
      fail(`--${name} may only be provided once.`);
    }
    const value = equalsIndex < 0 ? args[++index] : argument.slice(equalsIndex + 1);
    if (!value || value.startsWith("--")) {
      fail(`--${name} requires a value.`);
    }
    values[name] = value;
  }
  if (values["api-url"] && values.profile) {
    fail("--api-url and --profile cannot be used together.");
  }
  return {
    commandArgs,
    ...values["api-url"] ? { apiUrl: values["api-url"] } : {},
    ...values.profile ? { profile: values.profile } : {},
    ...values.token ? { token: values.token } : {}
  };
}
try {
  await main(process.argv.slice(2));
} catch (error) {
  process.exitCode = reportError(error);
}
