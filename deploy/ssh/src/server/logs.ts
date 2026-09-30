import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir, open, rename, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { ProcessManifest } from "./manifest"
import { isMissing } from "./state"

/** A log past this size moves to `<name>.log.1`, replacing the previous one. */
export const MAX_LOG_BYTES = 20 * 1024 * 1024

/** How much of a log `readRecentLogLines` reads from its end. */
const RECENT_BYTES = 256 * 1024

export interface LogLine {
  readonly path: string
  readonly line: string
}

export function processLogPath(
  manifest: Pick<ProcessManifest, "logDir">,
  processName: string,
  instance: number
): string {
  return resolve(manifest.logDir, `${processName}-${instance}.log`)
}

export async function openProcessLog(path: string): Promise<WriteStream> {
  await mkdir(dirname(path), { recursive: true })
  return createWriteStream(path, { flags: "a" })
}

/** Moves a log aside once it passes {@link MAX_LOG_BYTES}. Returns whether it did. */
export async function rotateLogIfLarge(path: string): Promise<boolean> {
  if ((await fileSize(path)) <= MAX_LOG_BYTES) return false
  await rename(path, `${path}.1`)
  return true
}

/** The last `tail` lines across the given logs, in time order. */
export async function readRecentLogLines(
  paths: readonly string[],
  tail: number
): Promise<LogLine[]> {
  const lines: LogLine[] = []
  for (const path of paths) {
    const recent = (await readEnd(path, RECENT_BYTES)).split(/\r?\n/).filter(Boolean).slice(-tail)
    lines.push(...recent.map((line) => ({ path, line })))
  }
  return sortLogLines(lines).slice(-tail)
}

export async function followLogFiles(
  paths: readonly string[],
  onLine: (line: LogLine) => void,
  options: { readonly intervalMs?: number; readonly signal?: AbortSignal } = {}
): Promise<void> {
  const positions = new Map<string, number>()
  for (const path of paths) positions.set(path, await fileSize(path))

  while (!options.signal?.aborted) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, options.intervalMs ?? 500))

    for (const path of paths) {
      const previous = positions.get(path) ?? 0
      const current = await fileSize(path)
      // A smaller file was rotated: read the new one from its start.
      const from = current < previous ? 0 : previous
      positions.set(path, current)
      if (current === from) continue

      const chunk = await readRange(path, from, current)
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) onLine({ path, line })
    }
  }
}

/** `hh:mm:ss service stderr message`, or `null` for an empty line. */
export function renderProcessLogLine(
  item: LogLine,
  options: { readonly label: string; readonly labelWidth?: number }
): string | null {
  const parsed = parseStoredLogLine(item.line)
  const message = formatLogMessage(parsed.message)
  if (!message.trim()) return null

  const time = parsed.timestamp ? formatLogTime(parsed.timestamp) : " ".repeat(8)
  const label = options.label.padEnd(options.labelWidth ?? options.label.length)
  const stream = parsed.stream === "stderr" ? " stderr" : ""
  return `${time} ${label}${stream} ${message}`
}

function sortLogLines(lines: readonly LogLine[]): LogLine[] {
  return lines
    .map((line, index) => ({ line, index, time: logTimestampMs(line.line) }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .map((item) => item.line)
}

function parseStoredLogLine(line: string): {
  readonly timestamp?: Date
  readonly stream?: "stdout" | "stderr"
  readonly message: string
} {
  const match = line.match(/^\[([^\]]+)](?: \[(stdout|stderr)])?\s?(.*)$/)
  if (!match) return { message: line }
  const timestamp = new Date(match[1] ?? "")
  return {
    ...(Number.isFinite(timestamp.getTime()) ? { timestamp } : {}),
    ...(match[2] === "stdout" || match[2] === "stderr" ? { stream: match[2] } : {}),
    message: match[3] ?? "",
  }
}

function formatLogMessage(message: string): string {
  const start = message.match(/^start\s+\S+#\d+\s+pid=(\S+)$/)
  if (start) return `started pid=${start[1]}`

  const exit = message.match(/^exit code=(\S+)\s+signal=(\S+)$/)
  if (exit) {
    const code = exit[1] === "null" ? "" : ` code=${exit[1]}`
    const signal = exit[2] === "null" ? "" : ` signal=${exit[2]}`
    return `exited${code}${signal}`
  }

  return message
}

function formatLogTime(value: Date): string {
  return [value.getHours(), value.getMinutes(), value.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")
}

function logTimestampMs(line: string): number {
  const time = Date.parse(line.match(/^\[([^\]]+)]/)?.[1] ?? "")
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER
}

async function readEnd(path: string, bytes: number): Promise<string> {
  const size = await fileSize(path)
  const text = await readRange(path, Math.max(0, size - bytes), size)
  // Drop a line cut in half by starting mid-file.
  return size > bytes ? text.slice(text.indexOf("\n") + 1) : text
}

async function readRange(path: string, start: number, end: number): Promise<string> {
  if (end <= start) return ""
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, "r")
  } catch (error) {
    if (isMissing(error)) return ""
    throw error
  }
  try {
    const buffer = Buffer.alloc(end - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    return buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (isMissing(error)) return 0
    throw error
  }
}
