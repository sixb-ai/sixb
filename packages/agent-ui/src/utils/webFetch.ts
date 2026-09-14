import { coerceWebSearchOutput, type WebSource } from "./webSearch"

export function coerceWebFetchOutput(value: unknown): WebSource | null {
  if (!isRecord(value) || typeof value.content !== "string") return null
  return coerceWebSearchOutput({ results: [{ ...value, text: value.content }] })?.[0] ?? null
}

export function webFetchUrl(input: unknown): URL | null {
  if (!isRecord(input) || typeof input.url !== "string") return null
  try {
    const url = new URL(input.url)
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
