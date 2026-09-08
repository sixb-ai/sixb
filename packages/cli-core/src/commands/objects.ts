import type { ApiClient } from "../api-client"
import {
  enumValue,
  integerInRange,
  isHelp,
  parseCommandArgs,
  requestsHelp,
  requireOrderedRange,
  rfc3339Value,
} from "../arguments"
import { inspectGraph } from "../graph"
import { fail, writeJson, writeText } from "../output"
import { CLI_LIMITS, DEFAULT_LIST_ORDER, DEFAULT_OBJECT_ORDER_BY } from "../policies"
import { FACETS_EXAMPLE, OBJECTS_HELP, QUERY_EXAMPLES, QUERY_HELP } from "./metadata"
import {
  asRecord,
  normalizeWindowOptions,
  parseQueryOptions,
  readJson,
  singleFileOption,
} from "./shared"

export async function objects(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub)) return writeText(OBJECTS_HELP)
  switch (sub) {
    case "inspect":
      return objectsInspect(api, rest)
    case "list":
      return objectsList(api, rest)
    case "get":
      return objectsGet(api, rest)
    case "search":
      return objectsSearch(api, rest)
    case "query":
      return objectsQuery(api, rest)
    case "count":
    case "exists":
      return objectsScalar(api, sub, rest)
    case "facets":
      return objectsFacets(api, rest)
    case "links":
      return objectsLinks(api, rest)
    default:
      fail(`Unknown objects command '${sub}'.`)
  }
}

async function objectsInspect(api: ApiClient, args: readonly string[]): Promise<void> {
  if (requestsHelp(args)) return writeText(OBJECTS_HELP)
  const { positionals, options } = parseCommandArgs(
    args,
    {
      "--full": "boolean",
      "--depth": "string",
      "--max-objects": "string",
      "--max-links": "string",
    },
    "objects inspect",
    2
  )
  const objectTypeId = positionals[0] ?? ""
  const primaryId = positionals[1] ?? ""
  const depth = integerInRange(
    "--depth",
    options["--depth"] ?? String(CLI_LIMITS.inspect.depth.default),
    0,
    CLI_LIMITS.inspect.depth.maximum
  )
  const maxObjects = integerInRange(
    "--max-objects",
    options["--max-objects"] ?? String(CLI_LIMITS.inspect.objects.default),
    1,
    CLI_LIMITS.inspect.objects.maximum
  )
  const maxLinks = integerInRange(
    "--max-links",
    options["--max-links"] ?? String(CLI_LIMITS.inspect.links.default),
    1,
    CLI_LIMITS.inspect.links.maximum
  )
  const full = options["--full"] ?? false
  writeJson(
    await inspectGraph(api, objectTypeId, primaryId, {
      depth,
      maxObjects,
      maxLinks,
      full,
    })
  )
}

async function objectsList(api: ApiClient, args: readonly string[]): Promise<void> {
  if (requestsHelp(args)) return writeText(OBJECTS_HELP)
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
  const options = normalizeWindowOptions(parseQueryOptions(args, optionNames, "objects list"), {
    defaultLimit: CLI_LIMITS.list.default,
    maximumLimit: CLI_LIMITS.list.maximum,
    defaultOrder: DEFAULT_LIST_ORDER,
    offset: true,
  })
  options.orderBy = enumValue("--order-by", options.orderBy ?? DEFAULT_OBJECT_ORDER_BY, [
    "createdAt",
    "updatedAt",
    "primaryId",
  ])
  for (const [name, flag] of [
    ["createdAfter", "--created-after"],
    ["createdBefore", "--created-before"],
    ["updatedAfter", "--updated-after"],
    ["updatedBefore", "--updated-before"],
  ] as const) {
    if (options[name] !== undefined) options[name] = rfc3339Value(flag, options[name])
  }
  requireOrderedRange(
    "--created-after",
    options.createdAfter,
    "--created-before",
    options.createdBefore
  )
  requireOrderedRange(
    "--updated-after",
    options.updatedAfter,
    "--updated-before",
    options.updatedBefore
  )
  writeJson(await api.get("/api/objects", options))
}

async function objectsGet(api: ApiClient, args: readonly string[]): Promise<void> {
  if (requestsHelp(args)) return writeText("Usage: sixb objects get <object-type> <primary-id>...")
  const { positionals } = parseCommandArgs(args, {}, "objects get", [2, Number.POSITIVE_INFINITY])
  const objectTypeId = positionals[0] ?? ""
  writeJson(
    await api.post("/api/objects/query", {
      query: {
        kind: "refs",
        refs: positionals.slice(1).map((primaryId) => ({ objectTypeId, primaryId })),
      },
      includeTotal: false,
    })
  )
}

async function objectsSearch(api: ApiClient, args: readonly string[]): Promise<void> {
  if (requestsHelp(args)) {
    return writeText(`Usage: sixb objects search <text> [--limit <1-${CLI_LIMITS.search.maximum}>]`)
  }
  const { positionals, options } = parseCommandArgs(
    args,
    { "--limit": "string" },
    "objects search",
    1
  )
  const limit = String(
    integerInRange(
      "--limit",
      options["--limit"] ?? String(CLI_LIMITS.search.default),
      1,
      CLI_LIMITS.search.maximum
    )
  )
  writeJson(await api.get("/api/objects/search", { q: positionals[0], limit }))
}

async function objectsQuery(api: ApiClient, args: readonly string[]): Promise<void> {
  if (requestsHelp(args)) return writeText(QUERY_HELP)
  const { options } = parseCommandArgs(
    args,
    {
      "--example": "string",
      "--file": "string",
      "--include-total": "boolean",
      "--no-total": "boolean",
    },
    "objects query"
  )
  if (options["--include-total"] && options["--no-total"])
    fail("--include-total and --no-total cannot be used together.")
  if (options["--example"]) {
    if (Object.keys(options).length !== 1) fail("--example cannot be combined with query options.")
    const name = options["--example"]
    if (name === "list") return writeText(Object.keys(QUERY_EXAMPLES).join(" "))
    const example = QUERY_EXAMPLES[name]
    if (!example) fail(`Unknown query example '${name}'. Run 'sixb objects query --example list'.`)
    return writeText(example)
  }
  const source = options["--file"]
  const includeTotal = options["--include-total"] ?? false
  if (!source) fail("objects query requires --file <path|->.")
  const input = await readJson(source)
  const record = asRecord(input)
  const body = Object.hasOwn(record, "query")
    ? { ...record, ...(Object.hasOwn(record, "includeTotal") ? {} : { includeTotal }) }
    : { query: input, includeTotal }
  writeJson(await api.post("/api/objects/query", body))
}

async function objectsScalar(
  api: ApiClient,
  operation: "count" | "exists",
  args: readonly string[]
): Promise<void> {
  if (requestsHelp(args)) return writeText(`Usage: sixb objects ${operation} --file <path|->`)
  const source = singleFileOption(args, `objects ${operation}`)
  const input = await readJson(source)
  const record = asRecord(input)
  writeJson(
    await api.post(`/api/objects/query/${operation}`, {
      query: Object.hasOwn(record, "query") ? record.query : input,
    })
  )
}

async function objectsFacets(api: ApiClient, args: readonly string[]): Promise<void> {
  if (requestsHelp(args)) {
    return writeText(
      "Usage: sixb objects facets --file <path|->\n       sixb objects facets --example"
    )
  }
  const { options } = parseCommandArgs(
    args,
    { "--file": "string", "--example": "boolean" },
    "objects facets"
  )
  if (options["--example"]) {
    if (options["--file"]) fail("--example cannot be combined with --file.")
    return writeText(FACETS_EXAMPLE)
  }
  if (!options["--file"]) fail("objects facets requires --file <path|->.")
  const body = await readJson(options["--file"])
  const record = asRecord(body)
  if (!Object.hasOwn(record, "query") || !Object.hasOwn(record, "facets")) {
    fail("objects facets input must contain query and facets.")
  }
  writeJson(await api.post("/api/objects/query/facets", body))
}

async function objectsLinks(api: ApiClient, args: readonly string[]): Promise<void> {
  if (requestsHelp(args)) return writeText(OBJECTS_HELP)
  const { positionals, options } = parseCommandArgs(
    args,
    {
      "--link": "string",
      "--direction": "string",
      "--page-size": "string",
      "--page-token": "string",
      "--include-objects": "boolean",
    },
    "objects links",
    2
  )
  const objectTypeId = positionals[0] ?? ""
  const primaryId = positionals[1] ?? ""
  const linkId = options["--link"]
  const direction = enumValue("--direction", options["--direction"] ?? "both", [
    "outgoing",
    "incoming",
    "both",
  ])
  const pageSize = integerInRange(
    "--page-size",
    options["--page-size"] ?? String(CLI_LIMITS.linkPage.default),
    1,
    CLI_LIMITS.linkPage.maximum
  )
  const pageToken = options["--page-token"]
  const includeObjects = options["--include-objects"] ?? false
  writeJson(
    await api.post("/api/objects/query/links", {
      query: { kind: "refs", refs: [{ objectTypeId, primaryId }] },
      direction,
      includeObjects,
      pageSize,
      ...(linkId ? { linkId } : {}),
      ...(pageToken ? { pageToken } : {}),
    })
  )
}
