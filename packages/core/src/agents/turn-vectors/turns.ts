import type { AgentMessageRecord } from "../../storage/agents"
import { answerOfSteps } from "../final-answer"

/** One input of search's query: a chunk is never longer than what a search can ask with. */
export const TURN_CHUNK_MAX_CHARS = 8000
/** How much of the request opens each chunk after the first, so each still says what was asked. */
const REQUEST_HEADER_MAX_CHARS = 1000
/** A turn longer than this many chunks is indexed up to there: a bound on what one turn costs. */
const TURN_MAX_CHUNKS = 16

/** One turn of a conversation: a person's message, and everything up to the next one. */
export interface AgentTurn {
  /** The person's message that opens it. */
  readonly messageId: string
  readonly firstSeq: number
  readonly lastSeq: number
  readonly turnAt: Date
  /** What they wrote, and the names of the files they attached. */
  readonly request: string
  /** The Agent's final answer: what it wrote after its last tool call. */
  readonly answer: string
  /** The runs that answered it, oldest first: whose turn it was, and what it published. */
  readonly runIds: readonly string[]
}

/**
 * Whether a message opens a turn: one a person wrote, with text or a file. The message that
 * resumes a paused turn with how its calls ended, or asks the Agent to continue an answer it cut
 * short, goes on with the turn before it.
 */
export function opensAgentTurn(message: Pick<AgentMessageRecord, "role" | "parts">): boolean {
  return (
    message.role === "user" &&
    message.parts.some(
      (part) => (part.type === "text" && part.text.trim() !== "") || part.type === "file"
    )
  )
}

/**
 * Split messages, in `seq` order, into turns. What comes before the first message that opens a
 * turn belongs to a turn the caller did not read, and is left out.
 */
export function splitAgentTurns(messages: readonly AgentMessageRecord[]): readonly AgentTurn[] {
  const turns: AgentMessageRecord[][] = []
  for (const message of messages) {
    if (opensAgentTurn(message)) turns.push([message])
    else turns.at(-1)?.push(message)
  }

  return turns.map((turn) => {
    const opening = turn[0]!
    const answers = turn.filter((message) => message.role === "assistant")
    const runIds = [...new Set(turn.flatMap((message) => (message.runId ? [message.runId] : [])))]

    return {
      messageId: opening.id,
      firstSeq: opening.seq,
      lastSeq: turn.at(-1)!.seq,
      turnAt: opening.createdAt,
      request: requestOf(opening),
      answer: answerOfSteps(answers.flatMap((message) => message.parts)),
      runIds,
    }
  })
}

function requestOf(message: AgentMessageRecord): string {
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
    .filter((line) => line !== "")
    .join("\n")
  const files = message.parts.flatMap((part) =>
    part.type === "file" && part.fileRef.fileName ? [part.fileRef.fileName] : []
  )

  return [text, files.length > 0 ? `Attached: ${files.join(", ")}` : ""]
    .filter((line) => line !== "")
    .join("\n")
}

export interface AgentTurnChunkLimits {
  /** UTF-16 code units, as JavaScript counts a string's length. */
  readonly maxChars?: number
  /** UTF-8 bytes, when the model bounds an input's size. */
  readonly maxBytes?: number
}

/**
 * What a turn embeds: its request, its answer and the titles of what it published, in one input or,
 * when that is too long, in chunks that each open with the request.
 */
export function agentTurnChunks(
  turn: Pick<AgentTurn, "request" | "answer">,
  titles: readonly string[],
  limits: AgentTurnChunkLimits = {}
): readonly string[] {
  const maxChars = Math.min(limits.maxChars ?? TURN_CHUNK_MAX_CHARS, TURN_CHUNK_MAX_CHARS)
  const maxBytes = limits.maxBytes ?? Number.POSITIVE_INFINITY

  const text = [
    turn.request ? `Request: ${turn.request}` : "",
    turn.answer ? `Answer: ${turn.answer}` : "",
    titles.length > 0 ? `Published: ${titles.join("; ")}` : "",
  ]
    .filter((section) => section !== "")
    .join("\n\n")
  if (!text.trim()) return []
  if (text.length <= maxChars && utf8Bytes(text) <= maxBytes) return [text]

  // The first chunk opens with the request already; the others repeat what of it fits a quarter.
  const [clippedRequest] = pieces(
    turn.request,
    Math.min(REQUEST_HEADER_MAX_CHARS, Math.floor(maxChars / 4)),
    Math.floor(maxBytes / 4)
  )
  const header = clippedRequest ? `Request: ${clippedRequest}\n\n` : ""
  const [first, ...rest] = pieces(text, maxChars - header.length, maxBytes - utf8Bytes(header))

  return [first!, ...rest.map((piece) => `${header}${piece}`)]
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== "")
    .slice(0, TURN_MAX_CHUNKS)
}

/**
 * Cut text into pieces within both bounds, at the last whitespace of a piece when one falls in its
 * second half, never inside a character.
 */
function pieces(text: string, maxChars: number, maxBytes: number): readonly string[] {
  const result: string[] = []
  let rest = text.trim()

  while (rest !== "") {
    let end = 0
    let bytes = 0
    for (const character of rest) {
      const size = characterBytes(character)
      if (end + character.length > maxChars || bytes + size > maxBytes) break
      end += character.length
      bytes += size
    }
    if (end >= rest.length) {
      result.push(rest)
      break
    }

    // A bound smaller than one character still moves on by one.
    if (end === 0) end = rest.codePointAt(0)! > 0xffff ? 2 : 1
    const space = lastWhitespace(rest, end)
    const cut = space > end / 2 ? space : end

    result.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }

  return result
}

function lastWhitespace(text: string, before: number): number {
  for (let index = before; index > 0; index--) {
    if (/\s/.test(text[index - 1]!)) return index - 1
  }
  return -1
}

function utf8Bytes(text: string): number {
  let bytes = 0
  for (const character of text) bytes += characterBytes(character)
  return bytes
}

function characterBytes(character: string): number {
  const codePoint = character.codePointAt(0)!
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  return codePoint < 0x10000 ? 3 : 4
}
