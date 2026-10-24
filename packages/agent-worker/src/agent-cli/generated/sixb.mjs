#!/usr/bin/env node

// ../cli-core/src/api-client.ts
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// ../cli-core/src/output.ts
var INSTANCE_CLI_VERSION = "1";
var EXIT_USAGE = 2;
var EXIT_API = 3;

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
function writeText(value) {
  process.stdout.write(value.endsWith(`
`) ? value : `${value}
`);
}
function reportError(error) {
  const cliError = error instanceof CliError ? error : new CliError({
    code: "internal_error",
    message: error instanceof Error ? error.message : "The Sixb CLI failed unexpectedly."
  }, EXIT_API);
  process.stderr.write(`${JSON.stringify({ error: cliError.body })}
`);
  return cliError.exitCode;
}

// ../cli-core/src/api-client.ts
class ApiClient {
  baseUrl;
  authorization;
  missingBaseUrlMessage;
  unavailableMessage;
  unavailableHint;
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.authorization = options.authorization;
    this.missingBaseUrlMessage = options.missingBaseUrlMessage;
    this.unavailableMessage = options.unavailableMessage;
    this.unavailableHint = options.unavailableHint;
  }
  async get(path, query) {
    const url = this.url(path, query);
    return this.json(url, { method: "GET" });
  }
  async post(path, body, options = {}) {
    return this.json(this.url(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...options.signal ? { signal: options.signal } : {}
    });
  }
  async upload(path, source, logicalPath, mediaType) {
    const form = new FormData;
    const bytes = new Uint8Array(await readFile(source));
    form.append("file", new Blob([bytes], mediaType ? { type: mediaType } : undefined), basename(source));
    if (logicalPath)
      form.append("logicalPath", logicalPath);
    return this.json(this.url(path), { method: "POST", body: form });
  }
  async download(path, output, query) {
    const response = await this.fetch(this.url(path, query), { method: "GET" });
    const temporary = join(dirname(output), `.${basename(output)}.sixb-${randomUUID()}.tmp`);
    try {
      const body = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
      await pipeline(body, createWriteStream(temporary, { flags: "wx" }));
      await rename(temporary, output);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
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
      response = await fetch(url, { ...init, headers });
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
    const record = asRecord(parsed);
    const error = record.error;
    const nested = asRecord(error);
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
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function stringField(record, key) {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
// ../cli-core/src/arguments.ts
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
// ../cli-core/src/commands/actions.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// ../cli-core/src/policies.ts
var CLI_LIMITS = {
  list: { default: 20, maximum: 1000 },
  search: { default: 20, maximum: 50 },
  vectorSearchText: { maximum: 8000 },
  telemetryHistory: { default: 100, maximum: 1000 },
  linkPage: { default: 100, maximum: 1000 },
  users: { default: 20, maximum: 200 },
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

// ../cli-core/src/commands/metadata.ts
var SANDBOX_MAIN_HELP = `Sixb agent CLI

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
For query IR, run \`sixb objects query --help\` and \`sixb objects query --example list\`.`;
var LOCAL_MAIN_HELP = SANDBOX_MAIN_HELP.replace("Sixb agent CLI", "Sixb instance CLI").replace("The CLI uses the run-scoped SIXB_API_BASE_URL. Do not configure authentication or another origin.", "The CLI uses the selected local profile and its API credentials.").replace(`  sixb doctor                         Check the sandbox and API gateway
  sixb context                        Print the current run context
`, "").replace(`
When you do not know a type's properties or links, read its file under $SIXB_ONTOLOGY_DIR. Use
\`sixb ontology get\` for a type that has no file there.
`, "").replace(`Files:
  sixb files upload|download ...
`, `Files:
  sixb files upload|download ...

Models:
  sixb models list [--kind <kind>]    Configured models of every kind, with prices
  sixb models get <model>             One model's options and rate card
  sixb models text|image|speech|transcribe ...   Call a model; see sixb models --help
`);
function renderInstanceHelp(mode) {
  return mode === "sandbox" ? SANDBOX_MAIN_HELP : LOCAL_MAIN_HELP;
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
  --order <asc|desc>            Started-time order; defaults to ${DEFAULT_LIST_ORDER}`
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

// ../cli-core/src/commands/shared.ts
import { readFile as readFile2 } from "node:fs/promises";
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
  let text;
  try {
    text = source === "-" ? await readStdin() : await readFile2(source, "utf8");
  } catch (error) {
    if (isFileError(error, "ENOENT"))
      fail(`JSON file '${source}' does not exist.`);
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(source === "-" ? "Standard input is not valid JSON." : `JSON file '${source}' is not valid JSON.`, "invalid_json");
  }
}
function asRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function asRecords(value) {
  return Array.isArray(value) ? value.map(asRecord2) : [];
}
function vectorProfileNames(objectType) {
  return Object.keys(asRecord2(asRecord2(objectType.search).vectors));
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

// ../cli-core/src/commands/actions.ts
var ACTION_REQUEST_WAIT_MS = 25000;
async function actions(api, args, requestWaitMs = ACTION_REQUEST_WAIT_MS) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.actions);
  if (sub === "get") {
    const { positionals } = parseCommandArgs(rest, {}, "actions get", 1);
    return writeJson(await api.get(`/api/actions/${encodeURIComponent(positionals[0] ?? "")}`));
  }
  if (sub === "list") {
    const options = parseQueryOptions(rest, { "--type": "objectTypeId" }, "actions list");
    const response = await api.get("/api/actions");
    if (!options.objectTypeId)
      return writeJson(response);
    if (!Array.isArray(response))
      fail("The actions API returned an invalid response.");
    return writeJson(response.filter((value) => asRecord2(value).objectTypeId === options.objectTypeId));
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
    const requestedRunId = runId ?? `act_${randomUUID2()}`;
    const waiting = AbortSignal.timeout(requestWaitMs);
    try {
      return writeJson(await api.post(`/api/actions/${encodeURIComponent(actionId)}`, {
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

// ../cli-core/src/commands/files.ts
import { access } from "node:fs/promises";
async function files(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP.files);
  if (sub === "upload") {
    const { positionals, options } = parseCommandArgs(rest, { "--logical-path": "string" }, "files upload", 1);
    const source = positionals[0] ?? "";
    try {
      await access(source);
    } catch {
      fail(`Upload file '${source}' does not exist.`);
    }
    return writeJson(await api.upload("/api/files", source, options["--logical-path"]));
  }
  if (sub === "download") {
    const { positionals, options } = parseCommandArgs(rest, { "--path": "string", "--output": "string" }, "files download", [2, 3]);
    const context = positionals[0];
    let route;
    if (context === "object") {
      requireExact(positionals, 3, "files download object requires object type and primary id.");
      const type = positionals[1] ?? "";
      const id = positionals[2] ?? "";
      route = `/api/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}/files/content`;
    } else if (context === "action-run" || context === "workflow-run") {
      requireExact(positionals, 2, `files download ${context} requires exactly one run id.`);
      const id = positionals[1] ?? "";
      route = `/api/${context}s/${encodeURIComponent(id)}/files/content`;
    } else
      fail(`Unknown file download context '${context}'.`);
    const path = options["--path"];
    const output = options["--output"];
    if (!path)
      fail("files download requires --path <json-pointer>.");
    if (!output)
      fail("files download requires --output <local-path>.");
    await api.download(route, output, { path });
    return writeJson({ downloaded: true, output });
  }
  fail(`Unknown files command '${sub}'.`);
}

// ../cli-core/src/commands/models.ts
import { access as access2, mkdir, stat } from "node:fs/promises";
import { dirname as dirname2, extname, join as join2, parse } from "node:path";
var MODEL_KINDS = ["language", "image", "speech", "transcription"];
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
  if (sub === "speech")
    return generateSpeech(api, rest);
  if (sub === "transcribe")
    return transcribe(api, rest);
  if (sub === "calls")
    return calls(api, rest);
  fail(`Unknown models command '${sub}'.`);
}
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
  ".webm": "audio/webm"
};
var EXTENSIONS = Object.fromEntries(Object.entries(MEDIA_TYPES).filter(([extension]) => extension !== ".jpeg").map(([extension, mediaType]) => [mediaType, extension]));
async function generateText(api, args) {
  const { positionals, options } = parseCommandArgs(args, {
    "--model": "string",
    "--instructions": "string",
    "--max-output-tokens": "string",
    "--reasoning": "string"
  }, "models text", 1);
  const maxOutputTokens = options["--max-output-tokens"];
  const result = await api.post("/api/models/language/generations", {
    ...await modelRef(api, options["--model"], "language"),
    prompt: positionals[0],
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
  writeJson({
    callId: result.callId,
    model: result.model.modelId,
    text: result.text,
    cost: describeCost(result.cost)
  });
}
async function calls(api, args) {
  const [sub, ...rest] = args;
  if (sub !== "files")
    fail(`Unknown models calls command '${sub ?? ""}'. Use 'models calls files'.`);
  const { positionals, options } = parseCommandArgs(rest, { "--output": "string" }, "models calls files", 1);
  const callId = positionals[0] ?? "";
  const call = await api.get(`/api/ai/model-calls/${encodeURIComponent(callId)}/files`);
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
    await access2(path);
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
  const directory = output.endsWith("/") || (await stat(output).catch(() => null))?.isDirectory();
  const paths = files.map((file, index) => {
    const number = files.length > 1 ? `-${index + 1}` : "";
    const extension = (file.mediaType && EXTENSIONS[file.mediaType]) ?? "";
    if (directory)
      return join2(output, `${callId}${number}${extension || ".bin"}`);
    const { dir, name, ext } = parse(output);
    return join2(dir, `${name}${number}${extension || ext}`);
  });
  for (const [index, path] of paths.entries()) {
    await mkdir(dirname2(path), { recursive: true });
    await api.download(`/api/ai/model-calls/${encodeURIComponent(callId)}/files/content`, path, {
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

// ../cli-core/src/graph.ts
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

// ../cli-core/src/commands/objects.ts
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
  const objectType = asRecord2(await api.get(`/api/object-types/${encodeURIComponent(objectTypeId)}`));
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
  const record = asRecord2(input);
  const body = Object.hasOwn(record, "query") ? { ...record, ...Object.hasOwn(record, "includeTotal") ? {} : { includeTotal } } : { query: input, includeTotal };
  writeJson(await api.post("/api/objects/query", body));
}
async function objectsScalar(api, operation, args) {
  if (requestsHelp(args))
    return writeText(`Usage: sixb objects ${operation} --file <path|->`);
  const source = singleFileOption(args, `objects ${operation}`);
  const input = await readJson(source);
  const record = asRecord2(input);
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
  const record = asRecord2(body);
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

// ../cli-core/src/commands/ontology.ts
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
      const type = asRecord2(entry);
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
    return writeJson(await api.get(`/api/object-types/${encodeURIComponent(positionals[0] ?? "")}`));
  }
  fail(`Unknown ontology command '${sub}'.`);
}

// ../cli-core/src/commands/project.ts
async function project(api, args) {
  if (!args[0] || isHelp(args[0]) || args[0] === "show" && requestsHelp(args.slice(1))) {
    return writeText(GROUP_HELP.project);
  }
  if (args[0] !== "show")
    fail(`Unknown project command '${args[0]}'.`);
  parseCommandArgs(args.slice(1), {}, "project show");
  writeJson(await api.get("/api/project"));
}

// ../cli-core/src/commands/runs.ts
var ACTION_RUN_STATUSES = ["succeeded", "failed"];
var WORKFLOW_RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled"
];
async function runs(api, kind, args) {
  const [sub, ...rest] = args;
  const group = `${kind}-runs`;
  if (!sub || isHelp(sub) || requestsHelp(rest))
    return writeText(GROUP_HELP[group]);
  if (sub === "get") {
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
    const action = {
      ...common,
      "--action": "actionId",
      "--type": "objectTypeId",
      "--id": "primaryId"
    };
    const workflow = { ...common, "--workflow": "workflowId" };
    const options = normalizeWindowOptions(parseQueryOptions(rest, kind === "action" ? action : workflow, `${group} list`), {
      defaultLimit: CLI_LIMITS.list.default,
      maximumLimit: CLI_LIMITS.list.maximum,
      defaultOrder: DEFAULT_LIST_ORDER,
      offset: true
    });
    if (options.status !== undefined) {
      options.status = enumValue("--status", options.status, kind === "action" ? ACTION_RUN_STATUSES : WORKFLOW_RUN_STATUSES);
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

// ../cli-core/src/commands/telemetry.ts
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
  return `/api/objects/${encodeURIComponent(args[0] ?? "")}/${encodeURIComponent(args[1] ?? "")}/telemetry/${encodeURIComponent(args[2] ?? "")}/${terminal}`;
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

// ../cli-core/src/commands/users.ts
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
    return writeJson(await api.get(`/api/users/${encodeURIComponent(positionals[0] ?? "")}`));
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

// ../cli-core/src/commands/workflows.ts
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
    return writeJson(await api.get(`/api/workflows/${encodeURIComponent(workflowId ?? "")}`));
  }
  if (sub === "start") {
    const {
      positionals: [workflowId],
      options
    } = parseCommandArgs(rest, { "--file": "string" }, "workflows start", 1);
    const input = options["--file"] ? await readJson(options["--file"]) : {};
    if (Array.isArray(input) || typeof input !== "object" || input === null) {
      fail("Workflow input must be a JSON object.");
    }
    return writeJson(await api.post(`/api/workflows/${encodeURIComponent(workflowId ?? "")}/runs`, { input }));
  }
  fail(`Unknown workflows command '${sub}'.`);
}

// ../cli-core/src/commands/index.ts
var INSTANCE_COMMANDS = [
  "project",
  "ontology",
  "objects",
  "telemetry",
  "actions",
  "action-runs",
  "files",
  "workflows",
  "workflow-runs",
  "users",
  "models"
];
function isInstanceCommand(command) {
  return INSTANCE_COMMANDS.includes(command);
}
async function dispatch(api, command, args) {
  switch (command) {
    case "project":
      return project(api, args);
    case "ontology":
      return ontology(api, args);
    case "objects":
      return objects(api, args);
    case "telemetry":
      return telemetry(api, args);
    case "actions":
      return actions(api, args);
    case "action-runs":
      return runs(api, "action", args);
    case "files":
      return files(api, args);
    case "workflows":
      return workflows(api, args);
    case "workflow-runs":
      return runs(api, "workflow", args);
    case "users":
      return users(api, args);
    case "models":
      return models(api, args);
    default:
      fail(`Unknown command '${command}'. Run 'sixb --help'.`);
  }
}
// ../cli-core/src/run.ts
async function runInstanceCli(input) {
  const [command, ...args] = input.args;
  await dispatch(createInstanceApiClient(input.mode), command ?? "", args);
}
function createInstanceApiClient(mode) {
  return new ApiClient({
    baseUrl: mode.baseUrl,
    ...mode.kind === "local" && mode.token ? { authorization: `Bearer ${mode.token}` } : {},
    missingBaseUrlMessage: mode.kind === "sandbox" ? "SIXB_API_BASE_URL is not set." : "The selected Sixb profile has no API URL.",
    unavailableMessage: mode.kind === "sandbox" ? "The Sixb API gateway could not be reached." : "The Sixb API could not be reached.",
    unavailableHint: mode.kind === "sandbox" ? "Run 'sixb doctor' to verify the sandbox runtime and gateway." : "Run 'sixb status' to verify the current profile."
  });
}
// src/agent-cli/commands/memory.ts
import { lstat, mkdir as mkdir2, readdir, readFile as readFile3, rm as rm2, writeFile } from "node:fs/promises";
import { dirname as dirname3, join as join3 } from "node:path";

// src/agent-runtime/memory.ts
import { createHash } from "node:crypto";
var AGENT_MEMORY_MANIFEST = "context/memory.json";
var AGENT_MEMORY_ENTRY = "MEMORY.md";
var AGENT_MEMORY_STARTER = `# Memory

`;
function agentMemoryFileHash(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

// src/agent-cli/commands/memory.ts
var HELP = `Usage:
  sixb memory save <repo> -m <message>   Save local edits as one revision
  sixb memory pull [repo]                Bring the local copy up to the latest revision

<repo> is user or project. Files live under $SIXB_MEMORY_DIR/<repo>/.

A save is rejected for files another conversation changed since they were loaded. Their
current contents are written next to yours as <file>.theirs: merge each into its file, delete
it, then save again. Changes others made to other files are brought in by save and pull.`;
var THEIRS = ".theirs";
var CONFLICT_HINT = "Merge each .theirs file into its file, delete it, then save again.";
async function memory(args, mode) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || rest.some(isHelp))
    return writeText(HELP);
  const local = localMemory();
  if (sub === "save")
    return save(local, rest, mode);
  if (sub === "pull")
    return pull(local, rest, mode);
  fail(`Unknown memory command '${sub}'. Run 'sixb memory --help'.`);
}
async function save(local, args, mode) {
  const { repo, message } = parseSaveArgs(args);
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
  const api = createInstanceApiClient(mode);
  let saved;
  try {
    saved = asRecord2(await api.post(`/api/agent-memory/${repo}/revisions`, {
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
async function pull(local, args, mode) {
  if (args.length > 1)
    fail("Invalid arguments for 'memory pull'.");
  const manifest = await local.readManifest();
  const repos = args[0] === undefined ? installedRepos(manifest) : [parseRepo(args[0])];
  if (repos.length === 0) {
    fail("No memory repo is installed.", "invalid_arguments", "Run 'sixb memory pull user'.");
  }
  const api = createInstanceApiClient(mode);
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
  const body = asRecord2(await api.get(`/api/agent-memory/${repo}`));
  const files = Array.isArray(body.files) ? body.files.map(asRecord2) : null;
  if (typeof body.revision !== "number" || !files?.every((file) => typeof file.path === "string" && typeof file.contents === "string")) {
    throw new CliError({ code: "invalid_api_response", message: "The Sixb API returned an invalid memory repo." }, EXIT_API);
  }
  return {
    revision: body.revision,
    files: new Map(files.map((file) => [String(file.path), String(file.contents)]))
  };
}
function localMemory() {
  const root = process.env.SIXB_MEMORY_DIR;
  const contextDir = process.env.SIXB_CONTEXT_DIR;
  if (!root || !contextDir) {
    fail("Agent memory is not available in this run.", "runtime_unavailable");
  }
  const manifestPath = join3(contextDir, ...AGENT_MEMORY_MANIFEST.split("/"));
  const fileOf = (repo, path) => join3(root, repo, ...path.split("/"));
  return {
    async readManifest() {
      let text;
      try {
        text = await readFile3(manifestPath, "utf8");
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
      await mkdir2(dirname3(manifestPath), { recursive: true });
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
          const stats = await lstat(join3(directory, name));
          if (stats.isDirectory())
            await walk(join3(directory, name), path);
          else if (stats.isFile())
            files.set(path, await readFile3(join3(directory, name), "utf8"));
          else
            fail(`Memory file '${repo}/${path}' is not a regular file.`);
        }
      };
      await walk(join3(root, repo), "");
      return files;
    },
    async write(repo, path, contents) {
      const file = fileOf(repo, path);
      if (contents === undefined) {
        await rm2(file, { force: true });
        return;
      }
      await mkdir2(dirname3(file), { recursive: true });
      await writeFile(file, contents);
    }
  };
}
function parseSaveArgs(args) {
  const positionals = [];
  let message;
  for (let index = 0;index < args.length; index++) {
    const argument = args[index] ?? "";
    if (argument === "-m" || argument === "--message") {
      if (message !== undefined)
        fail(`${argument} may only be provided once.`);
      message = args[++index];
      if (!message)
        fail(`${argument} requires a value.`);
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
  return { repo: parseRepo(positionals[0] ?? ""), message };
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
  const repos = asRecord2(asRecord2(value).repos);
  const parsed = {};
  for (const repo of ["user", "project"]) {
    if (repos[repo] === undefined)
      continue;
    const entry = asRecord2(repos[repo]);
    const files = asRecord2(entry.files);
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

// src/agent-cli/commands/system.ts
import { readFile as readFile4 } from "node:fs/promises";

// src/agent-runtime/profile.ts
var AGENT_RUNTIME_PROFILE = "sixb-agent-runtime/v1";

// src/agent-cli/commands/system.ts
async function doctor(args, mode) {
  if (isHelp(args[0]))
    return writeText("Usage: sixb doctor");
  if (args.length !== 0)
    fail("doctor accepts no arguments.");
  const project = asRecord2(await createInstanceApiClient(mode).get("/api/project"));
  if (typeof project.id !== "string" || project.id.length === 0) {
    throw new CliError({ code: "invalid_api_response", message: "The Sixb API returned an invalid project." }, EXIT_API);
  }
  const report = {
    ok: true,
    profile: AGENT_RUNTIME_PROFILE,
    cli: { version: INSTANCE_CLI_VERSION },
    javascript: javascriptRuntime(),
    project: { id: project.id }
  };
  writeJson(report);
}
async function context(args) {
  if (isHelp(args[0]))
    return writeText("Usage: sixb context");
  if (args.length !== 0)
    fail("context accepts no arguments.");
  const path = process.env.SIXB_RUN_CONTEXT;
  if (!path)
    fail("SIXB_RUN_CONTEXT is not set.");
  let text;
  try {
    text = await readFile4(path, "utf8");
  } catch (error) {
    if (isFileError(error, "ENOENT"))
      fail(`Run context '${path}' does not exist.`);
    throw error;
  }
  try {
    writeJson(JSON.parse(text));
  } catch {
    fail(`Run context '${path}' is not valid JSON.`, "invalid_json");
  }
}
function javascriptRuntime() {
  if (typeof globalThis.Bun === "object") {
    return { name: "bun", version: globalThis.Bun.version };
  }
  return { name: "node", version: process.versions.node };
}

// src/agent-cli/index.ts
async function main(args) {
  const [command, ...rest] = args;
  if (!command || isHelp(command))
    return writeText(renderInstanceHelp("sandbox"));
  if (command === "--version" || command === "version") {
    return writeText(`sixb agent CLI ${INSTANCE_CLI_VERSION}`);
  }
  if (command === "doctor")
    return doctor(rest, sandboxMode());
  if (command === "context")
    return context(rest);
  if (command === "memory")
    return memory(rest, sandboxMode());
  if (!isInstanceCommand(command))
    fail(`Unknown command '${command}'. Run 'sixb --help'.`);
  await runInstanceCli({ args, mode: sandboxMode() });
}
function sandboxMode() {
  return {
    kind: "sandbox",
    baseUrl: process.env.SIXB_API_BASE_URL ?? "",
    runContextPath: process.env.SIXB_RUN_CONTEXT ?? ""
  };
}
try {
  await main(process.argv.slice(2));
} catch (error) {
  process.exitCode = reportError(error);
}
