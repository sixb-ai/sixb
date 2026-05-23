import type { SixbBrowserOrigin } from "@sixb/server"

export interface BrowserTopologyOptions {
  readonly mode: "development" | "production"
  readonly host?: string
  readonly apiHost?: string
  readonly port?: string
  readonly appPort?: string
  readonly apiPort?: string
  readonly sentinelPort?: string
  readonly apiPublicOrigin?: string
  readonly atlasPublicOrigin?: string
  readonly sentinelPublicOrigin?: string
  readonly appPublicOrigin?: string
  readonly includeAtlas?: boolean
  readonly includeSentinel?: boolean
  readonly includeCustomApp: boolean
}

export interface BrowserTopology {
  readonly host: string
  readonly apiHost: string
  readonly atlasPort: number
  readonly appPort: number
  readonly apiPort: number
  readonly sentinelPort: number
  readonly apiPublicOrigin: string
  readonly atlasPublicOrigin: string | null
  readonly sentinelPublicOrigin: string | null
  readonly appPublicOrigin: string | null
  readonly allowedBrowserOrigins: readonly SixbBrowserOrigin[]
}

interface BrowserHosts {
  readonly host: string
  readonly apiHost: string
}

interface BrowserPorts {
  readonly atlasPort: number
  readonly appPort: number
  readonly apiPort: number
  readonly sentinelPort: number
}

interface BrowserPublicOrigins {
  readonly apiPublicOrigin: string
  readonly atlasPublicOrigin: string | null
  readonly sentinelPublicOrigin: string | null
  readonly appPublicOrigin: string | null
}

const DEFAULT_BROWSER_HOST = "0.0.0.0"
const DEFAULT_ATLAS_PORT = 3000
const DEFAULT_APP_PORT_OFFSET = 1
const DEFAULT_API_PORT_OFFSET = 2
const DEFAULT_SENTINEL_PORT_OFFSET = 3

export function resolveBrowserTopology(options: BrowserTopologyOptions): BrowserTopology {
  const hosts = resolveBrowserHosts(options)
  const ports = resolveBrowserPorts(options)
  const origins = resolveBrowserPublicOrigins(options, ports)

  return {
    ...hosts,
    ...ports,
    ...origins,
    allowedBrowserOrigins: createAllowedBrowserOrigins(origins),
  }
}

function resolveBrowserHosts(options: BrowserTopologyOptions): BrowserHosts {
  const host = options.host ?? DEFAULT_BROWSER_HOST
  return {
    host,
    apiHost: options.apiHost ?? host,
  }
}

function resolveBrowserPorts(options: BrowserTopologyOptions): BrowserPorts {
  const atlasPort = parsePort(options.port, "port", DEFAULT_ATLAS_PORT)
  const appPort = parsePort(options.appPort, "app-port", atlasPort + DEFAULT_APP_PORT_OFFSET)
  const apiPort = parsePort(options.apiPort, "api-port", atlasPort + DEFAULT_API_PORT_OFFSET)
  const sentinelPort = parsePort(
    options.sentinelPort,
    "sentinel-port",
    atlasPort + DEFAULT_SENTINEL_PORT_OFFSET
  )

  return {
    atlasPort,
    appPort,
    apiPort,
    sentinelPort,
  }
}

function resolveBrowserPublicOrigins(
  options: BrowserTopologyOptions,
  ports: BrowserPorts
): BrowserPublicOrigins {
  const apiPublicOrigin = resolvePublicOrigin({
    value: options.apiPublicOrigin,
    envName: "SIXB_API_PUBLIC_ORIGIN",
    label: "API public origin",
    localDefault: `http://localhost:${ports.apiPort}`,
    mode: options.mode,
  })
  const includeAtlas = options.includeAtlas ?? true
  const includeSentinel = options.includeSentinel ?? true
  const atlasPublicOrigin = includeAtlas
    ? resolvePublicOrigin({
        value: options.atlasPublicOrigin,
        envName: "SIXB_ATLAS_PUBLIC_ORIGIN",
        label: "Atlas public origin",
        localDefault: `http://localhost:${ports.atlasPort}`,
        mode: options.mode,
      })
    : null
  const sentinelPublicOrigin = includeSentinel
    ? resolvePublicOrigin({
        value: options.sentinelPublicOrigin,
        envName: "SIXB_SENTINEL_PUBLIC_ORIGIN",
        label: "Sentinel public origin",
        localDefault: `http://localhost:${ports.sentinelPort}`,
        mode: options.mode,
      })
    : null
  const appPublicOrigin = options.includeCustomApp
    ? resolvePublicOrigin({
        value: options.appPublicOrigin,
        envName: "SIXB_APP_PUBLIC_ORIGIN",
        label: "custom app public origin",
        localDefault: `http://localhost:${ports.appPort}`,
        mode: options.mode,
      })
    : null

  return {
    apiPublicOrigin,
    atlasPublicOrigin,
    sentinelPublicOrigin,
    appPublicOrigin,
  }
}

function createAllowedBrowserOrigins(origins: BrowserPublicOrigins): readonly SixbBrowserOrigin[] {
  const allowedOrigins: SixbBrowserOrigin[] = []

  if (origins.atlasPublicOrigin) {
    allowedOrigins.push({ origin: origins.atlasPublicOrigin, audience: "atlas", kind: "atlas" })
  }

  if (origins.sentinelPublicOrigin) {
    allowedOrigins.push({
      origin: origins.sentinelPublicOrigin,
      audience: "sentinel",
      kind: "sentinel",
    })
  }

  if (origins.appPublicOrigin) {
    allowedOrigins.push({ origin: origins.appPublicOrigin, audience: "app", kind: "app" })
  }

  return allowedOrigins
}

export function apiUrl(topology: BrowserTopology): string {
  return new URL("/api", topology.apiPublicOrigin).toString().replace(/\/$/, "")
}

export function apiDocsUrl(topology: BrowserTopology): string {
  return new URL("/docs", topology.apiPublicOrigin).toString()
}

export function apiEventsUrl(topology: BrowserTopology): string {
  const url = new URL("/ws/events", topology.apiPublicOrigin)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

function resolvePublicOrigin(input: {
  readonly value: string | undefined
  readonly envName: string
  readonly label: string
  readonly localDefault: string
  readonly mode: "development" | "production"
}): string {
  const configured = input.value ?? process.env[input.envName]
  if (configured) {
    return normalizeOrigin(configured, input.label)
  }

  if (input.mode === "development") {
    return input.localDefault
  }

  throw new Error(
    `[SixbCLI] Production serving requires ${input.envName} or --${toKebabCase(input.envName.replace(/^SIXB_/, "").toLowerCase())}.`
  )
}

function parsePort(value: string | undefined, label: string, fallback: number): number {
  if (!value) {
    return fallback
  }

  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || String(port) !== value.trim()) {
    throw new Error(`[SixbCLI] --${label} must be a valid TCP port.`)
  }

  return port
}

function normalizeOrigin(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`[SixbCLI] Invalid ${label}: '${value}'.`)
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`[SixbCLI] ${label} must use http or https.`)
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`[SixbCLI] ${label} must be an origin, not a full URL.`)
  }

  return url.origin
}

function toKebabCase(value: string): string {
  return value.replaceAll("_", "-")
}
