#!/usr/bin/env node

// src/agent-cli/output.ts
var AGENT_CLI_VERSION = "1";
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

// src/agent-cli/arguments.ts
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

// src/agent-cli/commands/index.ts
import { access, readFile as readFile2 } from "node:fs/promises";

// src/agent-cli/api-client.ts
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
class ApiClient {
  baseUrl;
  constructor(baseUrl = process.env.SIXB_API_BASE_URL) {
    if (!baseUrl)
      fail("SIXB_API_BASE_URL is not set.", "runtime_unavailable");
    this.baseUrl = baseUrl.replace(/\/$/, "");
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
    form.append("file", new Blob([await readFile(source)]), basename(source));
    if (logicalPath)
      form.append("logicalPath", logicalPath);
    return this.json(this.url(path), { method: "POST", body: form });
  }
  async download(path, output, query) {
    const response = await this.fetch(this.url(path, query), { method: "GET" });
    await writeFile(output, new Uint8Array(await response.arrayBuffer()));
  }
  url(path, query) {
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
      response = await fetch(url, init);
    } catch {
      throw new CliError({
        code: "api_unreachable",
        message: "The Sixb API gateway could not be reached.",
        hint: "Run 'sixb doctor' to verify the sandbox runtime and gateway."
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
    const structured = asRecord(error);
    throw new CliError({
      code: typeof structured.code === "string" ? structured.code : "http_error",
      status: response.status,
      message: typeof structured.message === "string" ? structured.message : typeof error === "string" ? error : `The Sixb API request failed with HTTP ${response.status}.`,
      ...typeof structured.hint === "string" ? { hint: structured.hint } : {}
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

// src/agent-cli/graph.ts
async function inspectGraph(api, objectTypeId, primaryId, options) {
  let refs = [{ objectTypeId, primaryId, distance: 0 }];
  let frontier = refs;
  const objects = new Map;
  const links = new Map;
  let truncated = false;
  const iterations = Math.max(options.depth, 1);
  for (let level = 0;level < iterations && frontier.length > 0; level += 1) {
    const levelObjects = new Map;
    const levelLinks = new Map;
    let pageToken;
    let continuePaging = true;
    while (continuePaging) {
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
        pageSize: 1000,
        ...pageToken ? { pageToken } : {}
      }));
      for (const object of response.objects)
        levelObjects.set(refKey(object), object);
      for (const link of response.links) {
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
      if (!response.hasMore || level >= options.depth) {
        continuePaging = false;
        continue;
      }
      if (!response.nextPageToken) {
        fail("The object-links API reported another page without a nextPageToken.");
      }
      pageToken = response.nextPageToken;
    }
    for (const [key, object] of levelObjects)
      objects.set(key, object);
    if (level >= options.depth)
      continue;
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
    truncated ||= all.length > options.maxObjects;
    refs = all.slice(0, options.maxObjects);
    frontier = refs.filter((ref) => !seen.has(refKey(ref)));
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
    fail(`Object '${objectTypeId}/${primaryId}' was not found.`);
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
      objectCount: 1 + relatedObjects.length,
      linkCount: filteredLinks.length,
      truncated
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
  return record;
}
function invalidLinksResponse() {
  fail("The object-links API returned an invalid response.");
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

// src/agent-cli/commands/metadata.ts
var MAIN_HELP = `Sixb agent CLI

Usage:
  sixb <command> [options]

The CLI uses the run-scoped SIXB_API_BASE_URL. Do not configure authentication or another origin.
Every command emits JSON except file downloads and help.

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

Files and escape hatch:
  sixb files upload|download ...
  sixb api get|post ...

Run \`sixb <group> --help\` or \`sixb <group> <command> --help\` for exact arguments.
For query IR, run \`sixb objects query --help\` and \`sixb objects query --example list\`.`;
var OBJECTS_HELP = `Usage:
  sixb objects inspect <object-type> <primary-id> [--depth <0-3>] [--max-objects <1-100>] [--full]
  sixb objects list [options]
  sixb objects get <object-type> <primary-id>...
  sixb objects search <text> [--limit <n>]
  sixb objects query --file <path|-> [--include-total|--no-total]
  sixb objects query --example <name>
  sixb objects count --file <path|->
  sixb objects exists --file <path|->
  sixb objects facets --file <path|->
  sixb objects links <object-type> <primary-id> [options]

List options:
  --type <id>                         Exact ontology object type id
  --limit <n>                         0 through 1000
  --offset <n>
  --order-by createdAt|updatedAt|primaryId
  --order asc|desc
  --id-prefix <value>                 Primary-id prefix
  --id-suffix <value>                 Primary-id suffix
  --created-after|--created-before <RFC3339>
  --updated-after|--updated-before <RFC3339>

Links options:
  --link <link-id>
  --direction outgoing|incoming|both  Defaults to both
  --page-size <1-1000>                Defaults to 1000
  --page-token <token>                Continue an edge page
  --include-objects                   Include selected and current-page endpoint objects

Use \`objects inspect\` first when context identifies an object. It follows both relationship
directions to depth 2 by default and returns a bounded graph. Use \`--depth 0\` for only the object.
Inspect omits materialization timestamps and ontology definitions by default. Use \`--full\` when
storage timestamps, declared links, or available actions are needed.

\`objects get\` uses a refs query without identity URL paths. Opaque ids containing :, /, #, ?, or
% are safe. Identifiers are case-sensitive.`;
var QUERY_HELP = `Usage:
  sixb objects query --file <path|-> [--include-total|--no-total]
  sixb objects query --example <exact|filter|incoming|expand|sort|page|facets>
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
  sixb telemetry query --file <path|->`,
  actions: `Usage:
  sixb actions list [--type <object-type>]
  sixb actions get <action-id>
  sixb actions request <action-id> [--subject-type <type> --subject-id <id>] [--params-file <path|->] [--run-id <id>]`,
  "action-runs": `Usage:
  sixb action-runs list [options]
  sixb action-runs get <run-id>`,
  files: `Usage:
  sixb files upload <local-path> [--logical-path <path>]
  sixb files download object <type> <id> --path <json-pointer> --output <local-path>
  sixb files download action-run|workflow-run <run-id> --path <json-pointer> --output <local-path>`,
  workflows: `Usage:
  sixb workflows list
  sixb workflows get <workflow-id>
  sixb workflows start <workflow-id> [--input-file <path|->]`,
  "workflow-runs": `Usage:
  sixb workflow-runs list [options]
  sixb workflow-runs get <run-id>`,
  api: `Usage:
  sixb api get </api/path[?query]> [--output <local-path>]
  sixb api post </api/path> --file <path|->`
};
var QUERY_EXAMPLES = {
  exact: '{"kind":"refs","refs":[{"objectTypeId":"RepositoryIssue","primaryId":"github:issue:owner/repo#297"}]}',
  filter: '{"kind":"limit","input":{"kind":"filter","input":{"kind":"start","objectTypeId":"Customer"},"predicate":{"op":"eq","propertyId":"status","value":"active"}},"limit":20}',
  incoming: '{"kind":"traverse","input":{"kind":"refs","refs":[{"objectTypeId":"RepositoryIssue","primaryId":"github:issue:owner/repo#297"}]},"linkId":"issue","direction":"incoming","sourceObjectTypeId":"RepositoryComment"}',
  expand: '{"kind":"expand","input":{"kind":"refs","refs":[{"objectTypeId":"RepositoryIssue","primaryId":"github:issue:owner/repo#297"}]},"expansions":[{"linkId":"issue","direction":"incoming","sourceObjectTypeId":"RepositoryComment","limit":20}]}',
  sort: '{"kind":"limit","input":{"kind":"sort","input":{"kind":"start","objectTypeId":"Customer"},"fields":[{"kind":"property","propertyId":"name","direction":"asc"}]},"limit":20}',
  page: '{"kind":"page","input":{"kind":"start","objectTypeId":"Customer"},"pageSize":20,"pageToken":"optional-token-from-previous-response"}',
  facets: '{"query":{"kind":"start","objectTypeId":"WorkOrder"},"facets":[{"propertyId":"status","limit":10}]}'
};

// src/agent-cli/commands/index.ts
async function dispatch(command, args) {
  switch (command) {
    case "doctor":
      return doctor(args);
    case "context":
      return context(args);
    case "project":
      return project(args);
    case "ontology":
      return ontology(args);
    case "objects":
      return objects(args);
    case "telemetry":
      return telemetry(args);
    case "actions":
      return actions(args);
    case "action-runs":
      return runs("action", args);
    case "files":
      return files(args);
    case "workflows":
      return workflows(args);
    case "workflow-runs":
      return runs("workflow", args);
    case "api":
      return rawApi(args);
    default:
      fail(`Unknown command '${command}'. Run 'sixb --help'.`);
  }
}
async function doctor(args) {
  if (isHelp(args[0]))
    return writeText(GROUP_HELP.doctor);
  requireExact(args, 0, "doctor accepts no arguments.");
  const api = new ApiClient;
  writeJson({
    ok: true,
    cliVersion: AGENT_CLI_VERSION,
    runtime: runtimeInfo(),
    dependencies: { fetch: true, json: true },
    project: await api.get("/api/project")
  });
}
async function context(args) {
  if (isHelp(args[0]))
    return writeText(GROUP_HELP.context);
  requireExact(args, 0, "context accepts no arguments.");
  const path = process.env.SIXB_RUN_CONTEXT;
  if (!path)
    fail("SIXB_RUN_CONTEXT is not set.");
  try {
    writeJson(JSON.parse(await readFile2(path, "utf8")));
  } catch (error) {
    if (isFileError(error, "ENOENT"))
      fail(`Run context '${path}' does not exist.`);
    fail(`Run context '${path}' is not valid JSON.`, "invalid_json");
  }
}
async function project(args) {
  if (!args[0] || isHelp(args[0]))
    return writeText(GROUP_HELP.project);
  if (args[0] !== "show")
    fail(`Unknown project command '${args[0]}'.`);
  requireExact(args, 1, "project show accepts no arguments.");
  writeJson(await new ApiClient().get("/api/project"));
}
async function ontology(args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub))
    return writeText(GROUP_HELP.ontology);
  const api = new ApiClient;
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
async function objects(args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub))
    return writeText(OBJECTS_HELP);
  switch (sub) {
    case "inspect":
      return objectsInspect(rest);
    case "list":
      return objectsList(rest);
    case "get":
      return objectsGet(rest);
    case "search":
      return objectsSearch(rest);
    case "query":
      return objectsQuery(rest);
    case "count":
    case "exists":
      return objectsScalar(sub, rest);
    case "facets":
      return objectsFacets(rest);
    case "links":
      return objectsLinks(rest);
    default:
      fail(`Unknown objects command '${sub}'.`);
  }
}
async function objectsInspect(args) {
  if (isHelp(args[0])) {
    return writeText("Usage: sixb objects inspect <object-type> <primary-id> [--depth <0-3>] [--max-objects <1-100>] [--full]");
  }
  const objectTypeId = requireValue("objects inspect object type", args[0]);
  const primaryId = requireValue("objects inspect primary id", args[1]);
  let depth = 2;
  let maxObjects = 40;
  let full = false;
  for (let index = 2;index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--full")
      full = true;
    else if (flag === "--depth") {
      depth = integerInRange(flag, requireValue(flag, args[++index]), 0, 3);
    } else if (flag === "--max-objects") {
      maxObjects = integerInRange(flag, requireValue(flag, args[++index]), 1, 100);
    } else
      fail(`Unknown objects inspect option '${flag}'.`);
  }
  writeJson(await inspectGraph(new ApiClient, objectTypeId, primaryId, { depth, maxObjects, full }));
}
async function objectsList(args) {
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
  writeJson(await new ApiClient().get("/api/objects", parseQueryOptions(args, optionNames, "objects list")));
}
async function objectsGet(args) {
  if (isHelp(args[0]))
    return writeText("Usage: sixb objects get <object-type> <primary-id>...");
  const objectTypeId = requireValue("objects get", args[0]);
  if (args.length < 2)
    fail("objects get requires at least one primary id.");
  writeJson(await new ApiClient().post("/api/objects/query", {
    query: {
      kind: "refs",
      refs: args.slice(1).map((primaryId) => ({ objectTypeId, primaryId }))
    },
    includeTotal: false
  }));
}
async function objectsSearch(args) {
  if (isHelp(args[0]))
    return writeText("Usage: sixb objects search <text> [--limit <1-50>]");
  const query = requireValue("objects search", args[0]);
  const options = parseQueryOptions(args.slice(1), { "--limit": "limit" }, "objects search");
  writeJson(await new ApiClient().get("/api/objects/search", { q: query, ...options }));
}
async function objectsQuery(args) {
  if (isHelp(args[0]))
    return writeText(QUERY_HELP);
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
    else if (flag === "--example") {
      const name = requireValue(flag, args[++index]);
      if (name === "list")
        return writeText(Object.keys(QUERY_EXAMPLES).join(" "));
      const example = QUERY_EXAMPLES[name];
      if (!example)
        fail(`Unknown query example '${name}'. Run 'sixb objects query --example list'.`);
      return writeText(example);
    } else
      fail(`Unknown objects query option '${flag}'.`);
  }
  if (!source)
    fail("objects query requires --file <path|->.");
  const input = await readJson(source);
  const record = asRecord2(input);
  const body = Object.hasOwn(record, "query") ? { ...record, ...Object.hasOwn(record, "includeTotal") ? {} : { includeTotal } } : { query: input, includeTotal };
  writeJson(await new ApiClient().post("/api/objects/query", body));
}
async function objectsScalar(operation, args) {
  if (isHelp(args[0]))
    return writeText(`Usage: sixb objects ${operation} --file <path|->`);
  const source = singleFileOption(args, `objects ${operation}`);
  const input = await readJson(source);
  const record = asRecord2(input);
  writeJson(await new ApiClient().post(`/api/objects/query/${operation}`, {
    query: Object.hasOwn(record, "query") ? record.query : input
  }));
}
async function objectsFacets(args) {
  if (isHelp(args[0]))
    return writeText("Usage: sixb objects facets --file <path|->");
  const body = await readJson(singleFileOption(args, "objects facets"));
  const record = asRecord2(body);
  if (!Object.hasOwn(record, "query") || !Object.hasOwn(record, "facets")) {
    fail("objects facets input must contain query and facets.");
  }
  writeJson(await new ApiClient().post("/api/objects/query/facets", body));
}
async function objectsLinks(args) {
  if (isHelp(args[0]))
    return writeText(OBJECTS_HELP);
  const objectTypeId = requireValue("objects links object type", args[0]);
  const primaryId = requireValue("objects links primary id", args[1]);
  let linkId;
  let direction = "both";
  let pageSize = 1000;
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
      pageSize = integerInRange(flag, requireValue(flag, args[++index]), 1, 1000);
    } else if (flag === "--page-token")
      pageToken = requireValue(flag, args[++index]);
    else if (flag === "--include-objects")
      includeObjects = true;
    else
      fail(`Unknown objects links option '${flag}'.`);
  }
  writeJson(await new ApiClient().post("/api/objects/query/links", {
    query: { kind: "refs", refs: [{ objectTypeId, primaryId }] },
    direction,
    includeObjects,
    pageSize,
    ...linkId ? { linkId } : {},
    ...pageToken ? { pageToken } : {}
  }));
}
async function telemetry(args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || isHelp(rest[0]))
    return writeText(GROUP_HELP.telemetry);
  const api = new ApiClient;
  if (sub === "latest") {
    requireExact(rest, 3, "telemetry latest requires object type, primary id, and property id.");
    return writeJson(await api.get(telemetryPath(rest, "latest")));
  }
  if (sub === "history") {
    if (rest.length < 3)
      fail("telemetry history requires object type, primary id, and property id.");
    const query = parseQueryOptions(rest.slice(3), { "--from": "from", "--to": "to", "--limit": "limit", "--order": "order" }, "telemetry history");
    return writeJson(await api.get(telemetryPath(rest, "history"), query));
  }
  if (sub === "query") {
    return writeJson(await api.post("/api/telemetry/history", await readJson(singleFileOption(rest, "telemetry query"))));
  }
  fail(`Unknown telemetry command '${sub}'.`);
}
async function actions(args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || isHelp(rest[0]))
    return writeText(GROUP_HELP.actions);
  const api = new ApiClient;
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
      else if (flag === "--params-file")
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
async function runs(kind, args) {
  const [sub, ...rest] = args;
  const group = `${kind}-runs`;
  if (!sub || isHelp(sub) || isHelp(rest[0]))
    return writeText(GROUP_HELP[group]);
  const api = new ApiClient;
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
    return writeJson(await api.get(`/api/${group}`, parseQueryOptions(rest, kind === "action" ? action : workflow, `${group} list`)));
  }
  fail(`Unknown ${group} command '${sub}'.`);
}
async function files(args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || isHelp(rest[0]))
    return writeText(GROUP_HELP.files);
  const api = new ApiClient;
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
    const context2 = requireValue("files download", rest[0]);
    let route;
    let optionsStart;
    if (context2 === "object") {
      const type = requireValue("files download object", rest[1]);
      const id = requireValue("files download object", rest[2]);
      route = `/api/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}/files/content`;
      optionsStart = 3;
    } else if (context2 === "action-run" || context2 === "workflow-run") {
      const id = requireValue(`files download ${context2}`, rest[1]);
      route = `/api/${context2}s/${encodeURIComponent(id)}/files/content`;
      optionsStart = 2;
    } else
      fail(`Unknown file download context '${context2}'.`);
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
async function workflows(args) {
  const [sub, ...rest] = args;
  if (!sub || isHelp(sub) || isHelp(rest[0]))
    return writeText(GROUP_HELP.workflows);
  const api = new ApiClient;
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
    if (rest.length > 1)
      input = await readJson(singleNamedFileOption(rest.slice(1), "--input-file", "workflows start"));
    if (Array.isArray(input) || typeof input !== "object" || input === null) {
      fail("Workflow input must be a JSON object.");
    }
    return writeJson(await api.post(`/api/workflows/${encodeURIComponent(workflowId ?? "")}/runs`, { input }));
  }
  fail(`Unknown workflows command '${sub}'.`);
}
async function rawApi(args) {
  const [method, path, ...rest] = args;
  if (!method || isHelp(method) || isHelp(path))
    return writeText(GROUP_HELP.api);
  requireValue(`api ${method}`, path);
  const api = new ApiClient;
  if (method === "get") {
    let output;
    if (rest.length > 0)
      output = singleNamedFileOption(rest, "--output", "api get");
    if (output) {
      await api.download(path ?? "", output);
      return writeJson({ downloaded: true, output });
    }
    return writeJson(await api.get(path ?? ""));
  }
  if (method === "post") {
    return writeJson(await api.post(path ?? "", await readJson(singleFileOption(rest, "api post"))));
  }
  fail(`Unknown api method '${method}'. Only get and post are supported.`);
}
function parseQueryOptions(args, names, command) {
  const query = {};
  for (let index = 0;index < args.length; index += 2) {
    const flag = args[index] ?? "";
    const name = names[flag];
    if (!name)
      fail(`Unknown ${command} option '${flag}'.`);
    query[name] = requireValue(flag, args[index + 1]);
  }
  return query;
}
function singleFileOption(args, command) {
  return singleNamedFileOption(args, "--file", command);
}
function singleNamedFileOption(args, flag, command) {
  if (args[0] !== flag)
    fail(`${command} requires ${flag} <path|->.`);
  const source = requireValue(flag, args[1]);
  if (args.length !== 2)
    fail(`${command} accepts only ${flag} <path|->.`);
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
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
function telemetryPath(args, terminal) {
  return `/api/objects/${encodeURIComponent(args[0] ?? "")}/${encodeURIComponent(args[1] ?? "")}/telemetry/${encodeURIComponent(args[2] ?? "")}/${terminal}`;
}
function runtimeInfo() {
  if (typeof globalThis.Bun === "object") {
    return { name: "bun", version: globalThis.Bun.version };
  }
  return { name: "node", version: process.versions.node };
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

// src/agent-cli/index.ts
async function main(args) {
  const [command, ...rest] = args;
  if (!command || isHelp(command))
    return writeText(MAIN_HELP);
  if (command === "--version" || command === "version") {
    return writeText(`sixb agent CLI ${AGENT_CLI_VERSION}`);
  }
  await dispatch(command, rest);
}
try {
  await main(process.argv.slice(2));
} catch (error) {
  process.exitCode = reportError(error);
}
