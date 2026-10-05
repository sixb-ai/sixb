import { type RestRequestContext, rest } from "@sixb/connector-rest"
import type { ConnectorAccessToken, ConnectorContext, ConnectorTokenSource } from "@sixb/core"
import { PlaudApiError } from "./errors"
import { API_BASE, routingHeaders } from "./oauth"
import type { PlaudConnectorOptions } from "./types"
import { signalFor } from "./validation"

const DEFAULT_DOWNLOAD_HOSTS = ["prod-plaud-content-storage.s3-accelerate.amazonaws.com"]

export async function createHttp(
  context: ConnectorContext,
  tokens: ConnectorTokenSource,
  options: PlaudConnectorOptions
) {
  const handles = new WeakMap<RestRequestContext, ConnectorAccessToken>()
  const api = await rest({
    baseUrl: API_BASE,
    timeoutMs: options.timeoutMs ?? 30_000,
    minDelayMs: options.minDelayMs,
    retry: { maxRetries: options.maxRetries ?? 2 },
    async headers(request) {
      const token = await tokens.get()
      context.signal.throwIfAborted()
      handles.set(request, token)
      return {
        Accept: "application/json",
        Authorization: `Bearer ${token.accessToken}`,
        ...routingHeaders(options),
      }
    },
    onUnauthorized: (request) => handles.get(request)?.invalidate(),
  }).connect(context)
  const downloads = await rest({
    baseUrl: API_BASE,
    timeoutMs: options.timeoutMs ?? 30_000,
    retry: { maxRetries: options.maxRetries ?? 2 },
  }).connect(context)
  const hosts = new Set(
    [...DEFAULT_DOWNLOAD_HOSTS, ...(options.downloadHosts ?? [])].map((host) => host.toLowerCase())
  )

  async function download(raw: string, signal?: AbortSignal): Promise<Response> {
    let target: URL
    try {
      target = new URL(raw)
    } catch {
      throw new Error("[SixbPlaud] Invalid content URL.")
    }
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.port ||
      !hosts.has(target.hostname.toLowerCase())
    )
      throw new Error(
        "[SixbPlaud] Untrusted content host. Add its exact hostname to downloadHosts only after verifying it belongs to your Plaud storage region."
      )
    const response = await downloads.get(target.href, {
      signal: signalFor(context.signal, signal, options.timeoutMs ?? 30_000),
      redirect: "error",
      credentials: "omit",
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new PlaudApiError(response.status, "Content download")
    }
    return response
  }

  return {
    async get(path: string, signal?: AbortSignal): Promise<unknown> {
      const response = await api.get(path, { signal, redirect: "error", credentials: "omit" })
      if (!response.ok) {
        await response.body?.cancel()
        throw new PlaudApiError(response.status, "API request")
      }
      try {
        return await response.json()
      } catch {
        throw new Error("[SixbPlaud] Invalid API JSON response.")
      }
    },
    download,
    async text(url: string, signal?: AbortSignal): Promise<string> {
      const response = await download(url, signal)
      if (!response.body) return ""
      const reader = response.body.getReader()
      const limit = options.maxContentBytes ?? 20 * 1024 * 1024
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          length += value.byteLength
          if (length > limit) throw new Error("[SixbPlaud] Content exceeds maxContentBytes.")
          chunks.push(value)
        }
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return new TextDecoder().decode(bytes)
    },
  }
}

export type PlaudHttp = Awaited<ReturnType<typeof createHttp>>
