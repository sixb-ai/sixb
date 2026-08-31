import { ApiClient } from "../api-client"
import {
  enumValue,
  integerInRange,
  isHelp,
  requireOrderedRange,
  requireValue,
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

export async function objects(args: string[]): Promise<void> {
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
  if (isHelp(args[0])) return writeText(OBJECTS_HELP)
  const objectTypeId = requireValue("objects inspect object type", args[0])
  const primaryId = requireValue("objects inspect primary id", args[1])
  let depth: number = CLI_LIMITS.inspect.depth.default
  let maxObjects: number = CLI_LIMITS.inspect.objects.default
  let maxLinks: number = CLI_LIMITS.inspect.links.default
  let full = false
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === "--full") full = true
    else if (flag === "--depth") {
      depth = integerInRange(
        flag,
        requireValue(flag, args[++index]),
        0,
        CLI_LIMITS.inspect.depth.maximum
      )
    } else if (flag === "--max-objects") {
      maxObjects = integerInRange(
        flag,
        requireValue(flag, args[++index]),
        1,
        CLI_LIMITS.inspect.objects.maximum
      )
    } else if (flag === "--max-links") {
      maxLinks = integerInRange(
        flag,
        requireValue(flag, args[++index]),
        1,
        CLI_LIMITS.inspect.links.maximum
      )
    } else fail(`Unknown objects inspect option '${flag}'.`)
  }
  writeJson(
    await inspectGraph(new ApiClient(), objectTypeId, primaryId, {
      depth,
      maxObjects,
      maxLinks,
      full,
    })
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
  writeJson(await new ApiClient().get("/api/objects", options))
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
  if (isHelp(args[0])) {
    return writeText(`Usage: sixb objects search <text> [--limit <1-${CLI_LIMITS.search.maximum}>]`)
  }
  const query = requireValue("objects search", args[0])
  const options = parseQueryOptions(args.slice(1), { "--limit": "limit" }, "objects search")
  options.limit = String(
    integerInRange(
      "--limit",
      options.limit ?? String(CLI_LIMITS.search.default),
      1,
      CLI_LIMITS.search.maximum
    )
  )
  writeJson(await new ApiClient().get("/api/objects/search", { q: query, ...options }))
}

async function objectsQuery(args: string[]): Promise<void> {
  if (isHelp(args[0])) return writeText(QUERY_HELP)
  if (args[0] === "--example") {
    if (args.length !== 2) fail("objects query --example requires exactly one example name.")
    const name = requireValue("--example", args[1])
    if (name === "list") return writeText(Object.keys(QUERY_EXAMPLES).join(" "))
    const example = QUERY_EXAMPLES[name]
    if (!example) fail(`Unknown query example '${name}'. Run 'sixb objects query --example list'.`)
    return writeText(example)
  }
  let source: string | undefined
  let includeTotal = false
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === "--file") source = requireValue(flag, args[++index])
    else if (flag === "--include-total") includeTotal = true
    else if (flag === "--no-total") includeTotal = false
    else fail(`Unknown objects query option '${flag}'.`)
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
  if (isHelp(args[0])) {
    return writeText(
      "Usage: sixb objects facets --file <path|->\n       sixb objects facets --example"
    )
  }
  if (args.length === 1 && args[0] === "--example") return writeText(FACETS_EXAMPLE)
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
  let pageSize: number = CLI_LIMITS.linkPage.default
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
      pageSize = integerInRange(
        flag,
        requireValue(flag, args[++index]),
        1,
        CLI_LIMITS.linkPage.maximum
      )
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
