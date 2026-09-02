import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { readFile, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"
import { CliError, EXIT_API, fail } from "./output"

export class ApiClient {
  readonly baseUrl: string
  private readonly authorization: string | undefined
  private readonly missingBaseUrlMessage: string
  private readonly unavailableMessage: string
  private readonly unavailableHint: string

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "")
    this.authorization = options.authorization
    this.missingBaseUrlMessage = options.missingBaseUrlMessage
    this.unavailableMessage = options.unavailableMessage
    this.unavailableHint = options.unavailableHint
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
    form.append("file", new Blob([new Uint8Array(await readFile(source))]), basename(source))
    if (logicalPath) form.append("logicalPath", logicalPath)
    return this.json(this.url(path), { method: "POST", body: form })
  }

  async download(
    path: string,
    output: string,
    query?: Readonly<Record<string, string | undefined>>
  ): Promise<void> {
    const response = await this.fetch(this.url(path, query), { method: "GET" })
    const temporary = join(dirname(output), `.${basename(output)}.sixb-${randomUUID()}.tmp`)
    try {
      const body = response.body
        ? Readable.fromWeb(response.body as unknown as NodeReadableStream)
        : Readable.from([])
      await pipeline(body, createWriteStream(temporary, { flags: "wx" }))
      await rename(temporary, output)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  private url(path: string, query?: Readonly<Record<string, string | undefined>>): URL {
    if (!this.baseUrl) fail(this.missingBaseUrlMessage, "runtime_unavailable")
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
      const headers = new Headers(init.headers)
      if (this.authorization) headers.set("authorization", this.authorization)
      response = await fetch(url, { ...init, headers })
    } catch {
      throw new CliError(
        {
          code: "api_unreachable",
          message: this.unavailableMessage,
          hint: this.unavailableHint,
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

export interface ApiClientOptions {
  readonly baseUrl: string
  readonly authorization?: string
  readonly missingBaseUrlMessage: string
  readonly unavailableMessage: string
  readonly unavailableHint: string
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
