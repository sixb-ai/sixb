const defaultApiUrl = "http://localhost:3002/api"

export function apiBaseUrl(): string {
  const value = process.env.SIXB_API_URL ?? defaultApiUrl
  const normalized = value.replace(/\/+$/, "")
  return normalized.endsWith("/api") ? normalized : `${normalized}/api`
}

export async function apiRequest(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl()}${path}`, init)
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const detail =
      isRecord(body) && typeof body.error === "string" ? body.error : response.statusText
    throw new Error(`[Northline] API request failed (${response.status}): ${detail}`)
  }
  return body
}

export async function waitUntil(
  description: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(250)
  }
  throw new Error(`[Northline] Timed out waiting for ${description}.`)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
