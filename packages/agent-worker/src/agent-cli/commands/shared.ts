import { readFile } from "node:fs/promises"
import { fail } from "../output"

export type QueryOptions = Record<string, string | undefined>

export function parseQueryOptions(
  args: readonly string[],
  names: Readonly<Record<string, string>>,
  command: string
): QueryOptions {
  const query: QueryOptions = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? ""
    const name = names[flag]
    if (!name) fail(`Unknown ${command} option '${flag}'.`)
    query[name] = requireOptionValue(flag, args[index + 1])
  }
  return query
}

export function singleFileOption(args: readonly string[], command: string): string {
  return singleNamedFileOption(args, "--file", command)
}

export function singleNamedFileOption(
  args: readonly string[],
  flag: string,
  command: string
): string {
  if (args[0] !== flag) fail(`${command} requires ${flag} <path|->.`)
  const source = requireOptionValue(flag, args[1])
  if (args.length !== 2) fail(`${command} accepts only ${flag} <path|->.`)
  return source
}

export async function readJson(source: string): Promise<unknown> {
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

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : []
}

export function isFileError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}

function requireOptionValue(label: string, value: string | undefined): string {
  if (!value) fail(`${label} requires a value.`)
  return value
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
