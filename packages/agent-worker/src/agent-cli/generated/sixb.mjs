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
  async post(path, body) {
    return this.json(this.url(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }
  async upload(path, source, logicalPath) {
    const form = new FormData;
    form.append("file", new Blob([new Uint8Array(await readFile(source))]), basename(source));
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
    } catch {
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
var RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function isHelp(value) {
  return value === "-h" || value === "--help" || value === "help";
}
function requireValue(label, value) {
  if (!value)
    fail(`${label} requires a value.`);
  return value;
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
  return `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
}
// ../cli-core/src/policies.ts
var CLI_LIMITS = {
  list: { default: 20, maximum: 1000 },
  search: { default: 20, maximum: 50 },
  telemetryHistory: { default: 100, maximum: 1000 },
  linkPage: { default: 100, maximum: 1000 },
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
For query IR, run \`sixb objects query --help\` and \`sixb objects query --example list\`.`;
var LOCAL_MAIN_HELP = SANDBOX_MAIN_HELP.replace("Sixb agent CLI", "Sixb instance CLI").replace("The CLI uses the run-scoped SIXB_API_BASE_URL. Do not configure authentication or another origin.", "The CLI uses the selected local profile and its API credentials.").replace(`  sixb doctor                         Check the sandbox and API gateway
  sixb context                        Print the current run context
`, "");
function renderInstanceHelp(mode) {
  return mode === "sandbox" ? SANDBOX_MAIN_HELP : LOCAL_MAIN_HELP;
}
var OBJECTS_HELP = `Usage:
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

Use \`objects inspect\` first when context identifies an object. It follows both relationship
directions to depth 2 by default and returns a bounded graph.
Inspect omits materialization timestamps and ontology definitions by default. Use \`--full\` when
storage timestamps, declared links, or available actions are needed.

Search returns at most ${CLI_LIMITS.search.maximum} matches and defaults to ${CLI_LIMITS.search.default}.

\`objects get\` uses a refs query without identity URL paths. Opaque ids containing :, /, #, ?, or
% are safe. Identifiers are case-sensitive.`;
var QUERY_HELP = `Usage:
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
identities. Put limits and pages inside the query tree.`;
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

The JSON file contains the action parameter object. Use - to read standard input.`,
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
  --order <asc|desc>            Started-time order; defaults to ${DEFAULT_LIST_ORDER}`
};
var QUERY_EXAMPLES = {
  exact: '{"kind":"refs","refs":[{"objectTypeId":"RepositoryIssue","primaryId":"github:issue:owner/repo#297"}]}',
  filter: `{"kind":"limit","input":{"kind":"filter","input":{"kind":"start","objectTypeId":"Customer"},"predicate":{"op":"eq","propertyId":"status","value":"active"}},"limit":${CLI_LIMITS.list.default}}`,
  incoming: '{"kind":"traverse","input":{"kind":"refs","refs":[{"objectTypeId":"RepositoryIssue","primaryId":"github:issue:owner/repo#297"}]},"linkId":"issue","direction":"incoming","sourceObjectTypeId":"RepositoryComment"}',
  expand: `{"kind":"expand","input":{"kind":"refs","refs":[{"objectTypeId":"RepositoryIssue","primaryId":"github:issue:owner/repo#297"}]},"expansions":[{"linkId":"issue","direction":"incoming","sourceObjectTypeId":"RepositoryComment","limit":${CLI_LIMITS.list.default}}]}`,
  sort: `{"kind":"limit","input":{"kind":"sort","input":{"kind":"start","objectTypeId":"Customer"},"fields":[{"kind":"property","propertyId":"name","direction":"asc"}]},"limit":${CLI_LIMITS.list.default}}`,
  page: `{"kind":"page","input":{"kind":"start","objectTypeId":"Customer"},"pageSize":${CLI_LIMITS.list.default}}`
};
var FACETS_EXAMPLE = '{"query":{"kind":"start","objectTypeId":"WorkOrder"},"facets":[{"propertyId":"status","limit":10}]}';

// ../cli-core/src/commands/shared.ts
import { readFile as readFile2 } from "node:fs/promises";
function parseQueryOptions(args, names, command) {
  const query = {};
  for (let index = 0;index < args.length; index += 2) {
    const flag = args[index] ?? "";
    const name = names[flag];
    if (!name)
      fail(`Unknown ${command} option '${flag}'.`);
    query[name] = requireOptionValue(flag, args[index + 1]);
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
  if (args[0] !== "--file")
    fail(`${command} requires --file <path|->.`);
  const source = requireOptionValue("--file", args[1]);
  if (args.length !== 2)
    fail(`${command} accepts only --file <path|->.`);
  return source;
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
function isFileError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
function requireOptionValue(label, value) {
  if (!value)
    fail(`${label} requires a value.`);
  return value;
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// ../cli-core/src/commands/actions.ts
async function actions(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || isHelp(rest[0]))
    return writeText(GROUP_HELP.actions);
  if (sub === "get") {
    requireExact(rest, 1, "actions get requires exactly one action id.");
    return writeJson(await api.get(`/api/actions/${encodeURIComponent(rest[0] ?? "")}`));
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
    const actionId = requireValue("actions request", rest[0]);
    let subjectType;
    let subjectId;
    let paramsSource;
    let runId;
    for (let index = 1;index < rest.length; index += 1) {
      const flag = rest[index];
      if (flag === "--subject-type")
        subjectType = requireValue(flag, rest[++index]);
      else if (flag === "--subject-id")
        subjectId = requireValue(flag, rest[++index]);
      else if (flag === "--file")
        paramsSource = requireValue(flag, rest[++index]);
      else if (flag === "--run-id")
        runId = requireValue(flag, rest[++index]);
      else
        fail(`Unknown actions request option '${flag}'.`);
    }
    if (Boolean(subjectType) !== Boolean(subjectId)) {
      fail("--subject-type and --subject-id must be provided together.");
    }
    const params = paramsSource ? await readJson(paramsSource) : {};
    if (Array.isArray(params) || typeof params !== "object" || params === null) {
      fail("Action params must be a JSON object.");
    }
    return writeJson(await api.post(`/api/actions/${encodeURIComponent(actionId)}`, {
      params,
      ...subjectType && subjectId ? { subject: { kind: "object", objectTypeId: subjectType, primaryId: subjectId } } : {},
      ...runId ? { runId } : {}
    }));
  }
  fail(`Unknown actions command '${sub}'.`);
}

// ../cli-core/src/commands/files.ts
import { access } from "node:fs/promises";
async function files(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || isHelp(rest[0]))
    return writeText(GROUP_HELP.files);
  if (sub === "upload") {
    const source = requireValue("files upload", rest[0]);
    try {
      await access(source);
    } catch {
      fail(`Upload file '${source}' does not exist.`);
    }
    let logicalPath;
    if (rest.length > 1) {
      if (rest[1] !== "--logical-path")
        fail(`Unknown files upload option '${rest[1]}'.`);
      logicalPath = requireValue("--logical-path", rest[2]);
      requireExact(rest, 3, "files upload accepts only --logical-path <path>.");
    }
    return writeJson(await api.upload("/api/files", source, logicalPath));
  }
  if (sub === "download") {
    const context = requireValue("files download", rest[0]);
    let route;
    let optionsStart;
    if (context === "object") {
      const type = requireValue("files download object", rest[1]);
      const id = requireValue("files download object", rest[2]);
      route = `/api/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}/files/content`;
      optionsStart = 3;
    } else if (context === "action-run" || context === "workflow-run") {
      const id = requireValue(`files download ${context}`, rest[1]);
      route = `/api/${context}s/${encodeURIComponent(id)}/files/content`;
      optionsStart = 2;
    } else
      fail(`Unknown file download context '${context}'.`);
    const parsed = parseQueryOptions(rest.slice(optionsStart), { "--path": "path", "--output": "output" }, "files download");
    if (!parsed.path)
      fail("files download requires --path <json-pointer>.");
    if (!parsed.output)
      fail("files download requires --output <local-path>.");
    await api.download(route, parsed.output, { path: parsed.path });
    return writeJson({ downloaded: true, output: parsed.output });
  }
  fail(`Unknown files command '${sub}'.`);
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
  if (isHelp(args[0]))
    return writeText(OBJECTS_HELP);
  const objectTypeId = requireValue("objects inspect object type", args[0]);
  const primaryId = requireValue("objects inspect primary id", args[1]);
  let depth = CLI_LIMITS.inspect.depth.default;
  let maxObjects = CLI_LIMITS.inspect.objects.default;
  let maxLinks = CLI_LIMITS.inspect.links.default;
  let full = false;
  for (let index = 2;index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--full")
      full = true;
    else if (flag === "--depth") {
      depth = integerInRange(flag, requireValue(flag, args[++index]), 0, CLI_LIMITS.inspect.depth.maximum);
    } else if (flag === "--max-objects") {
      maxObjects = integerInRange(flag, requireValue(flag, args[++index]), 1, CLI_LIMITS.inspect.objects.maximum);
    } else if (flag === "--max-links") {
      maxLinks = integerInRange(flag, requireValue(flag, args[++index]), 1, CLI_LIMITS.inspect.links.maximum);
    } else
      fail(`Unknown objects inspect option '${flag}'.`);
  }
  writeJson(await inspectGraph(api, objectTypeId, primaryId, {
    depth,
    maxObjects,
    maxLinks,
    full
  }));
}
async function objectsList(api, args) {
  if (isHelp(args[0]))
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
  if (isHelp(args[0]))
    return writeText("Usage: sixb objects get <object-type> <primary-id>...");
  const objectTypeId = requireValue("objects get", args[0]);
  if (args.length < 2)
    fail("objects get requires at least one primary id.");
  writeJson(await api.post("/api/objects/query", {
    query: {
      kind: "refs",
      refs: args.slice(1).map((primaryId) => ({ objectTypeId, primaryId }))
    },
    includeTotal: false
  }));
}
async function objectsSearch(api, args) {
  if (isHelp(args[0])) {
    return writeText(`Usage: sixb objects search <text> [--limit <1-${CLI_LIMITS.search.maximum}>]`);
  }
  const query = requireValue("objects search", args[0]);
  const options = parseQueryOptions(args.slice(1), { "--limit": "limit" }, "objects search");
  options.limit = String(integerInRange("--limit", options.limit ?? String(CLI_LIMITS.search.default), 1, CLI_LIMITS.search.maximum));
  writeJson(await api.get("/api/objects/search", { q: query, ...options }));
}
async function objectsQuery(api, args) {
  if (isHelp(args[0]))
    return writeText(QUERY_HELP);
  if (args[0] === "--example") {
    if (args.length !== 2)
      fail("objects query --example requires exactly one example name.");
    const name = requireValue("--example", args[1]);
    if (name === "list")
      return writeText(Object.keys(QUERY_EXAMPLES).join(" "));
    const example = QUERY_EXAMPLES[name];
    if (!example)
      fail(`Unknown query example '${name}'. Run 'sixb objects query --example list'.`);
    return writeText(example);
  }
  let source;
  let includeTotal = false;
  for (let index = 0;index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--file")
      source = requireValue(flag, args[++index]);
    else if (flag === "--include-total")
      includeTotal = true;
    else if (flag === "--no-total")
      includeTotal = false;
    else
      fail(`Unknown objects query option '${flag}'.`);
  }
  if (!source)
    fail("objects query requires --file <path|->.");
  const input = await readJson(source);
  const record = asRecord2(input);
  const body = Object.hasOwn(record, "query") ? { ...record, ...Object.hasOwn(record, "includeTotal") ? {} : { includeTotal } } : { query: input, includeTotal };
  writeJson(await api.post("/api/objects/query", body));
}
async function objectsScalar(api, operation, args) {
  if (isHelp(args[0]))
    return writeText(`Usage: sixb objects ${operation} --file <path|->`);
  const source = singleFileOption(args, `objects ${operation}`);
  const input = await readJson(source);
  const record = asRecord2(input);
  writeJson(await api.post(`/api/objects/query/${operation}`, {
    query: Object.hasOwn(record, "query") ? record.query : input
  }));
}
async function objectsFacets(api, args) {
  if (isHelp(args[0])) {
    return writeText(`Usage: sixb objects facets --file <path|->
       sixb objects facets --example`);
  }
  if (args.length === 1 && args[0] === "--example")
    return writeText(FACETS_EXAMPLE);
  const body = await readJson(singleFileOption(args, "objects facets"));
  const record = asRecord2(body);
  if (!Object.hasOwn(record, "query") || !Object.hasOwn(record, "facets")) {
    fail("objects facets input must contain query and facets.");
  }
  writeJson(await api.post("/api/objects/query/facets", body));
}
async function objectsLinks(api, args) {
  if (isHelp(args[0]))
    return writeText(OBJECTS_HELP);
  const objectTypeId = requireValue("objects links object type", args[0]);
  const primaryId = requireValue("objects links primary id", args[1]);
  let linkId;
  let direction = "both";
  let pageSize = CLI_LIMITS.linkPage.default;
  let pageToken;
  let includeObjects = false;
  for (let index = 2;index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--link")
      linkId = requireValue(flag, args[++index]);
    else if (flag === "--direction") {
      direction = enumValue(flag, requireValue(flag, args[++index]), [
        "outgoing",
        "incoming",
        "both"
      ]);
    } else if (flag === "--page-size") {
      pageSize = integerInRange(flag, requireValue(flag, args[++index]), 1, CLI_LIMITS.linkPage.maximum);
    } else if (flag === "--page-token")
      pageToken = requireValue(flag, args[++index]);
    else if (flag === "--include-objects")
      includeObjects = true;
    else
      fail(`Unknown objects links option '${flag}'.`);
  }
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
    if (isHelp(rest[0]))
      return writeText("Usage: sixb ontology list [--full]");
    const full = rest.length === 1 && rest[0] === "--full";
    if (!full && rest.length > 0)
      fail(`Unknown ontology list option '${rest[0]}'.`);
    const value = await api.get("/api/object-types");
    if (full)
      return writeJson(value);
    if (!Array.isArray(value))
      fail("The ontology API returned an invalid response.");
    return writeJson(value.map((entry) => {
      const type = asRecord2(entry);
      const properties = asRecords(type.properties);
      return {
        id: type.id,
        name: type.name,
        description: type.description,
        primaryPropertyId: properties.find((property) => property.primary === true)?.id,
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
    if (isHelp(rest[0]))
      return writeText("Usage: sixb ontology get <object-type>");
    requireExact(rest, 1, "ontology get requires exactly one object type.");
    return writeJson(await api.get(`/api/object-types/${encodeURIComponent(rest[0] ?? "")}`));
  }
  fail(`Unknown ontology command '${sub}'.`);
}

// ../cli-core/src/commands/project.ts
async function project(api, args) {
  if (!args[0] || isHelp(args[0]) || args[0] === "show" && isHelp(args[1])) {
    return writeText(GROUP_HELP.project);
  }
  if (args[0] !== "show")
    fail(`Unknown project command '${args[0]}'.`);
  requireExact(args, 1, "project show accepts no arguments.");
  writeJson(await api.get("/api/project"));
}

// ../cli-core/src/commands/runs.ts
var ACTION_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"];
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
  if (!sub || isHelp(sub) || isHelp(rest[0]))
    return writeText(GROUP_HELP[group]);
  if (sub === "get") {
    requireExact(rest, 1, `${group} get requires exactly one run id.`);
    return writeJson(await api.get(`/api/${group}/${encodeURIComponent(rest[0] ?? "")}`));
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
  if (!sub || isHelp(sub) || isHelp(rest[0]))
    return writeText(GROUP_HELP.telemetry);
  if (sub === "latest") {
    requireExact(rest, 3, "telemetry latest requires object type, primary id, and property id.");
    return writeJson(await api.get(telemetryPath(rest, "latest")));
  }
  if (sub === "history") {
    if (rest.length < 3)
      fail("telemetry history requires object type, primary id, and property id.");
    const query = normalizeWindowOptions(parseQueryOptions(rest.slice(3), { "--from": "from", "--to": "to", "--limit": "limit", "--order": "order" }, "telemetry history"), {
      defaultLimit: CLI_LIMITS.telemetryHistory.default,
      maximumLimit: CLI_LIMITS.telemetryHistory.maximum,
      defaultOrder: DEFAULT_TELEMETRY_ORDER
    });
    if (query.from !== undefined)
      query.from = rfc3339Value("--from", query.from);
    if (query.to !== undefined)
      query.to = rfc3339Value("--to", query.to);
    requireOrderedRange("--from", query.from, "--to", query.to);
    return writeJson(await api.get(telemetryPath(rest, "history"), query));
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

// ../cli-core/src/commands/workflows.ts
async function workflows(api, args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || isHelp(rest[0]))
    return writeText(GROUP_HELP.workflows);
  if (sub === "list") {
    requireExact(rest, 0, "workflows list accepts no arguments.");
    return writeJson(await api.get("/api/workflows"));
  }
  const workflowId = rest[0];
  if (sub === "get") {
    requireExact(rest, 1, "workflows get requires exactly one workflow id.");
    return writeJson(await api.get(`/api/workflows/${encodeURIComponent(workflowId ?? "")}`));
  }
  if (sub === "start") {
    requireValue("workflows start", workflowId);
    let input = {};
    if (rest.length > 1) {
      input = await readJson(singleFileOption(rest.slice(1), "workflows start"));
    }
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
  "workflow-runs"
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
// src/agent-cli/commands/system.ts
import { readFile as readFile3 } from "node:fs/promises";

// src/agent-runtime/profile.ts
var AGENT_RUNTIME_PROFILE = "sixb-agent-runtime/v1";

// src/agent-cli/commands/system.ts
async function doctor(args, mode) {
  if (isHelp(args[0]))
    return writeText("Usage: sixb doctor");
  if (args.length !== 0)
    fail("doctor accepts no arguments.");
  const project2 = asRecord2(await createInstanceApiClient(mode).get("/api/project"));
  if (typeof project2.id !== "string" || project2.id.length === 0) {
    throw new CliError({ code: "invalid_api_response", message: "The Sixb API returned an invalid project." }, EXIT_API);
  }
  const report = {
    ok: true,
    profile: AGENT_RUNTIME_PROFILE,
    cli: { version: INSTANCE_CLI_VERSION },
    javascript: javascriptRuntime(),
    project: { id: project2.id }
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
    text = await readFile3(path, "utf8");
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
