import { readFile, writeFile } from "node:fs/promises"
import { basename } from "node:path"
import { CliError, EXIT_API, fail } from "./output"

export class ApiClient {
  readonly baseUrl: string

  constructor(baseUrl = process.env.SIXB_API_BASE_URL) {
    if (!baseUrl) fail("SIXB_API_BASE_URL is not set.", "runtime_unavailable")
    this.baseUrl = baseUrl.replace(/\/$/, "")
  }

  async get(path: string, query?: Readonly<Record<string, string | undefined>>): Promise<unknown> {
    const url = this.url(path, query)
    return this.json(url, { method: "GET" })
  }

  async post(path: string, body: unknown): Promise<unknown> {
    return this.json(this.url(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  async upload(path: string, source: string, logicalPath?: string): Promise<unknown> {
    const form = new FormData()
    form.append("file", new Blob([await readFile(source)]), basename(source))
    if (logicalPath) form.append("logicalPath", logicalPath)
    return this.json(this.url(path), { method: "POST", body: form })
  }

  async download(
    path: string,
    output: string,
    query?: Readonly<Record<string, string | undefined>>
  ): Promise<void> {
    const response = await this.fetch(this.url(path, query), { method: "GET" })
    await writeFile(output, new Uint8Array(await response.arrayBuffer()))
  }

  private url(path: string, query?: Readonly<Record<string, string | undefined>>): URL {
    validateApiPath(path)
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    return url
  }

  private async json(url: URL, init: RequestInit): Promise<unknown> {
    const response = await this.fetch(url, init)
    const text = await response.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new CliError(
        { code: "invalid_api_response", message: "The Sixb API returned invalid JSON." },
        EXIT_API
      )
    }
  }

  private async fetch(url: URL, init: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await fetch(url, init)
    } catch {
      throw new CliError(
        {
          code: "api_unreachable",
          message: "The Sixb API gateway could not be reached.",
          hint: "Run 'sixb doctor' to verify the sandbox runtime and gateway.",
        },
        EXIT_API
      )
    }
    if (response.ok) return response

    const body = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = undefined
    }
    const record = asRecord(parsed)
    const error = record.error
    const nested = asRecord(error)
    const code = stringField(record, "code") ?? stringField(nested, "code") ?? "http_error"
    const message =
      stringField(record, "message") ??
      stringField(nested, "message") ??
      (typeof error === "string"
        ? error
        : `The Sixb API request failed with HTTP ${response.status}.`)
    const hint = stringField(record, "hint") ?? stringField(nested, "hint")
    const issues = Array.isArray(record.issues)
      ? record.issues
      : Array.isArray(nested.issues)
        ? nested.issues
        : undefined
    throw new CliError(
      {
        code,
        status: response.status,
        message,
        ...(hint ? { hint } : {}),
        ...(issues ? { issues } : {}),
      },
      EXIT_API
    )
  }
}

function validateApiPath(path: string): void {
  const invalid = (): never => fail("API paths must be relative and start with /api/.")
  if (path.includes("\\") || path.includes("#")) invalid()
  const normalized = (() => {
    try {
      return new URL(path, "http://sixb.invalid")
    } catch {
      return invalid()
    }
  })()
  if (
    normalized.origin !== "http://sixb.invalid" ||
    (normalized.pathname !== "/api" && !normalized.pathname.startsWith("/api/"))
  ) {
    invalid()
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}
