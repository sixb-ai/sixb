import { Buffer } from "node:buffer"
import { createSocket } from "node:dgram"
import type { DiscoveredRokuDevice, RokuDiscoveryOptions } from "./types"
import { DEFAULT_DISCOVERY_TIMEOUT_MS, SSDP_ADDRESS, SSDP_PORT } from "./types"

const M_SEARCH = [
  "M-SEARCH * HTTP/1.1",
  `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
  'MAN: "ssdp:discover"',
  "MX: 3",
  "ST: roku:ecp",
  "",
  "",
].join("\r\n")

function parseSsdpHeaders(message: string): Record<string, string> {
  const headers: Record<string, string> = {}

  for (const line of message.split(/\r?\n/)) {
    const separator = line.indexOf(":")
    if (separator <= 0) {
      continue
    }

    const key = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (!key || !value) {
      continue
    }

    headers[key] = value
  }

  return headers
}

export function normalizeRokuHost(host: string): string {
  const trimmed = host.trim()
  if (!trimmed) {
    throw new Error("[RokuTV] Host must not be empty.")
  }

  const asUrl = /^https?:\/\//i.test(trimmed) ? new URL(trimmed) : null
  if (asUrl) {
    return asUrl.port ? `${asUrl.hostname}:${asUrl.port}` : `${asUrl.hostname}:8060`
  }

  return trimmed.includes(":") ? trimmed : `${trimmed}:8060`
}

export function discoverRokuDevices(
  options: RokuDiscoveryOptions | number = {}
): Promise<DiscoveredRokuDevice[]> {
  const resolvedOptions =
    typeof options === "number" ? ({ timeoutMs: options } satisfies RokuDiscoveryOptions) : options

  const timeoutMs = resolvedOptions.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
  const signal = resolvedOptions.signal

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve([])
      return
    }

    const socket = createSocket({ type: "udp4", reuseAddr: true })
    const devices = new Map<string, DiscoveredRokuDevice>()

    let settled = false
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }

      if (signal) {
        signal.removeEventListener("abort", finish)
      }

      socket.removeAllListeners()

      try {
        socket.close()
      } catch {
        // Ignore close errors during shutdown.
      }
    }

    const finalize = () => {
      if (settled) {
        return
      }

      settled = true
      const result = Array.from(devices.values()).sort((a, b) => a.host.localeCompare(b.host))
      cleanup()
      resolve(result)
    }

    const finish = () => {
      finalize()
    }

    timeoutHandle = setTimeout(finalize, timeoutMs)

    if (signal) {
      signal.addEventListener("abort", finish, { once: true })
    }

    socket.on("error", finalize)

    socket.on("message", (msg: Buffer) => {
      const headers = parseSsdpHeaders(msg.toString())
      const location = headers.location
      if (!location) {
        return
      }

      let parsed: URL
      try {
        parsed = new URL(location)
      } catch {
        return
      }

      const host = parsed.port ? `${parsed.hostname}:${parsed.port}` : `${parsed.hostname}:8060`
      if (devices.has(host)) {
        return
      }

      devices.set(host, {
        host,
        location,
        usn: headers.usn,
        server: headers.server,
      })
    })

    socket.bind(() => {
      const message = Buffer.from(M_SEARCH)
      socket.send(message, 0, message.length, SSDP_PORT, SSDP_ADDRESS, () => {
        // Discovery completion is timeout-driven.
      })
    })
  })
}
