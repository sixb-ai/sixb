import { access, readFile } from "node:fs/promises"
import { ApiClient } from "../api-client"
import { enumValue, integerInRange, isHelp, requireExact, requireValue } from "../arguments"
import { inspectGraph } from "../graph"
import { AGENT_CLI_VERSION, fail, writeJson, writeText } from "../output"
import { GROUP_HELP, OBJECTS_HELP, QUERY_EXAMPLES, QUERY_HELP } from "./metadata"

type Query = Record<string, string | undefined>

export async function dispatch(command: string, args: string[]): Promise<void> {
  switch (command) {
    case "doctor":
      return doctor(args)
    case "context":
      return context(args)
    case "project":
      return project(args)
    case "ontology":
      return ontology(args)
    case "objects":
      return objects(args)
    case "telemetry":
      return telemetry(args)
    case "actions":
      return actions(args)
    case "action-runs":
      return runs("action", args)
    case "files":
      return files(args)
    case "workflows":
      return workflows(args)
    case "workflow-runs":
      return runs("workflow", args)
    case "api":
      return rawApi(args)
    default:
      fail(`Unknown command '${command}'. Run 'sixb --help'.`)
  }
}

async function doctor(args: string[]): Promise<void> {
  if (isHelp(args[0])) return writeText(GROUP_HELP.doctor)
  requireExact(args, 0, "doctor accepts no arguments.")
  const api = new ApiClient()
  writeJson({
    ok: true,
    cliVersion: AGENT_CLI_VERSION,
    runtime: runtimeInfo(),
    dependencies: { fetch: true, json: true },
    project: await api.get("/api/project"),
  })
}

async function context(args: string[]): Promise<void> {
  if (isHelp(args[0])) return writeText(GROUP_HELP.context)
  requireExact(args, 0, "context accepts no arguments.")
  const path = process.env.SIXB_RUN_CONTEXT
  if (!path) fail("SIXB_RUN_CONTEXT is not set.")
  try {
    writeJson(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if (isFileError(error, "ENOENT")) fail(`Run context '${path}' does not exist.`)
    fail(`Run context '${path}' is not valid JSON.`, "invalid_json")
  }
}

async function project(args: string[]): Promise<void> {
  if (!args[0] || isHelp(args[0])) return writeText(GROUP_HELP.project)
  if (args[0] !== "show") fail(`Unknown project command '${args[0]}'.`)
  requireExact(args, 1, "project show accepts no arguments.")
  writeJson(await new ApiClient().get("/api/project"))
}

async function ontology(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub)) return writeText(GROUP_HELP.ontology)
  const api = new ApiClient()
  if (sub === "list") {
    if (isHelp(rest[0])) return writeText("Usage: sixb ontology list [--full]")
    const full = rest.length === 1 && rest[0] === "--full"
    if (!full && rest.length > 0) fail(`Unknown ontology list option '${rest[0]}'.`)
    const value = await api.get("/api/object-types")
    if (full) return writeJson(value)
    if (!Array.isArray(value)) fail("The ontology API returned an invalid response.")
    return writeJson(
      value.map((entry) => {
        const type = asRecord(entry)
        const properties = asRecords(type.properties)
        return {
          id: type.id,
          name: type.name,
          description: type.description,
          primaryPropertyId: properties.find((property) => property.primary === true)?.id,
          links: asRecords(type.links).map(
            ({ id, name, description, targetObjectTypeId, cardinality }) => ({
              id,
              name,
              ...(description === undefined ? {} : { description }),
              targetObjectTypeId,
              cardinality,
            })
          ),
          actions: asRecords(type.actions).map(({ id, name, description }) => ({
            id,
            name,
            ...(description === undefined ? {} : { description }),
          })),
        }
      })
    )
  }
  if (sub === "get") {
    if (isHelp(rest[0])) return writeText("Usage: sixb ontology get <object-type>")
    requireExact(rest, 1, "ontology get requires exactly one object type.")
    return writeJson(await api.get(`/api/object-types/${encodeURIComponent(rest[0] ?? "")}`))
  }
  fail(`Unknown ontology command '${sub}'.`)
}

async function objects(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub)) return writeText(OBJECTS_HELP)
  switch (sub) {
    case "inspect":
      return objectsInspect(rest)
    case "list":
      return objectsList(rest)
    case "get":
      return objectsGet(rest)
    case "search":
      return objectsSearch(rest)
    case "query":
      return objectsQuery(rest)
    case "count":
    case "exists":
      return objectsScalar(sub, rest)
    case "facets":
      return objectsFacets(rest)
    case "links":
      return objectsLinks(rest)
    default:
      fail(`Unknown objects command '${sub}'.`)
  }
}

async function objectsInspect(args: string[]): Promise<void> {
  if (isHelp(args[0])) {
    return writeText(
      "Usage: sixb objects inspect <object-type> <primary-id> [--depth <0-3>] [--max-objects <1-100>] [--full]"
    )
  }
  const objectTypeId = requireValue("objects inspect object type", args[0])
  const primaryId = requireValue("objects inspect primary id", args[1])
  let depth = 2
  let maxObjects = 40
  let full = false
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === "--full") full = true
    else if (flag === "--depth") {
      depth = integerInRange(flag, requireValue(flag, args[++index]), 0, 3)
    } else if (flag === "--max-objects") {
      maxObjects = integerInRange(flag, requireValue(flag, args[++index]), 1, 100)
    } else fail(`Unknown objects inspect option '${flag}'.`)
  }
  writeJson(
    await inspectGraph(new ApiClient(), objectTypeId, primaryId, { depth, maxObjects, full })
  )
}

async function objectsList(args: string[]): Promise<void> {
  if (isHelp(args[0])) return writeText(OBJECTS_HELP)
  const optionNames: Record<string, string> = {
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
    "--updated-before": "updatedBefore",
  }
  writeJson(
    await new ApiClient().get("/api/objects", parseQueryOptions(args, optionNames, "objects list"))
  )
}

async function objectsGet(args: string[]): Promise<void> {
  if (isHelp(args[0])) return writeText("Usage: sixb objects get <object-type> <primary-id>...")
  const objectTypeId = requireValue("objects get", args[0])
  if (args.length < 2) fail("objects get requires at least one primary id.")
  writeJson(
    await new ApiClient().post("/api/objects/query", {
      query: {
        kind: "refs",
        refs: args.slice(1).map((primaryId) => ({ objectTypeId, primaryId })),
      },
      includeTotal: false,
    })
  )
}

async function objectsSearch(args: string[]): Promise<void> {
  if (isHelp(args[0])) return writeText("Usage: sixb objects search <text> [--limit <1-50>]")
  const query = requireValue("objects search", args[0])
  const options = parseQueryOptions(args.slice(1), { "--limit": "limit" }, "objects search")
  writeJson(await new ApiClient().get("/api/objects/search", { q: query, ...options }))
}

async function objectsQuery(args: string[]): Promise<void> {
  if (isHelp(args[0])) return writeText(QUERY_HELP)
  let source: string | undefined
  let includeTotal = false
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === "--file") source = requireValue(flag, args[++index])
    else if (flag === "--include-total") includeTotal = true
    else if (flag === "--no-total") includeTotal = false
    else if (flag === "--example") {
      const name = requireValue(flag, args[++index])
      if (name === "list") return writeText(Object.keys(QUERY_EXAMPLES).join(" "))
      const example = QUERY_EXAMPLES[name]
      if (!example)
        fail(`Unknown query example '${name}'. Run 'sixb objects query --example list'.`)
      return writeText(example)
    } else fail(`Unknown objects query option '${flag}'.`)
  }
  if (!source) fail("objects query requires --file <path|->.")
  const input = await readJson(source)
  const record = asRecord(input)
  const body = Object.hasOwn(record, "query")
    ? { ...record, ...(Object.hasOwn(record, "includeTotal") ? {} : { includeTotal }) }
    : { query: input, includeTotal }
  writeJson(await new ApiClient().post("/api/objects/query", body))
}

async function objectsScalar(operation: "count" | "exists", args: string[]): Promise<void> {
  if (isHelp(args[0])) return writeText(`Usage: sixb objects ${operation} --file <path|->`)
  const source = singleFileOption(args, `objects ${operation}`)
  const input = await readJson(source)
  const record = asRecord(input)
  writeJson(
    await new ApiClient().post(`/api/objects/query/${operation}`, {
      query: Object.hasOwn(record, "query") ? record.query : input,
    })
  )
}

async function objectsFacets(args: string[]): Promise<void> {
  if (isHelp(args[0])) return writeText("Usage: sixb objects facets --file <path|->")
  const body = await readJson(singleFileOption(args, "objects facets"))
  const record = asRecord(body)
  if (!Object.hasOwn(record, "query") || !Object.hasOwn(record, "facets")) {
    fail("objects facets input must contain query and facets.")
  }
  writeJson(await new ApiClient().post("/api/objects/query/facets", body))
}

async function objectsLinks(args: string[]): Promise<void> {
  if (isHelp(args[0])) return writeText(OBJECTS_HELP)
  const objectTypeId = requireValue("objects links object type", args[0])
  const primaryId = requireValue("objects links primary id", args[1])
  let linkId: string | undefined
  let direction: "outgoing" | "incoming" | "both" = "both"
  let pageSize = 1_000
  let pageToken: string | undefined
  let includeObjects = false
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === "--link") linkId = requireValue(flag, args[++index])
    else if (flag === "--direction") {
      direction = enumValue(flag, requireValue(flag, args[++index]), [
        "outgoing",
        "incoming",
        "both",
      ])
    } else if (flag === "--page-size") {
      pageSize = integerInRange(flag, requireValue(flag, args[++index]), 1, 1_000)
    } else if (flag === "--page-token") pageToken = requireValue(flag, args[++index])
    else if (flag === "--include-objects") includeObjects = true
    else fail(`Unknown objects links option '${flag}'.`)
  }
  writeJson(
    await new ApiClient().post("/api/objects/query/links", {
      query: { kind: "refs", refs: [{ objectTypeId, primaryId }] },
      direction,
      includeObjects,
      pageSize,
      ...(linkId ? { linkId } : {}),
      ...(pageToken ? { pageToken } : {}),
    })
  )
}

async function telemetry(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || isHelp(rest[0])) return writeText(GROUP_HELP.telemetry)
  const api = new ApiClient()
  if (sub === "latest") {
    requireExact(rest, 3, "telemetry latest requires object type, primary id, and property id.")
    return writeJson(await api.get(telemetryPath(rest, "latest")))
  }
  if (sub === "history") {
    if (rest.length < 3)
      fail("telemetry history requires object type, primary id, and property id.")
    const query = parseQueryOptions(
      rest.slice(3),
      { "--from": "from", "--to": "to", "--limit": "limit", "--order": "order" },
      "telemetry history"
    )
    return writeJson(await api.get(telemetryPath(rest, "history"), query))
  }
  if (sub === "query") {
    return writeJson(
      await api.post(
        "/api/telemetry/history",
        await readJson(singleFileOption(rest, "telemetry query"))
      )
    )
  }
  fail(`Unknown telemetry command '${sub}'.`)
}

async function actions(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || isHelp(rest[0])) return writeText(GROUP_HELP.actions)
  const api = new ApiClient()
  if (sub === "get") {
    requireExact(rest, 1, "actions get requires exactly one action id.")
    return writeJson(await api.get(`/api/actions/${encodeURIComponent(rest[0] ?? "")}`))
  }
  if (sub === "list") {
    const options = parseQueryOptions(rest, { "--type": "objectTypeId" }, "actions list")
    const response = await api.get("/api/actions")
    if (!options.objectTypeId) return writeJson(response)
    if (!Array.isArray(response)) fail("The actions API returned an invalid response.")
    return writeJson(
      response.filter((value) => asRecord(value).objectTypeId === options.objectTypeId)
    )
  }
  if (sub === "request") {
    const actionId = requireValue("actions request", rest[0])
    let subjectType: string | undefined
    let subjectId: string | undefined
    let paramsSource: string | undefined
    let runId: string | undefined
    for (let index = 1; index < rest.length; index += 1) {
      const flag = rest[index]
      if (flag === "--subject-type") subjectType = requireValue(flag, rest[++index])
      else if (flag === "--subject-id") subjectId = requireValue(flag, rest[++index])
      else if (flag === "--params-file") paramsSource = requireValue(flag, rest[++index])
      else if (flag === "--run-id") runId = requireValue(flag, rest[++index])
      else fail(`Unknown actions request option '${flag}'.`)
    }
    if (Boolean(subjectType) !== Boolean(subjectId)) {
      fail("--subject-type and --subject-id must be provided together.")
    }
    const params = paramsSource ? await readJson(paramsSource) : {}
    if (Array.isArray(params) || typeof params !== "object" || params === null) {
      fail("Action params must be a JSON object.")
    }
    return writeJson(
      await api.post(`/api/actions/${encodeURIComponent(actionId)}`, {
        params,
        ...(subjectType && subjectId
          ? { subject: { kind: "object", objectTypeId: subjectType, primaryId: subjectId } }
          : {}),
        ...(runId ? { runId } : {}),
      })
    )
  }
  fail(`Unknown actions command '${sub}'.`)
}

async function runs(kind: "action" | "workflow", args: string[]): Promise<void> {
  const [sub, ...rest] = args
  const group = `${kind}-runs` as "action-runs" | "workflow-runs"
  if (!sub || isHelp(sub) || isHelp(rest[0])) return writeText(GROUP_HELP[group])
  const api = new ApiClient()
  if (sub === "get") {
    requireExact(rest, 1, `${group} get requires exactly one run id.`)
    return writeJson(await api.get(`/api/${group}/${encodeURIComponent(rest[0] ?? "")}`))
  }
  if (sub === "list") {
    const common = {
      "--status": "status",
      "--started-after": "startedAfter",
      "--started-before": "startedBefore",
      "--limit": "limit",
      "--offset": "offset",
      "--order": "order",
    }
    const action = {
      ...common,
      "--action": "actionId",
      "--type": "objectTypeId",
      "--id": "primaryId",
    }
    const workflow = { ...common, "--workflow": "workflowId" }
    return writeJson(
      await api.get(
        `/api/${group}`,
        parseQueryOptions(rest, kind === "action" ? action : workflow, `${group} list`)
      )
    )
  }
  fail(`Unknown ${group} command '${sub}'.`)
}

async function files(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || isHelp(rest[0])) return writeText(GROUP_HELP.files)
  const api = new ApiClient()
  if (sub === "upload") {
    const source = requireValue("files upload", rest[0])
    try {
      await access(source)
    } catch {
      fail(`Upload file '${source}' does not exist.`)
    }
    let logicalPath: string | undefined
    if (rest.length > 1) {
      if (rest[1] !== "--logical-path") fail(`Unknown files upload option '${rest[1]}'.`)
      logicalPath = requireValue("--logical-path", rest[2])
      requireExact(rest, 3, "files upload accepts only --logical-path <path>.")
    }
    return writeJson(await api.upload("/api/files", source, logicalPath))
  }
  if (sub === "download") {
    const context = requireValue("files download", rest[0])
    let route: string
    let optionsStart: number
    if (context === "object") {
      const type = requireValue("files download object", rest[1])
      const id = requireValue("files download object", rest[2])
      route = `/api/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}/files/content`
      optionsStart = 3
    } else if (context === "action-run" || context === "workflow-run") {
      const id = requireValue(`files download ${context}`, rest[1])
      route = `/api/${context}s/${encodeURIComponent(id)}/files/content`
      optionsStart = 2
    } else fail(`Unknown file download context '${context}'.`)
    const parsed = parseQueryOptions(
      rest.slice(optionsStart),
      { "--path": "path", "--output": "output" },
      "files download"
    )
    if (!parsed.path) fail("files download requires --path <json-pointer>.")
    if (!parsed.output) fail("files download requires --output <local-path>.")
    await api.download(route, parsed.output, { path: parsed.path })
    return writeJson({ downloaded: true, output: parsed.output })
  }
  fail(`Unknown files command '${sub}'.`)
}

async function workflows(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || isHelp(rest[0])) return writeText(GROUP_HELP.workflows)
  const api = new ApiClient()
  if (sub === "list") {
    requireExact(rest, 0, "workflows list accepts no arguments.")
    return writeJson(await api.get("/api/workflows"))
  }
  const workflowId = rest[0]
  if (sub === "get") {
    requireExact(rest, 1, "workflows get requires exactly one workflow id.")
    return writeJson(await api.get(`/api/workflows/${encodeURIComponent(workflowId ?? "")}`))
  }
  if (sub === "start") {
    requireValue("workflows start", workflowId)
    let input: unknown = {}
    if (rest.length > 1)
      input = await readJson(
        singleNamedFileOption(rest.slice(1), "--input-file", "workflows start")
      )
    if (Array.isArray(input) || typeof input !== "object" || input === null) {
      fail("Workflow input must be a JSON object.")
    }
    return writeJson(
      await api.post(`/api/workflows/${encodeURIComponent(workflowId ?? "")}/runs`, { input })
    )
  }
  fail(`Unknown workflows command '${sub}'.`)
}

async function rawApi(args: string[]): Promise<void> {
  const [method, path, ...rest] = args
  if (!method || isHelp(method) || isHelp(path)) return writeText(GROUP_HELP.api)
  requireValue(`api ${method}`, path)
  const api = new ApiClient()
  if (method === "get") {
    let output: string | undefined
    if (rest.length > 0) output = singleNamedFileOption(rest, "--output", "api get")
    if (output) {
      await api.download(path ?? "", output)
      return writeJson({ downloaded: true, output })
    }
    return writeJson(await api.get(path ?? ""))
  }
  if (method === "post") {
    return writeJson(await api.post(path ?? "", await readJson(singleFileOption(rest, "api post"))))
  }
  fail(`Unknown api method '${method}'. Only get and post are supported.`)
}

function parseQueryOptions(
  args: readonly string[],
  names: Readonly<Record<string, string>>,
  command: string
): Query {
  const query: Query = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? ""
    const name = names[flag]
    if (!name) fail(`Unknown ${command} option '${flag}'.`)
    query[name] = requireValue(flag, args[index + 1])
  }
  return query
}

function singleFileOption(args: readonly string[], command: string): string {
  return singleNamedFileOption(args, "--file", command)
}

function singleNamedFileOption(args: readonly string[], flag: string, command: string): string {
  if (args[0] !== flag) fail(`${command} requires ${flag} <path|->.`)
  const source = requireValue(flag, args[1])
  if (args.length !== 2) fail(`${command} accepts only ${flag} <path|->.`)
  return source
}

async function readJson(source: string): Promise<unknown> {
  let text: string
  try {
    text = source === "-" ? await readStdin() : await readFile(source, "utf8")
  } catch (error) {
    if (isFileError(error, "ENOENT")) fail(`JSON file '${source}' does not exist.`)
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    fail(
      source === "-"
        ? "Standard input is not valid JSON."
        : `JSON file '${source}' is not valid JSON.`,
      "invalid_json"
    )
  }
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

function telemetryPath(args: readonly string[], terminal: "latest" | "history"): string {
  return `/api/objects/${encodeURIComponent(args[0] ?? "")}/${encodeURIComponent(args[1] ?? "")}/telemetry/${encodeURIComponent(args[2] ?? "")}/${terminal}`
}

function runtimeInfo(): { readonly name: "bun" | "node"; readonly version: string } {
  if (typeof globalThis.Bun === "object") {
    return { name: "bun", version: globalThis.Bun.version }
  }
  return { name: "node", version: process.versions.node }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : []
}

function isFileError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}
