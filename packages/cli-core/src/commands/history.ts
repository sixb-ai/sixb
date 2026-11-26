import type { ApiClient } from "../api-client"
import {
  integerInRange,
  isHelp,
  nonNegativeInteger,
  parseCommandArgs,
  requestsHelp,
} from "../arguments"
import { CliError, EXIT_API, fail, writeText } from "../output"
import { CLI_LIMITS } from "../policies"
import { GROUP_HELP } from "./metadata"
import { idSegment } from "./shared"

/** In a page, longer text is cut: `sixb history <seq>` prints a message whole. */
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

/** The conversation a command reads, and the command that reads more of it. */
interface Conversation {
  readonly id: string
  /** The run's own: its sandbox holds the outputs its calls saved to files. */
  readonly own: boolean
  readonly command: string
}

/**
 * Read a conversation as text, oldest first, compacted turns included: what was said, the files
 * sent, and each tool call with its result. Reasoning stays out. The run's own by default;
 * `--thread` reads another of its requester's, and `search` finds them.
 */
export async function history(api: ApiClient, args: readonly string[]): Promise<void> {
  if (isHelp(args[0]) || requestsHelp(args)) return writeText(GROUP_HELP.history)
  if (args[0] === "search") return searchHistory(api, args.slice(1))

  const { positionals, options } = parseCommandArgs(
    args,
    { "--thread": "string", "--offset": "string", "--limit": "string" },
    "history",
    [0, 1]
  )
  const ownId = process.env.SIXB_THREAD_ID
  const threadId = options["--thread"] ?? ownId
  if (!threadId) fail("This run has no conversation to read: SIXB_THREAD_ID is not set.")

  const own = threadId === ownId
  const conversation: Conversation = {
    id: threadId,
    own,
    command: own ? "sixb history" : `sixb history --thread ${shellWord(threadId)}`,
  }
  const path = `/api/agent-threads/${idSegment(threadId)}/messages`

  const seq = positionals[0]
  if (seq !== undefined) {
    const wanted = integerInRange("<seq>", seq, 1, Number.MAX_SAFE_INTEGER)
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
    return writeText(renderMessage(message, page, { whole: true, conversation }))
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

  const shown = page.messages.map((message) =>
    renderMessage(message, page, { whole: false, conversation })
  )
  const end = offset + page.messages.length
  const footer =
    page.messages.length === 0
      ? `No messages from offset ${offset}: the conversation has ${page.total}.`
      : page.hasMore
        ? `Messages ${offset + 1}–${end} of ${page.total}. Next: ${conversation.command} --offset ${end}`
        : `Messages ${offset + 1}–${end} of ${page.total}: the end of the conversation.`
  writeText([...shown, footer].join("\n\n"))
}

function renderMessage(
  message: StoredMessage,
  page: MessagePage,
  options: { readonly whole: boolean; readonly conversation: Conversation }
): string {
  const author = message.authorPrincipal
    ? page.authors.find((person) => person.id === message.authorPrincipal?.id)?.displayName
    : undefined
  const heading = [`#${message.seq} ${message.role}`, author, message.createdAt]
    .filter(Boolean)
    .join(" · ")
  const bounds = {
    seq: message.seq,
    command: options.conversation.command,
    textChars: options.whole ? Number.POSITIVE_INFINITY : PAGE_TEXT_CHARS,
    toolChars: options.whole ? Number.POSITIVE_INFINITY : PAGE_TOOL_CHARS,
  }

  return [
    `── ${heading}`,
    ...message.parts.flatMap((part, index) => [
      ...renderPart(part, bounds),
      ...renderOutputFile(part, message, index, options.conversation),
    ]),
  ].join("\n")
}

/**
 * Where a call's whole output is, when it was too large for the context and its part keeps a
 * bounded copy: in the sandbox while the run's own conversation still shows the call, which every
 * run writes back, and through the message's file route whatever happened since. Another
 * conversation's outputs are never in the sandbox.
 */
function renderOutputFile(
  part: Record<string, unknown>,
  message: StoredMessage,
  index: number,
  conversation: Conversation
): string[] {
  const file = part.type === "tool-call" ? record(part.outputFile) : undefined
  const fileRef = record(file?.fileRef)
  if (typeof file?.path !== "string" || typeof fileRef?.sizeBytes !== "number") return []

  const size = `${fileRef.sizeBytes.toLocaleString("en-US")} bytes`
  const apiBaseUrl = process.env.SIXB_API_BASE_URL
  const download =
    apiBaseUrl && message.id
      ? `sixb files download url ${apiBaseUrl.replace(/\/$/, "")}/api/agent-threads/${idSegment(conversation.id)}/messages/${idSegment(message.id)}/files/content?path=${encodeURIComponent(`/parts/${index}/outputFile/fileRef`)} --output <file>`
      : undefined

  if (!conversation.own) return [`  [whole output, ${size}${download ? `: ${download}` : ""}]`]

  const contextDir = process.env.SIXB_CONTEXT_DIR
  const path = contextDir ? `${contextDir.replace(/\/$/, "")}/${file.path}` : file.path
  return [
    `  [whole output, ${size}: ${path}, written back to the sandbox at each run while the conversation shows this call${download ? `; else: ${download}` : ""}]`,
  ]
}

function renderPart(
  part: Record<string, unknown>,
  bounds: {
    readonly seq: number
    readonly command: string
    readonly textChars: number
    readonly toolChars: number
  }
): string[] {
  const cut = (value: string, max: number) =>
    value.length <= max
      ? value
      : `${value.slice(0, max)}… [${(value.length - max).toLocaleString("en-US")} more characters: ${bounds.command} ${bounds.seq}]`

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
    // Reasoning, provider state and step marks are not part of what was said.
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

interface FoundConversation {
  readonly thread: {
    readonly id: string
    readonly title?: string
    readonly createdAt: string
    readonly lastMessageAt?: string
    readonly shared: boolean
  }
  readonly turns: readonly {
    readonly firstSeq: number
    readonly lastSeq: number
    readonly at: string
    readonly excerpt: string
    readonly artifacts: readonly { readonly id: string; readonly title: string }[]
  }[]
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * Find the requester's earlier conversations by meaning, and print each with its best turns, for
 * the Agent to read further with `--thread`.
 */
async function searchHistory(api: ApiClient, args: readonly string[]): Promise<void> {
  const { positionals, options } = parseCommandArgs(
    args,
    { "--since": "string", "--until": "string", "--limit": "string" },
    "history search",
    [1, Number.POSITIVE_INFINITY]
  )

  // Unquoted words are one text, as they were meant.
  const text = positionals.join(" ").trim()
  if (!text || text.length > CLI_LIMITS.vectorSearchText.maximum) {
    fail(
      `Search text must be nonempty and at most ${CLI_LIMITS.vectorSearchText.maximum} characters.`
    )
  }

  const since = options["--since"] && instant("--since", options["--since"], "start")
  const until = options["--until"] && instant("--until", options["--until"], "end")
  if (since && until && Date.parse(since) >= Date.parse(until)) {
    fail("--since must be before --until.")
  }
  const limit =
    options["--limit"] &&
    integerInRange("--limit", options["--limit"], 1, CLI_LIMITS.historySearch.maximum)

  const result = record(
    await api.post("/api/agent-threads/search", {
      text,
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      ...(limit ? { limit } : {}),
    })
  )
  if (!Array.isArray(result?.conversations)) {
    throw new CliError(
      { code: "invalid_api_response", message: "The Sixb API returned an invalid search result." },
      EXIT_API
    )
  }

  const conversations = result.conversations as FoundConversation[]
  const searchedFrom = typeof result.searchedFrom === "string" ? result.searchedFrom : undefined
  writeText(renderSearch(conversations, searchedFrom))
}

/**
 * A date or a timestamp, as the API takes it. A date alone is a day in the user's time zone
 * (`$SIXB_TIME_ZONE`, UTC without it): `--since` from its start, `--until` through its end.
 */
function instant(flag: string, value: string, edge: "start" | "end"): string {
  const invalid = () =>
    fail(`${flag} must be a date (2026-11-20) or a timestamp with its offset (2026-11-20T15:04Z).`)

  if (DATE.test(value)) {
    const day = new Date(`${value}T00:00:00.000Z`)
    // A day that does not exist, such as 2026-02-30, rolls over: refuse it.
    if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) invalid()

    if (edge === "end") day.setUTCDate(day.getUTCDate() + 1)
    return new Date(startOfDay(day, userTimeZone())).toISOString()
  }

  if (!TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) invalid()
  return new Date(value).toISOString()
}

/** The user's IANA time zone, as the run gives it; UTC when it gives none Intl knows. */
function userTimeZone(): string {
  const timeZone = process.env.SIXB_TIME_ZONE
  if (!timeZone) return "UTC"
  try {
    new Intl.DateTimeFormat("en-US", { timeZone })
    return timeZone
  } catch {
    return "UTC"
  }
}

/**
 * The instant a calendar day starts in a time zone, the day given as its UTC midnight. The zone's
 * offset is read at UTC midnight, then again at the instant that gives: right when the clocks
 * change between the two, as on Sydney's daylight saving days.
 */
function startOfDay(day: Date, timeZone: string): number {
  const midnight = day.getTime()
  const first = midnight - zoneOffset(midnight, timeZone)
  return midnight - zoneOffset(first, timeZone)
}

/** How far ahead of UTC a time zone's clocks are at an instant, in milliseconds. */
function zoneOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((each) => each.type === type)?.value)

  const local = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second")
  )
  return local - (at - (at % 1000))
}

function renderSearch(
  conversations: readonly FoundConversation[],
  searchedFrom: string | undefined
): string {
  const further = searchedFrom
    ? [
        `Only turns from ${searchedFrom} on were searched: add --until ${searchedFrom} to search earlier ones.`,
      ]
    : []
  if (conversations.length === 0) {
    return ["No earlier conversation matches.", ...further].join("\n")
  }

  const found = conversations.map(({ thread, turns }) => {
    const dates = [
      `started ${minute(thread.createdAt)}`,
      thread.lastMessageAt ? `last message ${minute(thread.lastMessageAt)}` : undefined,
      thread.shared ? "shared" : undefined,
    ]
    return [
      `── ${thread.id} · ${thread.title ? JSON.stringify(thread.title) : "untitled"}`,
      dates.filter(Boolean).join(" · "),
      ...turns.flatMap((turn) => [
        `  #${turn.firstSeq} · ${minute(turn.at)} · ${turn.excerpt.replace(/\s+/g, " ").trim()}`,
        ...(turn.artifacts.length > 0
          ? [
              `    Published: ${turn.artifacts
                .map((artifact) => `${JSON.stringify(artifact.title)} (artifact:${artifact.id})`)
                .join(", ")}`,
            ]
          : []),
        `    Read it: ${readTurnCommand(thread.id, turn)}`,
      ]),
    ].join("\n")
  })

  const count = conversations.length
  return [
    `${count} earlier conversation${count === 1 ? "" : "s"} found, the closest first.`,
    ...found,
    ["A whole conversation: sixb history --thread <id>.", ...further].join("\n"),
  ].join("\n\n")
}

/**
 * The page that holds a turn's messages, from the person's message to the answer: a message alone
 * (`<seq>`) would show only the request. A turn longer than a page reads on with `--offset`.
 */
function readTurnCommand(
  threadId: string,
  turn: { readonly firstSeq: number; readonly lastSeq: number }
): string {
  const limit = Math.min(turn.lastSeq - turn.firstSeq + 1, CLI_LIMITS.history.maximum)
  return `sixb history --thread ${shellWord(threadId)} --offset ${turn.firstSeq - 1} --limit ${limit}`
}

/** An instant to the minute, as `--since` and `--until` take it back. */
function minute(value: string): string {
  const at = Date.parse(value)
  return Number.isNaN(at) ? value : `${new Date(at).toISOString().slice(0, 16)}Z`
}

/** An id as one shell word. */
function shellWord(value: string): string {
  return /^[\w.:@-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}
