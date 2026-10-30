import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { readFile, rename, rm } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { basename, dirname, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"
import { CliError, EXIT_API, fail } from "./output"

/**
 * A base URL of `unix:<socket path>` reaches the API through a local socket, such as the one a
 * sandbox's credential forwarder listens on: requests go to `http://localhost` over that socket.
 */
const UNIX_BASE_URL_PREFIX = "unix:"

export class ApiClient {
  readonly baseUrl: string
  private readonly socketPath: string | undefined
  private readonly authorization: string | undefined
  private readonly missingBaseUrlMessage: string
  private readonly unavailableMessage: string
  private readonly unavailableHint: string

  constructor(options: ApiClientOptions) {
    const baseUrl = options.baseUrl.replace(/\/+$/, "")
    this.socketPath = baseUrl.startsWith(UNIX_BASE_URL_PREFIX)
      ? baseUrl.slice(UNIX_BASE_URL_PREFIX.length)
      : undefined
    this.baseUrl = this.socketPath === undefined ? baseUrl : "http://localhost"
    this.authorization = options.authorization
    this.missingBaseUrlMessage = options.missingBaseUrlMessage
    this.unavailableMessage = options.unavailableMessage
    this.unavailableHint = options.unavailableHint
  }

  async get(path: string, query?: Readonly<Record<string, string | undefined>>): Promise<unknown> {
    const url = this.url(path, query)
    return this.json(url, { method: "GET" })
  }

  /** `signal` stops waiting for the response; the abort is rethrown as it was raised. */
  async post(
    path: string,
    body: unknown,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<unknown> {
    return this.json(this.url(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  /** `mediaType` labels the part; without it, the server reads the type from the file name. */
  async upload(
    path: string,
    source: string,
    logicalPath?: string,
    mediaType?: string
  ): Promise<unknown> {
    const form = new FormData()
    const bytes = new Uint8Array(await readFile(source))
    form.append(
      "file",
      new Blob([bytes], mediaType ? { type: mediaType } : undefined),
      basename(source)
    )
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
      response = await send(url, { ...init, headers }, this.socketPath)
    } catch (error) {
      if (init.signal?.aborted) throw error
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

/** One request, over a Unix socket when the API is behind one. */
function send(url: URL, init: RequestInit, socketPath: string | undefined): Promise<Response> {
  if (socketPath === undefined) return fetch(url, init)
  // Bun's fetch speaks over a Unix socket itself; Node's does not, so it goes through node:http.
  if (typeof Bun !== "undefined") return fetch(url, { ...init, unix: socketPath })
  return sendOverNodeSocket(url, init, socketPath)
}

async function sendOverNodeSocket(
  url: URL,
  init: RequestInit,
  socketPath: string
): Promise<Response> {
  // A Request settles the body and its content type (a form's boundary included) as fetch would.
  const outgoing = new Request(url, init)
  const body = outgoing.body ? Buffer.from(await outgoing.arrayBuffer()) : undefined
  const headers: Record<string, string> = Object.fromEntries(outgoing.headers)
  if (body) headers["content-length"] = String(body.byteLength)

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        method: outgoing.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: "localhost" },
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (response) => {
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          for (const each of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
            responseHeaders.append(name, each)
          }
        }
        const status = response.statusCode ?? 502
        const empty = status === 204 || status === 304 || outgoing.method === "HEAD"
        resolve(
          new Response(empty ? null : nodeBody(response), {
            status,
            statusText: response.statusMessage ?? "",
            headers: responseHeaders,
          })
        )
      }
    )
    request.on("error", reject)
    request.end(body)
  })
}

/** The response body as a web stream: Node's and the global stream types differ only in typing. */
function nodeBody(response: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>
}
