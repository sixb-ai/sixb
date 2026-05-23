import type { RestClient } from "@sixb/connector-rest"
import type { RokuActiveApp, RokuApp, RokuDeviceInfo, RokuKey, RokuMediaPlayerState } from "./types"

function extractTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i")
  const match = regex.exec(xml)
  return match ? match[1].trim() : null
}

function parseXmlAttributes(input: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const regex = /([a-zA-Z0-9:-]+)="([^"]*)"/g

  for (const match of input.matchAll(regex)) {
    const key = match[1]
    const value = match[2]
    attributes[key] = value
  }

  return attributes
}

function parseAppNode(xml: string, tag: "app" | "screensaver"): RokuActiveApp | null {
  const match = new RegExp(`<${tag}\\b([^>]*)>([^<]*)</${tag}>`, "i").exec(xml)
  if (!match) {
    return null
  }

  const attrs = parseXmlAttributes(match[1])
  return {
    kind: tag,
    id: attrs.id ?? "",
    type: attrs.type,
    version: attrs.version,
    name: match[2].trim(),
  }
}

export class RokuApiService {
  constructor(
    private readonly client: RestClient,
    private readonly host: string
  ) {}

  async getDeviceInfo(): Promise<RokuDeviceInfo> {
    const xml = await this.request("/query/device-info")

    return {
      friendlyName:
        extractTag(xml, "friendly-device-name") ?? extractTag(xml, "user-device-name") ?? "Roku",
      modelName: extractTag(xml, "model-name") ?? "Unknown",
      modelNumber: extractTag(xml, "model-number") ?? "",
      serialNumber: extractTag(xml, "serial-number") ?? "",
      softwareVersion: extractTag(xml, "software-version") ?? "",
      softwareBuild: extractTag(xml, "software-build") ?? "",
      vendorName: extractTag(xml, "vendor-name") ?? "",
      isTv: extractTag(xml, "is-tv") === "true",
      powerMode: extractTag(xml, "power-mode") ?? "unknown",
    }
  }

  async getMediaPlayer(): Promise<RokuMediaPlayerState | null> {
    const xml = await this.request("/query/media-player")

    const stateMatch = /state="([^"]*)"/i.exec(xml)
    if (!stateMatch) {
      return null
    }

    return {
      state: stateMatch[1],
      isLive: /is_live="true"/i.test(xml),
      error: /error="true"/i.test(xml),
    }
  }

  async listApps(): Promise<RokuApp[]> {
    const xml = await this.request("/query/apps")
    const apps: RokuApp[] = []
    const appRegex = /<app\b([^>]*)>([^<]*)<\/app>/gi

    for (const match of xml.matchAll(appRegex)) {
      const attrs = parseXmlAttributes(match[1])
      apps.push({
        id: attrs.id ?? "",
        type: attrs.type,
        version: attrs.version,
        name: match[2].trim(),
      })
    }

    return apps
  }

  async getActiveApp(): Promise<RokuActiveApp | null> {
    const xml = await this.request("/query/active-app")
    return parseAppNode(xml, "app") ?? parseAppNode(xml, "screensaver")
  }

  async keypress(key: RokuKey | string): Promise<void> {
    const keyName = String(key).trim()
    if (!keyName) {
      throw new Error("[RokuTV] keypress key must not be empty.")
    }

    await this.request(`/keypress/${encodeURIComponent(keyName)}`, { method: "POST" })
  }

  async launch(appId: string): Promise<void> {
    const normalizedAppId = appId.trim()
    if (!normalizedAppId) {
      throw new Error("[RokuTV] launch appId must not be empty.")
    }

    await this.request(`/launch/${encodeURIComponent(normalizedAppId)}`, { method: "POST" })
  }

  private async request(path: string, init?: RequestInit): Promise<string> {
    const response = await this.client.request(path, init)
    if (!response.ok) {
      throw new Error(`[RokuTV] HTTP ${response.status} from http://${this.host}${path}`)
    }

    return response.text()
  }
}

export type RokuApi = RokuApiService
