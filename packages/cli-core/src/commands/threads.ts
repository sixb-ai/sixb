import type { ApiClient } from "../api-client"
import {
  integerInRange,
  isHelp,
  nonNegativeInteger,
  parseCommandArgs,
  requestsHelp,
} from "../arguments"
import { CliError, EXIT_API, fail, writeJson, writeText } from "../output"
import { CLI_LIMITS } from "../policies"
import { GROUP_HELP } from "./metadata"
import { idSegment } from "./shared"

/** In a page, longer text is cut: `sixb threads messages --seq <n>` prints one message whole. */
const PAGE_TEXT_CHARS = 4_000
const PAGE_TOOL_CHARS = 1_000

interface StoredMessage {
  readonly id?: string
  readonly seq: number
  readonly role: string
  readonly createdAt?: string
  readonly authorPrincipal?: { readonly type: string; readonly id: string }
  readonly parts: readonly Record<string, unknown>[]
}

interface MessagePage {
  readonly messages: readonly StoredMessage[]
  readonly authors: readonly { readonly id: string; readonly displayName?: string }[]
  readonly hasMore: boolean
  readonly total: number
}

export async function threads(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP.threads)

  if (sub === "list") {
    const { options } = parseCommandArgs(
      rest,
      { "--limit": "string", "--offset": "string" },
      "threads list"
    )
    const limit = integerInRange(
      "--limit",
      options["--limit"] ?? String(CLI_LIMITS.list.default),
      1,
      CLI_LIMITS.list.maximum
    )
    const offset =
      options["--offset"] === undefined
        ? undefined
        : nonNegativeInteger("--offset", options["--offset"])
    return writeJson(
      await api.get("/api/agent-threads", {
        limit: String(limit),
        ...(offset === undefined ? {} : { offset: String(offset) }),
      })
    )
  }

  if (sub === "get") {
    const { positionals } = parseCommandArgs(rest, {}, "threads get", [0, 1])
    const threadId = resolveThreadId(positionals[0])
    return writeJson(await api.get(`/api/agent-threads/${idSegment(threadId)}`))
  }

  if (sub === "runs") {
    const { positionals } = parseCommandArgs(rest, {}, "threads runs", [0, 1])
    const threadId = resolveThreadId(positionals[0])
    return writeJson(await api.get(`/api/agent-threads/${idSegment(threadId)}/runs`))
  }

  if (sub === "approvals") {
    const { positionals } = parseCommandArgs(rest, {}, "threads approvals", [0, 1])
    const threadId = resolveThreadId(positionals[0])
    return writeJson(await api.get(`/api/agent-threads/${idSegment(threadId)}/approvals`))
  }

  if (sub === "messages") {
    return threadMessages(api, rest)
  }

  fail(`Unknown threads command '${sub}'. Run 'sixb threads --help'.`)
}

/**
 * Read a conversation's messages, oldest first, compacted turns included: what was said, the files
 * sent, and each tool call with its result. Prints compact readable text by default, or raw JSON
 * with `--json`.
 */
async function threadMessages(api: ApiClient, args: readonly string[]): Promise<void> {
  const { positionals, options } = parseCommandArgs(
    args,
    { "--offset": "string", "--limit": "string", "--seq": "string", "--json": "boolean" },
    "threads messages",
    [0, 1]
  )
  const threadId = resolveThreadId(positionals[0])
  const explicitThread = positionals[0] !== undefined
  const path = `/api/agent-threads/${idSegment(threadId)}/messages`
  const asJson = options["--json"] === true

  const seqRaw = options["--seq"]
  if (seqRaw !== undefined) {
    const wanted = integerInRange("--seq", seqRaw, 1, Number.MAX_SAFE_INTEGER)
    const page = messagePage(
      await api.get(path, { order: "asc", offset: String(wanted - 1), limit: "1" })
    )
    const message = page.messages[0]
    if (message?.seq !== wanted) {
      throw new CliError(
        { code: "not_found", message: `The conversation has no message #${wanted}.` },
        EXIT_API
      )
    }
    if (asJson) return writeJson(message)
    return writeText(renderMessage(message, page, threadId, { whole: true }))
  }

  const offset = nonNegativeInteger("--offset", options["--offset"] ?? "0")
  const limit = integerInRange(
    "--limit",
    options["--limit"] ?? String(CLI_LIMITS.history.default),
    1,
    CLI_LIMITS.history.maximum
  )
  const page = messagePage(
    await api.get(path, { order: "asc", offset: String(offset), limit: String(limit) })
  )
  if (asJson) return writeJson(page)

  const cmdPrefix = explicitThread ? `sixb threads messages ${threadId}` : "sixb threads messages"
  const shown = page.messages.map((message) =>
    renderMessage(message, page, threadId, { whole: false, cmdPrefix })
  )
  const end = offset + page.messages.length
  const footer =
    page.messages.length === 0
      ? `No messages from offset ${offset}: the conversation has ${page.total}.`
      : page.hasMore
        ? `Messages ${offset + 1}–${end} of ${page.total}. Next: ${cmdPrefix} --offset ${end}`
        : `Messages ${offset + 1}–${end} of ${page.total}: the end of the conversation.`
  writeText([...shown, footer].join("\n\n"))
}

function resolveThreadId(explicit: string | undefined): string {
  const threadId = explicit?.trim() || process.env.SIXB_THREAD_ID?.trim()
  if (!threadId) {
    fail("Specify a thread id, or set SIXB_THREAD_ID.")
  }
  return threadId
}

function renderMessage(
  message: StoredMessage,
  page: MessagePage,
  threadId: string,
  options: { readonly whole: boolean; readonly cmdPrefix?: string }
): string {
  const author = message.authorPrincipal
    ? page.authors.find((person) => person.id === message.authorPrincipal?.id)?.displayName
    : undefined
  const heading = [`#${message.seq} ${message.role}`, author, message.createdAt]
    .filter(Boolean)
    .join(" · ")
  const bounds = {
    seq: message.seq,
    cmdPrefix: options.cmdPrefix ?? "sixb threads messages",
    textChars: options.whole ? Number.POSITIVE_INFINITY : PAGE_TEXT_CHARS,
    toolChars: options.whole ? Number.POSITIVE_INFINITY : PAGE_TOOL_CHARS,
  }

  return [
    `── ${heading}`,
    ...message.parts.flatMap((part, index) => [
      ...renderPart(part, bounds),
      ...renderOutputFile(part, message, threadId, index),
    ]),
  ].join("\n")
}

function renderOutputFile(
  part: Record<string, unknown>,
  message: StoredMessage,
  threadId: string,
  index: number
): string[] {
  const file = part.type === "tool-call" ? record(part.outputFile) : undefined
  const fileRef = record(file?.fileRef)
  if (typeof file?.path !== "string" || typeof fileRef?.sizeBytes !== "number") return []

  const contextDir = process.env.SIXB_CONTEXT_DIR
  const path = contextDir ? `${contextDir.replace(/\/$/, "")}/${file.path}` : file.path
  const apiBaseUrl = process.env.SIXB_API_URL || process.env.SIXB_API_BASE_URL
  const download =
    apiBaseUrl && message.id
      ? `; else: sixb files download url ${apiBaseUrl.replace(/\/$/, "")}/api/agent-threads/${idSegment(threadId)}/messages/${idSegment(message.id)}/files/content?path=${encodeURIComponent(`/parts/${index}/outputFile/fileRef`)} --output <file>`
      : ""
  return [
    `  [whole output, ${fileRef.sizeBytes.toLocaleString("en-US")} bytes: ${path}, written back to the sandbox at each run while the conversation shows this call${download}]`,
  ]
}

function renderPart(
  part: Record<string, unknown>,
  bounds: {
    readonly seq: number
    readonly cmdPrefix: string
    readonly textChars: number
    readonly toolChars: number
  }
): string[] {
  const cut = (value: string, max: number) =>
    value.length <= max
      ? value
      : `${value.slice(0, max)}… [${(value.length - max).toLocaleString("en-US")} more characters: ${bounds.cmdPrefix} --seq ${bounds.seq}]`

  switch (part.type) {
    case "text":
      return typeof part.text === "string" && part.text.trim()
        ? [cut(part.text, bounds.textChars)]
        : []
    case "file": {
      const file = record(part.fileRef)
      const name = file?.fileName ?? file?.logicalPath ?? file?.blobId
      return [`[file ${String(name)}${file?.mediaType ? `, ${String(file.mediaType)}` : ""}]`]
    }
    case "tool-call": {
      const input = cut(JSON.stringify(part.input ?? {}), bounds.toolChars)
      const outcome =
        part.state === "output-error"
          ? `error: ${cut(String(part.errorText ?? ""), bounds.toolChars)}`
          : part.state === "output-available"
            ? cut(
                typeof part.output === "string" ? part.output : JSON.stringify(part.output),
                bounds.toolChars
              )
            : String(part.state ?? "")
      return [`[${String(part.toolName)}] ${input}`, `→ ${outcome}`]
    }
    case "continuation":
      return ["[asked to continue]"]
    case "approval-outcome":
      return [`[approval ${String(part.status)}]`]
    default:
      return []
  }
}

function messagePage(value: unknown): MessagePage {
  const page = record(value)
  if (!page || !Array.isArray(page.messages) || typeof page.total !== "number") {
    throw new CliError(
      { code: "invalid_api_response", message: "The Sixb API returned an invalid message page." },
      EXIT_API
    )
  }
  return {
    messages: page.messages as StoredMessage[],
    authors: Array.isArray(page.authors) ? (page.authors as MessagePage["authors"]) : [],
    hasMore: page.hasMore === true,
    total: page.total,
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
