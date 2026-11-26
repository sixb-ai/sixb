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

/**
 * Names the run whose command sends a request (`AGENT_RUN_HEADER` in `@sixb/core`): a child working
 * in its parent's workspace calls the API with its parent's token, and the server acts as the
 * child it names.
 */
const RUN_HEADER = "x-sixb-run"

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"

export class ApiClient {
  readonly baseUrl: string
  private readonly socketPath: string | undefined
  private readonly authorization: string | undefined
  private readonly runId: string | undefined
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
    this.runId = options.runId || undefined
    this.missingBaseUrlMessage =
      options.missingBaseUrlMessage ??
      "No Sixb API URL is configured. Run 'sixb login <api-url>' or set SIXB_API_URL."
    this.unavailableMessage = options.unavailableMessage ?? "The Sixb API could not be reached."
    this.unavailableHint = options.unavailableHint ?? "Run 'sixb status' to check the connection."
  }

  /** The raw Bearer token configured on this client, if any. */
  get bearerToken(): string | undefined {
    return this.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
  }

  async request(
    method: HttpMethod,
    path: string,
    options: {
      readonly query?: Readonly<Record<string, string | undefined>>
      readonly body?: unknown
      readonly signal?: AbortSignal
    } = {}
  ): Promise<unknown> {
    const url = this.url(path, options.query)
    if (method === "HEAD") {
      const response = await this.fetch(url, {
        method,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      return { status: response.status, ok: response.ok }
    }
    const init: RequestInit = {
      method,
      ...(options.signal ? { signal: options.signal } : {}),
    }
    if (options.body !== undefined) {
      init.headers = { "content-type": "application/json" }
      init.body = JSON.stringify(options.body)
    }
    return this.json(url, init)
  }

  async get(path: string, query?: Readonly<Record<string, string | undefined>>): Promise<unknown> {
    return this.request("GET", path, { query })
  }

  async delete(
    path: string,
    query?: Readonly<Record<string, string | undefined>>
  ): Promise<unknown> {
    return this.request("DELETE", path, { query })
  }

  /** `signal` stops waiting for the response; the abort is rethrown as it was raised. */
  async post(
    path: string,
    body: unknown,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<unknown> {
    return this.request("POST", path, { body, signal: options.signal })
  }

  async patch(
    path: string,
    body: unknown,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<unknown> {
    return this.request("PATCH", path, { body, signal: options.signal })
  }

  /**
   * Sends `body` as it streams, for a body too large to hold: `sizeBytes` says how large it is, so
   * it is not sent in chunks of unknown length where the transport can tell.
   */
  async put(path: string, body: ReadableStream<Uint8Array>, sizeBytes: number): Promise<unknown> {
    return this.json(this.url(path), {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(sizeBytes),
      },
      body,
      duplex: "half",
    } as RequestInit)
  }

  /** `mediaType` labels the part; without it, the API types the file by its bytes or name. */
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
      if (this.runId) headers.set(RUN_HEADER, this.runId)
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
  /** Names the acting run when a child speaks through its parent's credential: `SIXB_RUN_ID`. */
  readonly runId?: string
  readonly missingBaseUrlMessage?: string
  readonly unavailableMessage?: string
  readonly unavailableHint?: string
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
  // A body of known length is sent whole; a stream, such as a large upload's, as it is read.
  const outgoing = new Request(url, init)
  const headers: Record<string, string> = Object.fromEntries(outgoing.headers)
  const streamed = init.body instanceof ReadableStream
  const body = outgoing.body && !streamed ? Buffer.from(await outgoing.arrayBuffer()) : undefined
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
    if (streamed && outgoing.body) {
      Readable.fromWeb(outgoing.body as unknown as NodeReadableStream)
        .on("error", (error) => request.destroy(error))
        .pipe(request)
    } else request.end(body)
  })
}

/** The response body as a web stream: Node's and the global stream types differ only in typing. */
function nodeBody(response: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>
}
