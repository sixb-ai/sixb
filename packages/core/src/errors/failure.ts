import type { JsonValue } from "../json"
import { isSixbErrorCode, type SixbErrorCode } from "./codes"
import { SixbError } from "./error"

/**
 * The context a failure carries: flat, and scalar.
 *
 * Flat on purpose. Details are rendered as key/value beside the message and searched as text —
 * nothing branches into them — so nesting buys no reader anything and costs every renderer a
 * schema. It is also where the two specifications in this space landed: the metadata bag of
 * `google.rpc.Status` is a `map<string, string>`.
 *
 * Written to the run row and returned on the wire, so nothing secret goes in.
 */
export type SixbFailureDetails = Readonly<Record<string, string | number | boolean>>

/**
 * The one shape Sixb uses to record a failure.
 *
 * The same object is written to the `error` column of every run table, returned by the HTTP API,
 * and handed to the runtime observer. That is the point: an operator who learns to read it once
 * reads it everywhere.
 *
 * Four fields, and deliberately no more. `retryable` stays on the thrown {@link SixbError}, where
 * a `catch` can still act on it — stored, it would be `SIXB_ERROR_RETRYABLE[code]` frozen at the
 * moment of the failure, which is a copy that can only go stale. There is no timestamp because
 * every surface that carries a failure already has one of its own.
 *
 * A primitive may *extend* this with typed data it genuinely owns (see `ActionRunFailure` and its
 * `phase`); it may never re-specify a field it already has.
 */
export interface SixbFailure {
  readonly code: SixbErrorCode
  /** Human-readable, not a contract. Branch on `code`. */
  readonly message: string
  readonly details?: SixbFailureDetails
  /** What the failure wrapped, outermost first: `could not reach the store: ECONNREFUSED`. */
  readonly cause?: string
}

/**
 * Deep enough for real wrapping (worker → materializer → storage → driver), short enough that a
 * self-referencing chain cannot fill a database column before the cycle guard notices.
 */
const MAX_CAUSE_DEPTH = 8

export interface ToSixbFailureOptions {
  /**
   * The code to record when the thrown value carries none. Defaults to `runtime.unexpected`, which
   * is the honest answer for a bare `throw new Error(...)`; a call site that knows better should
   * say so rather than let every unlabeled failure look identical.
   */
  readonly fallbackCode?: SixbErrorCode
  /** Merged under the error's own details, so the error wins on a key collision. */
  readonly details?: SixbFailureDetails
}

/**
 * Turns anything that was thrown into the record Sixb persists and reports.
 *
 * Total by construction: a string, a plain object, `undefined`, or an `Error` whose `cause` is a
 * string all produce a valid {@link SixbFailure}. Nothing here throws — a failure path that can
 * itself fail is how failures get lost.
 */
export function toSixbFailure(error: unknown, options: ToSixbFailureOptions = {}): SixbFailure {
  const sixbError = asSixbErrorShape(error)
  const details = mergeDetails(options.details, sixbError?.details)
  const cause = renderCause(error)

  return {
    code: sixbError?.code ?? options.fallbackCode ?? "runtime.unexpected",
    message: messageOf(error),
    ...(details ? { details } : {}),
    ...(cause ? { cause } : {}),
  }
}

/**
 * Renders what the thrown value wrapped, outermost first.
 *
 * The thrown value's own message is already the failure's `message`, so the rendering starts one
 * link in. What it adds is the part a code cannot say: which driver call under
 * `storage.unavailable` actually refused. Cycles and runaway depth are bounded rather than
 * trusted — a chain assembled from third-party errors is not under Sixb's control.
 */
function renderCause(error: unknown): string | undefined {
  const messages: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error

  while (messages.length < MAX_CAUSE_DEPTH) {
    if (typeof current !== "object" || current === null) break
    if (seen.has(current)) break
    seen.add(current)

    current = readProperty(current, "cause")
    if (current === undefined) break

    const message = messageOf(current)
    if (message) messages.push(message)
  }

  return messages.length > 0 ? messages.join(": ") : undefined
}

/**
 * Reads the Sixb-error fields off a thrown value without requiring `instanceof`.
 *
 * The runtime, the server, and a custom app are bundled separately, so an error raised in one and
 * caught in another is the normal case, not the exotic one.
 */
function asSixbErrorShape(
  error: unknown
): { code: SixbErrorCode; details?: SixbFailureDetails } | undefined {
  if (error instanceof SixbError) {
    return { code: error.code, details: error.details }
  }

  if (typeof error !== "object" || error === null) return undefined
  const code = readProperty(error, "code")
  if (!isSixbErrorCode(code)) return undefined

  return { code, details: asFailureDetails(readProperty(error, "details")) }
}

function mergeDetails(
  base: SixbFailureDetails | undefined,
  overrides: SixbFailureDetails | undefined
): SixbFailureDetails | undefined {
  if (!base) return overrides
  if (!overrides) return base
  return { ...base, ...overrides }
}

/**
 * Keeps the scalar entries of an untrusted bag and drops the rest.
 *
 * Two things reach this that Sixb does not control: an error thrown by another copy of the runtime,
 * and a column written by an older build. Losing the whole bag over one bad key would throw away
 * the context that is fine, so the filter is per key. Non-finite numbers go too — they come back
 * from JSON as `null`, and a detail that changes on the way to the database is worse than absent.
 */
function asFailureDetails(value: unknown): SixbFailureDetails | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined

  let entries: [string, unknown][]
  try {
    entries = Object.entries(value)
  } catch {
    return undefined
  }

  const details: Record<string, string | number | boolean> = {}
  for (const [key, entry] of entries) {
    const keep =
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    if (keep) details[key] = entry as string | number | boolean
  }

  return Object.keys(details).length > 0 ? details : undefined
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === "object" && value !== null) {
    const message = readProperty(value, "message")
    if (typeof message === "string") return message
  }
  return safeString(value)
}

/** A getter on a foreign object may throw; reading a failure must not raise a second one. */
function readProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key)
  } catch {
    return undefined
  }
}

function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return "Unknown thrown value"
  }
}

/**
 * Reads a failure back out of a storage column.
 *
 * One reader for both dialects: Postgres hands back a parsed `JSONB` object, SQLite hands back the
 * `TEXT` it stored, and neither provider should be hand-rolling the difference — that is how
 * fourteen tables ended up with fourteen slightly different error shapes in the first place.
 *
 * A column that holds something this cannot read is reported rather than dropped. Silence there
 * would show a failed run with no failure, which reads as a bug in the run and hides the real one.
 */
export function parseSixbFailure(value: JsonValue | undefined): SixbFailure | undefined {
  if (value === null || value === undefined || value === "") return undefined

  const parsed = typeof value === "string" ? tryParseJson(value) : value
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return unreadableFailure(value)
  }

  const candidate = parsed as Record<string, unknown>
  if (!isSixbErrorCode(candidate.code) || typeof candidate.message !== "string") {
    return unreadableFailure(value)
  }

  const details = asFailureDetails(candidate.details)
  const cause = typeof candidate.cause === "string" ? candidate.cause : undefined

  return {
    code: candidate.code,
    message: candidate.message,
    ...(details ? { details } : {}),
    ...(cause ? { cause } : {}),
  }
}

/**
 * Writes a failure into a storage column. `null` for the empty case, so a column can be cleared.
 *
 * Generic over the record so an extension serializes whole: `ActionRunFailure` keeps its `phase`
 * rather than being silently narrowed to the base on the way to the database.
 */
export function serializeSixbFailure<TFailure extends SixbFailure>(
  failure: TFailure | undefined
): string | null {
  return failure ? JSON.stringify(failure) : null
}

function unreadableFailure(value: JsonValue): SixbFailure {
  return {
    code: "runtime.invariant_violated",
    message: "[Sixb] A stored failure record could not be read.",
    details: { stored: safeString(value).slice(0, 1000) },
  }
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
